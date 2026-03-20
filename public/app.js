/* ─── Brat-o-meter frontend ─────────────────────────────────────────────── */

const SPOTS = [
  { id: 'milwaukee',     label: 'Milwaukee' },
  { id: 'racine',        label: 'Racine' },
  { id: 'portWashington', label: 'Port Washington' },
];

const QUALITY_ICONS = { Epic: '🔥', Good: '✅', Fair: '〰️', Poor: '😴' };

const COMPASS_DIRS = [
  'N','NNE','NE','ENE','E','ESE','SE','SSE',
  'S','SSW','SW','WSW','W','WNW','NW','NNW',
];

function compassToDeg(dir) {
  const i = COMPASS_DIRS.indexOf(dir);
  return i >= 0 ? i * 22.5 : 0;
}

// Wind arrow Unicode by direction
function windArrowChar(deg) {
  // Arrow points in the direction the wind IS GOING (downwind)
  const arrows = ['↓','↙','←','↖','↑','↗','→','↘'];
  const idx = Math.round(((deg + 180) % 360) / 45) % 8;
  return arrows[idx];
}

/* ─── STATE ─────────────────────────────────────────────────────────────── */
let activeSpot     = 'milwaukee';
let allConditions  = null;
let forecastCache  = {};
let smsEnabled     = false;
let twilioConfigured = false;
let refreshTimer   = null;

/* ─── DOM REFS ──────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const elLoading        = $('loading');
const elError          = $('error-state');
const elPanel          = $('conditions-panel');
const elAlertBanner    = $('alert-banner');
const elAlertText      = $('alert-text');
const elAlertIndicator = $('alert-indicator');
const elQualityBadge   = $('quality-badge');
const elQualityIcon    = $('quality-icon');
const elQualityRating  = $('quality-rating');
const elWaveHeight     = $('wave-height');
const elWavePeriod     = $('wave-period');
const elWindSpeed      = $('wind-speed');
const elAirTemp        = $('air-temp');
const elWaterTemp      = $('water-temp');
const elWindDirLabel   = $('wind-dir-label');
const elWindArrow      = $('wind-arrow');
const elWaveSource     = $('wave-source');
const elWaveSourceFtr  = $('wave-source-footer');
const elLastUpdated    = $('last-updated');
const elForecastStrip  = $('forecast-strip');
const elForecastLoad   = $('forecast-loading');
const elForecastNote   = $('forecast-note');
const elSmsToggle      = $('sms-toggle');
const elSmsControl     = $('sms-control');
const elRefreshBtn     = $('refresh-btn');
const elRetryBtn       = $('retry-btn');
const elAlertBannerGlobal = $('alert-banner');

/* ─── HELPERS ───────────────────────────────────────────────────────────── */
function fmt(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(decimals);
}

function fmtInt(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toString();
}

function qualityClass(rating) {
  const map = { Epic: 'q-epic', Good: 'q-good', Fair: 'q-fair', Poor: 'q-poor' };
  return map[rating] || 'q-poor';
}

function qualityColorClass(rating) {
  const map = { Epic: 'quality-epic', Good: 'quality-good', Fair: 'quality-fair', Poor: 'quality-poor' };
  return map[rating] || 'quality-poor';
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)  return 'just now';
  if (diff < 120) return '1 min ago';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/* ─── DRAW COMPASS ──────────────────────────────────────────────────────── */
function setCompass(dirStr) {
  const deg = compassToDeg(dirStr);
  if (elWindArrow) {
    elWindArrow.setAttribute('transform', `rotate(${deg}, 110, 110)`);
  }
  if (elWindDirLabel) {
    elWindDirLabel.textContent = dirStr || '—';
  }
}

