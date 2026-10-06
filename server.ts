import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createHttpServer } from 'http';
import { createServer as createViteServer } from 'vite';

import { searchLocations, reverseGeocode } from './server/services/geocodingService';
import { fetchWeather, fetchAirQuality, WeatherUnavailableError } from './server/services/weatherService';
import { fetchImdAlerts, fetchImdCurrentWeather, fetchImdDistrictWarnings, fetchImdDistrictNowcast } from './server/services/imdService';
import { fetchClimateTrends } from './server/services/climateService';
import { generateAgriAdvisory, generateDecisionSupport } from './server/services/advisoryService';
import { generateChatResponse, generateWeatherBriefing } from './server/services/aiService';
import { fetchNwpModel, compareNwpModels, getWrfStatus } from './server/services/nwpService';
import { attachRealtimeServer } from './server/services/realtimeService';
import { initSchema, logChat, logAlertEvents, isDbEnabled } from './server/db';
import { fetchMarineConditions } from './server/services/marineService';
import { deriveFlightCategory } from './server/services/aviationService';
import { assessFloodCycloneRisk } from './server/services/disasterRiskService';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

function sendWeatherError(res: Response, err: any, fallbackMsg: string) {
  if (err instanceof WeatherUnavailableError) {
    return res.status(503).json({ error: 'Live weather data is currently unavailable.', details: err.message });
  }
  console.error(fallbackMsg, err);
  return res.status(500).json({ error: fallbackMsg, details: err.message });
}


// API Health / diagnostics: never expose secret values, only booleans/status.
app.get('/api/health', async (req: Request, res: Response) => {
  const checkReachable = async (url: string, timeoutMs = 5000): Promise<boolean> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal, method: 'GET' });
      return r.ok || r.status === 400 || r.status === 404; // reachable even if this exact query 400s
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };

  const [openMeteoUp, imdUp, ndmaUp] = await Promise.all([
    checkReachable('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m'),
    checkReachable('https://api.imd.gov.in/api/v1'),
    checkReachable('https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails'),
  ]);

  res.json({
    status: 'ok',
    service: 'WeatherGPT Backend Engine',
    time: new Date().toISOString(),
    providers: {
      openMeteo: openMeteoUp ? 'Available' : 'Unavailable',
      imd: imdUp ? 'Available' : 'Unavailable',
      ndmaSachet: ndmaUp ? 'Available' : 'Unavailable',
      aiEngine: process.env.GROQ_API_KEY ? `Configured (Groq)` : 'Not Configured',
      imdApiKey: process.env.IMD_API_KEY ? 'Configured' : 'Not Configured (Sachet CAP feed still used)',
      wrf: getWrfStatus().status,
      database: isDbEnabled() ? 'Connected (PostgreSQL)' : 'Not Configured (DATABASE_URL unset)',
    }
  });
});

// Location Search: GET /api/location/search?q=Coimbatore
app.get('/api/location/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string) || '';
    if (!q || q.trim().length < 2) {
      return res.json([]);
    }
    const locations = await searchLocations(q);
    res.json(locations);
  } catch (err: any) {
    console.error('Location search endpoint error:', err);
    res.status(500).json({ error: 'Failed to search location', details: err.message });
  }
});

// Location Reverse: GET /api/location/reverse?lat=11.01&lon=76.95
app.get('/api/location/reverse', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid lat and lon query parameters required' });
    }
    const loc = await reverseGeocode(lat, lon);
    res.json(loc);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reverse geocode', details: err.message });
  }
});

// Current Weather: GET /api/weather/current?lat=11.01&lon=76.95&city=Coimbatore
app.get('/api/weather/current', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const city = (req.query.city as string) || (req.query.location as string);
    const weather = await fetchWeather(lat, lon, { city, name: req.query.name as string });
    res.json({
      location: weather.location,
      current: weather.current,
      source: weather.source,
      fetchedAt: weather.fetchedAt
    });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to retrieve current weather');
  }
});

// Full Forecast (Current + Hourly + Daily): GET /api/weather/forecast
app.get('/api/weather/forecast', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const weather = await fetchWeather(lat, lon, {
      city: (req.query.city as string) || (req.query.location as string),
      district: req.query.district as string,
      state: req.query.state as string,
      country: req.query.country as string
    });
    res.json(weather);
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to retrieve forecast');
  }
});

