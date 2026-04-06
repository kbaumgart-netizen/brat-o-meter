require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+14144045955';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SPOTS = [
  {
    id: 'milwaukee',
    name: 'Milwaukee',
    fullName: 'Milwaukee / Bradford Beach',
    lat: 43.063,
    lon: -87.877,
  },
  {
    id: 'racine',
    name: 'Racine',
    fullName: 'Racine',
    lat: 42.726,
    lon: -87.782,
  },
  {
    id: 'portWashington',
    name: 'Port Washington',
    fullName: 'Port Washington',
    lat: 43.385,
    lon: -87.875,
  },
];

// NDBC buoys for S. Lake Michigan — tried in priority order.
// 45214: wave-only spotter buoy, confirmed year-round active (42.67°N 87.03°W)
// 45013: traditional full met buoy, best data when deployed (seasonal, ~Apr–Nov)
// 45007: mid-lake fallback (45.0°N 87.0°W)
const NDBC_STATIONS = ['45214', '45013', '45007'];

// Favored wind directions for WI Lake Michigan breaks
const FAVORABLE_DIRS = new Set(['N', 'NNW', 'NW', 'S', 'SE', 'SSE']);
const MIN_WIND_MPH = 15;
const MIN_WAVE_FT = 3;

const NWS_USER_AGENT = 'BratOMeter/1.0 (Lake Michigan surf forecast; github.com/bratboys)';

// ─── STATE ───────────────────────────────────────────────────────────────────

const nwsGridpointCache = {};   // lat,lon → {gridId, gridX, gridY}
let cachedConditions = null;
let conditionsTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let smsEnabled = false;
const alertSent = {};
SPOTS.forEach((s) => (alertSent[s.id] = false));

// Twilio (optional)
let twilioClient = null;
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  !process.env.TWILIO_ACCOUNT_SID.includes('your_')
) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('✅ Twilio configured');
  } catch (e) {
    console.warn('⚠️  Twilio init failed:', e.message);
  }
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function degreesToCompass(deg) {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function compassToDegrees(compass) {
  const map = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
    E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
    W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return map[compass] ?? 0;
}

function getSurfQuality(waveHeightFt, windSpeedMph, windDir) {
  const h = waveHeightFt ?? 0;
  const w = windSpeedMph ?? 0;
  const goodDir = FAVORABLE_DIRS.has(windDir);
  if (h >= 4 && goodDir && w >= 15 && w <= 35) return { rating: 'Epic', grade: 4 };
  if (h >= 3 && goodDir && w >= 12)             return { rating: 'Good', grade: 3 };
  if (h >= 2 || (goodDir && w >= 10 && h >= 1)) return { rating: 'Fair', grade: 2 };
  return { rating: 'Poor', grade: 1 };
}

function checkAlertConditions(windDir, windSpeedMph, waveHeightFt) {
  if (!windDir || !windSpeedMph || !waveHeightFt) return false;
  return (
    FAVORABLE_DIRS.has(windDir) &&
    windSpeedMph >= MIN_WIND_MPH &&
    waveHeightFt >= MIN_WAVE_FT
  );
}

// ─── NWS API ─────────────────────────────────────────────────────────────────

async function getNWSGridpoint(lat, lon) {
  const key = `${lat},${lon}`;
  if (nwsGridpointCache[key]) return nwsGridpointCache[key];

  const resp = await axios.get(
    `https://api.weather.gov/points/${lat},${lon}`,
    { headers: { 'User-Agent': NWS_USER_AGENT }, timeout: 12000 }
  );
  const { gridId, gridX, gridY } = resp.data.properties;
  nwsGridpointCache[key] = { gridId, gridX, gridY };
  return nwsGridpointCache[key];
}

async function getNWSHourlyForecast(lat, lon) {
  const { gridId, gridX, gridY } = await getNWSGridpoint(lat, lon);
  const resp = await axios.get(
    `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}/forecast/hourly`,
    { headers: { 'User-Agent': NWS_USER_AGENT }, timeout: 15000 }
  );
  return resp.data.properties.periods;
}

// ─── OPEN-METEO FALLBACK ──────────────────────────────────────────────────────

async function getOpenMeteoData(lat, lon) {
  const resp = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: lat,
      longitude: lon,
      hourly: 'windspeed_10m,winddirection_10m,temperature_2m',
      windspeed_unit: 'mph',
      timezone: 'America/Chicago',
      forecast_days: 7,
    },
    timeout: 12000,
  });
  return resp.data;
}

// ─── NDBC BUOY ───────────────────────────────────────────────────────────────

async function getNDBCData(station) {
  const resp = await axios.get(
    `https://www.ndbc.noaa.gov/data/realtime2/${station}.txt`,
    { timeout: 12000, responseType: 'text' }
  );
  return parseNDBCText(resp.data);
}

