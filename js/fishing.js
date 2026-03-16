/**
 * Fishing guide — weather-aware bait/lure/technique recommendations.
 * Uses Open-Meteo API (free, no key) for current weather conditions.
 * Includes detailed lure specs: weight, size, color, rigging.
 */

import { distanceMiles } from './api.js';

function fetchWithTimeout(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

// ===== Weather via Open-Meteo =====

let weatherCache = null;
const WEATHER_TTL = 30 * 60 * 1000; // 30 min

async function fetchWeather(lat, lon) {
  if (weatherCache &&
    Math.abs(weatherCache.lat - lat) < 0.1 &&
    Math.abs(weatherCache.lon - lon) < 0.1 &&
    Date.now() - weatherCache.timestamp < WEATHER_TTL) {
    return weatherCache.data;
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation', 'rain', 'weather_code', 'cloud_cover',
      'pressure_msl', 'surface_pressure', 'wind_speed_10m',
      'wind_direction_10m', 'wind_gusts_10m',
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/New_York',
  });

  const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`, 10000);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);

  const json = await res.json();
  const c = json.current;

  const weather = {
    temp: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precipitation: c.precipitation,
    cloudCover: c.cloud_cover,
    pressureMsl: c.pressure_msl,
    surfacePressure: c.surface_pressure,
    windSpeed: c.wind_speed_10m,
    windGusts: c.wind_gusts_10m,
    windDir: c.wind_direction_10m,
    weatherCode: c.weather_code,
    time: c.time,
  };

  weather.pressureTrend = getPressureTrend(weather.pressureMsl);
  weather.conditions = describeWeatherCode(weather.weatherCode);
  weather.fishActivity = rateFishActivity(weather);

  weatherCache = { lat, lon, data: weather, timestamp: Date.now() };
  return weather;
}

function describeWeatherCode(code) {
  const codes = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
  };
  return codes[code] || 'Unknown';
}

function getPressureTrend(msl) {
  if (msl > 1025) return 'high';
  if (msl > 1018) return 'rising';
  if (msl > 1010) return 'stable';
  if (msl > 1003) return 'falling';
  return 'low';
}

function rateFishActivity(w) {
  // Base 40, max realistic ~85, bad days ~20-35
  let score = 40;

  // Barometric pressure — falling is best (pre-front feeding), stable is OK
  if (w.pressureTrend === 'falling') score += 18;
  else if (w.pressureTrend === 'stable') score += 8;
  else if (w.pressureTrend === 'rising') score -= 12; // post-front = toughest fishing
  else if (w.pressureTrend === 'high') score -= 10; // bluebird post-front
  else score -= 8; // low

  // Cloud cover — overcast is best for most species
  if (w.cloudCover > 80) score += 12;
  else if (w.cloudCover > 50) score += 6;
  else if (w.cloudCover > 25) score += 0;
  else score -= 8; // bright bluebird

  // Wind — light to moderate best
  if (w.windSpeed >= 5 && w.windSpeed <= 12) score += 7;
  else if (w.windSpeed > 12 && w.windSpeed <= 20) score += 2;
  else if (w.windSpeed > 20) score -= 12;
  else if (w.windSpeed < 3) score -= 4; // dead calm = tough

  // Precipitation
  if (w.precipitation > 0 && w.precipitation < 0.08) score += 8; // light rain
  else if (w.precipitation >= 0.08 && w.precipitation < 0.2) score += 2;
  else if (w.precipitation >= 0.3) score -= 8; // downpour

  // Temperature sweet spot
  if (w.temp >= 60 && w.temp <= 75) score += 8;
  else if (w.temp >= 50 && w.temp <= 85) score += 3;
  else if (w.temp < 38) score -= 15;
  else if (w.temp > 95) score -= 12;
  else score -= 5;

  // Time of day bonus
  const hour = new Date().getHours();
  if ((hour >= 5 && hour <= 9) || (hour >= 17 && hour <= 21)) score += 6;
  else if (hour >= 11 && hour <= 14) score -= 4;

  // Moon phase influence
  const moon = getMoonPhase();
  if (moon.name === 'New Moon' || moon.name === 'Full Moon') score += 5;
  else if (moon.name === 'First Quarter' || moon.name === 'Last Quarter') score -= 2;

  // Thunderstorms — bad + dangerous
  if (w.weatherCode >= 95) score -= 20;

  return Math.max(5, Math.min(95, score));
}

// ===== Moon Phase =====

function getMoonPhase(date) {
  const d = date ? new Date(date) : new Date();
  // Compute days since known new moon (Jan 6, 2000 18:14 UTC)
  const knownNew = new Date('2000-01-06T18:14:00Z');
  const diffDays = (d - knownNew) / (1000 * 60 * 60 * 24);
  const lunarCycle = 29.53059;
  const phase = ((diffDays % lunarCycle) + lunarCycle) % lunarCycle;
  const pct = Math.round((phase / lunarCycle) * 100);
  const illumination = Math.round(50 - 50 * Math.cos(2 * Math.PI * phase / lunarCycle));

  let name, emoji;
  if (phase < 1.85)       { name = 'New Moon';        emoji = '\u{1F311}'; }
  else if (phase < 7.38)  { name = 'Waxing Crescent'; emoji = '\u{1F312}'; }
  else if (phase < 9.23)  { name = 'First Quarter';   emoji = '\u{1F313}'; }
  else if (phase < 14.77) { name = 'Waxing Gibbous';  emoji = '\u{1F314}'; }
  else if (phase < 16.61) { name = 'Full Moon';        emoji = '\u{1F315}'; }
  else if (phase < 22.15) { name = 'Waning Gibbous';  emoji = '\u{1F316}'; }
  else if (phase < 24.00) { name = 'Last Quarter';    emoji = '\u{1F317}'; }
  else                     { name = 'Waning Crescent'; emoji = '\u{1F318}'; }

  return { name, emoji, illumination, dayInCycle: Math.round(phase * 10) / 10 };
}


// ===== Best Fishing Times =====

function getBestFishingTimes(weather, date) {
  const moon = getMoonPhase(date);
  const isOvercast = weather.cloudCover > 65;
  const isRainy = weather.precipitation > 0.02;
  const isNewOrFull = moon.name === 'New Moon' || moon.name === 'Full Moon';

  // Rate each hour 5AM - 9PM based on proven factors
  const hours = [];
  for (let h = 5; h <= 21; h++) {
    let score = 30;

    // Dawn/dusk golden hours — the most reliable fishing pattern
    if (h >= 5 && h <= 7) score += 25;       // prime dawn
    else if (h >= 6 && h <= 9) score += 18;   // early morning
    else if (h >= 17 && h <= 19) score += 22;  // prime dusk
    else if (h >= 19 && h <= 21) score += 15;  // late evening
    else if (h >= 11 && h <= 14) score -= 10;  // midday slump

    // Overcast skies extend the bite window through midday
    if (isOvercast && h >= 10 && h <= 15) score += 12;

    // Light rain boosts action anytime
    if (isRainy) score += 5;

    // New/full moon = generally more active feeding overall
    if (isNewOrFull) score += 4;

    hours.push({
      hour: h,
      label: formatHour(h),
      score: Math.max(5, Math.min(95, score)),
    });
  }

  // Find the best windows
  const sorted = [...hours].sort((a, b) => b.score - a.score);
  const bestWindow = sorted[0];
  const secondBest = sorted.find(h => Math.abs(h.hour - bestWindow.hour) > 2) || sorted[1];

  return {
    hours,
    bestWindow,
    secondBest,
    moon,
  };
}

function formatHour(h) {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h > 12 ? `${h - 12} PM` : `${h} AM`;
}

function getBestTimesHtml(times) {
  const maxScore = Math.max(...times.hours.map(h => h.score));

  return `
    <div class="detail-section">
      <h3>Best Times to Fish Today</h3>
      <div class="best-times-summary">
        <span class="best-time-badge best">Best: ${times.bestWindow.label}</span>
        ${times.secondBest ? `<span class="best-time-badge good">Also good: ${times.secondBest.label}</span>` : ''}
      </div>
      <div class="times-chart">
        ${times.hours.map(h => {
          const pct = Math.round((h.score / maxScore) * 100);
          const color = h.score >= 65 ? '#2ecc71' : h.score >= 45 ? '#f39c12' : '#e74c3c';
          return `<div class="times-bar-col">
            <div class="times-bar" style="height:${pct}%;background:${color};" title="${h.label}: ${h.score}/100"></div>
            <span class="times-label">${h.hour % 12 || 12}${h.hour >= 12 ? 'p' : 'a'}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="solunar-info">
        <span class="solunar-badge">${times.moon.emoji} ${times.moon.name}</span>
        <span class="solunar-item">Dawn &amp; dusk are peak feeding windows</span>
      </div>
    </div>
  `;
}


// ===== Tidal Detection & NOAA Tides =====

// VA/NC NOAA tide stations — hardcoded for the region
const TIDE_STATIONS = [
  // James River (tidal from Richmond to Hampton Roads)
  { id: '8638610', name: 'Sewells Point', lat: 36.9467, lon: -76.3300 },
  { id: '8638511', name: 'Dominion Terminal', lat: 36.9600, lon: -76.4200 },
  { id: '8638595', name: 'Newport News', lat: 36.9467, lon: -76.4267 },
  { id: '8637611', name: 'Jamaica Island (James R)', lat: 37.2050, lon: -76.7717 },
  { id: '8637689', name: 'Yorktown USCG', lat: 37.2267, lon: -76.4783 },
  { id: '8638424', name: 'Kingsmill (James R)', lat: 37.2233, lon: -76.6617 },
  { id: '8638489', name: 'Jamestown (James R)', lat: 37.2083, lon: -76.7750 },
  { id: '8638614', name: 'Willoughby Bay', lat: 36.9583, lon: -76.3150 },
  { id: '8637542', name: 'Hopewell (James R)', lat: 37.3067, lon: -77.2883 },
  { id: '8638660', name: 'Richmond Locks (James R)', lat: 37.5233, lon: -77.4233 },
  // Chesapeake Bay
  { id: '8638863', name: 'Chesapeake Bay Bridge Tunnel', lat: 36.9667, lon: -76.1133 },
  { id: '8632200', name: 'Kiptopeke', lat: 37.1667, lon: -75.9883 },
  { id: '8635750', name: 'Lewisetta', lat: 37.9950, lon: -76.4633 },
  { id: '8636580', name: 'Windmill Point', lat: 37.6150, lon: -76.2900 },
  { id: '8637624', name: 'Gloucester Point', lat: 37.2467, lon: -76.5000 },
  // York River
  { id: '8637610', name: 'West Point (York R)', lat: 37.5317, lon: -76.7950 },
  // Rappahannock River
  { id: '8635985', name: 'Tappahannock', lat: 37.9267, lon: -76.8567 },
  // Hampton Roads / Norfolk area
  { id: '8639348', name: 'Money Point', lat: 36.7767, lon: -76.3017 },
  // Eastern Shore
  { id: '8631044', name: 'Wachapreague', lat: 37.6078, lon: -75.6858 },
  // NC Outer Banks & Coast
  { id: '8652587', name: 'Oregon Inlet', lat: 35.7956, lon: -75.5481 },
  { id: '8656483', name: 'Beaufort, NC', lat: 34.7200, lon: -76.6700 },
  { id: '8658120', name: 'Wilmington, NC', lat: 34.2267, lon: -77.9533 },
  { id: '8654467', name: 'Hatteras, NC', lat: 35.2094, lon: -75.6903 },
  // NC Rivers
  { id: '8651370', name: 'Duck, NC', lat: 36.1833, lon: -75.7467 },
  { id: '8653365', name: 'Manns Harbor, NC', lat: 35.9083, lon: -75.8950 },
];

function isTidalWater(lat, lon, waterType) {
  // Only rivers, streams, boat landings, and fishing piers can be tidal
  // Lakes and ponds in tidal areas are not themselves tidal
  if (waterType === 'pond' || waterType === 'lake') return false;

  // Out of VA/NC range
  if (lat < 33.5 || lat > 39) return false;

  // East of the fall line = tidal influence zone
  // VA fall line: Richmond area (~-77.5), but James River is tidal TO Richmond
  // NC fall line: further west (~-78.9)
  // Use the same geographic splits as brackish species detection:
  // - Eastern VA/NC: lon > -78 (matches species logic)
  // - Coastal/brackish: lon > -76.5
  // The James River is tidal all the way to Richmond (~-77.44)
  const inVA = lat >= 36.54;
  const fallLine = inVA ? -77.5 : -79.0; // VA: James tidal to Richmond; NC: wider tidal zone
  if (lon < fallLine) return false;

  // Must be within reasonable distance of a tide station
  // With stations now along the James, York, Rappahannock — 60 miles covers the tidal rivers
  const nearest = findNearestTideStation(lat, lon);
  return nearest && nearest.dist < 60;
}

function findNearestTideStation(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const s of TIDE_STATIONS) {
    const dist = distanceMiles(lat, lon, s.lat, s.lon);
    if (dist < bestDist) { bestDist = dist; best = { ...s, dist }; }
  }
  return best;
}

async function fetchTidePredictions(stationId, date) {
  const d = date ? new Date(date + 'T00:00:00') : new Date();
  const beginDate = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  // Fetch 24 hours of predictions
  const endD = new Date(d);
  endD.setDate(endD.getDate() + 1);
  const endDate = `${endD.getFullYear()}${String(endD.getMonth()+1).padStart(2,'0')}${String(endD.getDate()).padStart(2,'0')}`;

  const params = new URLSearchParams({
    product: 'predictions',
    datum: 'MLLW',
    time_zone: 'lst_ldt',
    units: 'english',
    format: 'json',
    station: stationId,
    begin_date: beginDate,
    end_date: endDate,
    interval: '6', // every 6 minutes for smooth chart
  });

  const res = await fetchWithTimeout(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`, 10000);
  if (!res.ok) throw new Error(`NOAA API error: ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);

  const predictions = (json.predictions || []).map(p => ({
    time: p.t,
    height: parseFloat(p.v),
  }));

  // Find highs and lows
  const highsLows = findHighsLows(predictions);

  return { predictions, highsLows, stationId };
}

function findHighsLows(predictions) {
  const results = [];
  for (let i = 1; i < predictions.length - 1; i++) {
    const prev = predictions[i - 1].height;
    const curr = predictions[i].height;
    const next = predictions[i + 1].height;
    if (curr > prev && curr > next) {
      results.push({ type: 'high', time: predictions[i].time, height: curr });
    } else if (curr < prev && curr < next) {
      results.push({ type: 'low', time: predictions[i].time, height: curr });
    }
  }
  return results;
}

function getTideHtml(tideData, stationName) {
  const { predictions, highsLows } = tideData;
  if (!predictions.length) return '';

  // Next high and low from now
  const now = new Date();
  const upcoming = highsLows.filter(hl => new Date(hl.time.replace(' ', 'T')) > now);
  const nextHigh = upcoming.find(hl => hl.type === 'high');
  const nextLow = upcoming.find(hl => hl.type === 'low');

  // Build SVG chart — 24 hours of tide data
  const minH = Math.min(...predictions.map(p => p.height));
  const maxH = Math.max(...predictions.map(p => p.height));
  const range = maxH - minH || 1;
  const chartW = 300;
  const chartH = 80;
  const padY = 5;

  const points = predictions.map((p, i) => {
    const x = (i / (predictions.length - 1)) * chartW;
    const y = padY + (chartH - 2 * padY) * (1 - (p.height - minH) / range);
    return `${x},${y}`;
  }).join(' ');

  // Current time marker
  const firstTime = new Date(predictions[0].time.replace(' ', 'T'));
  const lastTime = new Date(predictions[predictions.length - 1].time.replace(' ', 'T'));
  const nowPct = Math.max(0, Math.min(1, (now - firstTime) / (lastTime - firstTime)));
  const nowX = nowPct * chartW;

  // High/low markers on chart
  const markers = highsLows.map(hl => {
    const t = new Date(hl.time.replace(' ', 'T'));
    const pct = (t - firstTime) / (lastTime - firstTime);
    if (pct < 0 || pct > 1) return '';
    const x = pct * chartW;
    const idx = Math.round(pct * (predictions.length - 1));
    const y = padY + (chartH - 2 * padY) * (1 - (predictions[idx]?.height - minH) / range);
    const color = hl.type === 'high' ? '#3498db' : '#e67e22';
    return `<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
  }).join('');

  const formatTideTime = (t) => {
    const d = new Date(t.replace(' ', 'T'));
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  return `
    <div class="detail-section">
      <h3>Tides — ${stationName}</h3>
      <div class="tide-next">
        ${nextHigh ? `<div class="tide-next-item">
          <span class="tide-type high-tide">Next High</span>
          <span class="tide-time">${formatTideTime(nextHigh.time)}</span>
          <span class="tide-height">${nextHigh.height.toFixed(1)} ft</span>
        </div>` : ''}
        ${nextLow ? `<div class="tide-next-item">
          <span class="tide-type low-tide">Next Low</span>
          <span class="tide-time">${formatTideTime(nextLow.time)}</span>
          <span class="tide-height">${nextLow.height.toFixed(1)} ft</span>
        </div>` : ''}
      </div>
      <div class="tide-chart-wrap">
        <svg class="tide-chart" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none">
          <polyline points="${points}" fill="none" stroke="#3498db" stroke-width="2" stroke-linejoin="round"/>
          <polygon points="0,${chartH} ${points} ${chartW},${chartH}" fill="rgba(52,152,219,0.12)"/>
          <line x1="${nowX}" y1="0" x2="${nowX}" y2="${chartH}" stroke="#e74c3c" stroke-width="1.5" stroke-dasharray="3 3"/>
          ${markers}
        </svg>
        <div class="tide-chart-labels">
          <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
        </div>
      </div>
      <div class="tide-all-times">
        ${highsLows.map(hl => `
          <span class="tide-hl-badge ${hl.type === 'high' ? 'high-tide' : 'low-tide'}">
            ${hl.type === 'high' ? 'H' : 'L'} ${formatTideTime(hl.time)} (${hl.height.toFixed(1)}ft)
          </span>
        `).join('')}
      </div>
    </div>
  `;
}


// ===== Detailed Lure Database =====
// Each lure: { name, weight, size, colors:{clear,stained,muddy}, rig, retrieve, hookSize? }
// Colors keyed by water clarity for weather-aware color picks

const LURE_DB = {
  // === JERKBAITS ===
  'Jerkbait': {
    weight: '3/8–5/8 oz',
    size: '3.5–5.5"',
    colors: {
      clear: ['Ghost Minnow', 'Sexy Shad', 'Chrome/Blue', 'Natural Perch'],
      stained: ['Clown', 'Table Rock Shad', 'Chartreuse/Blue', 'Firetiger'],
      muddy: ['Chartreuse/Black', 'Firetiger', 'Gold/Black', 'Bright Clown'],
    },
    rig: 'Tie direct to 8-10lb fluorocarbon. Use snap for more action. Treble hooks stock.',
    retrieve: 'Jerk-jerk-pause cadence. Cold water = longer pauses (5-15 sec). Warm = shorter (1-3 sec).',
  },
  'Suspending Minnow': {
    weight: '1/4–3/8 oz',
    size: '3–4.5"',
    colors: {
      clear: ['Silver/Black', 'Ghost Shad', 'Rainbow Trout'],
      stained: ['Gold/Black', 'Chartreuse Shad', 'Firetiger'],
      muddy: ['Chartreuse/Orange', 'Gold/Black', 'Bright Perch'],
    },
    rig: 'Tie direct to 6-8lb fluorocarbon. Can add suspend dots to fine-tune buoyancy.',
    retrieve: 'Twitch-twitch-pause. Let it sit motionless in the strike zone. Dead stick in cold water.',
  },

  // === SOFT PLASTICS ===
  'Ned Rig': {
    weight: '1/16–3/16 oz (mushroom head jig)',
    size: '2.75–3.5" stick bait (Z-Man TRD, Finesse TRD)',
    colors: {
      clear: ['Green Pumpkin', 'Bama Bug', 'Coppertreuse', 'Smokin Smoke'],
      stained: ['Green Pumpkin/Orange', 'PB&J', 'Mud Minnow', 'Coppertreuse'],
      muddy: ['Black/Blue', 'Junebug', 'Electric Chicken', 'Chartreuse'],
    },
    rig: 'Thread onto mushroom head jig (1/10-3/16oz). Exposed hook. Light spinning tackle, 6-8lb fluoro or braid to fluoro leader.',
    retrieve: 'Drag slowly on bottom with small hops. Shake in place. Dead stick on drop. Less is more.',
  },
  'Soft Plastic Worm': {
    weight: '1/8–1/2 oz (depending on rig)',
    size: '6–10" (Senko, Ribbontail, Trick Worm)',
    colors: {
      clear: ['Green Pumpkin', 'Watermelon Red Flake', 'Morning Dawn', 'Smoke'],
      stained: ['Green Pumpkin/Purple', 'Junebug', 'Plum', 'Red Shad'],
      muddy: ['Black/Blue', 'Junebug', 'Black Grape', 'Dark Watermelon'],
    },
    rig: 'Texas Rig: 3/0-5/0 EWG hook, bullet weight (peg in brush). Wacky Rig: hook through middle of 5" Senko, no weight.',
    retrieve: 'Texas: hop & drag bottom. Wacky: cast, let sink on slack line — watch for line jump. Shake gently.',
  },
  'Plastic Worm (Texas Rig)': {
    weight: '1/8–1/2 oz bullet weight',
    size: '7–10" ribbon tail or straight worm',
    colors: {
      clear: ['Green Pumpkin', 'Watermelon Candy', 'Redbug'],
      stained: ['Junebug', 'Plum', 'Green Pumpkin/Chartreuse Tail'],
      muddy: ['Black/Blue', 'Junebug', 'Black Grape'],
    },
    rig: '3/0-5/0 EWG offset hook. Slide bullet weight on line first, then tie hook. Peg weight in heavy cover. 15-20lb fluoro.',
    retrieve: 'Cast to cover, let sink to bottom. Slow drag with rod tip, reel slack. Hop gently over structure.',
  },
  'Drop Shot': {
    weight: '1/8–3/8 oz drop shot weight (cylinder or tear)',
    size: '3–5" finesse worm, minnow, or craw',
    colors: {
      clear: ['Morning Dawn', 'Smoke Shad', 'Green Pumpkin', 'Aaron\'s Magic'],
      stained: ['Green Pumpkin/Purple', 'Bold Bluegill', 'Oxblood'],
      muddy: ['Black/Blue', 'Junebug', 'PB&J'],
    },
    rig: '#1-1/0 drop shot hook, tied 12-18" above weight with Palomar knot (tag end down to weight). Nose hook the bait.',
    retrieve: 'Lower to bottom. Shake rod tip in place — keep weight still, bait dances. Slowly drag to cover new ground.',
  },
  'Finesse Worm': {
    weight: '1/8–1/4 oz shaky head or drop shot',
    size: '4–6" straight or ribbon tail',
    colors: {
      clear: ['Green Pumpkin', 'Smoke', 'Morning Dawn'],
      stained: ['Plum', 'PB&J', 'Green Pumpkin/Orange'],
      muddy: ['Black/Blue', 'Junebug', 'Dark Grape'],
    },
    rig: 'Shaky Head: thread onto jig head, 1/8-1/4oz. Or nose-hook on drop shot. 6-10lb fluorocarbon spinning gear.',
    retrieve: 'Shaky Head: drag bottom, shake in place at structure. Let it stand up on bottom. Subtle movements.',
  },
  'Tube Bait': {
    weight: '1/8–3/8 oz internal tube jig head',
    size: '3–4" tube',
    colors: {
      clear: ['Green Pumpkin', 'Smoke', 'Watermelon', 'Brown Craw'],
      stained: ['Green Pumpkin/Orange', 'PB&J', 'Brown/Orange'],
      muddy: ['Black/Blue', 'Brown/Black', 'Peanut Butter & Jelly'],
    },
    rig: 'Insert tube jig head (1/8-3/8oz) inside tube body, hook point exits top. Or Texas rig with bullet weight.',
    retrieve: 'Hop along rocky bottom, let it spiral on the fall. Drag & pause near smallmouth structure.',
  },
  'Tube Jig': {
    weight: '1/8–3/8 oz',
    size: '3–4"',
    colors: {
      clear: ['Smoke', 'Green Pumpkin', 'Watermelon Seed'],
      stained: ['Green Pumpkin/Orange', 'Brown Craw'],
      muddy: ['Black/Blue', 'Dark Craw'],
    },
    rig: 'Internal jig head inserted into tube. 1/0-3/0 hook. 6-10lb fluorocarbon.',
    retrieve: 'Hop and drag along rocky bottom. Let spiral down on slack line. Smallmouth love the erratic fall.',
  },
  'Grub': {
    weight: '1/8–1/4 oz jig head',
    size: '2–4" curly tail grub',
    colors: {
      clear: ['Smoke/Silver Flake', 'Pearl White', 'Chartreuse/White'],
      stained: ['Chartreuse/White', 'Pumpkinseed', 'Motor Oil'],
      muddy: ['Chartreuse', 'White', 'Chartreuse/Black'],
    },
    rig: 'Thread onto round jig head, 1/8-1/4oz. Match hook size to grub (1/0-2/0 for 3-4").',
    retrieve: 'Steady slow retrieve with occasional pause. Or hop along bottom. Tail action does the work.',
  },
  'Swimbait': {
    weight: '1/4–1 oz (jig head or weighted hook)',
    size: '3.5–6" paddle tail or boot tail',
    colors: {
      clear: ['Hitch', 'Bluegill', 'Gizzard Shad', 'Ayu'],
      stained: ['Chartreuse Shad', 'Bluegill Flash', 'Sexy Shad'],
      muddy: ['Chartreuse/White', 'White Pearl', 'Gold/Black'],
    },
    rig: 'Weighted swimbait hook (3/0-5/0) for weedless. Or open jig head for open water. 12-17lb fluoro or braid.',
    retrieve: 'Steady retrieve at target depth. Vary speed until you find it. Bump structure. Slow roll deep.',
  },

  // === HARD BAITS ===
  'Crankbait': {
    weight: '1/4–3/4 oz',
    size: '2–4" (shallow to deep depending on lip)',
    colors: {
      clear: ['Sexy Shad', 'Ghost Minnow', 'Natural Crawfish', 'Chartreuse/Blue'],
      stained: ['Firetiger', 'Chartreuse/Black', 'Red Crawfish', 'Citrus Shad'],
      muddy: ['Chartreuse/Muddy', 'Red/Orange Craw', 'Firetiger', 'Bright Chartreuse'],
    },
    rig: 'Tie direct to 10-15lb fluorocarbon (controls depth). Medium action rod. Do NOT use a snap — reduces wobble.',
    retrieve: 'Steady retrieve, deflect off cover ("the ricochet"). Stop-and-go near structure. Match lip depth to target zone.',
  },
  'Deep Diving Crankbait': {
    weight: '1/2–1 oz',
    size: '2.5–4" with large bill (dives 10-20ft+)',
    colors: {
      clear: ['Sexy Shad', 'Tennessee Shad', 'Chartreuse/Blue'],
      stained: ['Firetiger', 'Chartreuse/Black', 'Red Craw'],
      muddy: ['Chartreuse', 'Firetiger', 'Orange Belly Craw'],
    },
    rig: 'Long cast on 10-12lb fluoro for max depth. 7ft+ medium-heavy cranking rod. Long casts = deeper dives.',
    retrieve: 'Steady crank to reach depth, then vary speed. Bang it off ledges and rocks. Pause after deflection.',
  },
  'Deep Crankbait': {
    weight: '1/2–1 oz',
    size: '2.5–4"',
    colors: {
      clear: ['Sexy Shad', 'Chartreuse/Blue', 'Natural Shad'],
      stained: ['Firetiger', 'Red Craw', 'Citrus Shad'],
      muddy: ['Chartreuse', 'Orange Craw', 'Firetiger'],
    },
    rig: 'Long cast on 10-12lb fluorocarbon. 7ft+ medium cranking rod. Lighter line = deeper dive.',
    retrieve: 'Long cast, steady crank to depth. Bang off structure. Pause on contact with cover.',
  },
  'Small Crankbait': {
    weight: '1/8–3/8 oz',
    size: '1.5–2.5"',
    colors: {
      clear: ['Natural Shad', 'Ghost Minnow', 'Bluegill'],
      stained: ['Firetiger', 'Chartreuse/Blue', 'Red Craw'],
      muddy: ['Chartreuse', 'Firetiger', 'Bright Orange'],
    },
    rig: 'Light line 6-8lb. Spinning or light baitcaster. Tie direct, no snap.',
    retrieve: 'Steady or stop-and-go near cover. Let it float up over snags.',
  },
  'Tiny Crankbait': {
    weight: '1/16–1/8 oz',
    size: '1–1.5"',
    colors: {
      clear: ['Ghost Shad', 'Baby Bass', 'Natural Perch'],
      stained: ['Firetiger', 'Chartreuse', 'Gold/Black'],
      muddy: ['Chartreuse', 'Orange', 'Firetiger'],
    },
    rig: 'Ultralight spinning rod, 4-6lb line. Tie direct. Tiny trebles.',
    retrieve: 'Slow steady retrieve. Let it tick along bottom in shallow water.',
  },
  'Rattletrap': {
    weight: '1/4–3/4 oz',
    size: '2–3.5" lipless crankbait',
    colors: {
      clear: ['Chrome/Blue', 'Chrome/Black', 'Natural Shad'],
      stained: ['Red Craw', 'Rayburn Red', 'Gold/Black'],
      muddy: ['Chartreuse/Blue', 'Red/Orange', 'Gold/Black'],
    },
    rig: 'Tie direct to 12-17lb fluoro or braid. Medium-heavy rod for ripping through grass.',
    retrieve: 'Steady retrieve just above grass tops. Rip through grass — the "yo-yo" retrieve. Let it sink and rip.',
  },

  // === TOPWATER ===
  'Topwater Frog': {
    weight: '1/2–5/8 oz',
    size: '2.5–3.5" hollow body',
    colors: {
      clear: ['Natural Green', 'Black', 'White Belly/Green'],
      stained: ['Black', 'White', 'Chartreuse Frog'],
      muddy: ['Black (silhouette)', 'White', 'Bright Yellow'],
    },
    rig: 'Braided line 50-65lb to heavy frog rod. Bend hook points out slightly for better hookup. No leader needed.',
    retrieve: 'Walk-the-dog over pads & mats. Pause near holes in vegetation. Wait for weight on line before setting hook.',
  },
  'Buzzbait': {
    weight: '1/4–1/2 oz',
    size: 'Standard or double-blade',
    colors: {
      clear: ['White/Chart Skirt', 'White', 'Clear/Silver'],
      stained: ['Chartreuse/White', 'Black', 'White/Gold Blade'],
      muddy: ['Black', 'Chartreuse/Black', 'White (max contrast)'],
    },
    rig: 'Tie direct to 15-20lb fluoro or braid. Add a trailer hook for short strikes. Bend blade for more squeak.',
    retrieve: 'Steady retrieve fast enough to keep blade on surface. Burn it parallel to cover. Do not pause.',
  },
  'Popper': {
    weight: '1/4–5/8 oz (bass) or 1/16oz (panfish)',
    size: '2–4" (bass), 1–2" (panfish)',
    colors: {
      clear: ['Bone/Chrome', 'Clear Shad', 'Ghost'],
      stained: ['Chartreuse/White', 'Baby Bass', 'Sexy Shad'],
      muddy: ['Chartreuse', 'White', 'Bright Yellow'],
    },
    rig: 'Tie direct with loop knot for more action. 10-15lb fluoro or monofilament (floats better). Baitcaster or spinning.',
    retrieve: 'Pop-pop-pause. Twitch rod tip downward. Vary cadence. Longer pauses in cold water.',
  },
  'Small Popper': {
    weight: '1/16–1/8 oz',
    size: '1–2"',
    colors: {
      clear: ['Bone', 'Ghost Shad', 'Natural Bug'],
      stained: ['Chartreuse', 'Yellow', 'White'],
      muddy: ['Chartreuse', 'White', 'Black'],
    },
    rig: 'Ultralight rod, 4-6lb monofilament. Tie direct with small snap or loop knot.',
    retrieve: 'Gentle pops with pauses. Twitch lightly — panfish hit on the pause.',
  },
  'Topwater Plug': {
    weight: '3/8–1 oz',
    size: '3–6" walking bait or prop bait',
    colors: {
      clear: ['Bone', 'Chrome/Blue', 'Sexy Shad', 'Ghost'],
      stained: ['Chartreuse/Blue', 'Baby Bass', 'Clown'],
      muddy: ['White', 'Chartreuse', 'Black (silhouette)'],
    },
    rig: 'Braid 30-50lb to short 15-20lb fluoro leader (optional). Medium-heavy rod with soft tip. Loop knot.',
    retrieve: 'Walk-the-dog: rhythmic rod twitches. "Spit" it with harder pops. Pause near structure.',
  },
  'Topwater Popper': {
    weight: '1/4–1/2 oz',
    size: '2.5–4"',
    colors: {
      clear: ['Bone', 'Chrome/Blue', 'Ghost Shad'],
      stained: ['Chartreuse/White', 'Firetiger', 'Baby Bass'],
      muddy: ['White', 'Chartreuse', 'Bright Yellow'],
    },
    rig: 'Loop knot for more action. 10-15lb mono or fluoro. Medium action rod.',
    retrieve: 'Pop-pop-long pause. Vary cadence until fish tell you what they want.',
  },

  // === JIGS ===
  'Jig & Trailer': {
    weight: '1/4–1/2 oz (casting jig)',
    size: '3/8oz most versatile, match trailer to forage',
    colors: {
      clear: ['Green Pumpkin/Brown', 'Natural Craw', 'PB&J'],
      stained: ['Black/Blue', 'Brown/Orange', 'PB&J'],
      muddy: ['Black/Blue', 'Black/Chartreuse', 'Dark Craw'],
    },
    rig: 'Thread craw or chunk trailer onto jig hook. Trim skirt if needed. 15-20lb fluoro, baitcaster, medium-heavy rod.',
    retrieve: 'Hop along bottom 6-12" at a time. Drag through brush. Swim through laydowns. Feel for the thump.',
  },
  'Football Jig': {
    weight: '3/8–3/4 oz',
    size: 'Football-shaped head with craw trailer (3-4")',
    colors: {
      clear: ['Green Pumpkin', 'Natural Craw', 'Brown/Orange'],
      stained: ['PB&J', 'Black/Blue', 'Brown/Purple'],
      muddy: ['Black/Blue', 'Black/Brown', 'Dark Grape'],
    },
    rig: 'Pair with chunk or craw trailer. 15-20lb fluoro. Heavy baitcaster rod for deep hook sets.',
    retrieve: 'Drag slowly across rocky bottom. The head rolls over rocks = erratic action. Pause at contact.',
  },
  'Swim Jig': {
    weight: '1/4–3/8 oz',
    size: 'Pointed head with swimbait trailer (3-4")',
    colors: {
      clear: ['Bluegill', 'Green Pumpkin/Chart', 'Sexy Shad'],
      stained: ['Black/Blue', 'White/Chart', 'Bluegill'],
      muddy: ['Black/Blue', 'Chartreuse/White', 'White'],
    },
    rig: 'Add paddle tail swimbait trailer (Keitech, Strike King). 15lb fluoro, medium-heavy rod. Weedguard up.',
    retrieve: 'Steady swim through grass, over brush, along docks. Vary depth by rod angle. Bump cover.',
  },
  'Hair Jig': {
    weight: '1/16–3/8 oz',
    size: 'Tied hair/marabou on jig head',
    colors: {
      clear: ['Brown/Orange', 'White/Olive', 'Natural Sculpin'],
      stained: ['Brown/Orange', 'Black/Chart', 'Olive/White'],
      muddy: ['Black/Chartreuse', 'Bright Orange', 'White/Chartreuse'],
    },
    rig: 'Tie direct to 6-10lb fluorocarbon. Can tip with soft plastic or live minnow for extra action.',
    retrieve: 'Hop along bottom. Swim slowly through current. Let it drift and settle. Barely move it in cold water.',
  },
  'Chatterbait': {
    weight: '3/8–1/2 oz',
    size: 'Bladed swim jig with soft plastic trailer (3-5")',
    colors: {
      clear: ['Green Pumpkin/Shad', 'Sexy Shad', 'Bluegill'],
      stained: ['Chartreuse/White', 'Black/Blue', 'White/Chart'],
      muddy: ['Chartreuse/White', 'White', 'Black/Chartreuse'],
    },
    rig: 'Add a matching swimbait trailer (Z-Man or Keitech). 15-17lb fluoro, medium-heavy rod.',
    retrieve: 'Steady retrieve through grass. Rip free from snags — triggers reaction strikes. Vary speed.',
  },

  // === SPINNERBAITS ===
  'Spinnerbait': {
    weight: '1/4–3/4 oz',
    size: 'Single or tandem blade (Colorado, Willow, Indiana)',
    colors: {
      clear: ['White/Silver Blades', 'Shad', 'Chartreuse/White/Silver'],
      stained: ['Chartreuse/White/Gold Blades', 'Firetiger', 'White/Chart/Gold'],
      muddy: ['Chartreuse/Gold Blades', 'White/Gold', 'Orange/Gold Colorado Blade'],
    },
    rig: 'Tie direct (no snap). Add trailer hook for short strikes. Willow blades for speed/flash, Colorado for vibration/slow.',
    retrieve: 'Slow roll deep, steady retrieve mid-depth, or burn surface. Helicopter (let fall) along bluffs.',
  },
  'Inline Spinner': {
    weight: '1/8–3/8 oz',
    size: '#1–#4 blade (Rooster Tail, Panther Martin, Mepps)',
    colors: {
      clear: ['Silver Blade/White', 'Gold/Brown', 'Natural Trout', 'Black/Gold'],
      stained: ['Gold Blade/Chartreuse', 'Firetiger', 'Orange/Gold'],
      muddy: ['Chartreuse/Gold', 'White/Silver', 'Fluorescent Orange'],
    },
    rig: 'Tie direct to 4-8lb monofilament or fluoro. Use small snap-swivel ONLY if line twist is an issue.',
    retrieve: 'Cast upstream, steady retrieve downstream. Vary speed — just fast enough for blade spin. Count down for depth.',
  },
  'Small Inline Spinner': {
    weight: '1/16–1/8 oz',
    size: '#0–#1 blade',
    colors: {
      clear: ['Silver/White', 'Gold/Brown', 'Brook Trout'],
      stained: ['Gold/Chartreuse', 'Firetiger'],
      muddy: ['Chartreuse/Silver', 'White/Gold'],
    },
    rig: 'Ultralight rod, 2-4lb line. Tie direct, tiny snap optional for quick changes.',
    retrieve: 'Steady upstream cast. Slow retrieve. Keep blade spinning — lightest possible to maintain rotation.',
  },
  'Inline Spinner (Rooster Tail)': {
    weight: '1/8–1/4 oz',
    size: '#2–#3 blade with hackle tail',
    colors: {
      clear: ['Silver/White', 'Gold/Brown', 'Rainbow', 'Black/Gold'],
      stained: ['Firetiger', 'Chartreuse', 'Gold/Fluorescent Orange'],
      muddy: ['Chartreuse/Gold', 'Fluorescent Red/Gold', 'White/Silver'],
    },
    rig: 'Light spinning rod, 4-6lb mono or fluoro. Tie direct. Hackle tail adds pulsing action.',
    retrieve: 'Cast upstream at 45°, steady retrieve. Bounce off bottom in pools. Speed up in current.',
  },
  'Inline Spinner (slow)': {
    weight: '1/8–1/4 oz',
    size: '#1–#3 blade',
    colors: {
      clear: ['Silver/White', 'Gold/Brown Trout'],
      stained: ['Gold/Chartreuse', 'Firetiger'],
      muddy: ['Chartreuse/Gold', 'White/Silver'],
    },
    rig: 'Light spinning rod, 4-6lb line. Tie direct.',
    retrieve: 'Super slow retrieve — just enough to keep blade turning. Pause and let sink near holding water.',
  },
  'Small Spinner': {
    weight: '1/16–1/8 oz',
    size: '#0–#2 blade',
    colors: {
      clear: ['Silver/White', 'Gold/Brown'],
      stained: ['Gold/Chartreuse', 'Firetiger'],
      muddy: ['Chartreuse', 'White/Gold'],
    },
    rig: 'Ultralight rod, 4lb line. Tie direct.',
    retrieve: 'Steady slow retrieve. Cast upstream and swing through pools.',
  },
  'Tiny Spinner': {
    weight: '1/32–1/16 oz',
    size: '#00–#0 blade',
    colors: {
      clear: ['Silver', 'Gold', 'Black'],
      stained: ['Gold', 'Chartreuse'],
      muddy: ['Chartreuse', 'White'],
    },
    rig: 'Ultra-ultralight, 2-4lb line.',
    retrieve: 'Barely retrieve — just enough blade spin. Target small pockets.',
  },

  // === BLADE BAITS ===
  'Blade Bait': {
    weight: '1/4–3/4 oz',
    size: '2–3" metal vibrating blade',
    colors: {
      clear: ['Chrome/Blue', 'Silver', 'Gold'],
      stained: ['Gold', 'Chartreuse Chrome', 'Copper'],
      muddy: ['Gold', 'Chartreuse', 'Copper'],
    },
    rig: 'Tie to top line tie hole for tight vibration, bottom for wider wobble. 8-10lb fluoro. Sensitive rod.',
    retrieve: 'Lift-and-drop (yo-yo). Rip 1-3ft off bottom, let flutter back. Strikes come on the fall.',
  },

  // === SPOONS ===
  'Jigging Spoon': {
    weight: '1/2–1.5 oz',
    size: '3–5" heavy metal spoon',
    colors: {
      clear: ['Silver', 'Chrome', 'Gold/Silver'],
      stained: ['Gold', 'Hammered Gold'],
      muddy: ['Gold', 'Chartreuse/Silver'],
    },
    rig: 'Vertical jigging — drop straight down. Heavy rod, 15-20lb fluoro. Split ring to prevent line cut.',
    retrieve: 'Vertical yo-yo over deep schools. Rip up 3-5ft, let flutter down. Fish hit on the fall.',
  },
  'Small Spoon': {
    weight: '1/8–1/4 oz',
    size: '1.5–2.5" casting spoon',
    colors: {
      clear: ['Silver', 'Gold', 'Rainbow Trout', 'Brook Trout'],
      stained: ['Gold', 'Firetiger', 'Chartreuse/Silver'],
      muddy: ['Gold', 'Chartreuse', 'Fluorescent Orange'],
    },
    rig: 'Small snap-swivel to prevent twist. 4-6lb line. Light spinning rod.',
    retrieve: 'Steady retrieve with occasional twitch. Or let flutter into pools and lift.',
  },
  'Tiny Spoon': {
    weight: '1/16–1/8 oz',
    size: '1–1.5"',
    colors: {
      clear: ['Silver', 'Gold', 'Copper'],
      stained: ['Gold', 'Chartreuse'],
      muddy: ['Gold', 'Chartreuse'],
    },
    rig: 'Ultra-light, 2-4lb line. Small snap.',
    retrieve: 'Cast and flutter down. Gentle lift-drop in pools. Or slow steady retrieve.',
  },

  // === CAROLINA RIG ===
  'Carolina Rig': {
    weight: '1/2–1 oz egg or bullet sinker, 2-4ft leader',
    size: '4–7" lizard, creature, or finesse worm on leader',
    colors: {
      clear: ['Green Pumpkin', 'Watermelon', 'French Fry'],
      stained: ['Junebug', 'Green Pumpkin/Purple', 'Redbug'],
      muddy: ['Black/Blue', 'Junebug', 'Tequila Sunrise'],
    },
    rig: 'Main line: 15-20lb fluoro with egg sinker + bead + barrel swivel. Leader: 12-15lb fluoro 2-4ft to 3/0 EWG hook.',
    retrieve: 'Long casts, slow drag across bottom. The bait floats above bottom on the leader. Cover water methodically.',
  },

  // === SPECIALTY ===
  'Beetle Spin': {
    weight: '1/16–1/4 oz',
    size: 'Small spinnerbait + grub body',
    colors: {
      clear: ['White/Silver', 'Chartreuse/Silver', 'Smoke'],
      stained: ['Chartreuse/Gold', 'White/Gold', 'Yellow'],
      muddy: ['Chartreuse', 'White', 'Yellow/Gold'],
    },
    rig: 'Tie direct to 4-8lb mono. Can swap grub bodies for different colors on the fly.',
    retrieve: 'Slow steady retrieve around structure. Great for beginners. Bump docks and brush.',
  },
  'Bucktail Jig': {
    weight: '1/2–2 oz',
    size: 'Large jig head with bucktail hair, optional trailer',
    colors: {
      clear: ['White', 'White/Chartreuse', 'Natural Bunker'],
      stained: ['Chartreuse/White', 'Yellow/White', 'Olive/White'],
      muddy: ['Chartreuse', 'White', 'Bright Yellow'],
    },
    rig: 'Tie direct to 20-30lb braid or fluoro leader. Can add pork rind or soft plastic trailer for bulk.',
    retrieve: 'Sweep-and-drop along ledges. Swim steadily at baitfish depth. Vertical jig over schools.',
  },
  'Bucktail Spinner': {
    weight: '3/4–2 oz',
    size: '6–10" overall with large blade',
    colors: {
      clear: ['White/Silver', 'Natural Perch', 'Black/Gold'],
      stained: ['Firetiger', 'Chartreuse/Gold', 'Orange/Gold'],
      muddy: ['Chartreuse/Gold', 'White/Gold', 'Bright Orange'],
    },
    rig: 'Heavy rod (muskie rated), steel leader 12-18", 65-80lb braid. Always figure-8 at the boat.',
    retrieve: 'Steady retrieve with varying speeds. Burn fast in warm water, slow roll cold. Always figure-8.',
  },
  'Umbrella Rig': {
    weight: '1–3 oz (full rig with swimbaits)',
    size: '5-wire rig with 3-5" swimbaits',
    colors: {
      clear: ['White Pearl', 'Silver Shad', 'Alewife'],
      stained: ['Chartreuse Shad', 'White/Chartreuse'],
      muddy: ['Chartreuse/White', 'Bright White'],
    },
    rig: 'Heavy swimbait rod, 20-30lb braid. IMPORTANT: VA limits hooks/lures on umbrella rigs — verify current VA DWR regulations before use. NC also has restrictions. Slow roll.',
    retrieve: 'Steady slow retrieve at bait school depth. Mimic a school of baitfish. Use electronics to find depth.',
  },
  'Road Runner': {
    weight: '1/8–1/4 oz',
    size: 'Underspin jig head with curly tail grub',
    colors: {
      clear: ['White/Silver', 'Chartreuse/Silver', 'Smoke/Sparkle'],
      stained: ['Chartreuse/Gold', 'White/Gold', 'Pink/White'],
      muddy: ['Chartreuse', 'White', 'Fluorescent Pink'],
    },
    rig: 'Light spinning rod, 6-8lb line. Tie direct. Blade spins on retrieve.',
    retrieve: 'Steady retrieve. Count down for depth. Great around brush piles for crappie. Slow and steady.',
  },

  // === JIGS FOR PANFISH/CRAPPIE ===
  'Small Jig (1/32oz)': {
    weight: '1/64–1/32 oz',
    size: '1" micro body or marabou',
    colors: {
      clear: ['White', 'Smoke', 'Chartreuse', 'Pink/White'],
      stained: ['Chartreuse', 'Pink/White', 'Yellow'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Ultralight rod, 2-4lb mono. Under small bobber set 1-3ft deep. Or free-line with split shot.',
    retrieve: 'Under bobber — let it sit, twitch occasionally. Or slow retrieve. Tip with wax worm for scent.',
  },
  'Small Jig': {
    weight: '1/32–1/8 oz',
    size: '1–2" body',
    colors: {
      clear: ['White', 'Chartreuse', 'Smoke', 'Natural'],
      stained: ['Chartreuse', 'Pink/White', 'Yellow/Chartreuse'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Light spinning rod, 4-6lb line. Under bobber or free-line with split shot.',
    retrieve: 'Slow retrieve or suspend under bobber. Twitch gently. Tip with minnow or wax worm.',
  },
  'Micro Jig': {
    weight: '1/64–1/32 oz',
    size: '0.5–1" body',
    colors: {
      clear: ['Glow White', 'Smoke', 'Chartreuse'],
      stained: ['Chartreuse', 'Pink', 'Glow'],
      muddy: ['Chartreuse', 'Glow', 'White'],
    },
    rig: 'Ice rod or ultralight, 1-3lb line. Tiny bobber or sight fish.',
    retrieve: 'Micro-jigging — tiny hops. Or suspend under indicator. Barely move it.',
  },
  'Crappie Jig': {
    weight: '1/16–1/8 oz',
    size: '1.5–2.5" tube, grub, or minnow body',
    colors: {
      clear: ['Monkey Milk', 'White Pearl', 'Chartreuse/White', 'Smoke Sparkle'],
      stained: ['Chartreuse/Sparkle', 'Pink/White', 'Hot Chartreuse', 'Electric Chicken'],
      muddy: ['Chartreuse', 'White', 'Hot Pink', 'Orange/Chartreuse'],
    },
    rig: 'Under slip bobber set to target depth, or spider rig (multiple rods). 6lb mono. Tip with minnow optional.',
    retrieve: 'Slow fall under bobber. Or spider rig trolling at 0.5-1 mph. Vertical jig at structure edges.',
  },
  'Small Tube Jig': {
    weight: '1/16–1/8 oz',
    size: '1.5–2" mini tube',
    colors: {
      clear: ['Smoke/Silver', 'Pearl White', 'Chartreuse/Sparkle'],
      stained: ['Chartreuse', 'Pink/Pearl', 'Monkey Milk'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Internal jig head. 4-6lb line. Under bobber or free fall along structure.',
    retrieve: 'Let it spiral down next to brush piles. Or swim slowly through timber.',
  },
  'Hair Jig (1/16oz)': {
    weight: '1/32–1/16 oz',
    size: 'Marabou or hair tied on small jig head',
    colors: {
      clear: ['White', 'Olive/White', 'Pink/White', 'Brown/Orange'],
      stained: ['Chartreuse/White', 'Pink/White', 'All White'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Under slip bobber, 4-6lb mono. Marabou breathes and pulses naturally.',
    retrieve: 'Suspend at depth under bobber. The marabou does all the work. Barely twitch it.',
  },
  'Bobby Garland': {
    weight: '1/16 oz jig head',
    size: '2" Baby Shad or Stroll\'r body',
    colors: {
      clear: ['Monkey Milk', 'Blue Ice', 'Pearl/Chartreuse', 'Smoke/Silver'],
      stained: ['Electric Chicken', 'Chartreuse/Silver', 'Mo Glo Monkey Milk'],
      muddy: ['Chartreuse', 'Electric Chicken', 'Fluorescent Pink'],
    },
    rig: 'Thread onto 1/16oz round jig head. Under bobber or free-line. 4-6lb mono.',
    retrieve: 'Under bobber at brush pile depth. Or slow swim through timber. Very subtle action.',
  },
  'Deep Jig': {
    weight: '1/4–3/8 oz',
    size: '2–3" grub or minnow body on heavy jig head',
    colors: {
      clear: ['White Pearl', 'Smoke/Silver', 'Chartreuse/White'],
      stained: ['Chartreuse', 'Pink/White', 'Electric Chicken'],
      muddy: ['Chartreuse', 'White', 'Bright Pink'],
    },
    rig: 'Heavier jig head to reach 15-25ft. 8lb fluoro. Vertical presentation next to deep structure.',
    retrieve: 'Vertical jigging — drop to depth, lift and lower slowly. Or slow drag along deep edges.',
  },
  'Spider Rig Jigs': {
    weight: '1/16–1/8 oz each, 6-8 rods',
    size: '1.5–2.5" bodies, crappie jigs',
    colors: {
      clear: ['Monkey Milk', 'White Pearl', 'Chartreuse/White'],
      stained: ['Chartreuse', 'Pink/White', 'Electric Chicken'],
      muddy: ['Chartreuse', 'White', 'Hot Pink/Chartreuse'],
    },
    rig: 'Multiple rods in spider rig holders off bow. Set at varying depths with bobber stops. 6lb mono each.',
    retrieve: 'Troll at 0.3-0.8 mph over brush piles. Vary depths until you find the zone.',
  },
  'Small Spoon': {
    weight: '1/8–1/4 oz',
    size: '1.5–2.5"',
    colors: {
      clear: ['Silver', 'Gold', 'Hammered Silver'],
      stained: ['Gold', 'Chartreuse/Silver'],
      muddy: ['Gold', 'Chartreuse'],
    },
    rig: 'Small snap to prevent line twist. 4-6lb line, light spinning rod.',
    retrieve: 'Cast and retrieve with twitches. Or let flutter into pools.',
  },

  // === FLY PATTERNS ===
  'Nymph Fly': {
    weight: 'Bead head, split shot, or Euro nymph weights',
    size: '#10–#18 hook',
    colors: {
      clear: ['Pheasant Tail', 'Hare\'s Ear', 'Prince Nymph', 'Copper John'],
      stained: ['Copper John', 'Pat\'s Rubber Legs', 'Stonefly'],
      muddy: ['Glo-Bug', 'San Juan Worm (red)', 'Bright Copper John'],
    },
    rig: '9ft 4-5wt fly rod. 9ft leader tapered to 5X-6X. Add split shot 8" above fly. Or Euro nymph tight-line.',
    retrieve: 'Dead drift with indicator. Or Euro nymph (tight line, feel the take). Mend to maintain drag-free drift.',
  },
  'Nymph': {
    weight: 'Bead head or split shot',
    size: '#12–#18',
    colors: {
      clear: ['Pheasant Tail', 'Hare\'s Ear', 'Prince'],
      stained: ['Copper John', 'Stonefly', 'Pat\'s Rubber Legs'],
      muddy: ['San Juan Worm (red)', 'Bright Copper John', 'Egg Pattern'],
    },
    rig: 'Fly rod 4-5wt. 9ft leader, 5X-6X tippet. Under indicator or tight-line Euro nymph.',
    retrieve: 'Dead drift. Mend upstream to keep drag-free. Set hook on any pause in indicator.',
  },
  'Small Nymph': {
    weight: 'Tiny bead head or unweighted',
    size: '#16–#22',
    colors: {
      clear: ['Zebra Midge', 'RS2', 'WD-40', 'Pheasant Tail'],
      stained: ['Mercury Midge', 'Black Beauty', 'Thread Midge'],
      muddy: ['Bright Red Midge', 'Chartreuse Midge'],
    },
    rig: 'Light fly rod 2-4wt. Long leader 10-12ft, 6X-7X tippet. Tiny indicator.',
    retrieve: 'Dead drift in slow pools and seams. Micro movements. Fish close to bottom.',
  },
  'Deep Nymph': {
    weight: 'Heavy bead head + split shot, or tungsten',
    size: '#8–#14',
    colors: {
      clear: ['Stonefly', 'Pat\'s Rubber Legs', 'Copper John'],
      stained: ['Black Stonefly', 'Copper John', 'Hare\'s Ear'],
      muddy: ['San Juan Worm', 'Egg Pattern', 'Bright Stonefly'],
    },
    rig: 'Heavier fly rod 5-6wt. Short leader, heavy tippet 4X. Lots of weight to get down.',
    retrieve: 'High-stick through deep runs. Euro nymph technique. Get it bouncing bottom.',
  },
  'Dry Fly': {
    weight: 'None — floats on surface',
    size: '#10–#18 depending on hatch',
    colors: {
      clear: ['Elk Hair Caddis (tan)', 'Adams', 'Parachute Adams', 'Blue Wing Olive'],
      stained: ['Royal Wulff', 'Stimulator (orange)', 'Elk Hair Caddis'],
      muddy: ['Royal Wulff', 'High-vis Stimulator', 'Chernobyl Ant'],
    },
    rig: 'Fly rod 3-5wt. 9-12ft leader tapered to 5X-6X. Apply floatant to fly. Upstream presentation.',
    retrieve: 'Dead drift on surface. Match the hatch — observe what bugs are on water. Set hook gently on rise.',
  },
  'Dry Fly (Elk Hair Caddis)': {
    weight: 'None — floats',
    size: '#12–#18',
    colors: {
      clear: ['Tan', 'Olive', 'Gray'],
      stained: ['Tan', 'Orange', 'Yellow'],
      muddy: ['Bright Orange', 'Yellow', 'White'],
    },
    rig: '3-5wt fly rod, 9ft leader to 5X tippet. Floatant on every cast.',
    retrieve: 'Dead drift or slight skitter across surface. Caddis naturally flutter — a little drag is OK.',
  },
  'Fly (Woolly Bugger)': {
    weight: 'Bead head or cone head, weighted',
    size: '#6–#12',
    colors: {
      clear: ['Olive', 'Black', 'Brown', 'White'],
      stained: ['Olive/Chartreuse', 'Black/Purple', 'Rust'],
      muddy: ['Black/Chartreuse', 'Bright Olive', 'White/Red'],
    },
    rig: '5-6wt fly rod. 7.5ft leader, 3X-4X tippet. Sink tip line for deeper water optional.',
    retrieve: 'Strip-strip-pause. Vary strip speed. Let it sink between strips. The marabou tail pulses.',
  },
  'Streamer Fly': {
    weight: 'Weighted dumbbell eyes or cone head',
    size: '#2–#8 (2-5" long)',
    colors: {
      clear: ['Olive/White Clouser', 'Sculpin (tan)', 'Natural Minnow'],
      stained: ['Chartreuse/White', 'Black/Olive', 'Brown/Orange Sculpin'],
      muddy: ['Chartreuse/White', 'Bright Yellow', 'Black/Purple'],
    },
    rig: '6-7wt fly rod. Short stout leader 4-6ft, 0X-2X tippet. Sink tip line for depth. Strip-set, don\'t trout-set.',
    retrieve: 'Aggressive strips. Jerk-strip-pause. Swing across current. Bang the banks. Think like a predator.',
  },
  'Streamer': {
    weight: 'Weighted',
    size: '#2–#8',
    colors: {
      clear: ['Olive/White', 'Sculpin', 'Natural Baitfish'],
      stained: ['Chartreuse/White', 'Black/Olive'],
      muddy: ['Chartreuse/White', 'Bright Yellow', 'Black'],
    },
    rig: '6-7wt fly rod, short leader 4-6ft, heavy tippet 0X-2X.',
    retrieve: 'Aggressive strips across and downstream. Bang the banks. Strip-set on takes.',
  },
  'Streamer (sculpin)': {
    weight: 'Weighted sculpin head',
    size: '#2–#6 (3-4")',
    colors: {
      clear: ['Tan/Olive', 'Dark Sculpin', 'Natural Brown'],
      stained: ['Dark Olive', 'Brown/Orange', 'Black/Olive'],
      muddy: ['Dark Brown', 'Black/Chartreuse'],
    },
    rig: '6-7wt rod, sink tip, 4ft 1X leader. Fish tight to bottom structure.',
    retrieve: 'Strip-hop along bottom. Sculpins dart and settle. Dead drift through deep runs.',
  },
  'Fly (Clouser Minnow)': {
    weight: 'Dumbbell eyes (lead or bead chain)',
    size: '#2–#8 (1-3")',
    colors: {
      clear: ['Chartreuse/White', 'Olive/White', 'Tan/White'],
      stained: ['Chartreuse/Yellow', 'Red/White', 'All Chartreuse'],
      muddy: ['Chartreuse/White', 'Bright Yellow/Red', 'All White'],
    },
    rig: '6-8wt fly rod. Intermediate or sink tip line. 6-8ft leader, 1X-3X tippet. Non-slip loop knot.',
    retrieve: 'Strip-pause. The dumbbell eyes make it dive on the pause, rise on the strip — jigging action.',
  },
  'Fly (Streamer)': {
    weight: 'Bead head or cone',
    size: '#4–#10',
    colors: {
      clear: ['Olive/White', 'Tan Sculpin', 'Natural Minnow'],
      stained: ['Chartreuse/White', 'Black', 'Dark Olive'],
      muddy: ['Chartreuse/White', 'All Black', 'White'],
    },
    rig: '5-6wt rod. Sink tip optional. Short leader 5-7ft, 3X tippet.',
    retrieve: 'Strip and swing through runs. Vary speed. Dead drift through pools then strip at the end.',
  },
  'Fly (Nymph)': {
    weight: 'Bead head',
    size: '#12–#18',
    colors: {
      clear: ['Pheasant Tail', 'Hare\'s Ear', 'Prince'],
      stained: ['Copper John', 'Stonefly'],
      muddy: ['San Juan Worm', 'Egg', 'Bright Copper John'],
    },
    rig: '4-5wt fly rod. 9ft leader, 5X-6X tippet. Indicator or Euro nymph.',
    retrieve: 'Dead drift. Adjust indicator depth to keep fly near bottom. Set on any movement.',
  },
  'Soft Hackle Fly': {
    weight: 'Unweighted or lightly weighted',
    size: '#12–#16',
    colors: {
      clear: ['Partridge & Orange', 'Partridge & Yellow', 'Hare\'s Ear Soft Hackle'],
      stained: ['Partridge & Orange', 'Starling & Herl', 'Bright Green'],
      muddy: ['Orange/Gold', 'Bright Yellow', 'Fluorescent Green'],
    },
    rig: '3-5wt rod. 9ft leader, 5X tippet. Fish on the swing — cast across, let it sweep.',
    retrieve: 'Wet fly swing — cast across stream, mend, let it sweep downstream. The hackle pulses and breathes.',
  },
  'Mouse Fly (night)': {
    weight: 'Foam — floats',
    size: '#2–#6 (2-3" deer hair or foam)',
    colors: {
      clear: ['Natural Brown/Tan', 'Black', 'Gray'],
      stained: ['Black', 'Dark Brown'],
      muddy: ['Black', 'Dark Brown'],
    },
    rig: '6-7wt rod. Heavy tippet 0X-2X. Fish after dark or deep dusk.',
    retrieve: 'Slow strips across surface creating a wake. Pause near banks. Listen for the eat — set on the pull, not the splash.',
  },
  'Fly (shad pattern)': {
    weight: 'Bead chain or light dumbbell eyes',
    size: '#4–#8 (1-2")',
    colors: {
      clear: ['Silver/White', 'Pearl/Chartreuse', 'Olive/White'],
      stained: ['Chartreuse/White', 'All White'],
      muddy: ['Chartreuse', 'White/Chartreuse'],
    },
    rig: '6-8wt rod. Intermediate line. Short leader 5ft, 2X tippet.',
    retrieve: 'Quick short strips mimicking darting baitfish. Swing through current below dams.',
  },
  'Spider': {
    weight: '1/64–1/32 oz or fly hook',
    size: '#10–#14 with rubber legs',
    colors: {
      clear: ['Black', 'Brown', 'Olive/Yellow'],
      stained: ['Chartreuse', 'Black/Chartreuse', 'Yellow'],
      muddy: ['Chartreuse', 'White', 'Bright Yellow'],
    },
    rig: 'Ultralight or fly rod (2-4wt). Under tiny bobber or on surface. 2-4lb tippet.',
    retrieve: 'Dead drift on surface or just under. Legs wiggle naturally. Twitch occasionally.',
  },
  'Ice Fly': {
    weight: '1/64–1/32 oz tungsten',
    size: '#10–#16',
    colors: {
      clear: ['Glow White', 'Glow Chartreuse', 'Red/Glow'],
      stained: ['Chartreuse', 'Glow', 'Orange'],
      muddy: ['Glow Chartreuse', 'Bright Red', 'Glow White'],
    },
    rig: 'Ice rod or ultralight, 1-3lb line. Tiny spring bobber for bite detection.',
    retrieve: 'Micro jig — tiny bounces. Quiver in place. Barely perceptible movements. Tip with wax worm.',
  },
  'Tiny Grub': {
    weight: '1/32–1/16 oz jig head',
    size: '1–1.5" curly tail',
    colors: {
      clear: ['White Pearl', 'Smoke/Sparkle', 'Chartreuse/Sparkle'],
      stained: ['Chartreuse', 'Pink/Pearl', 'Yellow'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Thread onto 1/32oz jig head. Ultralight, 4lb line.',
    retrieve: 'Slow steady retrieve. Under bobber for panfish. Tail does all the work.',
  },

  // === CATFISH/OTHER ===
  'Jig tipped with bait': {
    weight: '1/4–1 oz jig head',
    size: 'Large enough to hold bait chunk',
    colors: {
      clear: ['Any — bait is the attraction'],
      stained: ['Chartreuse head helps visibility'],
      muddy: ['Chartreuse or glow head'],
    },
    rig: 'Heavy rod, 15-30lb line. Jig head tipped with cut bait, chicken liver, or stink bait. Circle hook option.',
    retrieve: 'Cast to deep holes, let sit on bottom. Slight lift-and-drop. Or drift along channel edges.',
  },
  'Shad Dart': {
    weight: '1/8–1/4 oz',
    size: 'Small leadhead with bucktail or tinsel',
    colors: {
      clear: ['Chartreuse/White', 'Pink/White', 'Red/White'],
      stained: ['Chartreuse', 'Chartreuse/Pink', 'Orange/White'],
      muddy: ['Bright Chartreuse', 'Fluorescent Pink', 'Orange'],
    },
    rig: 'Light spinning rod, 6-8lb mono. Can tandem rig two darts (dropper loop). Fish below dams.',
    retrieve: 'Cast upstream, let drift and bounce bottom. Or slow steady retrieve across current. Feel for taps.',
  },
  'Shad Dart (1/4oz)': {
    weight: '1/4 oz',
    size: 'Standard dart with bucktail',
    colors: {
      clear: ['Chartreuse/White', 'Pink/White', 'Red/White'],
      stained: ['Chartreuse', 'Chartreuse/Pink'],
      muddy: ['Bright Chartreuse', 'Fluorescent Pink'],
    },
    rig: '6-8lb line. Tandem rig optional. Cast upstream of dam tailrace.',
    retrieve: 'Bounce along bottom in current. Shad stack up below dams during runs.',
  },
  'Deep Dart': {
    weight: '3/8–1/2 oz',
    size: 'Heavy shad dart',
    colors: {
      clear: ['Chartreuse/White', 'Pink/White'],
      stained: ['Chartreuse', 'Orange'],
      muddy: ['Bright Chartreuse', 'Fluorescent Pink'],
    },
    rig: '8-10lb line. Heavier to get down in fast current.',
    retrieve: 'Vertical jigging in deep current. Bounce bottom in fast tailraces.',
  },
  'Shad Rig': {
    weight: '1/4–1/2 oz total with sinker',
    size: 'Tandem dart rig with sinker',
    colors: {
      clear: ['Chartreuse/White darts', 'Pink/White'],
      stained: ['Chartreuse', 'Orange/Yellow'],
      muddy: ['Bright Chartreuse', 'Hot Pink'],
    },
    rig: 'Two darts on dropper loops, sinker on bottom. 8lb mono mainline. Fish vertically or cast upstream.',
    retrieve: 'Let rig bounce along bottom in current. Lift-drop-drift. Multiple hooks increase odds.',
  },
  'Flutter Spoon': {
    weight: '1/4–3/4 oz',
    size: '2–3" thin flutter spoon',
    colors: {
      clear: ['Silver', 'Gold', 'Hammered Silver'],
      stained: ['Gold', 'Chartreuse/Silver'],
      muddy: ['Gold', 'Hammered Gold'],
    },
    rig: 'Small snap-swivel. 6-8lb line. Light spinning rod.',
    retrieve: 'Cast, let flutter down, retrieve with twitches. Or vertical jig over schools.',
  },
  'Sabiki Rig': {
    weight: '1–2 oz sinker on bottom',
    size: '6-hook rig with tiny flies/flashers',
    colors: {
      clear: ['Aurora/Flash', 'Pink/White', 'Green/Flash'],
      stained: ['Green/Glow', 'Pink/Flash'],
      muddy: ['Glow/Flash', 'Chartreuse'],
    },
    rig: 'Medium spinning rod, 10-15lb mainline. Drop sinker to bottom, reel up to desired depth.',
    retrieve: 'Jig up and down gently at baitfish depth. When you feel weight, reel in slowly. Can catch multiple at once.',
  },
  'Glide Bait': {
    weight: '1–4 oz',
    size: '6–10" hard jointed or soft body',
    colors: {
      clear: ['Ghost Shad', 'Natural Trout', 'Hitch'],
      stained: ['Bluegill', 'Perch', 'Shad Flash'],
      muddy: ['Black Back/White', 'Bright Perch'],
    },
    rig: 'Muskie/swimbait rod, 65-80lb braid. Steel leader for muskie. Heavy-duty hardware throughout.',
    retrieve: 'Slow S-shaped glide with rod sweeps. Pause at direction change — strikes come on the turn.',
  },
  'Large Bucktail': {
    weight: '1–2 oz',
    size: '8–12" with large blade',
    colors: {
      clear: ['White/Silver', 'Black/Orange', 'Natural Perch'],
      stained: ['Firetiger', 'Chartreuse/Gold', 'Orange/Gold'],
      muddy: ['Chartreuse', 'White/Gold', 'Bright Orange'],
    },
    rig: 'Muskie rod, 80lb braid, 12-18" steel leader. Always use quality snaps and swivels.',
    retrieve: 'Steady retrieve with speed changes. Burn in warm water. ALWAYS figure-8 at the boat — 50% of follows convert.',
  },
  'Bull Dawg': {
    weight: '3–5 oz',
    size: '9–12" soft rubber jerkbait',
    colors: {
      clear: ['Perch', 'Natural Sucker', 'Shad'],
      stained: ['Firetiger', 'Hot Perch', 'Black/Orange'],
      muddy: ['Firetiger', 'Bright Orange', 'Chartreuse'],
    },
    rig: 'Heavy muskie rod, 80lb braid, steel leader. Weighted jig head inside body.',
    retrieve: 'Jerk-jerk-pause. Wide erratic sweeps. Figure-8 at boat. The erratic action triggers following muskie.',
  },
  'Large Swimbait': {
    weight: '2–6 oz',
    size: '6–10"',
    colors: {
      clear: ['Ghost Shad', 'Rainbow Trout', 'Hitch'],
      stained: ['Bluegill', 'Perch', 'Chartreuse Shad'],
      muddy: ['White/Chartreuse', 'Bright Perch'],
    },
    rig: 'Swimbait rod, 20-25lb fluoro or braid to fluoro leader. Slow roll or match bait depth.',
    retrieve: 'Slow steady retrieve. Occasional pause. Bump structure. Match depth to where fish are holding.',
  },
  'Rubber Bait (slow roll)': {
    weight: '2–5 oz',
    size: '8–12" soft plastic muskie bait',
    colors: {
      clear: ['Natural Sucker', 'Perch', 'Shad'],
      stained: ['Firetiger', 'Bright Perch'],
      muddy: ['Firetiger', 'Chartreuse'],
    },
    rig: 'Muskie rod, braid, steel leader. Weighted hook or jig head.',
    retrieve: 'Slow roll through deep structure. Barely crawling. Pause near cover. Muskie follow before committing.',
  },
  'Bottom Bouncer': {
    weight: '1–3 oz (depending on depth & current)',
    size: 'Wire bouncer with spinner rig trailing 3-6ft',
    colors: {
      clear: ['Chrome/Chartreuse spinner', 'Gold/Green'],
      stained: ['Gold/Chartreuse', 'Hammered Gold/Orange'],
      muddy: ['Bright Chartreuse/Gold', 'Fluorescent Orange'],
    },
    rig: 'Medium-heavy rod, 10-14lb braid or mono. Bouncer on mainline, 3-6ft snell to hook with crawler or leech.',
    retrieve: 'Troll at 0.8-1.5 mph. Maintain bottom contact — the wire bounces along. Tip with nightcrawler.',
  },
  'Jerkbait (slow)': {
    weight: '3/8–5/8 oz (suspending model)',
    size: '4–5"',
    colors: {
      clear: ['Ghost Minnow', 'Perch', 'Natural Sucker'],
      stained: ['Firetiger', 'Clown', 'Chartreuse/Blue'],
      muddy: ['Firetiger', 'Gold/Black', 'Chartreuse'],
    },
    rig: '8-10lb fluoro. Suspending model. Can add suspend dots for perfect neutral buoyancy.',
    retrieve: 'Jerk-pause with very long pauses (10-30 seconds in cold water). Dead stick it. Muskie stare before eating.',
  },

  // === CATCH-ALL SIMPLE ENTRIES ===
  'Small Jig under float': {
    weight: '1/32–1/8 oz',
    size: '1–2" jig body',
    colors: {
      clear: ['White', 'Chartreuse', 'Smoke'],
      stained: ['Chartreuse', 'Pink/White', 'Yellow'],
      muddy: ['Chartreuse', 'White', 'Hot Pink'],
    },
    rig: 'Small fixed or slip bobber set 2-6ft deep. Split shot above jig if needed. 4-6lb mono.',
    retrieve: 'Let it sit, twitch occasionally. Adjust depth until you find fish. Great for kids & beginners.',
  },
  'Small Minnow Bait': {
    weight: '1/8–1/4 oz',
    size: '2–3" hard minnow plug',
    colors: {
      clear: ['Silver/Black', 'Ghost Shad', 'Natural Minnow'],
      stained: ['Firetiger', 'Chartreuse Shad', 'Gold/Black'],
      muddy: ['Chartreuse', 'Firetiger', 'Bright Orange'],
    },
    rig: 'Light spinning rod, 6lb line. Tie direct or small snap. Tiny treble hooks.',
    retrieve: 'Twitch-twitch-pause. Or slow steady retrieve. Great for crappie around structure.',
  },
  'Jigging Rap': {
    weight: '1/4–5/8 oz',
    size: '2–3" sinking jerkbait',
    colors: {
      clear: ['Glow Perch', 'Silver/Blue', 'Natural Perch'],
      stained: ['Glow Tiger', 'Gold/Perch', 'Firetiger'],
      muddy: ['Glow Tiger', 'Glow Perch', 'Chartreuse'],
    },
    rig: 'Medium rod, 8-10lb fluoro. Vertical presentation. Forward-facing hook + treble belly.',
    retrieve: 'Snap-jigging — rip up 1-2ft, let it circle back down on slack line. Fish hit on the swing/drop.',
  },
  'Live Bait Rig': {
    weight: '1/4–1 oz sinker (egg or walking)',
    size: 'Match hook to bait species',
    colors: {
      clear: ['N/A — bait provides all attraction'],
      stained: ['N/A'],
      muddy: ['N/A'],
    },
    rig: 'Sliding sinker on mainline, bead, swivel, 2-4ft fluoro leader to hook. Circle hook for catch & release.',
    retrieve: 'Let it sit on bottom. Or slow troll. Give fish time to eat — wait for line to move before setting.',
  },
  'Downline Rig': {
    weight: '2–4 oz sinker on bottom',
    size: 'Hook on dropper 3-5ft above weight',
    colors: {
      clear: ['N/A — live bait rig'],
      stained: ['N/A'],
      muddy: ['N/A'],
    },
    rig: 'Heavy sinker on bottom, 3-5ft dropper loop with live bait (shad/spot). Fish at specific depth shown on electronics.',
    retrieve: 'Vertical presentation. Lower to target depth. Hold position over fish marks. Let bait do the work.',
  },
  'Large Sucker Rig': {
    weight: '1–3 oz depending on current',
    size: '8–14" live sucker on quick-strike rig',
    colors: {
      clear: ['N/A — live bait'],
      stained: ['N/A'],
      muddy: ['N/A'],
    },
    rig: 'Quick-strike rig: two treble hooks rigged along bait. Steel leader. Float to keep bait off bottom.',
    retrieve: 'Under large float, let sucker swim freely. Set hook immediately on take (quick-strike prevents deep hooking).',
  },
  'Spinner Rig (Crawler Harness)': {
    weight: 'Bottom bouncer or walking sinker 1/2-2oz',
    size: 'Colorado or Indiana blade #3-#5, trailing 2-hook harness',
    colors: {
      clear: ['Silver Blade/Crawworm', 'Gold/Chartreuse', 'Hammered Silver'],
      stained: ['Gold/Chartreuse', 'Copper/Orange', 'Hammered Gold'],
      muddy: ['Chartreuse/Gold', 'Fluorescent Orange/Gold', 'Hot Pink'],
    },
    rig: 'Bottom bouncer or Lindy rig. Trailing harness with two small hooks threaded on nightcrawler. 8-12lb line.',
    retrieve: 'Troll at 1-1.5 mph. Maintain bottom contact. Blade spins from forward motion. Crawler trails naturally.',
  },
};

// ===== Derive water clarity from weather =====
function getWaterClarity(weather) {
  // Current-hour precipitation
  if (weather.precipitation > 0.25) return 'muddy';
  if (weather.precipitation > 0.05) return 'stained';
  // Forecast rain probability as proxy for recent/upcoming rain
  if (weather.precipProbability > 70) return 'muddy';
  if (weather.precipProbability > 40) return 'stained';
  // High humidity + heavy cloud = likely recent rain or saturated ground
  if (weather.humidity > 90 && weather.cloudCover > 85) return 'muddy';
  if (weather.humidity > 80 && weather.cloudCover > 70) return 'stained';
  // Even light current precip with any precip > 0 biases stained
  if (weather.precipitation > 0.01) return 'stained';
  return 'clear';
}


// ===== Species → Lure mapping (unchanged structure, references LURE_DB keys) =====

const SPECIES_DATA = {
  'Largemouth Bass': {
    lures: {
      cold: ['Jerkbait', 'Ned Rig', 'Blade Bait', 'Suspending Minnow'],
      mild: ['Spinnerbait', 'Crankbait', 'Jig & Trailer', 'Soft Plastic Worm', 'Chatterbait'],
      warm: ['Topwater Frog', 'Buzzbait', 'Plastic Worm (Texas Rig)', 'Swim Jig', 'Popper'],
      hot: ['Deep Diving Crankbait', 'Carolina Rig', 'Football Jig', 'Drop Shot'],
    },
    baits: ['Nightcrawlers', 'Shiners', 'Crawfish', 'Minnows', 'Crickets'],
    depthTips: { cold: 'Fish slow near bottom in 15-25ft', mild: 'Work transition zones 5-15ft, near structure', warm: 'Early/late topwater, midday shade & docks', hot: 'Deep structure 15-30ft, early morning best' },
  },
  'Smallmouth Bass': {
    lures: {
      cold: ['Tube Jig', 'Hair Jig', 'Blade Bait', 'Jigging Spoon'],
      mild: ['Ned Rig', 'Grub', 'Inline Spinner', 'Jerkbait', 'Crankbait'],
      warm: ['Topwater Popper', 'Tube Bait', 'Crankbait', 'Swimbait', 'Drop Shot'],
      hot: ['Deep Crankbait', 'Drop Shot', 'Football Jig', 'Finesse Worm'],
    },
    baits: ['Crawfish', 'Hellgrammites', 'Minnows', 'Leeches', 'Nightcrawlers'],
    depthTips: { cold: 'Slow presentation near rocky bottom 15-25ft', mild: 'Rocky points & current breaks 5-15ft', warm: 'Current seams, riffles, shade pockets', hot: 'Deeper pools 15-25ft, fish early & late' },
  },
  'Striped Bass': {
    lures: {
      cold: ['Jigging Spoon', 'Bucktail Jig', 'Umbrella Rig', 'Blade Bait'],
      mild: ['Bucktail Jig', 'Swimbait', 'Rattletrap', 'Topwater Plug'],
      warm: ['Topwater Plug', 'Popper', 'Swimbait', 'Umbrella Rig'],
      hot: ['Jigging Spoon', 'Live Bait Rig', 'Downline Rig', 'Umbrella Rig'],
    },
    baits: ['Live Shad', 'Cut Bait (Bunker)', 'Eels', 'Bloodworms', 'Spot'],
    depthTips: { cold: 'Find bait schools with electronics 20-40ft', mild: 'Follow baitfish, work points & ledges 10-25ft', warm: 'Dawn/dusk surface blitzes, midday deep', hot: 'Thermocline depth 25-45ft, trolling effective' },
  },
  'Channel Catfish': {
    lures: {
      cold: ['Jig tipped with bait'], mild: ['Jig tipped with bait'], warm: ['Jig tipped with bait'], hot: ['Jig tipped with bait'],
    },
    baits: ['Chicken Liver', 'Stink Bait', 'Nightcrawlers', 'Cut Shad', 'Hot Dogs', 'Punch Bait'],
    depthTips: { cold: 'Deep holes 15-30ft, slow presentation', mild: 'Channel edges, near structure 8-20ft', warm: 'Flats & channel edges, night fishing excellent', hot: 'Deep channels, night fishing best' },
  },
  'Bluegill': {
    lures: {
      cold: ['Small Jig (1/32oz)', 'Ice Fly', 'Tiny Grub'],
      mild: ['Small Spinner', 'Beetle Spin', 'Micro Jig', 'Small Popper'],
      warm: ['Popper', 'Spider', 'Beetle Spin', 'Fly (Woolly Bugger)'],
      hot: ['Small Jig under float', 'Tiny Crankbait', 'Fly (Nymph)'],
    },
    baits: ['Worms (pieces)', 'Crickets', 'Wax Worms', 'Bread Balls', 'Corn'],
    depthTips: { cold: 'Deeper water 10-15ft, very slow', mild: 'Beds near shore 2-6ft during spawn', warm: 'Shallow cover, docks, brush piles 3-8ft', hot: 'Shade & deeper brush 6-12ft' },
  },
  'Crappie': {
    lures: {
      cold: ['Small Tube Jig', 'Hair Jig (1/16oz)', 'Tiny Grub'],
      mild: ['Crappie Jig', 'Small Minnow Bait', 'Tube Jig', 'Bobby Garland'],
      warm: ['Small Jig under float', 'Small Crankbait', 'Road Runner'],
      hot: ['Deep Jig', 'Spider Rig Jigs', 'Small Spoon'],
    },
    baits: ['Minnows', 'Wax Worms', 'Small Shiners', 'Crickets'],
    depthTips: { cold: 'Suspend near structure 15-25ft', mild: 'Brush piles & docks 5-12ft, spider rig effective', warm: 'Spawning flats 3-8ft, then transition to docks', hot: 'Deep brush piles 15-25ft, early morning shallower' },
  },
  'Walleye': {
    tempBrackets: { cold: [35, 48], mild: [48, 60], warm: [60, 72], hot: [72, 85] },
    lures: {
      cold: ['Blade Bait', 'Hair Jig', 'Jigging Spoon'],
      mild: ['Crankbait', 'Jerkbait', 'Spinner Rig'],
      warm: ['Deep Crankbait', 'Worm Harness', 'Swimbait'],
      hot: ['Deep Crankbait', 'Live Bait Rig'],
    },
    baits: ['Live minnows', 'Nightcrawlers', 'Leeches'],
    depthTips: { cold: 'Deep structure 15-30ft, slow jigging presentations', mild: 'Transition banks 8-15ft, trolling crankbaits', warm: 'Points and humps 10-20ft, bottom bouncers', hot: 'Deepest structure 20-35ft, early morning or night fishing' },
    tips: ['Best bite is low light — dawn, dusk, and overcast days', 'Claytor Lake (VA) is the primary VA walleye fishery', 'Slow presentations in cold water — barely move the bait', 'Trolling crankbaits along creek channels in spring is very effective'],
  },
  'Muskie': {
    lures: {
      cold: ['Jerkbait (slow)', 'Large Sucker Rig', 'Glide Bait'],
      mild: ['Bucktail Spinner', 'Jerkbait', 'Crankbait', 'Topwater Plug'],
      warm: ['Topwater Plug', 'Large Bucktail', 'Bull Dawg', 'Jerkbait'],
      hot: ['Deep Crankbait', 'Large Swimbait', 'Rubber Bait (slow roll)'],
    },
    baits: ['Large Suckers (live)', 'Large Shiners'],
    depthTips: { cold: 'Slow down, work deep weed edges 15-25ft', mild: 'Weed lines, points, figure-8 at boat', warm: 'Weed flats, topwater early/late, figure-8', hot: 'Deeper structure 20-30ft, dawn/dusk windows' },
  },
  'Rainbow Trout': {
    lures: {
      cold: ['Small Spoon', 'Inline Spinner (slow)', 'Nymph Fly'],
      mild: ['Inline Spinner (Rooster Tail)', 'Small Spoon', 'Dry Fly', 'Nymph'],
      warm: ['Inline Spinner', 'Small Crankbait', 'Fly (Streamer)', 'Nymph'],
      hot: ['Deep Nymph', 'Small Spoon', 'Fly (Nymph)'],
    },
    baits: ['PowerBait', 'Nightcrawlers', 'Salmon Eggs', 'Corn', 'Wax Worms'],
    depthTips: { cold: 'Pools & slow runs 3-8ft, dead drift', mild: 'Riffles & runs, drift presentation', warm: 'Shade, deeper pools, early morning feedlines', hot: 'Deep pools only, early morning — trout stress above 68°F water' },
  },
  'Brown Trout': {
    lures: {
      cold: ['Jerkbait', 'Small Spoon', 'Streamer Fly', 'Nymph'],
      mild: ['Inline Spinner', 'Jerkbait', 'Streamer', 'Soft Hackle Fly'],
      warm: ['Streamer (sculpin)', 'Crankbait', 'Inline Spinner', 'Mouse Fly (night)'],
      hot: ['Deep Nymph', 'Streamer', 'Small Spoon'],
    },
    baits: ['Nightcrawlers', 'Minnows', 'Crawfish', 'Salmon Eggs'],
    depthTips: { cold: 'Slow & deep near undercuts & logjams', mild: 'Undercuts, deeper runs, structure-oriented', warm: 'Night fishing effective, work shaded structure', hot: 'Deep pools dawn only — browns need cool water' },
  },
  'Brook Trout': {
    lures: {
      cold: ['Tiny Spoon', 'Small Nymph', 'Micro Jig'],
      mild: ['Small Inline Spinner', 'Dry Fly (Elk Hair Caddis)', 'Nymph'],
      warm: ['Dry Fly', 'Tiny Spinner', 'Small Jig (1/32oz)'],
      hot: ['Deep Nymph'],
    },
    baits: ['Small Worms', 'Wax Worms', 'Single Salmon Egg'],
    depthTips: { cold: 'Plunge pools, behind rocks 2-5ft', mild: 'Pocket water, small pools, headwater streams', warm: 'Spring-fed areas, shaded headwaters only', hot: 'Find cold tributary inputs — brook trout are very heat-sensitive' },
  },
  'American Shad': {
    lures: {
      cold: ['Shad Dart (1/4oz)', 'Small Spoon', 'Shad Rig'],
      mild: ['Shad Dart', 'Small Jig', 'Flutter Spoon', 'Fly (Clouser Minnow)'],
      warm: ['Shad Dart', 'Small Spinner', 'Fly (shad pattern)'],
      hot: ['Deep Dart', 'Jigging Spoon'],
    },
    baits: ['Shad Darts (artificial best)', 'Small grubs'],
    depthTips: { cold: 'Below dams, deep channels', mild: 'Spring runs — below dams & rapids on rivers', warm: 'River channels, follow the schools', hot: 'Deep schooling areas, early morning surface' },
  },
  'White Perch': {
    lures: {
      cold: ['Small Jig', 'Blade Bait', 'Tiny Spoon'],
      mild: ['Small Spinner', 'Beetle Spin', 'Crappie Jig'],
      warm: ['Small Popper', 'Beetle Spin', 'Inline Spinner'],
      hot: ['Small Jig under float', 'Beetle Spin'],
    },
    baits: ['Bloodworms', 'Minnows', 'Nightcrawler pieces', 'Grass Shrimp'],
    depthTips: { cold: 'School up deep 15-25ft', mild: 'Tributaries & shallows for spawn run', warm: 'Docks, rip rap, shallow structure 3-10ft', hot: 'Deeper structure 10-20ft, shade areas' },
  },
  'Sunfish': {
    lures: {
      cold: ['Micro Jig', 'Ice Fly'],
      mild: ['Tiny Spinner', 'Beetle Spin', 'Small Popper'],
      warm: ['Small Popper', 'Spider', 'Micro Jig'],
      hot: ['Small Jig under float', 'Tiny Grub'],
    },
    baits: ['Worm pieces', 'Crickets', 'Bread', 'Wax Worms'],
    depthTips: { cold: 'Slow near bottom 8-12ft', mild: 'Shallow beds 2-5ft during spawn', warm: 'Shade, docks, brush 3-8ft', hot: 'Deeper shade 6-12ft' },
  },
  'Herring': {
    lures: {
      cold: ['Sabiki Rig', 'Small Spoon'],
      mild: ['Sabiki Rig', 'Shad Dart', 'Tiny Spoon'],
      warm: ['Sabiki Rig'],
      hot: ['Sabiki Rig'],
    },
    baits: ['Small pieces of shrimp', 'Fishbites'],
    depthTips: { cold: 'Deep channels', mild: 'Spring spawning runs up rivers', warm: 'Mid-water schools', hot: 'Deep schools, early morning surface' },
  },
  'Rock Bass': {
    lures: {
      cold: ['Small Jig', 'Tiny Grub'],
      mild: ['Small Spinner', 'Grub', 'Tube Jig', 'Beetle Spin'],
      warm: ['Small Crankbait', 'Inline Spinner', 'Tube Jig'],
      hot: ['Small Jig', 'Grub'],
    },
    baits: ['Nightcrawlers', 'Minnows', 'Crawfish', 'Crickets'],
    depthTips: { cold: 'Rocky pools 6-12ft', mild: 'Rocky runs & pools 3-8ft', warm: 'Rocky shaded areas, undercuts', hot: 'Deeper rocky pools' },
  },
  'Creek Chub': {
    lures: {
      cold: ['Micro Jig'],
      mild: ['Tiny Spinner', 'Micro Jig', 'Dry Fly'],
      warm: ['Small Spinner', 'Dry Fly'],
      hot: ['Micro Jig'],
    },
    baits: ['Small worm pieces', 'Bread', 'Corn'],
    depthTips: { cold: 'Deeper pools', mild: 'Riffles & runs', warm: 'Shallow runs, pools', hot: 'Shaded pools' },
  },
  'Blue Catfish': {
    lures: {
      cold: ['Jig tipped with bait'], mild: ['Jig tipped with bait'], warm: ['Jig tipped with bait'], hot: ['Jig tipped with bait'],
    },
    baits: ['Cut Gizzard Shad', 'Cut Skipjack Herring', 'Live Shad', 'Fresh Cut Bait (Bunker)', 'Chicken Liver'],
    depthTips: { cold: 'Deep channel ledges 20-40ft, anchor and wait', mild: 'Channel edges & hard bottom 15-30ft', warm: 'Main channel ledges, bridge pilings 10-25ft, night fishing productive', hot: 'Deep channels 20-40ft, fish at night for best action' },
  },
  'Speckled Trout': {
    lures: {
      cold: ['Jig tipped with bait', 'Small Jig', 'Suspending Minnow'],
      mild: ['Jerkbait', 'Small Jig', 'Grub', 'Popper'],
      warm: ['Topwater Plug', 'Popper', 'Swimbait', 'Grub', 'Jerkbait'],
      hot: ['Swimbait', 'Grub', 'Small Jig', 'Topwater Plug'],
    },
    baits: ['Live Shrimp', 'Live Mud Minnows', 'Cut Mullet', 'Fishbites'],
    depthTips: { cold: 'Deep holes & channels 8-15ft, slow presentation', mild: 'Grass flats & oyster bars 3-8ft, work edges', warm: 'Grass flats at dawn/dusk 2-5ft, shade at midday', hot: 'Deeper grass edges 4-8ft, early morning topwater' },
  },
  'Red Drum': {
    lures: {
      cold: ['Jig tipped with bait', 'Small Jig', 'Grub'],
      mild: ['Spinnerbait', 'Grub', 'Swimbait', 'Small Spoon'],
      warm: ['Small Spoon', 'Topwater Plug', 'Swimbait', 'Grub'],
      hot: ['Small Spoon', 'Swimbait', 'Topwater Plug', 'Popper'],
    },
    baits: ['Cut Blue Crab', 'Live Shrimp', 'Cut Mullet', 'Live Mud Minnows', 'Fishbites'],
    depthTips: { cold: 'Deep holes & channels 10-20ft, slow bait on bottom', mild: 'Oyster bars, marsh edges, flats 2-6ft', warm: 'Shallow flats & marsh drains 1-4ft at dawn/dusk, sight fish', hot: 'Early/late shallow flats, midday deeper structure 6-12ft' },
  },
  'Flounder': {
    lures: {
      cold: ['Jig tipped with bait', 'Small Jig'],
      mild: ['Grub', 'Swimbait', 'Bucktail Jig'],
      warm: ['Bucktail Jig', 'Grub', 'Swimbait', 'Inline Spinner'],
      hot: ['Bucktail Jig', 'Grub', 'Swimbait'],
    },
    baits: ['Live Mud Minnows', 'Live Finger Mullet', 'Strip Bait (Bluefish belly)', 'Gulp Swimming Mullet'],
    depthTips: { cold: 'Offshore — flounder migrate out in winter', mild: 'Inlets & channel edges 5-15ft as fish migrate in', warm: 'Sandy bottom near structure 3-10ft, work the tide changes', hot: 'Inlets, bridges, dock pilings 5-15ft, incoming tide best' },
  },
  'Hickory Shad': {
    tempBrackets: { cold: [45, 55], mild: [55, 65], warm: [65, 72], hot: [72, 85] },
    lures: {
      cold: ['Small Shad Dart', 'Gold Spoon'],
      mild: ['Shad Dart', 'Small Jig', 'Gold Spoon'],
      warm: ['Shad Dart', 'Small Inline Spinner'],
      hot: ['Shad Dart'],
    },
    baits: ['Small pieces of shad', 'Bloodworms'],
    depthTips: { cold: 'Deep pools below dams 8-15ft', mild: 'Mid-depth runs 4-8ft below rapids', warm: 'Current seams near dam tailraces', hot: 'Deep holes near cold water inputs' },
    tips: ['Fish below dams during spring run (March-May)', 'Use ultralight gear — 4-6lb test', 'Shad darts in white, chartreuse, or pink are standard', 'Cast upstream and let drift naturally through current'],
  },
  'Carp': {
    tempBrackets: { cold: [40, 55], mild: [55, 68], warm: [68, 80], hot: [80, 95] },
    lures: {
      cold: ['Small Hair Jig'],
      mild: ['Bread Fly', 'Corn Fly'],
      warm: ['Surface Bread', 'Corn Fly'],
      hot: ['Surface Bread'],
    },
    baits: ['Sweet corn (canned)', 'Bread', 'Boilies', 'Dough balls', 'Nightcrawlers'],
    depthTips: { cold: 'Deep slow pools 6-12ft, bottom rigs', mild: 'Shallow flats 2-6ft where they feed on bottom', warm: 'Visible cruising fish in shallows 1-4ft', hot: 'Shaded banks, deeper pools, early morning flats' },
    tips: ['Pack bait (ground corn mix) in the swim to attract fish', 'Use a hair rig for best hookup ratio', 'Strong gear needed — 15-20lb line minimum for big James River carp', 'Sight fishing with bread on the surface is exciting in warm months'],
  },
  'Spotted Bass': {
    tempBrackets: { cold: [42, 55], mild: [55, 68], warm: [68, 80], hot: [80, 90] },
    lures: {
      cold: ['Ned Rig', 'Small Jerkbait', 'Hair Jig'],
      mild: ['Grub', 'Small Crankbait', 'Drop Shot'],
      warm: ['Topwater', 'Crankbait', 'Swimbait'],
      hot: ['Deep Crankbait', 'Drop Shot', 'Ned Rig'],
    },
    baits: ['Crawfish', 'Hellgrammites', 'Minnows'],
    depthTips: { cold: 'Deep bluffs and ledges 12-25ft', mild: 'Rocky points and current breaks 6-15ft', warm: 'Current seams, rocky banks 3-10ft', hot: 'Deep ledges and shade 15-25ft, early morning topwater on shoals' },
    tips: ['Very common in New River, upper James, and Roanoke River', 'Prefer more current than largemouth — fish the flow', 'Smaller profile baits than largemouth — downsize everything', 'Often found mixed with smallmouth in rocky river sections'],
  },
};

// Accept optional waterTemp (from USGS) — use it when available, fall back to adjusted air temp.
// Water temp thresholds: <50 cold, 50-65 mild, 65-78 warm, >78 hot
// Air temp thresholds (proxy): <50 cold, 50-68 mild, 68-82 warm, >82 hot
function getTempBracket(airTemp, waterTemp) {
  const t = waterTemp != null ? waterTemp : airTemp;
  const thresholds = waterTemp != null
    ? [50, 65, 78]   // water temp boundaries
    : [50, 68, 82];  // air temp proxy boundaries
  if (t < thresholds[0]) return 'cold';
  if (t < thresholds[1]) return 'mild';
  if (t < thresholds[2]) return 'warm';
  return 'hot';
}

// Check if trout species are at thermal stress risk
function getTroutStressWarning(weather, species, waterTemp) {
  const troutSpecies = ['Rainbow Trout', 'Brown Trout', 'Brook Trout'];
  if (!troutSpecies.includes(species)) return null;
  const effectiveTemp = waterTemp != null ? waterTemp : weather.temp;
  // Water temp thresholds; use air temp as rough proxy if no water data
  const stressThreshold = waterTemp != null ? 68 : 75; // 68°F water = stress, ~75°F air proxy
  if (effectiveTemp >= stressThreshold) {
    return {
      level: effectiveTemp >= (waterTemp != null ? 72 : 82) ? 'critical' : 'warning',
      message: waterTemp != null
        ? `Water temperature is ${waterTemp}°F — trout are thermally stressed above 68°F. Consider not fishing for trout to avoid fish mortality.`
        : `Air temperature is ${weather.temp}°F — water may exceed 68°F. Check water temp before targeting trout. Trout die from catch-and-release stress in warm water.`,
    };
  }
  return null;
}

function getRecommendation(species, weather, waterTemp) {
  const data = SPECIES_DATA[species];
  if (!data) return null;

  const bracket = getTempBracket(weather.temp, waterTemp);
  const lureNames = data.lures[bracket] || data.lures.mild;
  const depthTip = data.depthTips[bracket] || '';
  const clarity = getWaterClarity(weather);

  // Trout thermal stress check
  const troutStress = getTroutStressWarning(weather, species, waterTemp);

  // Build detailed lure list with specs
  const lures = lureNames.map(name => {
    const detail = LURE_DB[name];
    if (!detail) return { name, detail: null };
    const colors = detail.colors[clarity] || detail.colors.clear;
    return { name, detail, colors, clarity };
  });

  // Weather-specific tips
  const tips = [];
  if (weather.pressureTrend === 'falling') tips.push('Falling barometer — fish tend to feed aggressively before a front');
  else if (weather.pressureTrend === 'low') tips.push('Low pressure — fish may be sluggish, slow your presentation');
  else if (weather.pressureTrend === 'stable') tips.push('Stable pressure — consistent bite likely');
  else tips.push('High pressure — fish may hold tight to cover, finesse approach');

  if (weather.cloudCover > 70) tips.push('Overcast skies — fish more willing to roam & chase, great conditions');
  else if (weather.cloudCover < 20) tips.push('Clear skies — target shade, cover, and deeper water');

  if (weather.windSpeed >= 8 && weather.windSpeed <= 18) tips.push(`Wind ${weather.windSpeed} mph — creates ripple that helps hide your line, fish windblown banks`);
  else if (weather.windSpeed > 18) tips.push(`Strong wind ${weather.windSpeed} mph — tough conditions, fish sheltered spots`);

  if (weather.precipitation > 0 && weather.precipitation < 0.15) tips.push('Light rain — excellent! Breaks surface tension, washes food in');
  else if (weather.precipitation >= 0.15) tips.push('Rain — muddy water likely, use brighter colors & rattling baits');

  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 8) tips.push('Early morning — prime feeding window');
  else if (hour >= 17 && hour <= 20) tips.push('Evening — fish moving shallow to feed');
  else if (hour >= 11 && hour <= 14) tips.push('Midday — fish often deeper or holding tight to structure');

  return { species, bracket, lures, baits: data.baits, depthTip, tips, activity: weather.fishActivity, clarity, troutStress };
}

// ===== HTML Renderers =====

function getWeatherCardHtml(weather) {
  const activityColor = weather.fishActivity >= 65 ? '#2ecc71' : weather.fishActivity >= 45 ? '#f39c12' : '#e74c3c';
  const activityLabel = weather.fishActivity >= 65 ? 'Excellent' : weather.fishActivity >= 55 ? 'Good' : weather.fishActivity >= 40 ? 'Fair' : 'Poor';
  const windDirLabel = degToCompass(weather.windDir);
  const moon = getMoonPhase();

  return `
    <div class="detail-section">
      <h3>Current Weather</h3>
      <div class="data-grid">
        <div class="data-card"><div class="label">Temperature</div><div class="value temp">${weather.temp}°F</div><div style="font-size:0.65rem;color:var(--text-muted)">Feels ${weather.feelsLike}°F</div></div>
        <div class="data-card"><div class="label">Fish Activity <span class="info-tip" onclick="this.nextElementSibling.classList.toggle('hidden');event.stopPropagation()">?</span><span class="info-tip-popup hidden">Based on barometric pressure, cloud cover, wind, temperature, moon phase, and time of day</span></div><div class="value" style="color:${activityColor}">${weather.fishActivity}/100</div><div style="font-size:0.65rem;color:${activityColor}">${activityLabel}</div></div>
        <div class="data-card"><div class="label">Conditions</div><div class="value" style="font-size:0.9rem">${weather.conditions}</div></div>
        <div class="data-card"><div class="label">Wind</div><div class="value" style="font-size:0.9rem">${weather.windSpeed} mph ${windDirLabel}</div><div style="font-size:0.65rem;color:var(--text-muted)">Gusts ${weather.windGusts} mph</div></div>
        <div class="data-card"><div class="label">Pressure</div><div class="value" style="font-size:0.9rem">${weather.pressureMsl} mb</div><div style="font-size:0.65rem;color:var(--text-muted)">${weather.pressureTrend}</div></div>
        <div class="data-card"><div class="label">Moon Phase</div><div class="value" style="font-size:1.2rem">${moon.emoji}</div><div style="font-size:0.65rem;color:var(--text-muted)">${moon.name} (${moon.illumination}%)</div></div>
      </div>
    </div>
  `;
}

function getRecommendationHtml(rec) {
  const clarityLabel = { clear: 'Clear Water', stained: 'Stained Water', muddy: 'Muddy Water' };

  const stressHtml = rec.troutStress
    ? `<div class="trout-stress-warning ${rec.troutStress.level === 'critical' ? 'stress-critical' : 'stress-warning'}">${rec.troutStress.message}</div>`
    : '';

  return `
    <div class="detail-section tackle-rec">
      <h3>Recommended for ${rec.species}</h3>
      ${stressHtml}
      <div class="clarity-badge">${clarityLabel[rec.clarity] || 'Clear Water'} — colors adjusted</div>

      <div class="rec-subsection">
        <h4>Lures & Artificials — Tap for Details</h4>
        <div class="lure-list">
          ${rec.lures.map((l, i) => {
            if (!l.detail) return `<div class="lure-item-simple"><span class="rec-tag lure-tag">${l.name}</span></div>`;
            return `
              <div class="lure-card">
                <div class="lure-card-header">
                  <span class="lure-card-name">${l.name}</span>
                  <span class="lure-card-toggle">+</span>
                </div>
                <div class="lure-card-detail">
                  <div class="lure-spec-grid">
                    <div class="lure-spec"><span class="lure-spec-label">Weight</span><span class="lure-spec-value">${l.detail.weight}</span></div>
                    <div class="lure-spec"><span class="lure-spec-label">Size</span><span class="lure-spec-value">${l.detail.size}</span></div>
                  </div>
                  <div class="lure-spec-section">
                    <span class="lure-spec-label">Best Colors (${rec.clarity})</span>
                    <div class="lure-colors">${l.colors.map(c => `<span class="color-chip">${c}</span>`).join('')}</div>
                  </div>
                  <div class="lure-spec-section">
                    <span class="lure-spec-label">How to Rig</span>
                    <p class="lure-spec-text">${l.detail.rig}</p>
                  </div>
                  <div class="lure-spec-section">
                    <span class="lure-spec-label">Retrieve / Technique</span>
                    <p class="lure-spec-text">${l.detail.retrieve}</p>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="rec-subsection">
        <h4>Live/Natural Bait</h4>
        <div class="rec-tags">${rec.baits.map(b => `<span class="rec-tag bait-tag">${b}</span>`).join('')}</div>
      </div>

      <div class="rec-subsection">
        <h4>Depth & Approach</h4>
        <p class="rec-depth-tip">${rec.depthTip}</p>
      </div>

      <div class="rec-subsection">
        <h4>Conditions Tips</h4>
        <ul class="rec-tips">${rec.tips.map(t => `<li>${t}</li>`).join('')}</ul>
      </div>
    </div>
  `;
}

function degToCompass(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

export {
  fetchWeather,
  getRecommendation,
  getWeatherCardHtml,
  getRecommendationHtml,
  SPECIES_DATA,
  rateFishActivity,
  getTempBracket,
  getWaterClarity,
  degToCompass,
  getMoonPhase,
  getPressureTrend,
  getBestFishingTimes,
  getBestTimesHtml,
  isTidalWater,
  findNearestTideStation,
  fetchTidePredictions,
  getTideHtml,
};