// Hourly Forecast: GET /api/weather/hourly
app.get('/api/weather/hourly', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const weather = await fetchWeather(lat, lon);
    res.json({
      hourly: weather.hourly,
      source: weather.source,
      fetchedAt: weather.fetchedAt
    });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to retrieve hourly forecast');
  }
});

// Daily Forecast: GET /api/weather/daily
app.get('/api/weather/daily', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const weather = await fetchWeather(lat, lon);
    res.json({
      daily: weather.daily,
      source: weather.source,
      fetchedAt: weather.fetchedAt
    });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to retrieve daily forecast');
  }
});

// Air Quality: GET /api/weather/air-quality
app.get('/api/weather/air-quality', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }
    const aq = await fetchAirQuality(lat, lon);
    res.json(aq);
  } catch (err: any) {
    if (err instanceof WeatherUnavailableError) {
      return res.status(503).json({ error: 'Air quality data unavailable.' });
    }
    res.status(500).json({ error: 'Failed to retrieve air quality', details: err.message });
  }
});

// NWP Models: GET /api/weather/nwp?lat=..&lon=..&model=ecmwf|gfs
app.get('/api/weather/nwp', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const model = (req.query.model as string) === 'gfs' ? 'gfs' : 'ecmwf';
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const data = await fetchNwpModel(model, lat, lon);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve NWP model data', details: err.message });
  }
});

// NWP Model Comparison: GET /api/weather/nwp/compare?lat=..&lon=..
app.get('/api/weather/nwp/compare', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const data = await compareNwpModels(lat, lon, req.query.location as string);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to compare NWP models', details: err.message });
  }
});

// WRF Status (architecture-only unless a provider is configured): GET /api/weather/wrf
app.get('/api/weather/wrf', (req: Request, res: Response) => {
  res.json(getWrfStatus());
});

// 6. IMD Current Weather: GET /api/imd/current
app.get('/api/imd/current', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string) || 20.5937;
    const lon = parseFloat(req.query.lon as string) || 78.9629;
    const locationName = (req.query.location as string) || (req.query.city as string) || 'Synoptic Station';
    const stationId = req.query.stationId as string;

    const data = await fetchImdCurrentWeather(lat, lon, locationName, stationId);
    res.json(data);
  } catch (err: any) {
    console.error('IMD current weather endpoint error:', err);
    res.status(500).json({ error: 'Failed to retrieve IMD current weather', details: err.message });
  }
});

// 7. IMD District Warnings: GET /api/imd/warnings
app.get('/api/imd/warnings', async (req: Request, res: Response) => {
  try {
    const district = (req.query.district as string) || (req.query.location as string) || (req.query.city as string) || 'Delhi';
    const state = req.query.state as string;
    const lat = parseFloat(req.query.lat as string) || 28.6139;
    const lon = parseFloat(req.query.lon as string) || 77.2090;

    const warnings = await fetchImdDistrictWarnings(district, state, lat, lon);
    res.json(warnings);
  } catch (err: any) {
    console.error('IMD district warnings endpoint error:', err);
    res.status(500).json({ error: 'Failed to retrieve IMD district warnings', details: err.message });
  }
});

// 8. IMD District Nowcast: GET /api/imd/nowcast
app.get('/api/imd/nowcast', async (req: Request, res: Response) => {
  try {
    const district = (req.query.district as string) || (req.query.location as string) || (req.query.city as string) || 'Delhi';
    const state = req.query.state as string;
    const lat = parseFloat(req.query.lat as string) || 28.6139;
    const lon = parseFloat(req.query.lon as string) || 77.2090;

    const nowcast = await fetchImdDistrictNowcast(district, state, lat, lon);
    res.json(nowcast);
  } catch (err: any) {
    console.error('IMD district nowcast endpoint error:', err);
    res.status(500).json({ error: 'Failed to retrieve IMD district nowcast', details: err.message });
  }
});

// Alerts & IMD bulletins: GET /api/alerts
app.get('/api/alerts', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const locationName = (req.query.location as string) || 'Location';
    const stateName = req.query.state as string;
    const districtName = req.query.district as string;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }

    const imdData = await fetchImdAlerts(lat, lon, locationName, stateName, districtName);
    res.json(imdData);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve alerts', details: err.message });
  }
});

