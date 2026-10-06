# WeatherGPT

**Conversational AI for Weather Forecasting, Alerts, and Climate Information**
Smart India Hackathon 2026 prototype.

## Objective

WeatherGPT is a real, end-to-end weather intelligence platform: a React/TypeScript
frontend backed by a Node.js/Express server that talks to live meteorological
APIs (Open-Meteo, IMD/NDMA, ECMWF & GFS model endpoints), grounds a Groq-based
chatbot in that real data, and never fabricates a weather value, AQI reading, or
official warning it doesn't actually have.

## Zero Fabrication Policy

This is the single most important design rule in the codebase:

> If a live data source fails or is unavailable, WeatherGPT says so
> ("Live weather data is currently unavailable.") — it never invents a
> plausible-looking number to paper over the gap.

Concretely:
- There is no synthetic/estimated weather generator anywhere in the code.
  `fetchWeather()` and `fetchAirQuality()` throw a `WeatherUnavailableError`
  on failure; every API route catches that and returns HTTP 503 with an
  honest message instead of guessed data.
- IMD/NDMA warnings distinguish **official warning found**, **no matching
  official warning found**, and **official warning data unavailable** —
  never collapsed into a false "all clear."
- The AI engine (Groq) is only ever given real, retrieved numbers to talk about, is
  instructed never to invent or declare an official warning, and — if
  `GROQ_API_KEY` isn't configured — falls back to a plain, non-AI summary
  built from the same real retrieved numbers (clearly labeled as such),
  not a fabricated one.
