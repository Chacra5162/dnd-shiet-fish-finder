/**
 * WaterWay Finder — Main App
 * PWA for discovering nearby water bodies with real-time USGS data.
 * Focused on Virginia & North Carolina. Supabase auth + user places.
 */

import { fetchWaterBodies, fetchUSGSSites, getFishingLinks, getCommonSpecies, getBBox, distanceMiles, assessPrivateProperty } from './api.js';
import { initMap, setMarkers, updateFilters, updateRadius, recenter, panTo, findNearbyUSGS, setUserPlaceMarkers } from './map.js';
import { initAuth, signUp, signIn, signOut, getUser, getUserPlacesNear, savePlace, removePlace, updatePlaceNotes, getPlaceStatuses, saveTripPlan, getUserTripPlans, updateTripPlan, deleteTripPlan } from './supabase.js';
import { fetchWeather, getRecommendation, getWeatherCardHtml, getRecommendationHtml, SPECIES_DATA, getWaterClarity, getBestFishingTimes, getBestTimesHtml, isTidalWater, findNearestTideStation, fetchTidePredictions, getTideHtml } from './fishing.js';
import { TIME_WINDOWS, fetchForecast, estimateTraffic, generateGearChecklist, getForecastCardHtml, getTrafficBadgeHtml, getGearChecklistHtml, getTripSummaryCardHtml, friendlyDate } from './tripPlan.js';
import { CATEGORIES, getArsenalItems, addArsenalItem, updateArsenalItem, deleteArsenalItem, getPhotoUrl, filterItems, getUniqueColors, getUniqueWeights } from './arsenal.js';

// ===== State =====
let userLat = 37.54; // Default: Richmond, VA
let userLon = -77.43;
let radiusMiles = 20;
let waterBodies = [];
let usgsSites = [];
let userPlaces = []; // cached user places for current area
let currentPlacesTab = 'favorite';
let userTrips = [];
let currentTripsTab = 'upcoming';
// Trip plan wizard state
let tripWizard = { wb: null, forecast: null, traffic: null, selectedSpecies: [] };
// Arsenal state
let arsenalItems = [];
let arsenalFilters = { category: 'all', color: '', weight: '', search: '' };
let hideUnnamed = localStorage.getItem('wwf_hide_unnamed') === 'true';

// ===== DOM refs =====
const $ = (sel) => document.querySelector(sel);
const loadingScreen = $('#loading-screen');
const loadingStatus = $('#loading-status');
const filterPanel = $('#filter-panel');
const detailPanel = $('#detail-panel');
const detailContent = $('#detail-content');
const infoModal = $('#info-modal');
const authModal = $('#auth-modal');
const arsenalPanel = $('#arsenal-panel');
const arsenalGrid = $('#arsenal-grid');
const arsenalFormModal = $('#arsenal-form-modal');
const tripModal = $('#trip-modal');
const tripsPanel = $('#trips-panel');
const tripsList = $('#trips-list');
const placesPanel = $('#places-panel');
const placesList = $('#places-list');
const toastContainer = $('#toast-container');
const radiusSlider = $('#radius-slider');
const radiusValue = $('#radius-value');

// ===== Water Type Preferences =====
// Stored in localStorage so user only picks once (can change via filter)
const PREF_KEY = 'wwf_water_prefs';
let waterTypePrefs = null; // null = not chosen yet, array = chosen types

function loadPrefs() {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored) {
      waterTypePrefs = JSON.parse(stored);
      // Add new types to existing prefs so returning users see them
      const newTypes = ['boat_landing', 'fishing_pier'];
      let updated = false;
      for (const t of newTypes) {
        if (!waterTypePrefs.includes(t)) {
          waterTypePrefs.push(t);
          updated = true;
        }
      }
      if (updated) localStorage.setItem(PREF_KEY, JSON.stringify(waterTypePrefs));
    }
  } catch {}
}

function savePrefs(types) {
  waterTypePrefs = types;
  localStorage.setItem(PREF_KEY, JSON.stringify(types));
  // Also sync the filter panel checkboxes
  filterPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const t = cb.dataset.type;
    if (t === 'usgs') { cb.checked = true; return; }
    cb.checked = types.includes(t);
  });
}

function showWaterTypeChooser() {
  return new Promise((resolve) => {
    const chooser = $('#water-type-chooser');
    chooser.classList.remove('hidden');

    const submit = $('#btn-chooser-go');
    const handler = () => {
      const checked = [...chooser.querySelectorAll('input:checked')].map(c => c.dataset.type);
      if (checked.length === 0) {
        toast('Pick at least one type', true);
        return;
      }
      submit.removeEventListener('click', handler);
      chooser.classList.add('hidden');
      savePrefs(checked);
      resolve(checked);
    };
    submit.addEventListener('click', handler);
  });
}

// ===== Init =====
async function init() {
  preventPageZoom();
  registerServiceWorker();
  setupEventListeners();
  setupAuth();
  loadPrefs();

  // Geolocate
  loadingStatus.textContent = 'Finding your location...';
  const located = await geolocate();

  if (!located) {
    toast('Using default location (Richmond, VA)');
  }

  // Check we're in VA/NC range
  if (userLat < 33.5 || userLat > 40 || userLon < -85 || userLon > -74) {
    toast('App is optimized for VA/NC — showing nearest area', true);
    userLat = 37.54;
    userLon = -77.43;
  }

  // Hide loading screen before showing chooser
  loadingScreen.classList.add('fade-out');
  setTimeout(() => { loadingScreen.style.display = 'none'; }, 600);

  // If first time, ask what they want to see
  if (!waterTypePrefs) {
    await showWaterTypeChooser();
  }

  initMap(userLat, userLon, radiusMiles);

  await loadData();
}

// ===== Auth =====

function setupAuth() {
  initAuth((user, event) => {
    updateAuthUI(user);
    if (user && (event === 'SIGNED_IN' || event === 'INITIAL')) {
      loadUserPlaces();
      loadUserTrips();
    }
    if (event === 'SIGNED_OUT') {
      userPlaces = [];
      userTrips = [];
    }
  });
}

function updateAuthUI(user) {
  const btn = $('#btn-account');
  if (user) {
    const name = user.user_metadata?.display_name || user.email?.split('@')[0] || 'User';
    btn.innerHTML = `<span class="user-badge">${escapeHtml(name)}</span>`;
    btn.title = `Signed in as ${name}`;
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor"/></svg>';
    btn.title = 'Sign in';
  }
}

async function loadUserPlaces() {
  const user = getUser();
  if (!user) return;
  try {
    userPlaces = await getUserPlacesNear(userLat, userLon, 0.5);
    refreshUserPlaceMarkers();
  } catch (e) {
    console.warn('Failed to load user places:', e);
  }
}

function refreshUserPlaceMarkers() {
  setUserPlaceMarkers(userPlaces, (place) => {
    // Find matching water body and show detail, or just pan
    const wb = waterBodies.find(w =>
      w.name === place.place_name && Math.abs(w.lat - place.lat) < 0.002 && Math.abs(w.lon - place.lon) < 0.002
    );
    if (wb) {
      const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
      showWaterDetail(wb, dist);
    } else {
      panTo(place.lat, place.lon, 14);
      toast(`${place.place_name} — ${place.status}`);
    }
  });
}