// Nowcast Alerts: GET /api/alerts/nowcast
app.get('/api/alerts/nowcast', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const locationName = (req.query.location as string) || 'Regional Sector';
    const imdData = await fetchImdAlerts(lat, lon, locationName, req.query.state as string, req.query.district as string);

    res.json({
      sector: locationName,
      validNextHours: 3,
      alerts: imdData.activeAlerts,
      bulletinTime: imdData.bulletinTime,
      source: imdData.source,
      status: imdData.activeAlerts.length > 0 ? 'Severe Weather Nowcast Active' : 'Normal Conditions Forecasted'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve nowcast', details: err.message });
  }
});

// Historical Climate Trends: GET /api/climate/trends and GET /api/climate/historical
const handleClimateTrends = async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const startYear = parseInt(req.query.startYear as string, 10) || 2018;
    const endYear = parseInt(req.query.endYear as string, 10) || 2024;
    const city = (req.query.city as string) || (req.query.location as string) || 'Region';

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }

    const trends = await fetchClimateTrends(lat, lon, startYear, endYear, {
      city,
      name: req.query.name as string
    });
    res.json(trends);
  } catch (err: any) {
    console.error('Climate trends error:', err);
    res.status(500).json({ error: 'Failed to retrieve climate analytics', details: err.message });
  }
};

app.get('/api/climate/trends', handleClimateTrends);
app.get('/api/climate/historical', handleClimateTrends);

// Decision Support: GET /api/decision-support
app.get('/api/decision-support', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }
    const weather = await fetchWeather(lat, lon, { city: req.query.city as string });
    const alerts = await fetchImdAlerts(lat, lon, weather.location.city, weather.location.state, weather.location.district);
    const cards = generateDecisionSupport(weather, alerts.activeAlerts);

    // Enrich the Aviation & Marine cards with real specialised data
    // (derived flight category + real wave-height data) instead of the
    // generic wind-only estimate — same card shape, better substance.
    try {
      const visibilityKm = weather.hourly?.[0]?.visibility ?? 10;
      const [marine, aviation] = await Promise.all([
        fetchMarineConditions(lat, lon),
        Promise.resolve(deriveFlightCategory(visibilityKm, weather.current.cloudCover ?? 0, weather.current.windSpeed, weather.current.windDirection)),
      ]);

      const marineCard = cards.find((c: any) => c.category === 'Marine');
      if (marineCard && marine.available) {
        marineCard.currentCondition = `Wave height ${marine.waveHeightM}m, swell ${marine.swellWaveHeightM ?? '—'}m, sea temp ${marine.seaSurfaceTempC ?? '—'}°C`;
        marineCard.recommendation = marine.fishingAdvisory;
        marineCard.statusLevel = marine.riskLevel;
        marineCard.confidence = 'High (Open-Meteo Marine)';
      }

      const aviationCard = cards.find((c: any) => c.category === 'Aviation');
      if (aviationCard) {
        aviationCard.currentCondition = `Flight category: ${aviation.flightCategory} (derived) — Visibility ${aviation.visibilityKm}km, Cloud ${aviation.cloudCoverPercent}%`;
        aviationCard.recommendation = `${aviation.crosswindNote} [Derived estimate, not an official METAR/TAF]`;
        aviationCard.statusLevel = aviation.flightCategory === 'LIFR' || aviation.flightCategory === 'IFR' ? 'Adverse' : aviation.flightCategory === 'MVFR' ? 'Caution' : 'Favorable';
      }

      const rain48h = (weather.daily?.[0]?.precipitationSum ?? 0) + (weather.daily?.[1]?.precipitationSum ?? 0);
      const maxGust = Math.max(weather.daily?.[0]?.windGustsMax ?? 0, weather.daily?.[1]?.windGustsMax ?? 0);
      const mentionsCyclone = (alerts.activeAlerts || []).some((a: any) => (a.event || a.type || '').toLowerCase().includes('cyclone'));
      const risk = await assessFloodCycloneRisk(lat, lon, rain48h, maxGust, mentionsCyclone);

      const disasterCard = cards.find((c: any) => c.category === 'Disaster Preparedness');
      if (disasterCard) {
        disasterCard.forecast = `Flood risk score: ${risk.floodRiskScore}/100 (${risk.floodRiskLevel}, heuristic). ${risk.reasoning}`;
        if (risk.cycloneWatch) disasterCard.relevantWarnings.push('Cyclone-force gusts possible');
        if (risk.floodRiskLevel === 'Extreme' || risk.floodRiskLevel === 'High') disasterCard.statusLevel = 'Severe';
      }
    } catch (enrichErr) {
      console.warn('Marine/Aviation enrichment failed (non-fatal, generic cards kept):', enrichErr);
    }

    res.json(cards);
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to generate decision support');
  }
});

