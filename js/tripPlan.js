/**
 * Trip Planner — forecast weather, traffic estimation, gear checklist.
 * Uses Open-Meteo hourly forecast API (free, no key, 7-day horizon).
 */

import {
  getRecommendation, SPECIES_DATA, rateFishActivity,
  getTempBracket, getWaterClarity, degToCompass,
} from './fishing.js';

// ===== Hourly Forecast =====

const TIME_WINDOWS = {
  morning: { label: 'Morning (5 AM – 10 AM)', start: 5, end: 10 },
  midday:  { label: 'Midday (10 AM – 3 PM)',  start: 10, end: 15 },
  evening: { label: 'Evening (3 PM – 9 PM)',   start: 15, end: 21 },
};

async function fetchForecast(lat, lon, date, timeWindow) {
  const win = TIME_WINDOWS[timeWindow] || TIME_WINDOWS.morning;
  const dateStr = formatDate(date);

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation_probability', 'precipitation', 'weather_code',
      'cloud_cover', 'pressure_msl', 'wind_speed_10m',
      'wind_direction_10m', 'wind_gusts_10m',
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/New_York',
    start_date: dateStr,
    end_date: dateStr,
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Forecast API error: ${res.status}`);

  const json = await res.json();
  const h = json.hourly;
  if (!h || !h.time) throw new Error('No hourly forecast data');

  // Filter to time window hours
  const indices = [];
  for (let i = 0; i < h.time.length; i++) {
    const hour = new Date(h.time[i]).getHours();
    if (hour >= win.start && hour < win.end) indices.push(i);
  }

  if (indices.length === 0) throw new Error('No data for time window');

  // Average/aggregate across window
  const avg = (arr) => indices.reduce((s, i) => s + (arr[i] || 0), 0) / indices.length;
  const max = (arr) => Math.max(...indices.map(i => arr[i] || 0));
  const mode = (arr) => {
    const counts = {};
    indices.forEach(i => { const v = arr[i]; counts[v] = (counts[v] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  };

  const forecast = {
    temp: Math.round(avg(h.temperature_2m)),
    feelsLike: Math.round(avg(h.apparent_temperature)),
    humidity: Math.round(avg(h.relative_humidity_2m)),
    precipitation: parseFloat(avg(h.precipitation).toFixed(2)),
    precipProbability: Math.round(max(h.precipitation_probability || [])),
    cloudCover: Math.round(avg(h.cloud_cover)),
    pressureMsl: Math.round(avg(h.pressure_msl) * 10) / 10,
    windSpeed: Math.round(avg(h.wind_speed_10m)),
    windGusts: Math.round(max(h.wind_gusts_10m)),
    windDir: Math.round(avg(h.wind_direction_10m)),
    weatherCode: parseInt(mode(h.weather_code)) || 0,
    date: dateStr,
    timeWindow,
    timeWindowLabel: win.label,
  };

  // Add derived fields
  forecast.pressureTrend = forecast.pressureMsl > 1022 ? 'high'
    : forecast.pressureMsl > 1013 ? 'stable'
    : forecast.pressureMsl > 1005 ? 'falling' : 'low';
  forecast.conditions = describeCode(forecast.weatherCode);
  forecast.fishActivity = rateFishActivity(forecast);

  return forecast;
}

function describeCode(code) {
  const c = { 0:'Clear',1:'Mostly Clear',2:'Partly Cloudy',3:'Overcast',45:'Fog',48:'Freezing Fog',51:'Light Drizzle',53:'Drizzle',55:'Heavy Drizzle',61:'Light Rain',63:'Rain',65:'Heavy Rain',71:'Light Snow',73:'Snow',75:'Heavy Snow',80:'Showers',81:'Mod. Showers',82:'Heavy Showers',95:'Thunderstorm',96:'T-Storm + Hail',99:'Severe T-Storm' };
  return c[code] || 'Unknown';
}

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d + 'T12:00:00');
  return dt.toISOString().split('T')[0];
}

function friendlyDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}

// ===== Traffic Estimation =====

const HOLIDAYS_2026 = [
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25',
  '2026-07-03','2026-07-04','2026-07-05',
  '2026-09-07','2026-11-26','2026-11-27','2026-12-25',
];

function estimateTraffic(dateStr, timeWindow) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun, 6=Sat
  const month = d.getMonth(); // 0-indexed
  const isWeekend = dow === 0 || dow === 6;
  const isFriday = dow === 5;
  const isHoliday = HOLIDAYS_2026.includes(dateStr);
  const isSummer = month >= 4 && month <= 8; // May-Sep

  let score = 30; // baseline
  const reasons = [];

  if (isWeekend) { score += 30; reasons.push('Weekend'); }
  else if (isFriday) { score += 15; reasons.push('Friday'); }
  else { reasons.push('Weekday'); }

  if (isHoliday) { score += 25; reasons.push('Holiday'); }

  if (isSummer) { score += 15; reasons.push('Peak season'); }
  else if (month >= 2 && month <= 3) { score += 5; reasons.push('Early spring'); }

  if (timeWindow === 'morning') {
    if (isWeekend) { score += 10; reasons.push('Popular morning slot'); }
  } else if (timeWindow === 'evening') {
    score += 5; reasons.push('Evening bite window');
  }

  let level, description;
  if (score >= 70) {
    level = 'high';
    description = `Expect crowds. ${reasons.join(' + ')}. Arrive early for parking.`;
  } else if (score >= 45) {
    level = 'moderate';
    description = `Moderate traffic. ${reasons.join(' + ')}. Shouldn't be too bad.`;
  } else {
    level = 'low';
    description = `Light traffic. ${reasons.join(' + ')}. Great time to go.`;
  }

  return { level, description, score };
}