/* ─── RENDER CONDITIONS ─────────────────────────────────────────────────── */
function renderConditions(cond) {
  if (!cond) return;

  // Quality
  const qClass = qualityColorClass(cond.quality);
  const qIcon  = QUALITY_ICONS[cond.quality] || '🌊';

  elQualityIcon.textContent   = qIcon;
  elQualityRating.textContent = cond.quality || '—';
  elQualityBadge.className    = `quality-badge ${qClass}`;

  // Alert indicator
  if (cond.alertActive) {
    elAlertIndicator.classList.remove('hidden');
  } else {
    elAlertIndicator.classList.add('hidden');
  }

  // Metrics
  elWaveHeight.textContent = cond.waveHeightFt != null ? fmt(cond.waveHeightFt) : '—';
  elWavePeriod.textContent = cond.wavePeriod   != null ? fmt(cond.wavePeriod)   : '—';
  elWindSpeed.textContent  = cond.windSpeedMph != null ? fmtInt(cond.windSpeedMph) : '—';
  elAirTemp.textContent    = cond.airTempF     != null ? fmtInt(cond.airTempF)  : '—';
  elWaterTemp.textContent  = cond.waterTempF   != null ? fmtInt(cond.waterTempF): '—';

  // Compass
  setCompass(cond.windDir || '—');

  // Wave source
  if (elWaveSource) {
    elWaveSource.textContent = cond.waveSource ? `Wave data: ${cond.waveSource}` : '';
  }

  // Footer
  if (elWaveSourceFtr) {
    elWaveSourceFtr.textContent = cond.waveSource || 'NOAA NWS + NDBC';
  }
  if (elLastUpdated) {
    elLastUpdated.textContent = `Updated ${relativeTime(cond.timestamp)}`;
  }

  // Show panel
  elLoading.classList.add('hidden');
  elError.classList.add('hidden');
  elPanel.classList.remove('hidden');
}

/* ─── RENDER GLOBAL ALERT BANNER ────────────────────────────────────────── */
function renderAlertBanner(conditions) {
  if (!conditions) return;
  const firingSpots = SPOTS
    .map((s) => conditions[s.id])
    .filter((c) => c && c.alertActive)
    .map((c) => c.name);

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    const spotId = tab.dataset.spot;
    const cond = conditions[spotId];
    if (cond?.alertActive) {
      tab.classList.add('has-alert');
    } else {
      tab.classList.remove('has-alert');
    }
  });

  if (firingSpots.length > 0) {
    elAlertBannerGlobal.classList.remove('hidden');
    elAlertText.textContent = `🏄 IT'S ON! ${firingSpots.join(' & ')} — conditions met!`;
  } else {
    elAlertBannerGlobal.classList.add('hidden');
  }
}

/* ─── RENDER FORECAST ───────────────────────────────────────────────────── */
function renderForecast(days) {
  if (!days || days.length === 0) {
    elForecastLoad.textContent = 'Forecast unavailable';
    return;
  }

  elForecastLoad.classList.add('hidden');
  elForecastNote.classList.remove('hidden');
  elForecastStrip.classList.remove('hidden');
  elForecastStrip.innerHTML = '';

  days.forEach((day) => {
    const qc     = qualityClass(day.quality);
    const dirDeg = day.windDirDeg || 0;
    // Arrow points downwind (where wind goes)
    const arrowChar = windArrowChar(dirDeg);

    const el = document.createElement('div');
    el.className = `forecast-day ${qc}`;
    el.innerHTML = `
      <div class="fc-day-label">${day.label.split(',')[0]}</div>
      <div class="fc-wave ${qc}">${fmt(day.estimatedWaveHeight)}</div>
      <div class="fc-wave-unit">ft</div>
      <div class="wind-mini-arrow" style="transform:rotate(${dirDeg}deg)">${arrowChar}</div>
      <div class="fc-wind-speed">${fmtInt(day.windSpeedMph)}<span style="font-size:0.5rem;opacity:.7"> mph</span></div>
      <div class="fc-wind-dir">${day.windDir || '—'}</div>
      <div class="fc-quality ${qc}">${day.quality}</div>
    `;
    elForecastStrip.appendChild(el);
  });
}