// Marine specialised conditions: GET /api/marine?lat=&lon=
app.get('/api/marine', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }
    const marine = await fetchMarineConditions(lat, lon);
    res.json(marine);
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to fetch marine conditions');
  }
});

// Aviation specialised briefing: GET /api/aviation?lat=&lon=
app.get('/api/aviation', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }
    const weather = await fetchWeather(lat, lon, { city: req.query.city as string });
    const visibilityKm = weather.hourly?.[0]?.visibility ?? 10;
    const cloudCover = weather.current.cloudCover ?? 0;
    const briefing = deriveFlightCategory(visibilityKm, cloudCover, weather.current.windSpeed, weather.current.windDirection);
    res.json({ location: weather.location, ...briefing });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to generate aviation briefing');
  }
});

// Specialised flood/cyclone risk: GET /api/disaster-risk?lat=&lon=
app.get('/api/disaster-risk', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid coordinates required' });
    }
    const weather = await fetchWeather(lat, lon, { city: req.query.city as string });
    const alerts = await fetchImdAlerts(lat, lon, weather.location.city, weather.location.state, weather.location.district);
    const rain48h = (weather.daily?.[0]?.precipitationSum ?? 0) + (weather.daily?.[1]?.precipitationSum ?? 0);
    const maxGust = Math.max(weather.daily?.[0]?.windGustsMax ?? 0, weather.daily?.[1]?.windGustsMax ?? 0);
    const mentionsCyclone = (alerts.activeAlerts || []).some((a: any) => (a.event || a.type || '').toLowerCase().includes('cyclone'));
    const assessment = await assessFloodCycloneRisk(lat, lon, rain48h, maxGust, mentionsCyclone);
    res.json({ location: weather.location, officialAlerts: alerts.activeAlerts, ...assessment });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to assess flood/cyclone risk');
  }
});

// Agricultural Advisory: POST /api/advisory
app.post('/api/advisory', async (req: Request, res: Response) => {
  try {
    const { crop, cropStage, location, lat, lon, language } = req.body;
    if (!lat || !lon) {
      return res.status(400).json({ error: 'Location coordinates required' });
    }
    const weather = await fetchWeather(Number(lat), Number(lon), { city: location });
    let activeAlerts: any[] = [];
    try {
      const imdData = await fetchImdAlerts(
        Number(lat),
        Number(lon),
        location || weather.location.city,
        weather.location.state,
        weather.location.district
      );
      activeAlerts = imdData.activeAlerts || [];
    } catch (alertErr) {
      console.warn('Could not retrieve alerts for advisory:', alertErr);
    }

    const advisory = await generateAgriAdvisory(
      {
        crop: crop || 'General Crop',
        cropStage: cropStage || 'Vegetative',
        location: location || weather.location.city,
        lat: Number(lat),
        lon: Number(lon),
        language
      },
      weather,
      activeAlerts
    );
    res.json(advisory);
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to generate advisory');
  }
});

// Weather Briefing: POST /api/briefing
app.post('/api/briefing', async (req: Request, res: Response) => {
  try {
    const { lat, lon, location, language } = req.body;
    if (!lat || !lon) {
      return res.status(400).json({ error: 'Coordinates required' });
    }
    const weather = await fetchWeather(Number(lat), Number(lon), { city: location });
    const briefing = await generateWeatherBriefing(weather, language);
    res.json({
      briefing,
      location: weather.location,
      generatedAt: new Date().toISOString(),
      source: 'WeatherGPT Operational Meteorological Briefing Engine'
    });
  } catch (err: any) {
    return sendWeatherError(res, err, 'Failed to generate weather briefing');
  }
});