// ===== Geolocation =====

async function geolocate() {
  if (!navigator.geolocation) return false;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        toast(`Located: ${userLat.toFixed(4)}, ${userLon.toFixed(4)}`);
        resolve(true);
      },
      (err) => {
        console.warn('Geolocation failed:', err.message);
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  });
}

// ===== Data Loading =====

async function loadData() {
  const bbox = getBBox(userLat, userLon, radiusMiles);

  try {
    const [waterResult, usgsResult] = await Promise.allSettled([
      fetchWaterBodies(bbox.south, bbox.west, bbox.north, bbox.east),
      fetchUSGSSites(bbox.south, bbox.west, bbox.north, bbox.east),
    ]);

    if (waterResult.status === 'fulfilled') {
      waterBodies = waterResult.value.data;
      if (waterResult.value.fromCache) toast('Water bodies loaded from cache');
    } else {
      console.error('Water body fetch failed:', waterResult.reason);
      toast('Failed to load water bodies', true);
      waterBodies = [];
    }

    if (usgsResult.status === 'fulfilled') {
      usgsSites = usgsResult.value.data;
      if (usgsResult.value.fromCache) toast('USGS data loaded from cache');
    } else {
      console.error('USGS fetch failed:', usgsResult.reason);
      toast('Failed to load USGS data', true);
      usgsSites = [];
    }

    // Filter to within radius and user type preferences
    waterBodies = waterBodies.filter(wb => {
      if (distanceMiles(userLat, userLon, wb.lat, wb.lon) > radiusMiles) return false;
      if (waterTypePrefs && !waterTypePrefs.includes(wb.type)) return false;
      return true;
    });
    usgsSites = usgsSites.filter(s =>
      distanceMiles(userLat, userLon, s.lat, s.lon) <= radiusMiles
    );

    // Count unnamed before filtering so we can show the suggestion
    const unnamedCount = waterBodies.filter(wb => isUnnamed(wb.name)).length;

    // Apply unnamed filter
    if (hideUnnamed) {
      waterBodies = waterBodies.filter(wb => !isUnnamed(wb.name));
    }

    // If lots of unnamed entries, suggest filtering (one-time)
    if (!hideUnnamed && unnamedCount > 20 && !localStorage.getItem('wwf_unnamed_dismissed')) {
      setTimeout(() => showUnnamedSuggestion(unnamedCount), 1500);
    }

    setMarkers(waterBodies, usgsSites, userLat, userLon, showWaterDetail, showUSGSDetail);
    refreshUserPlaceMarkers();

    toast(`Found ${waterBodies.length} water bodies, ${usgsSites.length} USGS stations`);

  } catch (err) {
    console.error('Load error:', err);
    toast('Error loading data — try again later', true);
  }
}

// ===== Place Actions (Favorite / Visited / Avoid) =====

function getPlaceStatusHtml(wb) {
  const user = getUser();
  if (!user) {
    return `
      <div class="place-actions">
        <button class="place-action-btn" onclick="document.dispatchEvent(new CustomEvent('require-auth'))">
          Sign in to save this place
        </button>
      </div>
    `;
  }

  // Check current statuses from cached userPlaces
  const statuses = userPlaces.filter(p =>
    p.place_name === wb.name &&
    Math.abs(p.lat - wb.lat) < 0.002 &&
    Math.abs(p.lon - wb.lon) < 0.002
  );
  const statusSet = new Set(statuses.map(s => s.status));
  const getRecord = (status) => statuses.find(s => s.status === status);

  const favActive = statusSet.has('favorite') ? ' active-favorite' : '';
  const visActive = statusSet.has('visited') ? ' active-visited' : '';
  const avoidActive = statusSet.has('avoid') ? ' active-avoid' : '';

  const notes = statuses.find(s => s.notes)?.notes || '';
  const anyRecordId = statuses[0]?.id || '';

  return `
    <div class="place-actions" data-wb='${escapeAttr(JSON.stringify({ name: wb.name, type: wb.type, lat: wb.lat, lon: wb.lon, id: wb.id }))}'>
      <button class="place-action-btn${favActive}" data-action="favorite" onclick="window._placeAction(this)">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="currentColor"/></svg>
        Favorite
      </button>
      <button class="place-action-btn${visActive}" data-action="visited" onclick="window._placeAction(this)">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
        Visited
      </button>
      <button class="place-action-btn${avoidActive}" data-action="avoid" onclick="window._placeAction(this)">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" fill="currentColor"/></svg>
        Avoid
      </button>
    </div>
    <div class="place-notes-section">
      <textarea class="place-notes-input" placeholder="Add personal notes about this spot..." data-wb-name="${escapeAttr(wb.name)}" data-wb-lat="${wb.lat}" data-wb-lon="${wb.lon}">${escapeHtml(notes)}</textarea>
      ${statusSet.size === 0 ? '<div class="notes-hint">Mark as favorite, visited, or avoid first to save notes</div>' : ''}
      <button class="place-notes-save" onclick="window._saveNotes(this)">Save Notes</button>
    </div>
  `;
}

// Global handlers for inline onclick (needed since we use innerHTML)
window._placeAction = async function(btn) {
  const user = getUser();
  if (!user) {
    authModal.classList.remove('hidden');
    return;
  }

  const container = btn.closest('.place-actions');
  const wb = JSON.parse(container.dataset.wb);
  const action = btn.dataset.action;
  const isActive = btn.classList.contains(`active-${action}`);

  try {
    if (isActive) {
      // Find and remove
      const record = userPlaces.find(p =>
        p.place_name === wb.name &&
        p.status === action &&
        Math.abs(p.lat - wb.lat) < 0.002 &&
        Math.abs(p.lon - wb.lon) < 0.002
      );
      if (record) {
        await removePlace(record.id);
        userPlaces = userPlaces.filter(p => p.id !== record.id);
        btn.classList.remove(`active-${action}`);
        toast(`Removed from ${action}`);
      }
    } else {
      // Save
      const saved = await savePlace(wb, action);
      userPlaces.push(saved);
      btn.classList.add(`active-${action}`);
      toast(`Marked as ${action}`);
    }
    refreshUserPlaceMarkers();
  } catch (e) {
    console.error('Place action error:', e);
    toast(`Error: ${e.message}`, true);
  }
};

window._saveNotes = async function(btn) {
  const user = getUser();
  if (!user) {
    authModal.classList.remove('hidden');
    return;
  }

  const textarea = btn.previousElementSibling;
  const notes = textarea.value.trim();
  const wbName = textarea.dataset.wbName;
  const wbLat = parseFloat(textarea.dataset.wbLat);
  const wbLon = parseFloat(textarea.dataset.wbLon);

  // Find any existing record to update
  const record = userPlaces.find(p =>
    p.place_name === wbName &&
    Math.abs(p.lat - wbLat) < 0.002 &&
    Math.abs(p.lon - wbLon) < 0.002
  );

  try {
    if (record) {
      await updatePlaceNotes(record.id, notes);
      record.notes = notes;
      toast('Notes saved');
    } else {
      toast('Mark this place first (favorite/visited/avoid), then save notes');
    }
  } catch (e) {
    toast(`Error saving notes: ${e.message}`, true);
  }
};