- NWP model comparisons pull actual named-model output (`ecmwf_ifs025`,
  `gfs_seamless` via Open-Meteo's `models=` parameter) rather than
  presenting a generic blended forecast as if it were a specific model.
- WRF and satellite/radar have no publicly available, zero-credential data
  source, so the app reports "architecturally supported but requires a
  configured provider" instead of faking either.

## Architecture

```
React + TypeScript frontend (Vite)
        |
        v
Node.js / Express backend  (server.ts, server/services/*)
        |
        +-- weatherService.ts   -> Open-Meteo (current/hourly/daily/air quality)
        +-- geocodingService.ts -> Open-Meteo Geocoding
        +-- imdService.ts       -> IMD (api.imd.gov.in, key-gated) + NDMA/Sachet CAP (public)
        +-- nwpService.ts       -> Open-Meteo model-specific endpoints (ECMWF, GFS) + WRF status stub
        +-- climateService.ts   -> Open-Meteo Historical Archive (ERA5-derived)
        +-- aiService.ts        -> Groq (chat, briefings) grounded in the above
        +-- advisoryService.ts  -> deterministic agro/decision-support rule engine + AI copy
        +-- realtimeService.ts  -> WebSocket (/ws/alerts) real-time push of new/changed alerts
```

All secret-requiring calls happen server-side only. No API key is ever sent
to the browser or to the AI provider.

## Features

- Live current/hourly/daily weather, feels-like, humidity, wind, pressure,
  UV, sunrise/sunset, air quality (Open-Meteo).
- Location search, reverse geocoding, favorites/recents (works globally,
  not just Indian cities).
- IMD district warnings + nowcasts, NDMA/Sachet CAP alerts, with distinct
  found / not-found / unavailable states and full source attribution.
- WeatherGPT chatbot grounded in live retrieved data (Groq-hosted LLM), multilingual
  (English, Tamil, Hindi, Telugu, Kannada, Malayalam, Marathi, Bengali),
  with browser-based voice input/output.
- **NWP Models** page: real ECMWF vs GFS comparison table, model agreement
  indicator, and AI interpretation of the retrieved values only.
- Historical climate trends and period-vs-period comparison (Open-Meteo
  Archive / ERA5), always labeled as historical analysis, not prediction.
- Agriculture advisory (rule-based + AI copy) and a general Decision
  Support Center (travel, outdoor activity, aviation/marine indicators —
  advisory language only, never a certified operational claim).
- Weather briefings, dark/light/system theme, mobile-first responsive
  layout, `/api/health` diagnostics that actually pings each provider.

## API Routes

See `server.ts` for the full list, including `/api/weather/current|hourly|daily|forecast|air-quality`,
`/api/weather/nwp` and `/api/weather/nwp/compare`, `/api/imd/*`, `/api/alerts`,
`/api/climate/trends`, `/api/chat`, `/api/advisory`, `/api/briefing`, `/api/health`,
`/api/decision-support`, `/api/marine`, `/api/aviation`, `/api/disaster-risk`,
and the WebSocket real-time stream at `/ws/alerts`.

## What was added to reach 100% problem-statement coverage

The base codebase already covered live weather, forecasts, NL chat, IMD/NDMA
alerts, GIS map, multilingual voice, climate trends, and advisory engines.
Three things from the problem statement were genuinely missing — added here:

1. **"A mobile-based conversational AI platform"**
   - The app is now an installable **PWA**: `public/manifest.json` +
     `public/sw.js` + icons — on Android Chrome, "Add to Home Screen" installs
     it full-screen like a native app, works offline for the shell (never
     for live data, per the Zero Fabrication Policy).
   - `capacitor.config.ts` + `npm run cap:add:android` / `cap:sync` /
     `cap:open:android` scaffolds a real installable **Android/iOS APK**
     wrapping this same UI — see "Building the native mobile app" below.

2. **"Scalable architecture supporting real-time data ingestion" / WebSocket**
   - `server/services/realtimeService.ts` adds a WebSocket server at
     `/ws/alerts`. Clients subscribe with a lat/lon; the server polls
     IMD/NDMA on an interval and **pushes only new/changed alerts**
     immediately, instead of every client re-polling REST. Wired into the
     frontend via `src/hooks/useRealtimeAlerts.ts` (triggers a browser
     notification + refresh when a new warning lands).
   - MQTT / WIS2.0: these are broker protocols for ingesting raw
     station/satellite feeds server-side, not for browser push — there is
     no free, credential-free public broker suitable for a demo. A ready
     integration point (commented, with the exact `mqtt` client code) is
     left in `realtimeService.ts` for when a real broker credential is
     available.

3. **Docker / Kubernetes** (named in the suggested tech stack)
   - `Dockerfile` + `docker-compose.yml` — `docker compose up --build`
     runs the whole app in one command.
   - `k8s/deployment.yaml` — Deployment + Service manifest for a
     multi-replica production rollout.

## Round 2 additions — native app, alarm system, DB, specialised systems, evaluation

1. **Real installable Android app** — `android/` is a genuine Capacitor
   native project (already scaffolded and synced in this zip). Open it
   directly in Android Studio (`npm run cap:open:android`) and hit Run/Build
   APK — no extra setup needed beyond pointing `capacitor.config.ts` at your
   deployed backend URL.

2. **Automatic location detection** — on first load, the app now requests
   the OS location permission and centres everything on the person's real
   GPS position (`WeatherContext.tsx` → `useCurrentLocation`, auto-triggered
   once on mount). Uses the Capacitor Geolocation plugin natively, the
   browser Geolocation API on web/PWA. Falls back to manual city search if
   permission is denied.

3. **10-second extreme-weather alarm** — `src/hooks/useAlertAlarm.ts`. When
   the real-time WebSocket stream (`/ws/alerts`) detects a new official
   warning, the app plays a 10-second audible beep (Web Audio oscillator,
   no audio file needed), vibrates the device 4 times (native), and raises
   an OS notification — automatically, without the app needing to be in the
   foreground chat screen. Test it any time from **Settings → Extreme
   Weather Alarm → Test Alarm**.
   - Honesty note on "while the phone is locked/app fully closed": what's
     implemented here fires reliably whenever the app is open (foreground
     or backgrounded but still running, which is how Android keeps most
     recently-used apps by default). A guaranteed wake-from-fully-killed
     alarm needs Firebase Cloud Messaging server-push, which requires your
     own free Firebase project (Google won't let any tool auto-create one
     on your behalf) — ask if you want the FCM wiring added once you have
     that project.

4. **PostgreSQL database** — `server/db.ts` + `docker-compose.yml`'s
   `postgres` service. Logs every chat query (with response time), every
   alert event, and forecast snapshots for accuracy verification (below).
   Fully optional — leave `DATABASE_URL` blank and the app runs exactly as
   before, logging calls just become no-ops.

5. **Aviation specialised system** — `server/services/aviationService.ts`
   derives a standard VFR/MVFR/IFR/LIFR flight category from real retrieved
   visibility + cloud-cover data (same thresholds pilots/ATC use), shown in
   the existing Decision Support → Aviation card. Clearly labeled as a
   derived estimate, not an official METAR/TAF (no free official aviation
   API exists to call).

6. **Marine specialised system** — `server/services/marineService.ts` calls
   Open-Meteo's free Marine Weather API for real wave height, swell, and sea
   surface temperature, replacing the old wind-only guess in the Marine
   decision-support card.

7. **Enhanced flood/cyclone risk scoring** —
   `server/services/disasterRiskService.ts` combines forecasted 48h rainfall
   with ALREADY-FALLEN rainfall over the past 3 days (soil/drainage
   saturation) into a 0–100 heuristic score — the same catchment floods at a
   much lower threshold if it's already wet. Official cyclone/flood
   WARNINGS still come only from the real IMD/NDMA feed; this is a
   clearly-labeled complementary heuristic, shown in the Disaster
   Preparedness card and via `GET /api/disaster-risk`.

8. **Quantitative evaluation harness** (the "Evaluation Parameters" section
   of the problem statement, made runnable):
   - `npm run benchmark` — real p50/p95/p99 **response latency** per
     endpoint (`scripts/benchmarkLatency.ts`).
   - `npm run loadtest` — concurrent **load/stress test** with throughput
     and success-rate reporting (`scripts/loadTest.ts`).
   - `npm run forecast:snapshot` then, a day later, `npm run
     forecast:verify` — **quantitative accuracy** (Mean Absolute Error in
     °C/mm) comparing yesterday's forecast against today's observed
     weather (`scripts/verifyForecastAccuracy.ts`). Requires `DATABASE_URL`
     — accuracy can only be measured after the predicted day actually
     happens, there's no way to produce this number instantly.

## Building the native mobile app

```bash
npm run build                  # build the web app first
npm run cap:add:android        # one-time: scaffolds an android/ project
# edit capacitor.config.ts -> server.url to your deployed backend HTTPS URL
npm run cap:sync
npm run cap:open:android       # opens Android Studio — Build > Build APK
```
(Requires Android Studio / Xcode installed locally — Capacitor wraps the
existing web UI, it doesn't need a UI rewrite.)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in whichever keys you have —
   see the comments in that file for what each one unlocks and what
   happens when it's left blank.
3. `npm run dev` (development, with Vite HMR) or `npm run build && npm start`
   (production build served by Express).

### Or run it with Docker (one command)

```bash
cp .env.example .env      # fill in your keys first
docker compose up --build
```
App is then live at `http://localhost:3000` (WebSocket at `ws://localhost:3000/ws/alerts`).

## Environment Variables

| Variable | Required? | Effect if missing |
|---|---|---|
| `GROQ_API_KEY` | For AI chat/briefings | Falls back to a plain, non-AI summary of the same real data |
| `IMD_API_KEY` / `IMD_AUTH_TOKEN` | Optional | NDMA/Sachet public CAP feed is still used for official warnings |
| `WRF_ENDPOINT_URL` | Optional | WRF page reports "not configured" instead of fabricating data |
| `DATABASE_URL` | Optional | Chat/alert logging + forecast-accuracy harness become no-ops |
| `MQTT_BROKER_URL` / `MQTT_USERNAME` / `MQTT_PASSWORD` | Optional | Only used if you wire in a real MQTT/WIS2.0 source (see `realtimeService.ts`) |
| `APP_URL` | Optional | Used for self-referential links only |

## Limitations

- IMD's `api.imd.gov.in` direct gateway requires an official credential this
  repo does not ship with; without one, official warnings are still sourced
  from the public NDMA/Sachet CAP feed, clearly labeled as such.
- WRF and satellite/radar layers are architecturally stubbed (real service
  interfaces exist) but have no data behind them until a real provider is
  configured — they say so rather than showing fake output.
- NWP comparison currently covers ECMWF and GFS; additional models can be
  added in `nwpService.ts`'s `MODEL_CONFIG` map using any other Open-Meteo
  model ID.

## Future Enhancements

- Real IMD gateway credential once available.
- Push notifications backed by a server-side scheduler (currently
  browser-notification permission only, as specified).
- Satellite/radar overlay once a provider is connected.