// Helper to extract candidate location mention from user queries
function extractCandidateCity(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length <= 30 && !/\b(what|why|how|when|where|is|will|are|can|could|give|tell|summary|forecast|weather|rain|temperature|pesticide|crop|alert|safety)\b/i.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\b(?:in|at|for|near|around)\s+([A-Za-z\u0900-\u0DFF]{3,25}(?:\s+[A-Za-z\u0900-\u0DFF]{3,20})?)/i);
  if (match && match[1]) {
    const candidate = match[1].trim();
    if (!/\b(today|tomorrow|yesterday|morning|evening|night|afternoon|week|weekend|my area|current location|india)\b/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Chatbot: POST /api/chat
app.post('/api/chat', async (req: Request, res: Response) => {
  const chatStartedAt = Date.now();
  try {
    const { message, lat, lon, location, language, history } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message string is required' });
    }

    let queryLat = Number(lat);
    let queryLon = Number(lon);
    let locationName = location || 'Current Location';

    // If the user's message mentions a specific city (e.g. "in Delhi", "for Mumbai", "Chennai")
    // geocode that specific candidate rather than the entire conversational text
    const candidateCity = extractCandidateCity(message);
    if (candidateCity) {
      try {
        const cityMatches = await searchLocations(candidateCity);
        if (cityMatches && cityMatches.length > 0) {
          queryLat = cityMatches[0].latitude;
          queryLon = cityMatches[0].longitude;
          locationName = cityMatches[0].name;
        }
      } catch (geoErr) {
        console.warn('City candidate geocoding failed (non-fatal):', geoErr);
      }
    }

    // Default to Coimbatore if coordinates are missing/invalid
    if (isNaN(queryLat) || isNaN(queryLon)) {
      queryLat = 11.0168;
      queryLon = 76.9558;
      locationName = 'Coimbatore, Tamil Nadu, India';
    }

    // Retrieve real weather data. Per the Zero Fabrication Policy, if live weather
    // cannot be retrieved we do NOT invent numbers for Gemini to talk about -
    // we tell the user plainly that live data is unavailable.
    let weather: any;
    try {
      weather = await fetchWeather(queryLat, queryLon, { city: locationName });
    } catch (wErr: any) {
      console.warn('fetchWeather error in chat:', wErr.message || wErr);
      return res.json({
        response: 'Live weather data is currently unavailable, so I cannot answer that accurately right now. Please try again in a moment.',
        source: 'WeatherGPT (Live data unavailable)',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }

    let activeAlerts: any[] = [];
    try {
      const imdData = await fetchImdAlerts(queryLat, queryLon, weather.location.city, weather.location.state, weather.location.district);
      activeAlerts = imdData.activeAlerts || [];
    } catch (imdErr) {
      console.warn('IMD alerts fetch in chat failed (non-fatal):', imdErr);
    }

    const result = await generateChatResponse({
      userMessage: message,
      weatherData: weather,
      alerts: activeAlerts,
      language: language || 'en',
      history
    });

    // Persist for the analytics/evaluation harness (no-op if no DATABASE_URL).
    logChat({
      message, language: language || 'en', lat: queryLat, lon: queryLon,
      responseMs: Date.now() - chatStartedAt, usedAi: !!result.source?.toLowerCase().includes('groq'),
    });
    if (activeAlerts.length > 0) {
      logAlertEvents(queryLat, queryLon, weather.location.city, activeAlerts);
    }

    res.json({
      ...result,
      detectedLocation: weather.location,
      weatherSnippet: {
        temp: weather.current.temperature,
        condition: weather.current.weatherCondition,
        rainProb: weather.daily[0]?.precipitationProbabilityMax ?? 0,
        tomorrowRainProb: weather.daily[1]?.precipitationProbabilityMax ?? 0
      }
    });
  } catch (err: any) {
    console.error('Chat error:', err);
    // Zero Fabrication Policy: never claim to know current conditions when we don't.
    res.json({
      response: 'I ran into a problem reaching live weather services just now, so I cannot give you an accurate answer. Please try again in a moment.',
      source: 'WeatherGPT (Service error)',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  }
});

// Vite middleware & Static serving
async function startServer() {
  await initSchema(); // no-op if DATABASE_URL isn't set

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = createHttpServer(app);
  attachRealtimeServer(httpServer);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`WeatherGPT server running on http://0.0.0.0:${PORT}`);
    console.log(`Real-time alert stream: ws://0.0.0.0:${PORT}/ws/alerts`);
  });
}

startServer();