// ===== Detail Panels =====

async function showWaterDetail(wb, dist) {
  const nearbyUSGS = findNearbyUSGS(wb.lat, wb.lon, 10);
  const links = getFishingLinks(wb.lat, wb.lon, wb.type, wb.name);
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon);
  const typeLabel = { lake: 'Lake / Reservoir', river: 'River', stream: 'Stream / Creek', pond: 'Pond', boat_landing: 'Boat Landing', fishing_pier: 'Fishing Pier' };

  let html = `
    <h2>${escapeHtml(wb.name)}</h2>
    <span class="detail-type-badge badge-${wb.type}">${typeLabel[wb.type] || wb.type}</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
  `;

  // Private property warning
  const access = assessPrivateProperty(wb);
  if (access.likely) {
    const icon = access.confidence === 'high'
      ? '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/></svg>';
    const cls = access.confidence === 'high' ? 'access-warn-high' : 'access-warn-med';
    html += `
      <div class="access-warning ${cls}">
        ${icon}
        <div>
          <strong>${access.confidence === 'high' ? 'Private Property' : 'Access Uncertain'}</strong>
          <span>${escapeHtml(access.reason)}. Always verify you have permission before accessing.</span>
        </div>
      </div>
    `;
  } else if (access.reason && access.confidence !== 'low') {
    html += `
      <div class="access-warning access-info">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
        <div><span>${escapeHtml(access.reason)}</span></div>
      </div>
    `;
  }

  // Place actions (favorite / visited / avoid)
  html += getPlaceStatusHtml(wb);

  // Plan a Trip button
  html += `
    <button class="btn-plan-trip" onclick="window._openTripPlan('${escapeAttr(JSON.stringify({ name: wb.name, type: wb.type, lat: wb.lat, lon: wb.lon, id: wb.id }))}')">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z" fill="currentColor"/></svg>
      Plan a Day on the Water
    </button>
  `;

  // Species selector — clickable chips that load tackle recs
  html += `
    <div class="detail-section">
      <h3>Species — Tap for What to Use</h3>
      <div class="species-selector" id="species-selector">
        ${species.map((s, i) => `<button class="species-chip" data-species="${escapeAttr(s)}" onclick="window._selectSpecies(this, ${wb.lat}, ${wb.lon})" disabled>${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>
  `;

  // Weather + best times + tide placeholder (loaded async)
  html += `<div id="weather-rec-area"><div class="loading-inline">Loading weather data...</div></div>`;
  html += `<div id="best-times-area"></div>`;

  // Tidal placeholder (only shown for tidal waters)
  const isTidal = isTidalWater(wb.lat, wb.lon, wb.type);
  if (isTidal) {
    html += `<div id="tide-area"><div class="loading-inline">Loading tide data...</div></div>`;
  }

  // Tags info
  if (wb.tags) {
    const useful = [];
    if (wb.tags.fishing) useful.push(['Fishing', wb.tags.fishing]);
    if (wb.tags.access) useful.push(['Access', wb.tags.access]);
    if (wb.tags.boat) useful.push(['Boat Access', wb.tags.boat]);
    if (wb.tags.leisure) useful.push(['Leisure', wb.tags.leisure]);
    if (wb.tags.sport) useful.push(['Sport', wb.tags.sport]);

    if (useful.length > 0) {
      html += `
        <div class="detail-section">
          <h3>Details</h3>
          <div class="data-grid">
            ${useful.map(([label, val]) => `
              <div class="data-card">
                <div class="label">${escapeHtml(label)}</div>
                <div class="value">${escapeHtml(val)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
  }

  // Nearby USGS
  if (nearbyUSGS.length > 0) {
    html += `
      <div class="detail-section">
        <h3>Nearby USGS Monitoring</h3>
        <div class="nearby-usgs-list">
          ${nearbyUSGS.map(s => {
            const dataSnippets = [];
            if (s.data.temp) dataSnippets.push(`${s.data.temp.value}${s.data.temp.unit}`);
            if (s.data.flow) dataSnippets.push(`${s.data.flow.value} ${s.data.flow.unit}`);
            if (s.data.gauge) dataSnippets.push(`${s.data.gauge.value} ${s.data.gauge.unit}`);
            const dataStr = dataSnippets.length > 0 ? ` — ${dataSnippets.join(', ')}` : '';
            return `
              <div class="nearby-usgs-item" onclick="document.dispatchEvent(new CustomEvent('show-usgs', {detail:'${s.siteCode}'}))">
                <div class="station-name">${escapeHtml(s.name)}</div>
                <div class="station-dist">${s.dist.toFixed(1)} mi from ${escapeHtml(wb.name)}${dataStr}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Links with separate Google & Apple Maps
  const linkIcon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>`;
  html += `
    <div class="detail-section">
      <h3>Resources</h3>
      <div class="detail-links">
        ${links.map(l => `
          <a href="${l.url}" target="_blank" rel="noopener" class="detail-link">
            ${linkIcon}
            ${escapeHtml(l.label)}
          </a>
        `).join('')}
      </div>
    </div>
  `;

  html += `
    <div style="margin-top:16px; font-size:0.75rem; color:var(--text-muted);">
      ${wb.lat.toFixed(5)}, ${wb.lon.toFixed(5)}
    </div>
  `;

  detailContent.innerHTML = html;
  detailPanel.classList.remove('hidden');
  panTo(wb.lat, wb.lon, 13);

  // Async: fetch weather, best times, and tides
  loadWeatherForDetail(wb.lat, wb.lon, wb.type);
}

// Fetch weather, best times, and tides for the detail panel
async function loadWeatherForDetail(lat, lon, waterType) {
  const area = document.getElementById('weather-rec-area');
  if (!area) return;

  try {
    const weather = await fetchWeather(lat, lon);
    area.innerHTML = getWeatherCardHtml(weather);
    window._currentWeather = weather;

    // Enable species chips now that weather is loaded
    document.querySelectorAll('#species-selector .species-chip').forEach(btn => btn.disabled = false);

    // Best fishing times
    const timesArea = document.getElementById('best-times-area');
    if (timesArea) {
      const times = getBestFishingTimes(weather);
      timesArea.innerHTML = getBestTimesHtml(times);
    }
  } catch (e) {
    console.warn('Weather fetch failed:', e);
    area.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Weather data unavailable</p>';
    window._currentWeather = null;
  }

  // Load tides if applicable (independent of weather)
  loadTidesForDetail(lat, lon, waterType);
}

async function loadTidesForDetail(lat, lon, waterType) {
  const tideArea = document.getElementById('tide-area');
  if (!tideArea) return;

  const station = findNearestTideStation(lat, lon);
  if (!station) { tideArea.innerHTML = ''; return; }

  try {
    const tideData = await fetchTidePredictions(station.id);
    tideArea.innerHTML = getTideHtml(tideData, station.name);
  } catch (e) {
    console.warn('Tide fetch failed:', e);
    tideArea.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Tide data unavailable</p>';
  }
}

// Species chip click handler
window._selectSpecies = async function(btn, lat, lon) {
  // Toggle active state
  const wasActive = btn.classList.contains('species-active');
  document.querySelectorAll('.species-chip').forEach(c => c.classList.remove('species-active'));

  // Remove any existing recommendation
  const existing = document.getElementById('species-rec');
  if (existing) existing.remove();

  if (wasActive) return; // just deselect

  btn.classList.add('species-active');
  const species = btn.dataset.species;

  // Get or fetch weather
  let weather = window._currentWeather;
  if (!weather) {
    try {
      weather = await fetchWeather(lat, lon);
      window._currentWeather = weather;
      // Also update weather card if it failed before
      const area = document.getElementById('weather-rec-area');
      if (area && area.querySelector('.loading-inline')) {
        area.innerHTML = getWeatherCardHtml(weather);
      }
    } catch {
      // Show rec without weather-specific tips
      weather = { temp: 65, cloudCover: 50, windSpeed: 5, pressureMsl: 1015, pressureTrend: 'stable', fishActivity: 50, precipitation: 0, windGusts: 8 };
    }
  }

  const rec = getRecommendation(species, weather);
  if (!rec) return;

  // Insert recommendation after the species selector section
  const recDiv = document.createElement('div');
  recDiv.id = 'species-rec';
  recDiv.innerHTML = getRecommendationHtml(rec);

  const selector = document.getElementById('species-selector');
  if (selector && selector.parentElement) {
    selector.parentElement.after(recDiv);
    // Scroll into view on mobile
    setTimeout(() => recDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  }
};

function showUSGSDetail(site, dist) {
  const links = getFishingLinks(site.lat, site.lon, 'river', site.name);

  let html = `
    <h2>${escapeHtml(site.name)}</h2>
    <span class="detail-type-badge badge-usgs">USGS Station</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">Site #${site.siteCode}</div>
  `;

  // Real-time data
  const dataEntries = Object.entries(site.data || {});
  if (dataEntries.length > 0) {
    html += `
      <div class="detail-section">
        <h3>Current Conditions</h3>
        <div class="data-grid">
          ${dataEntries.map(([key, d]) => {
            const colorClass = key === 'temp' ? 'temp' : key === 'flow' ? 'flow' : 'gauge';
            const time = d.dateTime ? new Date(d.dateTime).toLocaleString() : '';
            return `
              <div class="data-card">
                <div class="label">${escapeHtml(d.name)}</div>
                <div class="value ${colorClass}">${d.value} ${d.unit}</div>
                ${time ? `<div style="font-size:0.65rem; color:var(--text-muted); margin-top:2px;">${time}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else {
    html += `
      <div class="detail-section">
        <p style="color:var(--text-muted); font-size:0.9rem;">No current data available for this station.</p>
      </div>
    `;
  }

  // Links
  html += `
    <div class="detail-section">
      <h3>Resources</h3>
      <div class="detail-links">
        <a href="https://waterdata.usgs.gov/nwis/uv?site_no=${site.siteCode}" target="_blank" rel="noopener" class="detail-link">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>
          USGS Station Data Page
        </a>
        <a href="https://waterdata.usgs.gov/nwis/inventory/?site_no=${site.siteCode}" target="_blank" rel="noopener" class="detail-link">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>
          Station Inventory &amp; History
        </a>
        ${links.map(l => `
          <a href="${l.url}" target="_blank" rel="noopener" class="detail-link">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>
            ${escapeHtml(l.label)}
          </a>
        `).join('')}
      </div>
    </div>
  `;

  html += `
    <div style="margin-top:16px; font-size:0.75rem; color:var(--text-muted);">
      ${site.lat.toFixed(5)}, ${site.lon.toFixed(5)}
    </div>
  `;

  detailContent.innerHTML = html;
  detailPanel.classList.remove('hidden');
  panTo(site.lat, site.lon, 14);
}

// ===== My Places Panel =====

function renderPlacesList() {
  const user = getUser();
  if (!user) {
    placesList.innerHTML = '<p class="places-empty">Sign in to save places</p>';
    return;
  }

  const filtered = userPlaces.filter(p => p.status === currentPlacesTab);

  if (filtered.length === 0) {
    const labels = { favorite: 'favorites', visited: 'visited places', avoid: 'places to avoid' };
    placesList.innerHTML = `<p class="places-empty">No ${labels[currentPlacesTab]} yet</p>`;
    return;
  }

  placesList.innerHTML = filtered.map(p => `
    <div class="place-list-item" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${escapeAttr(p.place_name)}" onclick="window._goToPlace(this)">
      <div>
        <div class="place-item-name">${escapeHtml(p.place_name)}</div>
        <div class="place-item-type">${p.place_type}</div>
        ${p.notes ? `<div class="place-item-notes">${escapeHtml(p.notes)}</div>` : ''}
      </div>
      <button class="place-item-remove" title="Remove" onclick="event.stopPropagation(); window._removeListPlace('${p.id}')">
        &times;
      </button>
    </div>
  `).join('');
}

window._goToPlace = function(el) {
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);
  const name = el.dataset.name;

  panTo(lat, lon, 14);
  placesPanel.classList.add('hidden');

  // Try to find and show the matching water body
  const wb = waterBodies.find(w =>
    w.name === name && Math.abs(w.lat - lat) < 0.002 && Math.abs(w.lon - lon) < 0.002
  );
  if (wb) {
    const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
    showWaterDetail(wb, dist);
  } else {
    toast('This water body may be filtered out or outside the current radius. Check your filters.', true);
  }
};

window._removeListPlace = async function(placeId) {
  try {
    await removePlace(placeId);
    userPlaces = userPlaces.filter(p => p.id !== placeId);
    renderPlacesList();
    toast('Place removed');
  } catch (e) {
    toast(`Error: ${e.message}`, true);
  }
};

// ===== Arsenal =====

async function loadArsenal() {
  const user = getUser();
  if (!user) return;
  try {
    arsenalItems = await getArsenalItems(user.id);
  } catch (e) {
    console.warn('Failed to load arsenal:', e);
  }
}

function openArsenal() {
  const user = getUser();
  if (!user) { authModal.classList.remove('hidden'); return; }
  arsenalPanel.classList.remove('hidden');
  populateArsenalFilters();
  renderArsenal();
}

function populateArsenalFilters() {
  // Category dropdown
  const catSelect = $('#arsenal-cat-filter');
  catSelect.innerHTML = '<option value="all">All Categories</option>' +
    Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

  // Color + weight dropdowns from current items
  const colorSelect = $('#arsenal-color-filter');
  const colors = getUniqueColors(arsenalItems);
  colorSelect.innerHTML = '<option value="">Any Color</option>' +
    colors.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

  const weightSelect = $('#arsenal-weight-filter');
  const weights = getUniqueWeights(arsenalItems);
  weightSelect.innerHTML = '<option value="">Any Weight</option>' +
    weights.map(w => `<option value="${escapeAttr(w)}">${escapeHtml(w)}</option>`).join('');
}

function renderArsenal() {
  const filtered = filterItems(arsenalItems, arsenalFilters);
  $('#arsenal-count').textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}${arsenalFilters.category !== 'all' || arsenalFilters.search ? ' (filtered)' : ''}`;

  if (filtered.length === 0) {
    arsenalGrid.innerHTML = arsenalItems.length === 0
      ? '<p class="places-empty">No items yet — tap + to add your first lure</p>'
      : '<p class="places-empty">No items match your filters</p>';
    return;
  }

  arsenalGrid.innerHTML = filtered.map(item => {
    const photoUrl = getPhotoUrl(item.photo_path);
    const catLabel = CATEGORIES[item.category] || item.category;
    const meta = [item.color, item.weight, item.brand].filter(Boolean).join(' · ');
    return `
      <div class="arsenal-card" onclick="window._viewArsenalItem('${item.id}')">
        <div class="arsenal-card-photo">
          ${photoUrl
            ? `<img src="${photoUrl}" alt="${escapeAttr(item.name)}" loading="lazy">`
            : '<span class="no-photo">🎣</span>'}
        </div>
        <div class="arsenal-card-info">
          <div class="arsenal-card-name">${escapeHtml(item.name)}</div>
          ${meta ? `<div class="arsenal-card-meta">${escapeHtml(meta)}</div>` : ''}
          <span class="arsenal-card-cat">${escapeHtml(catLabel)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function openArsenalForm(editItem) {
  const form = $('#arsenal-form');
  form.reset();
  $('#af-photo-preview').innerHTML = '<span class="no-photo-placeholder">No photo</span>';
  $('#af-edit-id').value = '';

  // Populate category dropdown
  const catSelect = $('#af-category');
  catSelect.innerHTML = Object.entries(CATEGORIES).map(([k, v]) =>
    `<option value="${k}">${v}</option>`
  ).join('');

  if (editItem) {
    $('#arsenal-form-title').textContent = 'Edit Item';
    $('#af-submit').textContent = 'Save Changes';
    $('#af-name').value = editItem.name;
    $('#af-category').value = editItem.category;
    $('#af-color').value = editItem.color || '';
    $('#af-weight').value = editItem.weight || '';
    $('#af-brand').value = editItem.brand || '';
    $('#af-size').value = editItem.size || '';
    $('#af-notes').value = editItem.notes || '';
    $('#af-edit-id').value = editItem.id;
    if (editItem.photo_path) {
      $('#af-photo-preview').innerHTML = `<img src="${getPhotoUrl(editItem.photo_path)}" alt="Current photo">`;
    }
  } else {
    $('#arsenal-form-title').textContent = 'Add to Arsenal';
    $('#af-submit').textContent = 'Add Item';
  }

  arsenalPanel.classList.add('hidden');
  arsenalFormModal.classList.remove('hidden');
}

window._viewArsenalItem = function(itemId) {
  const item = arsenalItems.find(i => i.id === itemId);
  if (!item) return;

  const photoUrl = getPhotoUrl(item.photo_path);
  const catLabel = CATEGORIES[item.category] || item.category;

  // Hide arsenal, show detail
  arsenalPanel.classList.add('hidden');

  detailContent.innerHTML = `
    ${photoUrl ? `<div style="margin:-20px -20px 12px;"><img src="${photoUrl}" alt="${escapeAttr(item.name)}" style="width:100%;max-height:250px;object-fit:cover;border-radius:12px 12px 0 0;"></div>` : ''}
    <h2>${escapeHtml(item.name)}</h2>
    <span class="detail-type-badge" style="background:var(--accent);color:#fff;">${escapeHtml(catLabel)}</span>
    ${item.brand ? `<span style="color:var(--text-muted);font-size:0.85rem;margin-left:8px;">${escapeHtml(item.brand)}</span>` : ''}

    <div class="data-grid" style="margin-top:12px;">
      ${item.color ? `<div class="data-card"><div class="label">Color</div><div class="value" style="font-size:0.9rem">${escapeHtml(item.color)}</div></div>` : ''}
      ${item.weight ? `<div class="data-card"><div class="label">Weight</div><div class="value" style="font-size:0.9rem">${escapeHtml(item.weight)}</div></div>` : ''}
      ${item.size ? `<div class="data-card"><div class="label">Size</div><div class="value" style="font-size:0.9rem">${escapeHtml(item.size)}</div></div>` : ''}
    </div>

    ${item.notes ? `<div class="detail-section"><h3>Notes</h3><p style="font-size:0.85rem;color:var(--text-muted);">${escapeHtml(item.notes)}</p></div>` : ''}

    <div class="arsenal-detail-actions">
      <button class="btn-secondary" onclick="window._editArsenalItem('${item.id}')">Edit</button>
      <button class="btn-secondary" onclick="window._backToArsenal()">Back to Arsenal</button>
      <button class="btn-secondary delete-btn" style="color:#e74c3c;border-color:rgba(231,76,60,0.3);" onclick="window._deleteArsenalItem('${item.id}','${escapeAttr(item.photo_path || '')}')">Delete</button>
    </div>
  `;
  detailPanel.classList.remove('hidden');
};

window._editArsenalItem = function(itemId) {
  const item = arsenalItems.find(i => i.id === itemId);
  if (!item) return;
  detailPanel.classList.add('hidden');
  openArsenalForm(item);
};

window._backToArsenal = function() {
  detailPanel.classList.add('hidden');
  arsenalPanel.classList.remove('hidden');
};

window._deleteArsenalItem = function(itemId, photoPath) {
  showInlineConfirm('Delete this item?', 'Delete', async () => {
  const user = getUser();
  if (!user) return;
  try {
    await deleteArsenalItem(user.id, itemId, photoPath || null);
    arsenalItems = arsenalItems.filter(i => i.id !== itemId);
    detailPanel.classList.add('hidden');
    arsenalPanel.classList.remove('hidden');
    renderArsenal();
    populateArsenalFilters();
    toast('Item deleted');
  } catch (e) {
    toast(`Error: ${e.message}`, true);
  }
  });
};

// ===== Trip Planner =====

window._openTripPlan = function(wbJson) {
  const user = getUser();
  if (!user) { authModal.classList.remove('hidden'); return; }

  const wb = JSON.parse(wbJson);
  tripWizard = { wb, forecast: null, traffic: null, selectedSpecies: [] };

  // Set up step 1
  $('#trip-place-preview').innerHTML = `
    <div class="trip-place-name">${escapeHtml(wb.name)}</div>
    <div class="trip-place-type">${wb.type}</div>
  `;

  // Set date min/max (today to +6 days for forecast)
  const today = new Date();
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 6);
  const dateInput = $('#trip-date');
  dateInput.min = today.toISOString().split('T')[0];
  dateInput.max = maxDate.toISOString().split('T')[0];
  dateInput.value = today.toISOString().split('T')[0];

  // Reset steps
  showTripStep(1);
  tripModal.classList.remove('hidden');
  detailPanel.classList.add('hidden');
};

function showTripStep(n) {
  [1, 2, 3].forEach(s => {
    const el = $(`#trip-step-${s}`);
    if (el) el.classList.toggle('hidden', s !== n);
  });
}

async function handleGetForecast() {
  const wb = tripWizard.wb;
  if (!wb) return;

  const dateVal = $('#trip-date').value;
  if (!dateVal) { toast('Pick a date', true); return; }

  const timeWindow = document.querySelector('input[name="trip-time"]:checked')?.value || 'morning';
  const btn = $('#btn-trip-forecast');
  btn.disabled = true;
  btn.textContent = 'Loading forecast...';

  try {
    const forecast = await fetchForecast(wb.lat, wb.lon, dateVal, timeWindow);
    const traffic = estimateTraffic(dateVal, timeWindow);
    tripWizard.forecast = forecast;
    tripWizard.traffic = traffic;

    $('#trip-forecast-area').innerHTML = getForecastCardHtml(forecast);
    $('#trip-traffic-area').innerHTML = getTrafficBadgeHtml(traffic);

    // Populate species selector
    const species = getCommonSpecies(wb.type, wb.lat, wb.lon);
    const selectorEl = $('#trip-species-selector');
    selectorEl.innerHTML = species.map(s =>
      `<button class="species-chip" data-species="${escapeAttr(s)}" onclick="window._toggleTripSpecies(this)">${escapeHtml(s)}</button>`
    ).join('');
    tripWizard.selectedSpecies = [];

    showTripStep(2);
  } catch (e) {
    console.error('Forecast error:', e);
    toast(`Forecast error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Forecast';
  }
}

window._toggleTripSpecies = function(btn) {
  const species = btn.dataset.species;
  const idx = tripWizard.selectedSpecies.indexOf(species);
  if (idx >= 0) {
    tripWizard.selectedSpecies.splice(idx, 1);
    btn.classList.remove('species-active');
  } else {
    if (tripWizard.selectedSpecies.length >= 3) {
      toast('Max 3 species', true);
      return;
    }
    tripWizard.selectedSpecies.push(species);
    btn.classList.add('species-active');
  }
};

function handleGeneratePlan() {
  const { wb, forecast, traffic, selectedSpecies } = tripWizard;
  if (!forecast) return;
  if (selectedSpecies.length === 0) {
    toast('Select at least one species', true);
    return;
  }

  const clarity = getWaterClarity(forecast);
  const gear = generateGearChecklist(selectedSpecies, forecast, wb.type);
  tripWizard.gearChecklist = gear;
  tripWizard.clarity = clarity;

  // Summary
  $('#trip-plan-summary').innerHTML = `
    <div class="forecast-card" style="margin-bottom:10px;">
      <div class="forecast-header">
        <span class="forecast-date">${escapeHtml(wb.name)}</span>
        <span class="forecast-window">${forecast.timeWindowLabel}</span>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;margin-top:6px;">
        <span class="trip-meta-item temp">${forecast.temp}°F ${forecast.conditions}</span>
        <span class="trip-meta-item" style="color:${traffic.level === 'low' ? '#2ecc71' : traffic.level === 'moderate' ? '#f39c12' : '#e74c3c'}">${traffic.level} traffic</span>
        <span class="trip-meta-item">Activity: ${forecast.fishActivity}/100</span>
      </div>
      <div style="margin-top:8px;">${selectedSpecies.map(s => `<span class="species-chip-small">${escapeHtml(s)}</span>`).join(' ')}</div>
    </div>
  `;

  // Gear checklist
  $('#trip-gear-area').innerHTML = getGearChecklistHtml(gear, clarity);
  $('#trip-notes').value = '';

  showTripStep(3);
}

async function handleSaveTrip() {
  const { wb, forecast, traffic, selectedSpecies, gearChecklist } = tripWizard;
  const btn = $('#btn-trip-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await saveTripPlan({
      placeName: wb.name,
      placeType: wb.type,
      lat: wb.lat,
      lon: wb.lon,
      osmId: wb.id,
      tripDate: forecast.date,
      timeWindow: forecast.timeWindow,
      forecast,
      trafficEstimate: traffic.level,
      trafficDescription: traffic.description,
      species: selectedSpecies,
      gearChecklist,
      notes: $('#trip-notes').value.trim(),
    });
    toast('Trip saved!');
    tripModal.classList.add('hidden');
    loadUserTrips();
  } catch (e) {
    toast(`Error saving: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Trip';
  }
}

// ===== My Trips Panel =====

async function loadUserTrips() {
  const user = getUser();
  if (!user) return;
  try {
    userTrips = await getUserTripPlans(currentTripsTab === 'past');
  } catch (e) {
    console.warn('Failed to load trips:', e);
  }
}

function renderTripsList() {
  const user = getUser();
  if (!user) {
    tripsList.innerHTML = '<p class="places-empty">Sign in to plan trips</p>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  let filtered;
  if (currentTripsTab === 'upcoming') {
    filtered = userTrips.filter(t => t.trip_date >= today && t.status === 'planned');
  } else {
    filtered = userTrips.filter(t => t.trip_date < today || t.status !== 'planned');
  }

  if (filtered.length === 0) {
    tripsList.innerHTML = `<p class="places-empty">No ${currentTripsTab} trips</p>`;
    return;
  }

  tripsList.innerHTML = filtered.map(t => `
    ${getTripSummaryCardHtml(t)}
    <div class="trip-actions" data-trip-id="${t.id}">
      ${t.status === 'planned' ? `
        <button class="trip-action-btn complete-btn" onclick="window._completeTripAction('${t.id}')">Complete</button>
        <button class="trip-action-btn" onclick="window._viewTripGear('${t.id}')">View Gear</button>
      ` : ''}
      <button class="trip-action-btn delete-btn" onclick="window._deleteTripAction('${t.id}')">Delete</button>
    </div>
  `).join('');
}

window._completeTripAction = async function(id) {
  try {
    await updateTripPlan(id, { status: 'completed' });
    const trip = userTrips.find(t => t.id === id);
    if (trip) trip.status = 'completed';
    renderTripsList();
    toast('Trip marked complete');
  } catch (e) { toast(`Error: ${e.message}`, true); }
};

window._deleteTripAction = function(id) {
  showInlineConfirm('Delete this trip?', 'Delete', async () => {
    try {
      await deleteTripPlan(id);
      userTrips = userTrips.filter(t => t.id !== id);
      renderTripsList();
      toast('Trip deleted');
    } catch (e) { toast(`Error: ${e.message}`, true); }
  });
};

window._viewTripGear = function(id) {
  const trip = userTrips.find(t => t.id === id);
  if (!trip || !trip.gear_checklist) { toast('No gear data'); return; }

  // Open a detail-like view
  const clarity = trip.forecast ? getWaterClarity(trip.forecast) : 'clear';
  detailContent.innerHTML = `
    <h2>${escapeHtml(trip.place_name)}</h2>
    <span class="detail-type-badge badge-${trip.place_type}">${trip.place_type}</span>
    <span style="color:var(--text-muted);font-size:0.85rem;margin-left:8px;">${friendlyDate(trip.trip_date)}</span>
    ${trip.forecast ? getForecastCardHtml(trip.forecast) : ''}
    ${getGearChecklistHtml(trip.gear_checklist, clarity)}
  `;
  detailPanel.classList.remove('hidden');
  tripsPanel.classList.add('hidden');
};

// ===== Event Listeners =====

function setupEventListeners() {
  // Filter panel
  $('#btn-filter').addEventListener('click', () => {
    filterPanel.classList.toggle('hidden');
    placesPanel.classList.add('hidden');
  });
  $('#btn-close-filter').addEventListener('click', () => {
    filterPanel.classList.add('hidden');
  });

  // Filter checkboxes
  filterPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const active = [...filterPanel.querySelectorAll('input:checked')].map(c => c.dataset.type).filter(Boolean);
      // Save water type prefs (exclude usgs from pref, it's always available)
      const waterTypes = active.filter(t => t !== 'usgs');
      if (waterTypes.length > 0) savePrefs(waterTypes);
      updateFilters(active, userLat, userLon, showWaterDetail, showUSGSDetail);
    });
  });

  // Unnamed filter checkbox
  const unnamedCb = document.getElementById('filter-hide-unnamed');
  if (unnamedCb) {
    unnamedCb.checked = hideUnnamed;
    unnamedCb.addEventListener('change', () => {
      hideUnnamed = unnamedCb.checked;
      localStorage.setItem('wwf_hide_unnamed', hideUnnamed ? 'true' : 'false');
      loadData();
    });
  }

  // Radius slider
  radiusSlider.addEventListener('input', () => {
    radiusValue.textContent = radiusSlider.value;
  });
  radiusSlider.addEventListener('change', async () => {
    radiusMiles = parseInt(radiusSlider.value);
    updateRadius(radiusMiles, userLat, userLon);
    await loadData();
  });

  // Detail panel close
  $('#btn-close-detail').addEventListener('click', () => {
    detailPanel.classList.add('hidden');
  });

  // Recenter
  $('#btn-recenter').addEventListener('click', async () => {
    const located = await geolocate();
    recenter(userLat, userLon);
    if (located) await loadData();
  });

  // Account button
  $('#btn-account').addEventListener('click', () => {
    const user = getUser();
    if (user) {
      // Show sign-out option
      showInlineConfirm(
        `Signed in as ${user.email}`,
        'Sign Out',
        () => signOut().then(() => {
          updateAuthUI(null);
          userPlaces = [];
          userTrips = [];
          toast('Signed out');
        })
      );
    } else {
      authModal.classList.remove('hidden');
    }
  });

  // Auth modal
  let isSignUp = false;
  $('#btn-close-auth').addEventListener('click', () => authModal.classList.add('hidden'));
  authModal.addEventListener('click', (e) => {
    if (e.target === authModal) authModal.classList.add('hidden');
  });

  $('#btn-auth-toggle').addEventListener('click', () => {
    isSignUp = !isSignUp;
    $('#auth-title').textContent = isSignUp ? 'Create Account' : 'Sign In';
    $('#auth-submit').textContent = isSignUp ? 'Sign Up' : 'Sign In';
    $('#auth-toggle-text').textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
    $('#btn-auth-toggle').textContent = isSignUp ? 'Sign In' : 'Sign Up';
    $('#auth-name-field').classList.toggle('hidden', !isSignUp);
    $('#auth-error').classList.add('hidden');
    if (isSignUp) {
      $('#auth-password').autocomplete = 'new-password';
    } else {
      $('#auth-password').autocomplete = 'current-password';
    }
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim();
    const errorEl = $('#auth-error');
    const submitBtn = $('#auth-submit');

    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = isSignUp ? 'Creating account...' : 'Signing in...';

    try {
      if (isSignUp) {
        const data = await signUp(email, password, name || email.split('@')[0]);
        if (data.user && !data.session) {
          // Email confirmation needed
          errorEl.textContent = 'Check your email for a confirmation link!';
          errorEl.style.background = 'rgba(46,204,113,0.15)';
          errorEl.style.borderColor = 'rgba(46,204,113,0.3)';
          errorEl.style.color = '#2ecc71';
          errorEl.classList.remove('hidden');
        } else {
          authModal.classList.add('hidden');
          toast('Account created!');
        }
      } else {
        await signIn(email, password);
        authModal.classList.add('hidden');
        toast('Signed in!');
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Authentication failed';
      errorEl.style.background = '';
      errorEl.style.borderColor = '';
      errorEl.style.color = '';
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
    }
  });

  // My Places panel
  $('#btn-my-places').addEventListener('click', () => {
    const user = getUser();
    if (!user) {
      authModal.classList.remove('hidden');
      return;
    }
    placesPanel.classList.toggle('hidden');
    filterPanel.classList.add('hidden');
    tripsPanel.classList.add('hidden');
    renderPlacesList();
  });
  $('#btn-close-places').addEventListener('click', () => {
    placesPanel.classList.add('hidden');
  });

  // Places tabs
  document.querySelectorAll('.places-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.places-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPlacesTab = tab.dataset.tab;
      renderPlacesList();
    });
  });

  // === Arsenal ===
  $('#btn-arsenal').addEventListener('click', async () => {
    await loadArsenal();
    openArsenal();
  });
  $('#btn-close-arsenal').addEventListener('click', () => arsenalPanel.classList.add('hidden'));
  $('#btn-arsenal-add').addEventListener('click', () => openArsenalForm(null));
  $('#btn-close-arsenal-form').addEventListener('click', () => {
    arsenalFormModal.classList.add('hidden');
    arsenalPanel.classList.remove('hidden');
  });
  arsenalFormModal.addEventListener('click', (e) => {
    if (e.target === arsenalFormModal) {
      arsenalFormModal.classList.add('hidden');
      arsenalPanel.classList.remove('hidden');
    }
  });

  // Arsenal filters
  ['arsenal-cat-filter', 'arsenal-color-filter', 'arsenal-weight-filter'].forEach(id => {
    $(`#${id}`).addEventListener('change', () => {
      arsenalFilters.category = $('#arsenal-cat-filter').value;
      arsenalFilters.color = $('#arsenal-color-filter').value;
      arsenalFilters.weight = $('#arsenal-weight-filter').value;
      renderArsenal();
    });
  });
  $('#arsenal-search').addEventListener('input', () => {
    arsenalFilters.search = $('#arsenal-search').value;
    renderArsenal();
  });

  // Arsenal photo preview
  $('#af-photo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        $('#af-photo-preview').innerHTML = `<img src="${ev.target.result}" alt="Preview">`;
      };
      reader.readAsDataURL(file);
    }
  });

  // Arsenal form submit
  $('#arsenal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = getUser();
    if (!user) return;

    const btn = $('#af-submit');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const photoFile = $('#af-photo').files[0] || null;
    const editId = $('#af-edit-id').value;

    const itemData = {
      name: $('#af-name').value.trim(),
      category: $('#af-category').value,
      color: $('#af-color').value.trim(),
      weight: $('#af-weight').value.trim(),
      brand: $('#af-brand').value.trim(),
      size: $('#af-size').value.trim(),
      notes: $('#af-notes').value.trim(),
    };

    try {
      if (editId) {
        const oldItem = arsenalItems.find(i => i.id === editId);
        const updated = await updateArsenalItem(user.id, editId, itemData, photoFile, oldItem?.photo_path);
        const idx = arsenalItems.findIndex(i => i.id === editId);
        if (idx >= 0) arsenalItems[idx] = updated;
        toast('Item updated');
      } else {
        const added = await addArsenalItem(user.id, itemData, photoFile);
        arsenalItems.push(added);
        toast('Item added to arsenal!');
      }
      arsenalFormModal.classList.add('hidden');
      arsenalPanel.classList.remove('hidden');
      populateArsenalFilters();
      renderArsenal();
    } catch (err) {
      toast(`Error: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = editId ? 'Save Changes' : 'Add Item';
    }
  });

  // === Trip Plan Modal ===
  $('#btn-close-trip').addEventListener('click', () => tripModal.classList.add('hidden'));
  tripModal.addEventListener('click', (e) => { if (e.target === tripModal) tripModal.classList.add('hidden'); });
  $('#btn-trip-forecast').addEventListener('click', handleGetForecast);
  $('#btn-trip-back-1').addEventListener('click', () => showTripStep(1));
  $('#btn-trip-generate').addEventListener('click', handleGeneratePlan);
  $('#btn-trip-back-2').addEventListener('click', () => showTripStep(2));
  $('#btn-trip-save').addEventListener('click', handleSaveTrip);

  // Lure card delegation in trip modal too
  tripModal.addEventListener('click', (e) => {
    const card = e.target.closest('.lure-card');
    if (card) { if (!e.target.closest('a')) card.classList.toggle('lure-expanded'); }
  });

  // === My Trips Panel ===
  $('#btn-my-trips').addEventListener('click', async () => {
    const user = getUser();
    if (!user) { authModal.classList.remove('hidden'); return; }
    tripsPanel.classList.toggle('hidden');
    filterPanel.classList.add('hidden');
    placesPanel.classList.add('hidden');
    await loadUserTrips();
    renderTripsList();
  });
  $('#btn-close-trips').addEventListener('click', () => tripsPanel.classList.add('hidden'));
  document.querySelectorAll('.trips-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.trips-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTripsTab = tab.dataset.tab;
      await loadUserTrips();
      renderTripsList();
    });
  });

  // Require-auth event
  document.addEventListener('require-auth', () => {
    authModal.classList.remove('hidden');
  });

  // Info modal
  $('#btn-info').addEventListener('click', () => {
    infoModal.classList.remove('hidden');
  });
  $('#btn-close-modal').addEventListener('click', () => {
    infoModal.classList.add('hidden');
  });
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) infoModal.classList.add('hidden');
  });

  // Custom event for clicking USGS from water body detail
  document.addEventListener('show-usgs', (e) => {
    const site = usgsSites.find(s => s.siteCode === e.detail);
    if (site) {
      const dist = distanceMiles(userLat, userLon, site.lat, site.lon);
      showUSGSDetail(site, dist);
    }
  });

  // Swipe down to close detail panel
  let touchStartY = 0;
  const handle = $('#detail-handle');
  handle.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  });
  handle.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 60) {
      detailPanel.classList.add('hidden');
    }
  });

  // Event delegation for lure card expand/collapse
  detailPanel.addEventListener('click', (e) => {
    const card = e.target.closest('.lure-card');
    if (card) {
      // Don't toggle if they clicked a link inside
      if (e.target.closest('a')) return;
      card.classList.toggle('lure-expanded');
    }
  });
}

// ===== Unnamed Water Body Filter =====

function isUnnamed(name) {
  if (!name) return true;
  const n = name.toLowerCase().trim();
  return n === '' || n === 'unnamed' || n.startsWith('unnamed ') || n === 'unknown' || n === 'no name';
}

function showUnnamedSuggestion(count) {
  const el = document.createElement('div');
  el.className = 'unnamed-suggestion';
  el.innerHTML = `
    <div class="unnamed-suggestion-inner">
      <p><strong>${count} unnamed water bodies</strong> are cluttering your map and slowing load times.</p>
      <div class="unnamed-suggestion-actions">
        <button class="btn-primary" id="btn-hide-unnamed" style="font-size:0.85rem;padding:8px 14px;">Hide Unnamed</button>
        <button class="btn-secondary" id="btn-dismiss-unnamed" style="font-size:0.85rem;padding:8px 14px;">Dismiss</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.querySelector('#btn-hide-unnamed').addEventListener('click', () => {
    hideUnnamed = true;
    localStorage.setItem('wwf_hide_unnamed', 'true');
    localStorage.setItem('wwf_unnamed_dismissed', '1');
    // Update the filter panel checkbox
    const cb = document.getElementById('filter-hide-unnamed');
    if (cb) cb.checked = true;
    el.remove();
    loadData();
  });
  el.querySelector('#btn-dismiss-unnamed').addEventListener('click', () => {
    localStorage.setItem('wwf_unnamed_dismissed', '1');
    el.remove();
  });

  // Auto-dismiss after 10 seconds
  setTimeout(() => { if (el.parentNode) el.remove(); }, 10000);
}

// ===== Utilities =====

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// In-app confirm dialog — replaces window.confirm() which is broken on iOS PWA
function showInlineConfirm(message, actionLabel, onConfirm) {
  // Remove any existing confirm
  const existing = document.getElementById('inline-confirm');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'inline-confirm';
  overlay.className = 'modal';
  overlay.style.zIndex = '5000';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:340px;text-align:center;">
      <p style="margin-bottom:16px;font-size:0.95rem;">${escapeHtml(message)}</p>
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" style="flex:1;" id="confirm-cancel">Cancel</button>
        <button class="btn-primary" style="flex:1;background:#e74c3c;" id="confirm-action">${escapeHtml(actionLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#confirm-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#confirm-action').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ===== Prevent Page Zoom (allow map zoom only) =====

function preventPageZoom() {
  // Block pinch-to-zoom on everything except the map
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 && !e.target.closest('#map')) {
      e.preventDefault();
    }
  }, { passive: false });

  // Block ctrl+scroll / ctrl+plus/minus zoom
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey && !e.target.closest('#map')) {
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      if (!e.target.closest('#map')) {
        e.preventDefault();
      }
    }
  });

  // Block double-tap zoom on non-map areas (iOS/Android)
  let lastTap = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300 && !e.target.closest('#map')) {
      e.preventDefault();
    }
    lastTap = now;
  }, { passive: false });
}

// ===== Service Worker =====

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
}

// ===== Start =====
init();