function parseNDBCText(text) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('#YY'));
  if (headerIdx === -1) return null;

  // Line headerIdx   = header names
  // Line headerIdx+1 = units  (skip)
  // Line headerIdx+2 = first data row
  const headers = lines[headerIdx].replace(/^#/, '').trim().split(/\s+/);
  const dataLine = lines
    .slice(headerIdx + 2)
    .find((l) => l.trim() && !l.startsWith('#'));
  if (!dataLine) return null;

  const vals = dataLine.trim().split(/\s+/);
  const get = (key) => {
    const i = headers.indexOf(key);
    const v = i >= 0 ? vals[i] : 'MM';
    return v === 'MM' || v === undefined ? null : parseFloat(v);
  };

  const wvht = get('WVHT');         // meters
  const dpd  = get('DPD') ?? get('APD'); // seconds
  const wtmp = get('WTMP');         // °C
  const wspd = get('WSPD');         // m/s
  const wdir = get('WDIR');         // degrees

  return {
    waveHeightFt:  wvht !== null ? +(wvht * 3.281).toFixed(1)       : null,
    wavePeriod:    dpd  !== null ? +dpd.toFixed(1)                   : null,
    waterTempF:    wtmp !== null ? +((wtmp * 9) / 5 + 32).toFixed(1) : null,
    buoyWindMph:   wspd !== null ? +(wspd * 2.237).toFixed(1)        : null,
    buoyWindDirDeg: wdir,
  };
}

// ─── NDBC MULTI-STATION WAVE FETCH ───────────────────────────────────────────
// Tries stations in priority order, returns first one with valid wave height.
// 45214 is a wave-only spotter (no wind/water temp) but confirmed year-round.
// 45013 is the full met buoy closest to the spots, deployed ~Apr–Nov.

async function fetchBuoyWaveData() {
  for (const station of NDBC_STATIONS) {
    try {
      const data = await getNDBCData(station);
      if (data && data.waveHeightFt !== null) {
        console.log(`✅ Wave data from NDBC ${station}: ${data.waveHeightFt}ft`);
        return { ...data, source: `NDBC Buoy ${station}` };
      }
    } catch (e) {
      console.warn(`⚠️  NDBC ${station} failed:`, e.message);
    }
  }
  console.warn('⚠️  All NDBC buoys unavailable — no wave data');
  return null;
}

// ─── WAVE ESTIMATION (forecast fallback) ─────────────────────────────────────

function estimateWaveHeight(windSpeedMph, windDir) {
  if (!windSpeedMph || windSpeedMph < 5) return 0.5;
  // Fetch bonus for favourable directions (longer fetch on Lake Michigan)
  const fetchBonus = FAVORABLE_DIRS.has(windDir) ? 1.2 : 0.65;
  let h;
  if      (windSpeedMph < 10) h = 0.5;
  else if (windSpeedMph < 15) h = 1.5;
  else if (windSpeedMph < 20) h = 2.5;
  else if (windSpeedMph < 25) h = 3.5;
  else if (windSpeedMph < 30) h = 4.5;
  else if (windSpeedMph < 35) h = 5.5;
  else                         h = 6.5;
  return +(h * fetchBonus).toFixed(1);
}

// ─── MAIN CONDITIONS FETCH ───────────────────────────────────────────────────

