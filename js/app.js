/**
 * WaterWay Finder — Main App
 * PWA for discovering nearby water bodies with real-time USGS data.
 * Focused on Virginia & North Carolina. Supabase auth + user places.
 */

import { fetchWaterBodies, fetchUSGSSites, getFishingLinks, getCommonSpecies, getBBox, distanceMiles } from './api.js';
import { initMap, setMarkers, updateFilters, updateRadius, recenter, panTo, findNearbyUSGS } from './map.js';
import { initAuth, signUp, signIn, signOut, getUser, getUserPlacesNear, savePlace, removePlace, updatePlaceNotes, getPlaceStatuses } from './supabase.js';
import { fetchWeather, getRecommendation, getWeatherCardHtml, getRecommendationHtml, SPECIES_DATA } from './fishing.js';

// ===== State =====
let userLat = 37.54; // Default: Richmond, VA
let userLon = -77.43;
let radiusMiles = 20;
let waterBodies = [];
let usgsSites = [];
let userPlaces = []; // cached user places for current area
let currentPlacesTab = 'favorite';

// ===== DOM refs =====
const $ = (sel) => document.querySelector(sel);
const loadingScreen = $('#loading-screen');
const loadingStatus = $('#loading-status');
const filterPanel = $('#filter-panel');
const detailPanel = $('#detail-panel');
const detailContent = $('#detail-content');
const infoModal = $('#info-modal');
const authModal = $('#auth-modal');
const placesPanel = $('#places-panel');
const placesList = $('#places-list');
const toastContainer = $('#toast-container');
const radiusSlider = $('#radius-slider');
const radiusValue = $('#radius-value');

// ===== Init =====
async function init() {
  registerServiceWorker();
  setupEventListeners();
  setupAuth();

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

  loadingStatus.textContent = 'Loading map...';
  initMap(userLat, userLon, radiusMiles);

  loadingStatus.textContent = 'Fetching water bodies...';
  await loadData();

  // Hide loading
  loadingScreen.classList.add('fade-out');
  setTimeout(() => { loadingScreen.style.display = 'none'; }, 600);
}

// ===== Auth =====

function setupAuth() {
  initAuth((user, event) => {
    updateAuthUI(user);
    if (user && (event === 'SIGNED_IN' || event === 'INITIAL')) {
      loadUserPlaces();
    }
    if (event === 'SIGNED_OUT') {
      userPlaces = [];
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
  } catch (e) {
    console.warn('Failed to load user places:', e);
  }
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

    // Filter to within radius
    waterBodies = waterBodies.filter(wb =>
      distanceMiles(userLat, userLon, wb.lat, wb.lon) <= radiusMiles
    );
    usgsSites = usgsSites.filter(s =>
      distanceMiles(userLat, userLon, s.lat, s.lon) <= radiusMiles
    );

    setMarkers(waterBodies, usgsSites, userLat, userLon, showWaterDetail, showUSGSDetail);

    toast(`Found ${waterBodies.length} water bodies, ${usgsSites.length} USGS stations`);

    // Load user places after map data
    await loadUserPlaces();

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
  const typeLabel = { lake: 'Lake / Reservoir', river: 'River', stream: 'Stream / Creek', pond: 'Pond' };

  let html = `
    <h2>${escapeHtml(wb.name)}</h2>
    <span class="detail-type-badge badge-${wb.type}">${typeLabel[wb.type] || wb.type}</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
  `;

  // Place actions (favorite / visited / avoid)
  html += getPlaceStatusHtml(wb);

  // Species selector — clickable chips that load tackle recs
  html += `
    <div class="detail-section">
      <h3>Species — Tap for What to Use</h3>
      <div class="species-selector" id="species-selector">
        ${species.map((s, i) => `<button class="species-chip" data-species="${escapeAttr(s)}" onclick="window._selectSpecies(this, ${wb.lat}, ${wb.lon})">${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>
  `;

  // Weather + recommendation placeholder (loaded async)
  html += `<div id="weather-rec-area"><div class="loading-inline">Loading weather data...</div></div>`;

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

  // Async: fetch weather and show initial card
  loadWeatherForDetail(wb.lat, wb.lon);
}

// Fetch weather and render into the detail panel
async function loadWeatherForDetail(lat, lon) {
  const area = document.getElementById('weather-rec-area');
  if (!area) return;

  try {
    const weather = await fetchWeather(lat, lon);
    area.innerHTML = getWeatherCardHtml(weather);
    // Store weather on window for species selector to use
    window._currentWeather = weather;
  } catch (e) {
    console.warn('Weather fetch failed:', e);
    area.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Weather data unavailable</p>';
    window._currentWeather = null;
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
      const active = [...filterPanel.querySelectorAll('input:checked')].map(c => c.dataset.type);
      updateFilters(active, userLat, userLon, showWaterDetail, showUSGSDetail);
    });
  });

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
      if (confirm(`Signed in as ${user.email}\n\nSign out?`)) {
        signOut().then(() => {
          updateAuthUI(null);
          userPlaces = [];
          toast('Signed out');
        });
      }
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

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3000);
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
