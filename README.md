# 🌊 Brat-o-meter

> Lake Michigan surf forecasting dashboard for the Brat Boys crew.
> Monitors Milwaukee / Bradford Beach · Racine · Port Washington.

---

## What it does

- Real-time wave height, period, wind speed & direction, air & water temp
- Surf quality rating (Epic / Good / Fair / Poor)
- Compass rose with animated wind direction arrow
- 5-day forecast strip
- Amber pulsing alert when SMS conditions are met (N/NNW/NW/S/SE/SSE wind ≥ 15 mph AND waves ≥ 3 ft)
- SMS alerts via Twilio — no duplicate alerts until conditions reset

**Data sources (all free, no paid API keys required)**
| Data | Source |
|---|---|
| Wind speed & direction | NOAA National Weather Service (`api.weather.gov`) |
| Wind fallback | Open-Meteo (`api.open-meteo.com`) |
| Wave height & period | NOAA GLERL GLCFS WW3 model → NDBC Buoy 45013 fallback |
| Water temperature | NDBC Buoy 45013 (S. Lake Michigan) |
| Air temperature | NOAA NWS |

---

## Quick Start (local)

### 1. Clone / download

```bash
cd ~/Desktop
# If you have git:
git clone <your-repo-url> brat-o-meter
cd brat-o-meter
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values (see Twilio setup below).
The app works **without** Twilio — SMS is optional.

### 4. Run

```bash
npm start
# or during development:
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Twilio SMS Setup (free trial)

1. Go to **https://www.twilio.com/try-twilio** and create a free account.
2. Verify your personal phone number during signup.
3. From the Twilio Console dashboard, copy:
   - **Account SID** → `TWILIO_ACCOUNT_SID`
   - **Auth Token** → `TWILIO_AUTH_TOKEN`
4. Click **"Get a free phone number"** → copy it → `TWILIO_PHONE_NUMBER`
5. Set `ALERT_PHONE_NUMBER` to your own verified cell number (format: `+1XXXXXXXXXX`)

> **Free trial limit:** Twilio trial accounts can only send SMS to **verified** numbers.
> Verify your crew's numbers under *Phone Numbers → Verified Caller IDs* in the Twilio console.
> Upgrade to a paid account ($15–20/mo) to send to any number.

Your `.env` should look like:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+14155551234
ALERT_PHONE_NUMBER=+14145559876
```

---

## Alert Logic

An SMS fires when **all three** conditions are met **simultaneously** at any monitored spot:

| Condition | Threshold |
|---|---|
| Wind direction | N, NNW, NW, S, SE, or SSE |
| Wind speed | ≥ 15 mph |
| Wave height | ≥ 3 ft |

- Alerts are checked every **30 minutes** by the background cron job.
- **No duplicate alerts** — once an alert is sent, the state is locked until conditions drop below threshold and return, so you won't get spammed.
- Use the **SMS toggle** in the UI to enable/disable at any time.

---

## Deploy to Vercel (free)

1. Push your repo to GitHub (make sure `.env` is in `.gitignore` ✅).

2. Go to **https://vercel.com** → *New Project* → import your repo.

3. Under **Environment Variables**, add each key from `.env`:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `ALERT_PHONE_NUMBER`

4. Click **Deploy**. Vercel handles the Node.js backend automatically via `vercel.json`.

> Note: Vercel's free tier puts serverless functions to sleep when idle.
> For always-on SMS alerts, consider a cheap VPS (Railway, Render free tier, or a $5 DigitalOcean droplet).

---

## Deploy to Netlify (free)

Netlify works best with a static frontend + Netlify Functions for the API.
For the simplest path, **use Vercel** (supports Express natively).

If you want Netlify anyway:
1. Convert each `/api/*` route in `server.js` to a file in `netlify/functions/`.
2. Point the frontend `fetch()` calls to `/.netlify/functions/conditions` etc.

---

## Project Structure

```
brat-o-meter/
├── server.js          # Express backend — data fetching, SMS alerts, API routes
├── public/
│   ├── index.html     # Mobile-first dashboard UI
│   ├── style.css      # Dark ocean theme, CSS variables
│   └── app.js         # Frontend JS — fetch, render, compass, forecast
├── .env               # Your credentials (DO NOT commit)
├── .env.example       # Template
├── .gitignore
├── package.json
├── vercel.json        # Vercel deployment config
└── README.md
```

---

## Surf Spots

| Spot | Lat | Lon | Favored Winds |
|---|---|---|---|
| Milwaukee / Bradford Beach | 43.063 | -87.877 | N, NNW, NW, S, SE, SSE |
| Racine | 42.726 | -87.782 | N, NNW, NW, S, SE, SSE |
| Port Washington | 43.385 | -87.875 | N, NNW, NW, S, SE, SSE |

These wind directions produce the fetch angles that generate rideable waves on southern Lake Michigan.

---

## Troubleshooting

**"Could not fetch conditions"**
The NWS API occasionally has hiccups. The app auto-falls back to Open-Meteo for wind. Hit **Refresh** or wait for the 15-minute auto-refresh.

**Wave height shows "—"**
NDBC buoy 45013 may be offline or returning missing data (`MM`). The GLERL wave model is tried first; if both fail, wave data shows unavailable. Check https://www.ndbc.noaa.gov/station_page.php?station=45013.

**SMS not sending**
- Confirm Twilio credentials in `.env` are correct.
- Make sure `ALERT_PHONE_NUMBER` is verified in your Twilio trial account.
- Check server console logs for error messages.
- The SMS toggle in the UI must be **ON**.

---

*Ride the Brat wave. 🏄‍♂️*