async function fetchAllConditions(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConditions && now - conditionsTimestamp < CACHE_TTL_MS) {
    return cachedConditions;
  }

  console.log('🌊 Refreshing conditions...');

  // Shared buoy data fetched once — tries 45214, 45013, 45007 in order
  const buoyData = await fetchBuoyWaveData();

  const results = {};

  for (const spot of SPOTS) {
    let windSpeedMph = null;
    let windDir      = null;
    let airTempF     = null;
    let nwsOk        = false;

    // 1. NWS hourly
    try {
      const periods = await getNWSHourlyForecast(spot.lat, spot.lon);
      if (periods && periods.length > 0) {
        const cur = periods[0];
        const m = cur.windSpeed?.match(/(\d+)/);
        windSpeedMph = m ? parseInt(m[1]) : null;
        windDir      = cur.windDirection ?? null;
        airTempF     = cur.temperature   ?? null;
        nwsOk        = true;
      }
    } catch (e) {
      console.warn(`⚠️  NWS wind failed for ${spot.name}:`, e.message);
    }

    // 2. Open-Meteo fallback
    if (!nwsOk) {
      try {
        const om = await getOpenMeteoData(spot.lat, spot.lon);
        if (om?.hourly) {
          windSpeedMph = om.hourly.windspeed_10m?.[0] ?? null;
          const dd = om.hourly.winddirection_10m?.[0];
          windDir  = dd != null ? degreesToCompass(dd) : null;
          const tc = om.hourly.temperature_2m?.[0];
          airTempF = tc != null ? +((tc * 9) / 5 + 32).toFixed(1) : null;
        }
      } catch (e) {
        console.warn(`⚠️  Open-Meteo failed for ${spot.name}:`, e.message);
      }
    }

    // 3. Wave data from best available buoy (shared, fetched once above)
    const waveHeightFt = buoyData?.waveHeightFt ?? null;
    const wavePeriod   = buoyData?.wavePeriod   ?? null;
    const waveSource   = buoyData?.source        ?? 'N/A';

    // 4. Quality & alert
    const quality    = getSurfQuality(waveHeightFt, windSpeedMph, windDir);
    const alertActive = checkAlertConditions(windDir, windSpeedMph, waveHeightFt);

    results[spot.id] = {
      id:          spot.id,
      name:        spot.name,
      fullName:    spot.fullName,
      waveHeightFt,
      wavePeriod,
      waterTempF:  buoyData?.waterTempF ?? null,
      windSpeedMph,
      windDir,
      windDirDeg:  windDir ? compassToDegrees(windDir) : null,
      airTempF,
      quality:     quality.rating,
      qualityGrade: quality.grade,
      alertActive,
      waveSource,
      timestamp:   new Date().toISOString(),
    };
  }

  cachedConditions    = results;
  conditionsTimestamp = Date.now();
  return results;
}

// ─── FORECAST ────────────────────────────────────────────────────────────────

async function fetchForecast(spotId) {
  const spot = SPOTS.find((s) => s.id === spotId);
  if (!spot) throw new Error('Unknown spot');

  let periods = null;

  try {
    periods = await getNWSHourlyForecast(spot.lat, spot.lon);
  } catch (_) {
    try {
      const om = await getOpenMeteoData(spot.lat, spot.lon);
      if (om?.hourly) {
        periods = om.hourly.time.map((t, i) => ({
          startTime:     t,
          windSpeed:     `${Math.round(om.hourly.windspeed_10m[i])} mph`,
          windDirection: degreesToCompass(om.hourly.winddirection_10m[i]),
          temperature:   Math.round((om.hourly.temperature_2m[i] * 9) / 5 + 32),
          isDaytime:     true,
        }));
      }
    } catch (e) {
      console.warn('Forecast fallback also failed:', e.message);
    }
  }

  if (!periods) return [];

  // Group into calendar days (local Chicago time)
  const dayMap = new Map();
  for (const period of periods.slice(0, 120)) {
    const date = new Date(period.startTime);
    const label = date.toLocaleDateString('en-US', {
      weekday: 'short',
      month:   'short',
      day:     'numeric',
      timeZone: 'America/Chicago',
    });
    if (!dayMap.has(label)) dayMap.set(label, []);
    dayMap.get(label).push(period);
  }

  const days = [];
  for (const [label, dayPeriods] of dayMap) {
    if (days.length >= 5) break;

    // Pick the period closest to noon
    const noon = dayPeriods.reduce((best, p) => {
      const h = new Date(p.startTime).getHours();
      return Math.abs(h - 12) < Math.abs(new Date(best.startTime).getHours() - 12) ? p : best;
    }, dayPeriods[0]);

    const m = noon.windSpeed?.match(/(\d+)/);
    const windSpeedMph = m ? parseInt(m[1]) : 0;
    const windDir = noon.windDirection ?? 'N';
    const estWave = estimateWaveHeight(windSpeedMph, windDir);
    const quality = getSurfQuality(estWave, windSpeedMph, windDir);

    days.push({
      label,
      windSpeedMph,
      windDir,
      windDirDeg:           compassToDegrees(windDir),
      tempF:                noon.temperature ?? null,
      estimatedWaveHeight:  estWave,
      quality:              quality.rating,
      qualityGrade:         quality.grade,
    });
  }

  return days;
}

// ─── SMS ALERTS ───────────────────────────────────────────────────────────────

async function sendSMSAlert(spot, cond) {
  if (!twilioClient || !process.env.ALERT_PHONE_NUMBER) {
    console.log(`📱 [SMS disabled] Alert conditions met at ${spot.fullName}`);
    return;
  }
  const body =
    `BRAT-O-METER ALERT!\n` +
    `${spot.fullName} is firing!\n` +
    `Waves: ${cond.waveHeightFt}ft  Period: ${cond.wavePeriod ?? '?'}s\n` +
    `Wind: ${cond.windSpeedMph}mph ${cond.windDir}\n` +
    `Rating: ${cond.quality}\n` +
    `Drop everything! 🏄🌊`;

  const logoUrl = `https://ingenious-celebration-production-2aaa.up.railway.app/brat-boys-logo.png`;

  // Support multiple comma-separated recipients
  const recipients = process.env.ALERT_PHONE_NUMBER.split(',').map(n => n.trim()).filter(Boolean);

  for (const to of recipients) {
    try {
      await twilioClient.messages.create({
        body,
        mediaUrl: [logoUrl],
        from: TWILIO_FROM,
        to,
      });
      console.log(`📱 MMS sent to ${to} for ${spot.fullName}`);
    } catch (e) {
      console.error(`SMS error for ${to}:`, e.message);
    }
  }
}