// ===== Gear Checklist =====

function generateGearChecklist(speciesList, forecast, waterType) {
  const allLures = [];
  const allBaits = new Set();
  const depthTips = [];
  const weatherTips = new Set();
  const seenLures = new Set();

  for (const species of speciesList) {
    const rec = getRecommendation(species, forecast);
    if (!rec) continue;

    for (const lure of rec.lures) {
      if (!seenLures.has(lure.name)) {
        seenLures.add(lure.name);
        allLures.push(lure);
      }
    }
    rec.baits.forEach(b => allBaits.add(b));
    if (rec.depthTip) depthTips.push({ species, tip: rec.depthTip });
    rec.tips.forEach(t => weatherTips.add(t));
  }

  // Essentials based on forecast
  const essentials = ['Fishing license', 'Tackle box', 'Rod & reel', 'Line clippers', 'Pliers'];

  if (forecast.precipProbability > 40 || forecast.precipitation > 0.05) {
    essentials.push('Rain jacket/poncho');
  }
  if (forecast.cloudCover < 40) {
    essentials.push('Sunscreen', 'Sunglasses (polarized)', 'Hat');
  }
  if (forecast.temp < 50) {
    essentials.push('Warm layers', 'Gloves');
  } else if (forecast.temp > 80) {
    essentials.push('Plenty of water', 'Bug spray');
  }
  if (forecast.windSpeed > 15) {
    essentials.push('Windbreaker');
  }
  essentials.push('Cooler/snacks', 'First aid kit', 'Phone charger');

  return {
    lures: allLures,
    baits: Array.from(allBaits),
    depthTips,
    weatherTips: Array.from(weatherTips),
    essentials,
  };
}

// ===== HTML Renderers =====

function getForecastCardHtml(forecast) {
  const actColor = forecast.fishActivity >= 70 ? '#2ecc71' : forecast.fishActivity >= 45 ? '#f39c12' : '#e74c3c';
  const actLabel = forecast.fishActivity >= 70 ? 'Excellent' : forecast.fishActivity >= 55 ? 'Good' : forecast.fishActivity >= 40 ? 'Fair' : 'Poor';
  const windDir = degToCompass(forecast.windDir);

  return `
    <div class="forecast-card">
      <div class="forecast-header">
        <span class="forecast-date">${friendlyDate(forecast.date)}</span>
        <span class="forecast-window">${forecast.timeWindowLabel}</span>
      </div>
      <div class="data-grid">
        <div class="data-card"><div class="label">Temperature</div><div class="value temp">${forecast.temp}°F</div><div style="font-size:0.65rem;color:var(--text-muted)">Feels ${forecast.feelsLike}°F</div></div>
        <div class="data-card"><div class="label">Fish Activity</div><div class="value" style="color:${actColor}">${forecast.fishActivity}/100</div><div style="font-size:0.65rem;color:${actColor}">${actLabel}</div></div>
        <div class="data-card"><div class="label">Conditions</div><div class="value" style="font-size:0.9rem">${forecast.conditions}</div></div>
        <div class="data-card"><div class="label">Rain Chance</div><div class="value" style="font-size:0.9rem">${forecast.precipProbability || 0}%</div></div>
        <div class="data-card"><div class="label">Wind</div><div class="value" style="font-size:0.9rem">${forecast.windSpeed} mph ${windDir}</div><div style="font-size:0.65rem;color:var(--text-muted)">Gusts ${forecast.windGusts} mph</div></div>
        <div class="data-card"><div class="label">Pressure</div><div class="value" style="font-size:0.9rem">${forecast.pressureMsl} mb</div><div style="font-size:0.65rem;color:var(--text-muted)">${forecast.pressureTrend}</div></div>
      </div>
    </div>
  `;
}