/* ─── FETCH & REFRESH ───────────────────────────────────────────────────── */
async function fetchConditions() {
  try {
    setRefreshing(true);
    const res  = await fetch('/api/conditions');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'API error');

    allConditions    = json.data;
    smsEnabled       = json.smsEnabled;
    twilioConfigured = json.twilioConfigured;

    // Update SMS toggle state
    elSmsToggle.checked = smsEnabled;
    if (!twilioConfigured) {
      elSmsControl.title = 'Add Twilio credentials to .env to enable SMS';
      elSmsControl.style.opacity = '0.45';
      elSmsToggle.disabled = true;
    }

    renderConditions(allConditions[activeSpot]);
    renderAlertBanner(allConditions);
    return true;
  } catch (e) {
    console.error('Fetch conditions error:', e);
    elLoading.classList.add('hidden');
    elPanel.classList.add('hidden');
    elError.classList.remove('hidden');
    return false;
  } finally {
    setRefreshing(false);
  }
}

async function fetchForecast(spotId) {
  if (forecastCache[spotId]) {
    renderForecast(forecastCache[spotId]);
    return;
  }

  elForecastLoad.textContent = 'Loading forecast…';
  elForecastLoad.classList.remove('hidden');
  elForecastStrip.classList.add('hidden');

  try {
    const res  = await fetch(`/api/forecast/${spotId}`);
    const json = await res.json();
    if (json.success && json.data) {
      forecastCache[spotId] = json.data;
      renderForecast(json.data);
    } else {
      elForecastLoad.textContent = 'Forecast unavailable';
    }
  } catch (e) {
    elForecastLoad.textContent = 'Forecast unavailable';
  }
}

function setRefreshing(on) {
  if (on) {
    elRefreshBtn.classList.add('spinning');
    elRefreshBtn.disabled = true;
  } else {
    elRefreshBtn.classList.remove('spinning');
    elRefreshBtn.disabled = false;
  }
}

/* ─── SWITCH SPOT TAB ───────────────────────────────────────────────────── */
function switchToSpot(spotId) {
  activeSpot = spotId;

  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.spot === spotId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (allConditions) {
    renderConditions(allConditions[spotId]);
  } else {
    // Show loading if we haven't fetched yet
    elLoading.classList.remove('hidden');
    elPanel.classList.add('hidden');
  }

  fetchForecast(spotId);
}

/* ─── SMS TOGGLE ────────────────────────────────────────────────────────── */
elSmsToggle.addEventListener('change', async () => {
  if (!twilioConfigured) {
    elSmsToggle.checked = false;
    alert('Twilio is not configured. Add your credentials to the .env file and restart the server.');
    return;
  }
  try {
    const res  = await fetch('/api/alerts/toggle', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ enabled: elSmsToggle.checked }),
    });
    const json = await res.json();
    smsEnabled = json.smsEnabled;
    elSmsToggle.checked = smsEnabled;
  } catch (e) {
    elSmsToggle.checked = !elSmsToggle.checked;
    console.error('SMS toggle error:', e);
  }
});

/* ─── TAB CLICKS ────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchToSpot(tab.dataset.spot));
});

/* ─── REFRESH BUTTON ────────────────────────────────────────────────────── */
elRefreshBtn.addEventListener('click', async () => {
  forecastCache = {}; // clear forecast cache on manual refresh
  await fetchConditions();
  if (allConditions) fetchForecast(activeSpot);
});

/* ─── RETRY ─────────────────────────────────────────────────────────────── */
elRetryBtn.addEventListener('click', async () => {
  elError.classList.add('hidden');
  elLoading.classList.remove('hidden');
  await fetchConditions();
  if (allConditions) fetchForecast(activeSpot);
});

/* ─── AUTO-REFRESH (every 15 minutes) ──────────────────────────────────── */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    forecastCache = {};
    await fetchConditions();
    if (allConditions) fetchForecast(activeSpot);
    scheduleRefresh();
  }, 15 * 60 * 1000);
}

/* ─── TICK LAST-UPDATED LABEL every minute ──────────────────────────────── */
setInterval(() => {
  if (!allConditions) return;
  const cond = allConditions[activeSpot];
  if (cond && elLastUpdated) {
    elLastUpdated.textContent = `Updated ${relativeTime(cond.timestamp)}`;
  }
}, 60 * 1000);

/* ─── INIT ──────────────────────────────────────────────────────────────── */
(async function init() {
  const ok = await fetchConditions();
  if (ok) {
    await fetchForecast(activeSpot);
    scheduleRefresh();
  }
})();