async function checkAlertsAndNotify() {
  if (!smsEnabled) return;
  try {
    const conditions = await fetchAllConditions();
    for (const spot of SPOTS) {
      const cond = conditions[spot.id];
      if (!cond) continue;
      if (cond.alertActive && !alertSent[spot.id]) {
        await sendSMSAlert(spot, cond);
        alertSent[spot.id] = true;
      } else if (!cond.alertActive && alertSent[spot.id]) {
        alertSent[spot.id] = false;
        console.log(`🔄 Alert reset for ${spot.name}`);
      }
    }
  } catch (e) {
    console.error('Alert check error:', e);
  }
}

// Run alert check every 30 minutes
cron.schedule('*/30 * * * *', checkAlertsAndNotify);

// Reset all alert states at midnight CT so alerts can fire again each day
cron.schedule('0 0 * * *', () => {
  SPOTS.forEach(s => { alertSent[s.id] = false; });
  console.log('🔄 Daily alert reset — all spots ready to alert again');
}, { timezone: 'America/Chicago' });

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/conditions', async (req, res) => {
  try {
    const data = await fetchAllConditions();
    res.json({
      success: true,
      data,
      smsEnabled,
      alertSent,
      twilioConfigured: !!twilioClient,
    });
  } catch (e) {
    console.error('Conditions error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/forecast/:spotId', async (req, res) => {
  try {
    const data = await fetchForecast(req.params.spotId);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/alerts/toggle', (req, res) => {
  smsEnabled = !!req.body.enabled;
  console.log(`📱 SMS alerts ${smsEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ success: true, smsEnabled });
});

app.get('/api/alerts/status', (req, res) => {
  res.json({ smsEnabled, alertSent, twilioConfigured: !!twilioClient });
});

// ─── PRIVACY & TERMS ─────────────────────────────────────────────────────────

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Brat-o-meter Privacy Policy</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}</style></head>
  <body><h1>Brat-o-meter Privacy Policy</h1>
  <p><strong>Last updated: April 2026</strong></p>
  <p>Brat-o-meter is a private surf alert service for a small group of friends monitoring Lake Michigan surf conditions.</p>
  <h2>Information We Collect</h2>
  <p>We collect only the phone numbers of users who have explicitly opted in to receive surf condition alerts by texting START to our number.</p>
  <h2>How We Use Your Information</h2>
  <p>Phone numbers are used solely to send surf condition alert text messages when wave and wind thresholds are met at monitored Lake Michigan surf spots.</p>
  <h2>SMS Alerts</h2>
  <p>Message frequency varies based on surf conditions. Standard message and data rates may apply. Reply STOP to unsubscribe at any time. Reply HELP for help.</p>
  <h2>Data Sharing</h2>
  <p>We do not sell, share, or distribute any personal information to third parties.</p>
  <h2>Contact</h2>
  <p>For questions, reply HELP to any alert message.</p></body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Brat-o-meter Terms</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}</style></head>
  <body><h1>Brat-o-meter Terms of Service</h1>
  <p><strong>Last updated: April 2026</strong></p>
  <p>By opting in to Brat-o-meter SMS alerts, you agree to receive automated surf condition notifications for Lake Michigan spots.</p>
  <h2>Service Description</h2>
  <p>Brat-o-meter monitors wave height, wind speed, and wind direction at Milwaukee/Bradford Beach, Racine, and Port Washington. Alerts are sent when all three surfing thresholds are met simultaneously.</p>
  <h2>Opt-Out</h2>
  <p>Reply STOP at any time to unsubscribe. You will receive no further messages.</p>
  <h2>Disclaimer</h2>
  <p>Surf conditions are provided for informational purposes only. Always use your own judgment when entering the water.</p></body></html>`);
});

// ─── START ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🏄  Brat-o-meter is live!
  ─────────────────────────────────────
  URL     : http://localhost:${PORT}
  Spots   : Milwaukee · Racine · Port Washington
  SMS     : ${twilioClient ? 'Configured ✅' : 'Not configured (add Twilio creds to .env)'}
  ─────────────────────────────────────
  `);
});