function getTrafficBadgeHtml(traffic) {
  const colors = { low: '#2ecc71', moderate: '#f39c12', high: '#e74c3c' };
  const icons = { low: 'Smooth', moderate: 'Moderate', high: 'Busy' };
  return `
    <div class="traffic-badge" style="border-color:${colors[traffic.level]}">
      <span class="traffic-level" style="color:${colors[traffic.level]}">${icons[traffic.level]} Traffic</span>
      <span class="traffic-desc">${traffic.description}</span>
    </div>
  `;
}

function getGearChecklistHtml(checklist, clarity) {
  const clarityLabel = { clear: 'Clear Water', stained: 'Stained Water', muddy: 'Muddy Water' };

  let html = '';

  // Lures
  if (checklist.lures.length > 0) {
    html += `
      <div class="gear-section">
        <h4>Lures & Artificials</h4>
        ${clarity ? `<div class="clarity-badge">${clarityLabel[clarity] || 'Clear Water'} — colors adjusted</div>` : ''}
        <div class="lure-list">
          ${checklist.lures.map(l => {
            if (!l.detail) return `<div class="lure-item-simple"><span class="rec-tag lure-tag">${l.name}</span></div>`;
            const colors = l.colors || l.detail.colors?.clear || [];
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
                    <span class="lure-spec-label">Best Colors</span>
                    <div class="lure-colors">${colors.map(c => `<span class="color-chip">${c}</span>`).join('')}</div>
                  </div>
                  <div class="lure-spec-section">
                    <span class="lure-spec-label">How to Rig</span>
                    <p class="lure-spec-text">${l.detail.rig}</p>
                  </div>
                  <div class="lure-spec-section">
                    <span class="lure-spec-label">Retrieve</span>
                    <p class="lure-spec-text">${l.detail.retrieve}</p>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Baits
  if (checklist.baits.length > 0) {
    html += `
      <div class="gear-section">
        <h4>Live/Natural Bait</h4>
        <div class="rec-tags">${checklist.baits.map(b => `<span class="rec-tag bait-tag">${b}</span>`).join('')}</div>
      </div>
    `;
  }

  // Depth tips
  if (checklist.depthTips.length > 0) {
    html += `
      <div class="gear-section">
        <h4>Depth & Approach</h4>
        ${checklist.depthTips.map(d => `<p class="rec-depth-tip"><strong>${d.species}:</strong> ${d.tip}</p>`).join('')}
      </div>
    `;
  }

  // Weather tips
  if (checklist.weatherTips.length > 0) {
    html += `
      <div class="gear-section">
        <h4>Conditions Tips</h4>
        <ul class="rec-tips">${checklist.weatherTips.map(t => `<li>${t}</li>`).join('')}</ul>
      </div>
    `;
  }

  // Essentials
  html += `
    <div class="gear-section">
      <h4>Essentials Checklist</h4>
      <div class="essentials-list">
        ${checklist.essentials.map(item => `
          <label class="essential-item"><input type="checkbox"><span>${item}</span></label>
        `).join('')}
      </div>
    </div>
  `;

  return html;
}

function getTripSummaryCardHtml(plan) {
  const traffic = plan.traffic || estimateTraffic(plan.trip_date, plan.time_window);
  const trafficColors = { low: '#2ecc71', moderate: '#f39c12', high: '#e74c3c' };

  return `
    <div class="trip-summary-card" data-trip-id="${plan.id}">
      <div class="trip-summary-header">
        <div>
          <div class="trip-summary-name">${plan.place_name}</div>
          <div class="trip-summary-date">${friendlyDate(plan.trip_date)} &middot; ${(TIME_WINDOWS[plan.time_window] || {}).label || plan.time_window}</div>
        </div>
        <span class="trip-status-badge trip-status-${plan.status}">${plan.status}</span>
      </div>
      <div class="trip-summary-meta">
        ${plan.forecast ? `<span class="trip-meta-item temp">${plan.forecast.temp}°F ${plan.forecast.conditions}</span>` : ''}
        <span class="trip-meta-item" style="color:${trafficColors[traffic.level || plan.traffic_estimate]}">${(traffic.level || plan.traffic_estimate || 'unknown')} traffic</span>
        ${plan.forecast ? `<span class="trip-meta-item" style="color:${plan.forecast.fishActivity >= 55 ? '#2ecc71' : '#f39c12'}">Activity: ${plan.forecast.fishActivity}/100</span>` : ''}
      </div>
      ${plan.species?.length ? `<div class="trip-species-chips">${plan.species.map(s => `<span class="species-chip-small">${s}</span>`).join('')}</div>` : ''}
      ${plan.notes ? `<div class="trip-notes-preview">${plan.notes}</div>` : ''}
    </div>
  `;
}

export {
  TIME_WINDOWS,
  fetchForecast,
  estimateTraffic,
  generateGearChecklist,
  getForecastCardHtml,
  getTrafficBadgeHtml,
  getGearChecklistHtml,
  getTripSummaryCardHtml,
  friendlyDate,
  formatDate,
};
