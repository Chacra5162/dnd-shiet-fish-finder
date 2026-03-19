/**
 * WaterWay Finder — Main App
 * PWA for discovering nearby water bodies with real-time USGS data.
 * Focused on Virginia & North Carolina. Supabase auth + user places.
 */

import { fetchWaterBodies, fetchUSGSSites, fetchFishAttractors, getFishingLinks, getCommonSpecies, getSeasonalEvents, getBBox, distanceMiles, assessPrivateProperty, fetchNWSGaugeData, extractFloodStage, fetchRecentUSGSData, extractNWSForecast, analyzeTrend, getFloodStageHtml, getTrendHtml, fetchWaterTempHistory, getWaterTempChartHtml, fetchNOAAWaterTemp, fetchWaterDepth, findUSACEReservoir, fetchReservoirLevel } from './api.js';
import { initMap, setMarkers, updateFilters, updateRadius, recenter, panTo, findNearbyUSGS, setUserPlaceMarkers, setAttractors, highlightMarker, clearHighlight } from './map.js';
import { initAuth, signUp, signIn, signOut, getUser, getUserPlacesNear, savePlace, removePlace, updatePlaceNotes, saveTripPlan, getUserTripPlans, updateTripPlan, deleteTripPlan, fetchAllRegulations, getRegulationsForWater, getUserGaugeAlerts, saveGaugeAlert, deleteGaugeAlert } from './supabase.js';
import { fetchWeather, getRecommendation, getWeatherCardHtml, getRecommendationHtml, SPECIES_DATA, rateFishActivity, rateSpotActivity, getWaterClarity, calculateSolunarPeriods, getBestFishingTimes, getBestTimesHtml, isTidalWater, findNearestTideStation, fetchTidePredictions, getTideHtml, getHatchCalendarHtml } from './fishing.js';
import { TIME_WINDOWS, fetchForecast, estimateTraffic, generateGearChecklist, getForecastCardHtml, getTrafficBadgeHtml, getGearChecklistHtml, getTripSummaryCardHtml, friendlyDate } from './tripPlan.js';
import { CATEGORIES, getArsenalItems, addArsenalItem, updateArsenalItem, deleteArsenalItem, getPhotoUrl, filterItems, getUniqueColors, getUniqueWeights } from './arsenal.js';
import { generateWaterBodyKey, getCommunityPosts, getRecentPosts, addCommunityPost, deleteCommunityPost, getCommunityPhotoUrl, resizeImage } from './community.js';

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
// Generation counter to prevent async race conditions when detail panel is reopened quickly
let detailGeneration = 0;

// ===== Place Lookup Helper =====
function findWaterBody(name, lat, lon, tolerance = 0.01) {
  // Try exact name + close coordinates first
  let wb = waterBodies.find(w =>
    w.name === name && Math.abs(w.lat - lat) < tolerance && Math.abs(w.lon - lon) < tolerance
  );
  if (wb) return wb;
  // Fall back to closest water body by name alone
  let best = null, bestDist = Infinity;
  for (const w of waterBodies) {
    if (w.name !== name) continue;
    const d = Math.abs(w.lat - lat) + Math.abs(w.lon - lon);
    if (d < bestDist) { bestDist = d; best = w; }
  }
  return best;
}

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
const licensePanel = $('#license-panel');

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
  } catch (e) { localStorage.removeItem(PREF_KEY); }
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

  // Show header hint for first-time users
  if (!localStorage.getItem('wwf_header_hint_seen')) {
    const hint = document.getElementById('header-hint');
    if (hint) hint.classList.remove('hidden');
  }

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
  setUserPlaceMarkers(userPlaces, async (place) => {
    panTo(place.lat, place.lon, 14);

    // Find matching water body — try loaded data first, then fetch unfiltered if needed
    let wb = findWaterBody(place.place_name, place.lat, place.lon);
    if (!wb) {
      const bbox = getBBox(place.lat, place.lon, radiusMiles);
      try {
        const result = await fetchWaterBodies(bbox.south, bbox.west, bbox.north, bbox.east);
        if (result.data) {
          // Search the raw fetched data directly (bypasses filters)
          wb = result.data.find(w =>
            w.name === place.place_name && Math.abs(w.lat - place.lat) < 0.01 && Math.abs(w.lon - place.lon) < 0.01
          );
          // Also try name-only match on fetched data
          if (!wb) {
            let best = null, bestDist = Infinity;
            for (const w of result.data) {
              if (w.name !== place.place_name) continue;
              const d = Math.abs(w.lat - place.lat) + Math.abs(w.lon - place.lon);
              if (d < bestDist) { bestDist = d; best = w; }
            }
            wb = best;
          }
        }
      } catch (e) {
        console.warn('Failed to load water bodies for saved place:', e);
      }
    }
    // Last resort: build a minimal water body from the saved place data
    if (!wb) {
      wb = { name: place.place_name, type: place.place_type || 'pond', lat: place.lat, lon: place.lon, tags: {} };
    }
    const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
    showWaterDetail(wb, dist);
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
    const [waterResult, usgsResult, attractorResult] = await Promise.allSettled([
      fetchWaterBodies(bbox.south, bbox.west, bbox.north, bbox.east),
      fetchUSGSSites(bbox.south, bbox.west, bbox.north, bbox.east),
      fetchFishAttractors(bbox.south, bbox.west, bbox.north, bbox.east),
    ]);

    if (waterResult.status === 'fulfilled') {
      waterBodies = waterResult.value.data;
      if (waterResult.value.partial) {
        toast('Some water bodies loaded from cache — Overpass API was slow. Try again later for full results.', true);
      } else if (waterResult.value.fromCache) {
        // Silent — cache hit is the normal fast path
      }
    } else {
      console.error('Water body fetch failed:', waterResult.reason);
      toast('Failed to load water bodies — check your connection and try again', true);
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

    // Fish attractors (NC only — fails silently if outside NC)
    const attractors = attractorResult.status === 'fulfilled' ? attractorResult.value : [];
    if (attractors.length > 0) {
      setAttractors(attractors, showAttractorDetail);
    }

    // Filter to within radius and user type preferences
    waterBodies = waterBodies.filter(wb => {
      if (distanceMiles(userLat, userLon, wb.lat, wb.lon) > radiusMiles) return false;
      if (waterTypePrefs?.length && !waterTypePrefs.includes(wb.type)) return false;
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

    const parts = [`Found ${waterBodies.length} water bodies`, `${usgsSites.length} USGS stations`];
    if (attractors.length > 0) parts.push(`${attractors.length} fish attractors`);
    toast(parts.join(', '));

  } catch (err) {
    console.error('Load error:', err);
    toast('Error loading data — try again later', true);
  }
}

// ===== Hot Spots — Batch-score water bodies by current fishing conditions =====

async function loadHotSpots() {
  const list = $('#hotspots-list');
  const desc = $('#hotspots-panel').querySelector('.hotspots-desc');
  list.innerHTML = '<div class="hotspot-loading">Fetching weather & scoring spots...</div>';
  desc.textContent = 'Ranking nearby water bodies by current fishing conditions...';

  try {
    // Get weather for user's location (cached if recent)
    const weather = await fetchWeather(userLat, userLon);

    // Score each water body individually using type, nearby USGS data, and solunar
    const scored = waterBodies.map(wb => {
      const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
      // Find nearest USGS station to this water body
      const nearbyUSGS = findNearbyUSGS(wb.lat, wb.lon, 10);
      const nearestUSGS = nearbyUSGS.length > 0 ? nearbyUSGS[0] : null;
      const usgsDist = nearestUSGS ? nearestUSGS.dist : 99;
      const score = rateSpotActivity(weather, wb, nearestUSGS, usgsDist);
      return { ...wb, score, dist, hasUSGS: !!nearestUSGS };
    });

    // Sort by score descending, then by distance ascending as tiebreaker
    scored.sort((a, b) => b.score - a.score || a.dist - b.dist);

    // Take top 25
    const top = scored.slice(0, 25);

    if (top.length === 0) {
      list.innerHTML = '<div class="hotspot-loading">No water bodies loaded yet. Wait for map to finish loading.</div>';
      return;
    }

    const scoreLabel = (s) => s >= 65 ? 'excellent' : s >= 50 ? 'good' : s >= 40 ? 'fair' : 'poor';
    const scoreName = (s) => s >= 65 ? 'Excellent' : s >= 50 ? 'Good' : s >= 40 ? 'Fair' : 'Poor';
    const typeLabel = { lake: 'Lake', river: 'River', stream: 'Stream', pond: 'Pond', boat_landing: 'Boat Landing', fishing_pier: 'Pier' };

    desc.textContent = `${scoreName(weather.fishActivity)} conditions right now (${weather.temp}°F, ${weather.conditions})`;

    list.innerHTML = top.map((wb, i) => `
      <div class="hotspot-item" data-idx="${i}">
        <span class="hotspot-rank">${i + 1}</span>
        <span class="hotspot-score ${scoreLabel(wb.score)}">${wb.score}</span>
        <div class="hotspot-info">
          <div class="hotspot-name">${escapeHtml(wb.name)}</div>
          <div class="hotspot-meta">${typeLabel[wb.type] || wb.type} &bull; ${wb.dist.toFixed(1)} mi${wb.hasUSGS ? ' &bull; Live data' : ''}</div>
        </div>
      </div>
    `).join('');

    // Click to fly to spot and show detail
    list.querySelectorAll('.hotspot-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const wb = top[idx];
        panTo(wb.lat, wb.lon, 14);
        showWaterDetail(wb, wb.dist);
        $('#hotspots-panel').classList.add('hidden');
      });
    });

  } catch (err) {
    console.error('Hot spots error:', err);
    list.innerHTML = '<div class="hotspot-loading">Failed to load conditions. Try again later.</div>';
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

  const textarea = btn.closest('.place-notes-section').querySelector('textarea');
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

// ===== Trout License Warning =====

const TROUT_SPECIES = ['Rainbow Trout', 'Brown Trout', 'Brook Trout'];
// Track dismissed warnings per session so they don't nag repeatedly
const troutWarningDismissed = new Set();

function isTroutLocation(wb) {
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon, wb.name);
  return species.some(s => TROUT_SPECIES.includes(s));
}

function isTroutStockedName(name, lat, lon) {
  const n = (name || '').toLowerCase();
  // Only apply name heuristics in non-coastal areas where freshwater trout actually live
  // Coastal areas (lon > -76.5) use "trout" for Speckled Trout (saltwater, no license needed)
  const coastal = lon > -76.5;
  if (coastal) return false;
  return n.includes('trout') || n.includes('stocked') || n.includes('hatchery');
}

function getTroutWarningHtml(wb, context = 'detail') {
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon, wb.name);
  const troutFound = species.filter(s => TROUT_SPECIES.includes(s));
  const nameHint = isTroutStockedName(wb.name, wb.lat, wb.lon);

  if (troutFound.length === 0 && !nameHint) return '';
  if (troutWarningDismissed.has(context + '_' + wb.name)) return '';

  const inVA = wb.lat >= 36.54 && wb.lat <= 39.47 && wb.lon >= -83.68 && wb.lon <= -75.24;
  const stateLabel = inVA ? 'Virginia' : 'North Carolina';
  const troutList = troutFound.length > 0 ? troutFound.join(', ') : 'Trout (stocked area)';

  return `
    <div class="trout-license-warning" id="trout-warn-${context}">
      <div class="trout-license-inner">
        <svg viewBox="0 0 24 24" width="20" height="20" style="flex-shrink:0;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" fill="#f39c12"/></svg>
        <div>
          <strong>Trout License Required</strong>
          <p>This location has <strong>${escapeHtml(troutList)}</strong>. ${stateLabel} requires a separate <strong>trout fishing license</strong> in addition to your regular fishing license to target or keep trout.</p>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn-secondary" style="flex:0;padding:6px 12px;font-size:0.78rem;" onclick="window._dismissTroutWarning(this,'${escapeAttr(context + '_' + wb.name)}')">Dismiss</button>
            <button class="btn-secondary" style="flex:0;padding:6px 12px;font-size:0.78rem;color:var(--accent);border-color:var(--accent);" onclick="document.getElementById('btn-licenses')?.click()">My Licenses</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

window._dismissTroutWarning = function(btn, key) {
  troutWarningDismissed.add(key);
  const el = btn.closest('.trout-license-warning');
  if (el) el.remove();
};

// ===== Shad Run Calendar =====

const shadDismissed = new Set();

window._dismissShadRun = function(btn, name) {
  shadDismissed.add(name);
  const el = btn.closest('.detail-section');
  if (el) el.remove();
};

function getShadRunHtml(wb) {
  if (shadDismissed.has(wb.name)) return '';
  // Shad runs happen March through May on eastern VA/NC rivers
  const month = new Date().getMonth() + 1; // 1-12
  if (month < 3 || month > 5) return '';

  // Only eastern rivers (east of the fall line)
  if (wb.type !== 'river') return '';
  const inVA = wb.lat >= 36.54;
  const fallLine = inVA ? -77.5 : -79.0;
  if (wb.lon < fallLine) return '';

  // Known shad rivers
  const name = (wb.name || '').toLowerCase();
  const shadRivers = ['james', 'rappahannock', 'roanoke', 'potomac', 'york', 'mattaponi', 'pamunkey', 'appomattox', 'neuse', 'tar', 'cape fear'];
  const isKnownShadRiver = shadRivers.some(r => name.includes(r));

  if (!isKnownShadRiver) return '';

  const monthNames = { 3: 'March', 4: 'April', 5: 'May' };
  const peakText = month === 3 ? 'Early run — Hickory Shad starting, American Shad arriving'
    : month === 4 ? 'Peak run — both Hickory and American Shad active'
    : 'Late run — American Shad finishing, best below dams';

  return `
    <div class="detail-section">
      <div style="background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:8px;padding:12px 14px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="font-size:1.2rem;">🐟</span>
          <strong style="color:var(--accent);font-size:0.9rem;">Shad Run Active — ${monthNames[month]}</strong>
        </div>
        <p style="font-size:0.82rem;color:var(--text);margin:0;line-height:1.4;">${peakText}</p>
        <p style="font-size:0.75rem;color:var(--text-muted);margin:4px 0 0;">Use shad darts (white/chartreuse/pink) on ultralight gear below dams and rapids. VA trout license NOT required for shad.</p>
        <button class="btn-secondary" style="margin-top:6px;padding:4px 10px;font-size:0.75rem;" onclick="window._dismissShadRun(this, '${escapeAttr(wb.name)}')">Dismiss</button>
      </div>
    </div>
  `;
}

// ===== Access Info (Fishing / Bank-Pier / Boat) =====

// Determine access for fishing, bank/pier, and boat with deep heuristics.
// Returns { fishing, bankPier, boat } each as 'yes' | 'likely' | 'no' | 'unlikely' | 'unknown'
function assessAccess(wb) {
  const tags = wb.tags || {};
  const name = (wb.name || '').toLowerCase();
  const type = wb.type;
  const op = (tags.operator || '').toLowerCase();
  const ownr = (tags.ownership || '').toLowerCase();

  // Helpers
  const isPublicAccess = tags.access === 'yes' || tags.access === 'public' || tags.access === 'permissive';
  const isPrivateAccess = tags.access === 'private' || tags.access === 'no' || tags.access === 'members';
  const isPublicLand = tags.leisure === 'park' || tags.leisure === 'nature_reserve' ||
    tags.boundary === 'national_park' || tags.boundary === 'protected_area' ||
    ownr === 'public' || ownr === 'national' || ownr === 'state' || ownr === 'municipal' || ownr === 'federal' ||
    op.includes('wildlife') || op.includes('park') || op.includes('corps of engineers') ||
    op.includes('forest service') || op.includes('national forest') || op.includes('game commission') ||
    op.includes('fish and') || op.includes('dwr') || op.includes('dgif') || op.includes('ncwrc');
  const isGolfClub = tags.leisure === 'golf_course' || tags.club || name.includes('golf') || name.includes('country club');
  const isResidential = tags.landuse === 'residential' || tags.landuse === 'farmland' || tags.landuse === 'farmyard';
  const isCommercial = tags.landuse === 'commercial' || tags.landuse === 'industrial';

  // Name-based signals — comprehensive keyword matching
  const publicNames = [
    'state park', 'national', 'wildlife', 'management area', 'wma', 'public',
    'county park', 'city park', 'memorial', 'recreation', 'reservoir',
    'army corps', 'national forest', 'game land', 'state forest',
    'conservation', 'refuge', 'sportsman', 'access area', 'public landing',
    'boat access', 'fish hatchery', 'stocking', 'community lake',
    'municipal', 'town lake', 'city lake', 'county lake',
  ];
  const privateNames = [
    'estate', 'ranch', 'private', 'country club', 'golf',
    'subdivision', 'hoa', 'homeowner', 'community pond', 'retention',
    'stormwater', 'sewage', 'treatment', 'cooling', 'industrial',
  ];
  // "farm" checked separately with word-boundary to avoid matching "Farmville", "Farmer's Mill" etc.
  const hasFarmWord = /\bfarm\b/.test(name) && !name.includes('farmville') && !name.includes('farmer');
  const boatNames = [
    'boat ramp', 'boat landing', 'boat launch', 'launch ramp', 'slipway',
    'marina', 'boat access', 'public landing', 'landing', 'ramp',
  ];
  const pierNames = [
    'pier', 'dock', 'jetty', 'wharf', 'boardwalk', 'fishing platform',
    'observation deck', 'overlook',
  ];

  const hasPublicName = publicNames.some(p => name.includes(p));
  const hasPrivateName = privateNames.some(p => name.includes(p)) || hasFarmWord;
  const hasBoatName = boatNames.some(p => name.includes(p));
  const hasPierName = pierNames.some(p => name.includes(p));

  // VA/NC major managed reservoirs and rivers (almost always have full public access + boat ramps)
  const majorWaters = [
    'james river', 'roanoke river', 'new river', 'shenandoah', 'rappahannock',
    'york river', 'appomattox', 'dan river', 'staunton river', 'jackson river',
    'smith mountain', 'lake anna', 'buggs island', 'kerr', 'gaston', 'jordan lake',
    'falls lake', 'high rock', 'badin lake', 'lake norman', 'lake wylie',
    'claytor lake', 'philpott', 'leesville', 'lake moomaw', 'lake chesdin',
    'briery creek', 'sandy river', 'occoneechee', 'lake prince', 'western branch',
    'back bay', 'currituck', 'albemarle', 'neuse river', 'tar river', 'cape fear',
    'catawba river', 'yadkin river', 'hiwassee', 'nantahala', 'fontana',
    'lake murray', 'smith river', 'south holston', 'watauga',
  ];
  const isMajorWater = majorWaters.some(w => name.includes(w));

  // Is this a named reservoir? Reservoirs almost always have public access + boat ramps
  const isReservoir = name.includes('reservoir') || name.includes('lake') && (
    tags.water === 'reservoir' || name.includes('dam') || op.includes('corps') || op.includes('power') || op.includes('utility')
  );

  // --- FISHING ---
  let fishing = 'unknown';
  // Explicit tags
  if (tags.fishing === 'yes' || tags.sport === 'fishing' || tags.leisure === 'fishing') fishing = 'yes';
  else if (tags.fishing === 'no') fishing = 'no';
  // Type-based certainties
  else if (type === 'fishing_pier' || type === 'boat_landing') fishing = 'yes';
  // Name
  else if (name.includes('fishing') || name.includes('fish hatchery') || name.includes('stocking')) fishing = 'yes';
  // Explicit private
  else if (isPrivateAccess) fishing = 'no';
  else if (isGolfClub) fishing = 'no';
  else if (isCommercial) fishing = 'no';
  // Public land / managed areas
  else if (isPublicLand || isPublicAccess) fishing = 'yes';
  else if (hasPublicName || isMajorWater) fishing = 'yes';
  // Regional heuristics — VA/NC specific
  else if (type === 'river' || type === 'stream') {
    // In VA and NC, all navigable waterways allow fishing (public trust doctrine)
    fishing = 'likely';
  } else if (type === 'lake' && isReservoir) {
    fishing = 'likely';
  } else if (type === 'lake' && !hasPrivateName && !isResidential) {
    // Named lakes that aren't obviously private are usually fishable
    fishing = name ? 'likely' : 'unknown';
  } else if (type === 'pond') {
    fishing = (hasPrivateName || isResidential) ? 'unlikely' : 'unknown';
  } else if (hasPrivateName || isResidential) {
    fishing = 'unlikely';
  }

  // --- BANK / PIER ACCESS ---
  let bankPier = 'unknown';
  // Explicit tags
  if (type === 'fishing_pier' || tags.man_made === 'pier' || tags['fishing:pier'] === 'yes') bankPier = 'yes';
  else if (hasPierName) bankPier = 'yes';
  else if (type === 'boat_landing') bankPier = 'yes';
  // Explicit private
  else if (isPrivateAccess) bankPier = 'no';
  else if (isGolfClub || isCommercial) bankPier = 'no';
  // Public land
  else if (isPublicLand || isPublicAccess) bankPier = 'yes';
  else if (hasPublicName) bankPier = 'yes';
  // Rivers and streams — Virginia follows the "low water mark" doctrine,
  // so bank access depends on public land along the shore. Major rivers usually have public access points.
  else if (type === 'river') {
    bankPier = isMajorWater ? 'yes' : 'likely';
  } else if (type === 'stream') {
    bankPier = 'likely';
  }
  // Lakes and reservoirs
  else if (type === 'lake') {
    if (isMajorWater || isReservoir) bankPier = 'likely';
    else if (hasPrivateName || isResidential) bankPier = 'unlikely';
    else bankPier = name ? 'likely' : 'unknown';
  }
  // Ponds
  else if (type === 'pond') {
    bankPier = (hasPublicName || tags.sport === 'fishing') ? 'likely' : (hasPrivateName || isResidential) ? 'unlikely' : 'unknown';
  }

  // --- BOAT ACCESS ---
  let boat = 'unknown';
  // Explicit tags
  if (type === 'boat_landing') boat = 'yes';
  else if (tags.boat === 'yes' || tags.boat === 'motor' || tags.boat === 'public' ||
           tags.leisure === 'slipway' || tags.waterway === 'boat_ramp' ||
           tags['seamark:type'] === 'harbour' || tags['seamark:type'] === 'marina') boat = 'yes';
  else if (tags.boat === 'no' || tags.boat === 'private') boat = 'no';
  // Name
  else if (hasBoatName || name.includes('marina')) boat = 'yes';
  // Type-based
  else if (type === 'fishing_pier') boat = 'no';
  else if (type === 'stream') boat = 'no';
  else if (type === 'pond') boat = (hasPublicName && name.includes('lake')) ? 'unlikely' : 'no';
  // Private
  else if (isPrivateAccess || isGolfClub) boat = 'no';
  // Major waters and reservoirs almost always have boat ramps
  else if (isMajorWater) boat = 'likely';
  else if (type === 'lake' && isReservoir) boat = 'likely';
  // Rivers — larger rivers in VA/NC often have public access points
  else if (type === 'river') {
    boat = isMajorWater ? 'likely' : 'unknown';
  }
  // General lakes
  else if (type === 'lake') {
    if (isPublicLand || isPublicAccess || hasPublicName) boat = 'likely';
    else if (hasPrivateName || isResidential) boat = 'no';
    // Named lakes over default size are likely to have ramps
    else if (name && !hasPrivateName) boat = 'unknown';
  }

  return { fishing, bankPier, boat };
}

function collapsibleSection(title, content, startExpanded = false) {
  return `
    <div class="detail-section">
      <div class="collapsible-header" onclick="this.nextElementSibling.classList.toggle('expanded');this.querySelector('.collapsible-chevron').classList.toggle('expanded')">
        <h3>${title}</h3>
        <span class="collapsible-chevron ${startExpanded ? 'expanded' : ''}">&#9660;</span>
      </div>
      <div class="collapsible-body ${startExpanded ? 'expanded' : ''}">
        ${content}
      </div>
    </div>
  `;
}

function getAccessInfoHtml(wb) {
  const { fishing, bankPier, boat } = assessAccess(wb);

  const iconSvg = {
    yes: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#2ecc71"/></svg>',
    likely: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#2ecc71" opacity="0.6"/></svg>',
    no: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="#e74c3c"/></svg>',
    unlikely: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="#e74c3c" opacity="0.6"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="#f39c12"/></svg>',
  };
  const labels = { yes: 'Yes', likely: 'Likely', no: 'No', unlikely: 'Unlikely', unknown: 'Unknown' };
  const colors = { yes: '#2ecc71', likely: '#2ecc71', no: '#e74c3c', unlikely: '#e74c3c', unknown: '#f39c12' };

  const cell = (status, label) => `
    <div class="access-info-item">
      ${iconSvg[status]}
      <div>
        <div class="access-info-label">${label}</div>
        <div class="access-info-value" style="color:${colors[status]}">${labels[status]}</div>
      </div>
    </div>
  `;

  return `
    <div class="access-info-grid">
      ${cell(fishing, 'Fishing')}
      ${cell(bankPier, 'Bank / Pier')}
      ${cell(boat, 'Boat Access')}
    </div>
  `;
}

// ===== Detail Panels =====

function renderRegulationsHtml(regs, wb) {
  const inVA = wb.lat >= 36.54 && wb.lat <= 39.47 && wb.lon >= -83.68 && wb.lon <= -75.24;

  let html = '';

  if (regs.length > 0) {
    let slotExplained = false;
    html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">';
    for (const reg of regs) {
      const icon = reg.rule_type === 'size' ? '\u{1F4CF}' : reg.rule_type === 'slot' ? '\u{1F504}' : reg.rule_type === 'creel' ? '\u{1FAA3}' : '\u26A0\uFE0F';
      html += `<div style="background:var(--bg-surface);padding:8px 12px;border-radius:8px;font-size:0.82rem;display:flex;gap:8px;align-items:flex-start;">
        <span style="flex-shrink:0;">${icon}</span>
        <span>${escapeHtml(reg.rule_text)}</span>
      </div>`;
      if (reg.rule_type === 'slot' && !slotExplained) {
        html += '<div style="font-size:0.7rem;color:var(--text-muted);padding:0 12px;font-style:italic;">Slot limit = fish in this size range must be released</div>';
        slotExplained = true;
      }
    }
    html += '</div>';

    // Last updated
    const dates = regs.map(r => r.updated_at).filter(Boolean).sort();
    if (dates.length > 0) {
      const latest = new Date(dates[dates.length - 1]);
      html += `<p style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;">Last updated: ${latest.toLocaleDateString()}</p>`;
    }
  }

  // Always show link to full regulations
  const regUrl = inVA ? 'https://dwr.virginia.gov/fishing/regulations/' : 'https://www.ncwildlife.org/licensing/regulations';
  const regLabel = inVA ? 'VA DWR Full Fishing Regulations' : 'NC Wildlife Fishing Regulations';
  html += `<a href="${escapeAttr(regUrl)}" target="_blank" rel="noopener" class="detail-link" style="margin-top:4px;">
    <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>
    ${escapeHtml(regLabel)}
  </a>`;

  if (regs.length === 0) {
    html += '<p style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">General statewide limits apply. Check the link above for current regulations.</p>';
  } else {
    html += '<p style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">Regulations may change. Always verify with the latest official regulations before keeping fish.</p>';
  }

  return html;
}

async function loadRegulations(wb, gen) {
  const el = document.getElementById('regulations-area');
  if (!el) return;
  try {
    const allRegs = await fetchAllRegulations();
    if (gen !== detailGeneration) return;
    const regs = getRegulationsForWater(allRegs, wb.name);
    el.innerHTML = renderRegulationsHtml(regs, wb);
  } catch (e) {
    console.warn('Regulations load failed:', e);
  }
}

async function loadWaterConditions(wb, gen) {
  const area = document.getElementById('water-conditions-area');
  if (!area) return;

  const isTidal = isTidalWater(wb.lat, wb.lon, wb.type);
  const eastern = wb.lon > -78;
  const reservoir = (wb.type === 'lake') ? findUSACEReservoir(wb.lat, wb.lon, wb.name) : null;

  // Check if a nearby USGS site already has water temp
  const nearbyUSGS = findNearbyUSGS(wb.lat, wb.lon, 10);
  const usgsHasTemp = nearbyUSGS.some(s => s.data?.temp);

  // Fetch in parallel: NOAA water temp, water depth (coastal/bay), reservoir level
  const promises = [];

  // NOAA temp: fetch for any eastern location if USGS doesn't have temp nearby
  if (eastern && !usgsHasTemp) promises.push(fetchNOAAWaterTemp(wb.lat, wb.lon).catch(() => null));
  else promises.push(Promise.resolve(null));

  // Depth: try for all water bodies (NOAA DEM covers coastal/bay, returns null for inland)
  promises.push(fetchWaterDepth(wb.lat, wb.lon).catch(() => null));

  // Reservoir level
  if (reservoir) promises.push(fetchReservoirLevel(reservoir).catch(() => null));
  else promises.push(Promise.resolve(null));

  const [noaaTemp, depth, resLevel] = await Promise.all(promises);
  if (gen !== detailGeneration) return;

  const cards = [];

  // Show USGS water temp if available from nearby gauge
  const usgsTemp = nearbyUSGS.find(s => s.data?.temp);
  if (usgsTemp) {
    cards.push(`
      <div class="data-card">
        <div class="label">Water Temp</div>
        <div class="value" style="color:#e67e22;">${usgsTemp.data.temp.value}${escapeHtml(usgsTemp.data.temp.unit)}</div>
        <div style="font-size:0.6rem;color:var(--text-muted);">USGS ${escapeHtml(usgsTemp.name)}</div>
      </div>
    `);
  } else if (noaaTemp) {
    cards.push(`
      <div class="data-card">
        <div class="label">Water Temp</div>
        <div class="value" style="color:#e67e22;">${noaaTemp.temp.toFixed(1)}°F</div>
        <div style="font-size:0.6rem;color:var(--text-muted);">${escapeHtml(noaaTemp.station)} (${noaaTemp.distance} mi)</div>
      </div>
    `);
  }

  if (depth) {
    cards.push(`
      <div class="data-card">
        <div class="label">Water Depth</div>
        <div class="value" style="color:#3498db;">${depth.depthFt} ft</div>
        <div style="font-size:0.6rem;color:var(--text-muted);">${depth.depthM}m &bull; ${escapeHtml(depth.source)}</div>
      </div>
    `);
  }

  if (resLevel) {
    cards.push(`
      <div class="data-card">
        <div class="label">Pool Level</div>
        <div class="value" style="color:#2980b9;">${resLevel.elevation} ft</div>
        <div style="font-size:0.6rem;color:var(--text-muted);">USACE &bull; ${escapeHtml(resLevel.time)}</div>
      </div>
    `);
  }

  if (cards.length === 0) return;

  area.innerHTML = `
    <div class="detail-section">
      <h3>Water Conditions</h3>
      <div class="data-cards-row" style="display:flex;gap:8px;flex-wrap:wrap;">
        ${cards.join('')}
      </div>
    </div>
  `;
}

async function showWaterDetail(wb, dist) {
  // Highlight the selected marker on the map
  const style = { lake: '#2980b9', river: '#1abc9c', stream: '#27ae60', pond: '#8e44ad', boat_landing: '#e67e22', fishing_pier: '#9b59b6' };
  highlightMarker(wb.lat, wb.lon, style[wb.type] || '#f1c40f');

  const nearbyUSGS = findNearbyUSGS(wb.lat, wb.lon, 10);
  const links = getFishingLinks(wb.lat, wb.lon, wb.type, wb.name);
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon, wb.name);
  const typeLabel = { lake: 'Lake / Reservoir', river: 'River', stream: 'Stream / Creek', pond: 'Pond', boat_landing: 'Boat Landing', fishing_pier: 'Fishing Pier' };

  let html = `
    <h2>${escapeHtml(wb.name)}</h2>
    <span class="detail-type-badge badge-${wb.type}">${typeLabel[wb.type] || wb.type}</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
  `;

  html += `
    <div style="display:flex;gap:6px;margin-top:8px;">
      <a href="${escapeAttr(`https://www.google.com/maps/dir/?api=1&destination=${wb.lat},${wb.lon}`)}" target="_blank" rel="noopener" class="btn-secondary" style="flex:1;text-align:center;font-size:0.82rem;text-decoration:none;padding:8px;">Google Maps</a>
      <a href="${escapeAttr(`https://maps.apple.com/?daddr=${wb.lat},${wb.lon}&dirflg=d`)}" target="_blank" rel="noopener" class="btn-secondary" style="flex:1;text-align:center;font-size:0.82rem;text-decoration:none;padding:8px;">Apple Maps</a>
    </div>
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

  // Trout license warning
  html += getTroutWarningHtml(wb, 'detail');

  // Shad run indicator
  html += getShadRunHtml(wb);

  // Place actions (favorite / visited / avoid)
  html += getPlaceStatusHtml(wb);

  // Plan a Trip button
  html += `
    <button class="btn-plan-trip" data-wb='${escapeAttr(JSON.stringify({ name: wb.name, type: wb.type, lat: wb.lat, lon: wb.lon, id: wb.id }))}' onclick="window._openTripPlan(this.dataset.wb)">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z" fill="currentColor"/></svg>
      Plan a Day on the Water
    </button>
  `;

  // Species selector — clickable chips that load tackle recs
  html += `
    <div class="detail-section">
      <h3>Species — Tap for What to Use</h3>
      <div class="species-selector" id="species-selector">
        ${species.map((s, i) => `<button class="species-chip" data-species="${escapeAttr(s)}" data-lat="${wb.lat}" data-lon="${wb.lon}" onclick="window._selectSpecies(this)" disabled>${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>
  `;

  // Seasonal events (runs, spawns, stocking)
  const events = getSeasonalEvents(wb.type, wb.lat, wb.lon, wb.name);
  if (events.length > 0) {
    const eventIcons = { run: '\u{1F30A}', spawn: '\u{1F3AF}', stocking: '\u{1F69A}' };
    html += `
      <div class="detail-section">
        <h3>What's Happening Now</h3>
        ${events.map(e => `
          <div class="seasonal-event ${e.peak ? 'event-peak' : ''}">
            <div class="event-header">
              <span class="event-icon">${eventIcons[e.type] || '\u{1F41F}'}</span>
              <strong>${escapeHtml(e.title)}</strong>
              ${e.peak ? '<span class="event-peak-badge">PEAK</span>' : ''}
            </div>
            <p class="event-desc">${escapeHtml(e.desc)}</p>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Weather + best times + tide placeholder (loaded async)
  html += `<div id="weather-rec-area"><div class="loading-inline">Loading weather data...</div></div>`;
  html += `<div id="best-times-area"></div>`;

  // Tidal placeholder (only shown for tidal waters)
  const isTidal = isTidalWater(wb.lat, wb.lon, wb.type);
  if (isTidal) {
    html += `<div id="tide-area"><div class="loading-inline">Loading tide data...</div></div>`;
  }

  // Hatch calendar (mountain trout streams)
  if (wb.type === 'stream' || wb.type === 'river') {
    html += getHatchCalendarHtml(wb.lat, wb.lon);
  }

  // Water conditions placeholder (water temp, depth, reservoir level — loaded async)
  html += `<div id="water-conditions-area"></div>`;

  // Access info — collapsible
  html += collapsibleSection('Access Info', getAccessInfoHtml(wb), true);

  // Regulations — collapsible (loaded async from Supabase)
  html += collapsibleSection('Regulations', '<div id="regulations-area"><div class="loading-inline">Loading regulations...</div></div>');

  // Nearby USGS — collapsible
  if (nearbyUSGS.length > 0) {
    const usgsContent = `
      <div class="nearby-usgs-list">
        ${nearbyUSGS.map(s => {
          const dataSnippets = [];
          if (s.data.temp) dataSnippets.push(`${s.data.temp.value}${escapeHtml(s.data.temp.unit)}`);
          if (s.data.flow) dataSnippets.push(`${s.data.flow.value} ${escapeHtml(s.data.flow.unit)}`);
          if (s.data.gauge) dataSnippets.push(`${s.data.gauge.value} ${escapeHtml(s.data.gauge.unit)}`);
          const dataStr = dataSnippets.length > 0 ? ` — ${dataSnippets.join(', ')}` : '';
          return `
            <div class="nearby-usgs-item" data-site-code="${escapeAttr(s.siteCode)}">
              <div class="station-name">${escapeHtml(s.name)}</div>
              <div class="station-dist">${s.dist.toFixed(1)} mi from ${escapeHtml(wb.name)}${dataStr}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    html += collapsibleSection('Nearby USGS Monitoring', usgsContent);
  }

  // Links — collapsible
  const linkIcon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>`;
  const linksContent = `
    <div class="detail-links">
      ${links.map(l => `
        <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener" class="detail-link">
          ${linkIcon}
          ${escapeHtml(l.label)}
        </a>
      `).join('')}
    </div>
  `;
  html += collapsibleSection('Resources', linksContent);

  // Community board — collapsible, starts expanded
  const communityInner = `
    <div id="community-posts" class="community-posts">
      <div class="loading-inline">Loading posts...</div>
    </div>
    <div id="community-form-area"></div>
  `;
  html += `
    <div class="detail-section" id="community-section">
      <div class="collapsible-header" onclick="this.nextElementSibling.classList.toggle('expanded');this.querySelector('.collapsible-chevron').classList.toggle('expanded')">
        <h3>Community Board</h3>
        <span class="collapsible-chevron expanded">&#9660;</span>
      </div>
      <div class="collapsible-body expanded">
        ${communityInner}
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

  // Bump generation to invalidate any in-flight async from a previous panel
  const gen = ++detailGeneration;

  // Async: fetch weather, best times, and tides
  loadWeatherForDetail(wb.lat, wb.lon, wb.type, gen);

  // Async: load community posts
  loadCommunityBoard(wb, gen);

  // Async: load regulations from Supabase
  loadRegulations(wb, gen);

  // Async: load water conditions (NOAA temp, depth, USACE reservoir level)
  loadWaterConditions(wb, gen);
}

// Fetch weather, best times, and tides for the detail panel
async function loadWeatherForDetail(lat, lon, waterType, gen) {
  if (gen !== detailGeneration) return; // stale
  const area = document.getElementById('weather-rec-area');
  if (!area) return;

  try {
    const weather = await fetchWeather(lat, lon);
    if (gen !== detailGeneration) return; // stale
    area.innerHTML = getWeatherCardHtml(weather);
    window._currentWeather = weather;

    // Enable species chips now that weather is loaded
    document.querySelectorAll('#species-selector .species-chip').forEach(btn => btn.disabled = false);

    // Best fishing times
    const timesArea = document.getElementById('best-times-area');
    if (timesArea) {
      const times = getBestFishingTimes(weather, lat, lon);
      timesArea.innerHTML = getBestTimesHtml(times);
    }
  } catch (e) {
    if (gen !== detailGeneration) return;
    console.warn('Weather fetch failed:', e);
    area.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Weather data unavailable</p>';
    window._currentWeather = null;
  }

  // Load tides if applicable (independent of weather)
  loadTidesForDetail(lat, lon, waterType, gen);
}

async function loadTidesForDetail(lat, lon, waterType, gen) {
  const tideArea = document.getElementById('tide-area');
  if (!tideArea) return;

  const station = findNearestTideStation(lat, lon);
  if (!station || station.dist > 60) { if (tideArea) tideArea.innerHTML = ''; return; }

  try {
    const tideData = await fetchTidePredictions(station.id);
    if (gen !== detailGeneration) return; // stale
    tideArea.innerHTML = getTideHtml(tideData, station.name);
  } catch (e) {
    console.warn('Tide fetch failed:', e);
    tideArea.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Tide data unavailable</p>';
  }
}

// ===== Community Board =====

let communityCurrentWb = null;
let communityPostType = 'comment';
let communityPhotoFile = null;

async function loadCommunityBoard(wb, gen) {
  communityCurrentWb = wb;
  const postsEl = document.getElementById('community-posts');
  const formEl = document.getElementById('community-form-area');
  if (!postsEl) return;

  const key = generateWaterBodyKey(wb.name, wb.lat, wb.lon);

  try {
    const posts = await getCommunityPosts(key);
    if (gen !== undefined && gen !== detailGeneration) return;
    renderCommunityPosts(posts, postsEl);
  } catch (e) {
    console.warn('Community load failed:', e);
    postsEl.innerHTML = '<p class="community-empty">Could not load posts</p>';
  }

  // Render form (sign-in gated)
  if (gen !== undefined && gen !== detailGeneration) return;
  if (formEl) {
    const user = getUser();
    if (user) {
      formEl.innerHTML = getCommunityFormHtml(wb);
    } else {
      formEl.innerHTML = `
        <div style="text-align:center;padding:10px 0;">
          <button class="btn-link" onclick="document.dispatchEvent(new CustomEvent('require-auth'))">Sign in to post</button>
        </div>
      `;
    }
  }
}

function renderPostCardHtml(post, options = {}) {
  const { showDelete = false, showLocation = false, userId = null } = options;
  const initials = (post.display_name || 'A').slice(0, 2).toUpperCase();
  const time = timeAgo(new Date(post.created_at));
  const photoUrl = post.photo_path ? getCommunityPhotoUrl(post.photo_path) : null;
  const isOwn = showDelete && userId === post.user_id;

  let catchBadge = '';
  if (post.post_type === 'catch' && post.species) {
    const parts = [post.species];
    if (post.weight_lbs) parts.push(`${post.weight_lbs} lbs`);
    if (post.length_in) parts.push(`${post.length_in}"`);
    catchBadge = `<div class="community-catch-badge">${escapeHtml(parts.join(' · '))}</div>`;
  }

  const locationAttrs = showLocation
    ? ` data-lat="${escapeAttr(String(post.water_body_lat))}" data-lon="${escapeAttr(String(post.water_body_lon))}" data-name="${escapeAttr(post.water_body_name)}" onclick="window._goToSocialPost(this)"`
    : '';
  const cardClass = showLocation ? 'social-feed-card' : 'community-post-card';

  return `
    <div class="${cardClass}"${locationAttrs}>
      <div class="community-post-header">
        <div class="community-avatar">${escapeHtml(initials)}</div>
        ${showLocation ? `<div style="flex:1;min-width:0;">
            <span class="community-post-name">${escapeHtml(post.display_name)}</span>
            <div class="social-location-tag">${escapeHtml(post.water_body_name)}</div>
          </div>` : `<span class="community-post-name">${escapeHtml(post.display_name)}</span>`}
        <span class="community-post-time">${time}</span>
        ${isOwn ? `<button class="community-post-delete" data-post-id="${post.id}" data-photo="${escapeAttr(post.photo_path || '')}" onclick="window._deleteCommunityPost(this)">delete</button>` : ''}
      </div>
      ${catchBadge}
      ${photoUrl ? `<img class="community-post-photo" src="${photoUrl}" alt="Photo" data-url="${escapeAttr(photoUrl)}" onclick="${showLocation ? 'event.stopPropagation();' : ''}window._viewPhoto(this.dataset.url)">` : ''}
      ${post.body ? `<div class="community-post-body">${escapeHtml(post.body)}</div>` : ''}
      ${showLocation ? '<div class="social-go-hint">Tap to view location</div>' : ''}
    </div>
  `;
}

function renderCommunityPosts(posts, container) {
  if (!posts.length) {
    container.innerHTML = '<p class="community-empty">No posts yet — be the first to share!</p>';
    return;
  }

  const user = getUser();
  const userId = user?.id;

  container.innerHTML = posts.map(post =>
    renderPostCardHtml(post, { showDelete: true, showLocation: false, userId })
  ).join('');
}

function getCommunityFormHtml(wb) {
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon, wb.name);
  return `
    <div class="community-form">
      <div class="community-tab-bar">
        <button class="community-tab active" data-type="comment" onclick="window._setCommunityTab(this)">Comment</button>
        <button class="community-tab" data-type="catch" onclick="window._setCommunityTab(this)">Catch Report</button>
        <button class="community-tab" data-type="photo" onclick="window._setCommunityTab(this)">Photo</button>
      </div>
      <textarea id="community-body" placeholder="Share something about this spot..."></textarea>
      <div id="community-catch-fields" class="community-catch-fields" style="display:none;">
        <select id="community-species">
          <option value="">Species</option>
          ${species.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
        <input type="number" id="community-weight" placeholder="lbs" step="0.01" min="0">
        <input type="number" id="community-length" placeholder="inches" step="0.25" min="0">
      </div>
      <div class="community-form-actions">
        <button class="community-photo-btn" onclick="document.getElementById('community-photo-input').click()">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" fill="currentColor"/></svg>
          Photo
        </button>
        <span class="community-photo-preview" id="community-photo-preview"></span>
        <input type="file" id="community-photo-input" accept="image/*" capture="environment" style="display:none;" onchange="window._communityPhotoSelected(this)">
        <button class="community-submit-btn" id="community-submit-btn" onclick="window._submitCommunityPost()">Post</button>
      </div>
    </div>
  `;
}

window._setCommunityTab = function(btn) {
  document.querySelectorAll('.community-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  communityPostType = btn.dataset.type;
  const catchFields = document.getElementById('community-catch-fields');
  if (catchFields) catchFields.style.display = communityPostType === 'catch' ? 'grid' : 'none';
};

window._communityPhotoSelected = function(input) {
  communityPhotoFile = input.files[0] || null;
  const preview = document.getElementById('community-photo-preview');
  if (preview) preview.textContent = communityPhotoFile ? communityPhotoFile.name.slice(0, 20) : '';
};

window._submitCommunityPost = async function() {
  const user = getUser();
  if (!user) { document.dispatchEvent(new CustomEvent('require-auth')); return; }
  if (!communityCurrentWb) return;

  const body = document.getElementById('community-body')?.value?.trim() || '';
  const species = document.getElementById('community-species')?.value || '';
  const weight = parseFloat(document.getElementById('community-weight')?.value) || null;
  const length = parseFloat(document.getElementById('community-length')?.value) || null;

  if (!body && !communityPhotoFile) {
    toast('Write something or add a photo', true);
    return;
  }

  const btn = document.getElementById('community-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Posting...'; }

  try {
    const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'Angler';
    await addCommunityPost(user.id, displayName, communityCurrentWb, {
      type: communityPostType,
      body,
      species: communityPostType === 'catch' ? species : null,
      weight: communityPostType === 'catch' ? weight : null,
      length: communityPostType === 'catch' ? length : null,
    }, communityPhotoFile);

    communityPhotoFile = null;
    toast('Posted!');
    // Reload board
    loadCommunityBoard(communityCurrentWb);
  } catch (e) {
    console.error('Post error:', e);
    toast(`Error: ${e.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Post'; }
  }
};

window._deleteCommunityPost = function(el) {
  const user = getUser();
  if (!user) return;
  const postId = el.dataset.postId;
  const photoPath = el.dataset.photo;
  showInlineConfirm('Delete this post?', 'Delete', async () => {
    try {
      await deleteCommunityPost(user.id, postId, photoPath || null);
      toast('Post deleted');
      if (communityCurrentWb) loadCommunityBoard(communityCurrentWb);
    } catch (e) {
      toast(`Error: ${e.message}`, true);
    }
  });
};

window._viewPhoto = function(url) {
  const viewer = document.getElementById('photo-viewer');
  const img = document.getElementById('photo-viewer-img');
  if (viewer && img) {
    img.src = url;
    viewer.classList.remove('hidden');
  }
};

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ===== Social Feed =====

let socialPosts = [];
let socialTab = 'all';
let socialOffset = 0;
const SOCIAL_PAGE = 30;

async function openSocialFeed() {
  const panel = document.getElementById('social-panel');
  panel.classList.remove('hidden');
  socialOffset = 0;
  socialPosts = [];
  await loadSocialFeed(false);
}

async function loadSocialFeed(append) {
  const feedEl = document.getElementById('social-feed');
  const moreBtn = document.getElementById('social-load-more');
  if (!feedEl) return;

  if (!append) {
    feedEl.innerHTML = '<div class="loading-inline">Loading feed...</div>';
  }

  try {
    const posts = await getRecentPosts(SOCIAL_PAGE, socialOffset);
    if (append) {
      socialPosts = socialPosts.concat(posts);
    } else {
      socialPosts = posts;
    }
    renderSocialFeed(feedEl);
    // Show/hide load more
    if (moreBtn) moreBtn.classList.toggle('hidden', posts.length < SOCIAL_PAGE);
  } catch (e) {
    console.warn('Social feed error:', e);
    if (!append) feedEl.innerHTML = '<p class="community-empty">Could not load feed</p>';
  }
}

function renderSocialFeed(container) {
  const filtered = socialTab === 'all' ? socialPosts : socialPosts.filter(p => p.post_type === socialTab);

  if (!filtered.length) {
    container.innerHTML = `<p class="community-empty">${socialPosts.length ? 'No posts of this type yet' : 'No posts yet — be the first to share a catch!'}</p>`;
    return;
  }

  container.innerHTML = filtered.map(post =>
    renderPostCardHtml(post, { showDelete: false, showLocation: true, userId: null })
  ).join('');
}

window._setSocialTab = function(btn) {
  document.querySelectorAll('.social-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  socialTab = btn.dataset.tab;
  const feedEl = document.getElementById('social-feed');
  if (feedEl) renderSocialFeed(feedEl);
};

window._loadMoreSocial = async function() {
  socialOffset += SOCIAL_PAGE;
  await loadSocialFeed(true);
};

window._goToSocialPost = function(el) {
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);
  const name = el.dataset.name;

  // Close social panel
  document.getElementById('social-panel').classList.add('hidden');

  // Pan to location
  panTo(lat, lon, 14);

  // Try to find the water body and open its detail
  const wb = findWaterBody(name, lat, lon, 0.01);
  if (wb) {
    const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
    showWaterDetail(wb, dist);
  } else {
    toast(`${name} — tap a nearby marker for details`);
  }
};

// Species chip click handler
window._selectSpecies = async function(btn) {
  const lat = parseFloat(btn.dataset.lat);
  const lon = parseFloat(btn.dataset.lon);
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

function showAttractorDetail(attractor) {
  const dist = distanceMiles(userLat, userLon, attractor.lat, attractor.lon);
  highlightMarker(attractor.lat, attractor.lon, '#f39c12');

  let html = `
    <h2>${escapeHtml(attractor.name)}</h2>
    <span class="detail-type-badge" style="background:#f39c12;color:#000;">Fish Attractor</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
  `;

  html += '<div class="detail-section"><h3>Structure Details</h3><div class="detail-grid">';
  if (attractor.structure) html += `<div class="detail-item"><span class="detail-label">Type</span><span>${escapeHtml(attractor.structure)}</span></div>`;
  if (attractor.quantity) html += `<div class="detail-item"><span class="detail-label">Quantity</span><span>${attractor.quantity} structures</span></div>`;
  if (attractor.depth) html += `<div class="detail-item"><span class="detail-label">Depth</span><span>${attractor.depth} ft (at full pool)</span></div>`;
  if (attractor.waterbody) html += `<div class="detail-item"><span class="detail-label">Waterbody</span><span>${escapeHtml(attractor.waterbody)}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">Buoy Marker</span><span>${attractor.hasBuoy ? 'Yes' : 'No'}</span></div>`;
  html += '</div></div>';

  html += `<div class="detail-section" style="margin-top:12px;font-size:0.8rem;color:var(--text-muted);">
    Data: NC Wildlife Resources Commission
  </div>`;

  html += `
    <div style="display:flex;gap:6px;margin-top:8px;">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${attractor.lat},${attractor.lon}" target="_blank" rel="noopener" class="btn-secondary" style="flex:1;text-align:center;font-size:0.82rem;text-decoration:none;padding:8px;">Google Maps</a>
      <a href="https://maps.apple.com/?daddr=${attractor.lat},${attractor.lon}&dirflg=d" target="_blank" rel="noopener" class="btn-secondary" style="flex:1;text-align:center;font-size:0.82rem;text-decoration:none;padding:8px;">Apple Maps</a>
    </div>
  `;

  detailPanel.innerHTML = `<button id="btn-close-detail" class="close-btn">&times;</button>${html}`;
  detailPanel.classList.remove('hidden');
  $('#btn-close-detail').addEventListener('click', () => { detailPanel.classList.add('hidden'); clearHighlight(); });
  panTo(attractor.lat, attractor.lon, 15);
}

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

  // Water temperature trend chart placeholder (loaded async)
  html += `<div id="usgs-water-temp"></div>`;

  // Flood stage placeholder (loaded async)
  html += `<div id="usgs-flood-stage"><div class="loading-inline">Checking flood stage...</div></div>`;

  // 6-hour outlook placeholder (loaded async)
  html += `<div id="usgs-outlook"><div class="loading-inline">Loading 6-hour outlook...</div></div>`;

  // Gauge alert section (loaded async)
  html += `<div id="gauge-alert-area"></div>`;

  // Links
  const linkIcon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>`;
  html += `
    <div class="detail-section">
      <h3>Resources</h3>
      <div class="detail-links">
        <a href="https://waterdata.usgs.gov/nwis/uv?site_no=${escapeAttr(site.siteCode)}" target="_blank" rel="noopener" class="detail-link">
          ${linkIcon} USGS Station Data Page
        </a>
        <a href="https://waterdata.usgs.gov/nwis/inventory/?site_no=${escapeAttr(site.siteCode)}" target="_blank" rel="noopener" class="detail-link">
          ${linkIcon} Station Inventory &amp; History
        </a>
        <a href="https://water.weather.gov/ahps2/hydrograph.php?gage=USGS-${escapeAttr(site.siteCode)}" target="_blank" rel="noopener" class="detail-link">
          ${linkIcon} NWS River Forecast Hydrograph
        </a>
        ${links.map(l => `
          <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener" class="detail-link">
            ${linkIcon} ${escapeHtml(l.label)}
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

  // Async: load flood stage, trend data, and NWS forecast
  const gen = ++detailGeneration;
  loadUSGSFloodAndOutlook(site, gen);

  // Async: load gauge alerts
  renderGaugeAlertSection(site, gen);
}

async function loadUSGSFloodAndOutlook(site, gen) {
  const gaugeHeight = site.data?.gauge?.value ?? null;

  // Fetch NWS gauge data once (shared by flood stage + forecast)
  const [gaugeResult, recentData] = await Promise.allSettled([
    fetchNWSGaugeData(site.siteCode),
    fetchRecentUSGSData(site.siteCode),
  ]);

  if (gen !== detailGeneration) return; // stale — user opened a different location

  const gaugeObj = gaugeResult.status === 'fulfilled' ? gaugeResult.value : null;

  // Extract flood stage from the shared gauge object (no extra HTTP call)
  const floodArea = document.getElementById('usgs-flood-stage');
  if (floodArea) {
    const flood = extractFloodStage(gaugeObj);
    if (flood) {
      floodArea.innerHTML = getFloodStageHtml(flood, gaugeHeight);
    } else {
      floodArea.innerHTML = '';
    }
  }

  // Fetch NWS forecast using the shared gauge object (only the stageflow call is new)
  const nwsForecast = await extractNWSForecast(gaugeObj);

  if (gen !== detailGeneration) return;

  // 6-hour outlook (trend + NWS forecast)
  const outlookArea = document.getElementById('usgs-outlook');
  if (outlookArea) {
    const recent = recentData.status === 'fulfilled' ? recentData.value : null;
    const trend = analyzeTrend(recent);

    if (trend || nwsForecast) {
      outlookArea.innerHTML = getTrendHtml(trend, nwsForecast);
    } else {
      outlookArea.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;">Trend data not available for this station.</p>';
    }
  }

  // Water temperature trend (independent)
  if (site.data?.temp) {
    fetchWaterTempHistory(site.siteCode).then(temps => {
      if (gen !== detailGeneration) return;
      const el = document.getElementById('usgs-water-temp');
      if (el && temps) el.innerHTML = getWaterTempChartHtml(temps);
    });
  }
}

// ===== Gauge Alerts =====

async function renderGaugeAlertSection(site, gen) {
  const area = document.getElementById('gauge-alert-area');
  if (!area) return;
  const user = getUser();
  if (!user) {
    area.innerHTML = `
      <div class="detail-section">
        <h3>Gauge Alerts</h3>
        <p style="font-size:0.82rem;color:var(--text-muted);">Sign in to set gauge alerts for this station.</p>
      </div>
    `;
    return;
  }

  area.innerHTML = `
    <div class="detail-section">
      <h3>Gauge Alerts</h3>
      <div class="loading-inline">Loading alerts...</div>
    </div>
  `;

  try {
    const allAlerts = await getUserGaugeAlerts();
    if (gen !== detailGeneration) return;
    const siteAlerts = allAlerts.filter(a => a.site_code === site.siteCode);

    // Build current values map for context
    const currentValues = {};
    if (site.data?.flow) currentValues.flow = { value: site.data.flow.value, unit: site.data.flow.unit };
    if (site.data?.gauge) currentValues.gauge = { value: site.data.gauge.value, unit: site.data.gauge.unit };
    if (site.data?.temp) currentValues.temp = { value: site.data.temp.value, unit: site.data.temp.unit };

    const paramOptions = [];
    if (site.data?.flow) paramOptions.push({ value: 'flow', label: 'Flow', unit: site.data.flow.unit });
    if (site.data?.gauge) paramOptions.push({ value: 'gauge', label: 'Gauge Height', unit: site.data.gauge.unit });
    if (site.data?.temp) paramOptions.push({ value: 'temp', label: 'Temperature', unit: site.data.temp.unit });

    let html = '<div class="detail-section"><h3>Gauge Alerts</h3>';

    // Existing alerts
    if (siteAlerts.length > 0) {
      html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">';
      for (const a of siteAlerts) {
        const paramLabel = a.parameter === 'flow' ? 'Flow' : a.parameter === 'gauge' ? 'Gauge Height' : 'Temperature';
        const statusIcon = a.enabled ? '\u2705' : '\u274C';
        html += `<div style="background:var(--bg-surface);padding:8px 12px;border-radius:8px;font-size:0.82rem;display:flex;justify-content:space-between;align-items:center;">
          <span>${statusIcon} Alert: ${escapeHtml(paramLabel)} ${escapeHtml(a.condition)} ${a.threshold} ${escapeHtml(a.unit || '')}</span>
          <button class="btn-icon" style="color:var(--danger);font-size:1.1rem;background:none;border:none;cursor:pointer;padding:2px 6px;" title="Delete alert" data-alert-id="${escapeAttr(a.id)}" data-site="${escapeAttr(site.siteCode)}" onclick="window._deleteGaugeAlert(this.dataset.alertId, this.dataset.site)">&times;</button>
        </div>`;
      }
      html += '</div>';
    }

    // Add new alert form
    if (paramOptions.length > 0) {
      html += `
        <div style="background:var(--bg-surface);padding:12px;border-radius:8px;">
          <div style="font-size:0.82rem;font-weight:600;margin-bottom:8px;">Add Alert</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <select id="gauge-alert-param" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg);font-size:0.8rem;" onchange="window._updateAlertUnit()">
              ${paramOptions.map(p => `<option value="${p.value}" data-unit="${escapeAttr(p.unit)}">${escapeHtml(p.label)}</option>`).join('')}
            </select>
            <select id="gauge-alert-condition" style="padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg);font-size:0.8rem;">
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
            <input id="gauge-alert-threshold" type="number" step="any" placeholder="Value" style="width:80px;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg);font-size:0.8rem;">
            <span id="gauge-alert-unit" style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(paramOptions[0]?.unit || '')}</span>
          </div>`;

      // Show current value as context
      const firstParam = paramOptions[0];
      if (firstParam && currentValues[firstParam.value]) {
        html += `<div id="gauge-alert-current" style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">Current: ${currentValues[firstParam.value].value} ${escapeHtml(currentValues[firstParam.value].unit)}</div>`;
      }

      html += `
          <button class="btn-secondary" style="margin-top:8px;font-size:0.8rem;padding:6px 14px;" onclick="window._saveGaugeAlert('${escapeAttr(site.siteCode)}', '${escapeAttr(site.name)}')">Save Alert</button>
        </div>
        <p style="font-size:0.68rem;color:var(--text-muted);margin-top:6px;">Alerts are saved. Check back to see if conditions are met.</p>
      `;
    } else {
      html += '<p style="font-size:0.82rem;color:var(--text-muted);">No parameter data available to set alerts on.</p>';
    }

    html += '</div>';
    area.innerHTML = html;
  } catch (e) {
    if (gen !== detailGeneration) return;
    console.warn('Gauge alerts load failed:', e);
    area.innerHTML = '';
  }
}

window._updateAlertUnit = function() {
  const sel = document.getElementById('gauge-alert-param');
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const unitEl = document.getElementById('gauge-alert-unit');
  if (unitEl) unitEl.textContent = opt.dataset.unit || '';
};

window._saveGaugeAlert = async function(siteCode, siteName) {
  const param = document.getElementById('gauge-alert-param')?.value;
  const condition = document.getElementById('gauge-alert-condition')?.value;
  const threshold = parseFloat(document.getElementById('gauge-alert-threshold')?.value);
  const unit = document.getElementById('gauge-alert-unit')?.textContent || '';

  if (!param || !condition || isNaN(threshold)) {
    toast('Fill in all alert fields', true);
    return;
  }

  try {
    await saveGaugeAlert({
      site_code: siteCode,
      site_name: siteName,
      parameter: param,
      condition,
      threshold,
      unit,
      enabled: true,
    });
    toast('Alert saved!');
    // Re-render the alert section
    const site = usgsSites.find(s => s.siteCode === siteCode);
    if (site) renderGaugeAlertSection(site, detailGeneration);
  } catch (e) {
    toast(`Error: ${e.message}`, true);
  }
};

window._deleteGaugeAlert = async function(alertId, siteCode) {
  try {
    await deleteGaugeAlert(alertId);
    toast('Alert deleted');
    const site = usgsSites.find(s => s.siteCode === siteCode);
    if (site) renderGaugeAlertSection(site, detailGeneration);
  } catch (e) {
    toast(`Error: ${e.message}`, true);
  }
};

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
    <div class="place-list-item" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${escapeAttr(p.place_name)}" data-type="${escapeAttr(p.place_type || 'pond')}" onclick="window._goToPlace(this)">
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

window._goToPlace = async function(el) {
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);
  const name = el.dataset.name;

  panTo(lat, lon, 14);
  placesPanel.classList.add('hidden');

  // Try to find and show the matching water body
  let wb = findWaterBody(name, lat, lon);
  if (!wb) {
    // Water body not in current data — fetch unfiltered data around the place
    const bbox = getBBox(lat, lon, radiusMiles);
    try {
      const result = await fetchWaterBodies(bbox.south, bbox.west, bbox.north, bbox.east);
      if (result.data) {
        // Search raw fetched data directly (bypasses filters)
        wb = result.data.find(w =>
          w.name === name && Math.abs(w.lat - lat) < 0.01 && Math.abs(w.lon - lon) < 0.01
        );
        if (!wb) {
          let best = null, bestDist = Infinity;
          for (const w of result.data) {
            if (w.name !== name) continue;
            const d = Math.abs(w.lat - lat) + Math.abs(w.lon - lon);
            if (d < bestDist) { bestDist = d; best = w; }
          }
          wb = best;
        }
      }
    } catch (e) {
      console.warn('Failed to load water bodies for saved place:', e);
    }
  }
  // Last resort: build a minimal water body from saved place data
  if (!wb) {
    wb = { name, type: el.dataset.type || 'pond', lat, lon, tags: {} };
  }
  const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
  showWaterDetail(wb, dist);
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

  const wb = typeof wbJson === 'string' ? JSON.parse(wbJson) : wbJson;
  tripWizard = { wb, forecast: null, traffic: null, selectedSpecies: [] };

  // Clear stale trout warning from previous trip
  const tripWarnEl = document.getElementById('trip-trout-warn');
  if (tripWarnEl) tripWarnEl.innerHTML = '';

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
    const species = getCommonSpecies(wb.type, wb.lat, wb.lon, wb.name);
    const selectorEl = $('#trip-species-selector');
    selectorEl.innerHTML = species.map(s =>
      `<button class="species-chip" data-species="${escapeAttr(s)}" onclick="window._toggleTripSpecies(this)">${escapeHtml(s)}</button>`
    ).join('');
    tripWizard.selectedSpecies = [];

    // Trout warning in trip planner
    if (isTroutLocation(wb)) {
      const warnHtml = getTroutWarningHtml(wb, 'trip');
      if (warnHtml) {
        const warnDiv = document.getElementById('trip-trout-warn');
        if (warnDiv) warnDiv.innerHTML = warnHtml;
      }
    }

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

  // Share button
  $('#trip-plan-summary').innerHTML += `
    <button class="btn-secondary" style="margin-top:8px;width:100%;" onclick="window._shareTripBrief()">
      <svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle;margin-right:4px;"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" fill="currentColor"/></svg>
      Share Trip Brief
    </button>
  `;

  // Gear checklist
  $('#trip-gear-area').innerHTML = getGearChecklistHtml(gear, clarity);
  $('#trip-notes').value = '';

  showTripStep(3);
}

window._shareTripBrief = async function() {
  const { wb, forecast, selectedSpecies } = tripWizard;
  if (!wb || !forecast) return;

  const lines = [
    `\u{1F3A3} ${wb.name} \u2014 ${forecast.date}`,
    `\u23F0 ${forecast.timeWindowLabel}`,
    `\u{1F321}\uFE0F ${forecast.temp}\u00B0F, ${forecast.conditions}`,
    `\u{1F4A8} Wind ${forecast.windSpeed} mph, Gusts ${forecast.windGusts} mph`,
    `\u{1F4CA} Fish Activity: ${forecast.fishActivity}/100`,
    `\u{1F41F} Target: ${selectedSpecies.join(', ')}`,
    ``,
    `\u{1F4CD} Directions: https://www.google.com/maps/dir/?api=1&destination=${wb.lat},${wb.lon}`,
    ``,
    `\u2014 via DND Shiet Fish Finder`,
  ];

  const text = lines.join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ title: `Fishing Trip: ${wb.name}`, text });
      toast('Shared!');
    } catch (e) {
      if (e.name !== 'AbortError') toast('Share failed', true);
    }
  } else {
    try {
      await navigator.clipboard.writeText(text);
      toast('Trip brief copied to clipboard!');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Trip brief copied!');
    }
  }
};

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
    <span class="detail-type-badge badge-${escapeAttr(trip.place_type)}">${escapeHtml(trip.place_type)}</span>
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

  // Hot Spots panel
  $('#btn-hotspots').addEventListener('click', () => {
    const panel = $('#hotspots-panel');
    panel.classList.toggle('hidden');
    filterPanel.classList.add('hidden');
    placesPanel.classList.add('hidden');
    if (!panel.classList.contains('hidden')) {
      loadHotSpots();
    }
  });
  $('#btn-close-hotspots').addEventListener('click', () => {
    $('#hotspots-panel').classList.add('hidden');
  });

  // More menu (mobile overflow)
  const moreBtn = $('#btn-more');
  const headerRight = $('.header-right');
  if (moreBtn) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = headerRight.querySelector('.overflow-menu-dropdown');
      if (existing) {
        existing.remove();
        return;
      }
      // Build dropdown from overflow buttons
      const dropdown = document.createElement('div');
      dropdown.className = 'overflow-menu-dropdown';
      const overflowBtns = headerRight.querySelectorAll('.overflow-btn');
      overflowBtns.forEach(btn => {
        const clone = btn.cloneNode(true);
        clone.addEventListener('click', () => {
          btn.click();
          dropdown.remove();
        });
        dropdown.appendChild(clone);
      });
      headerRight.appendChild(dropdown);
      // Close on outside click
      const closeMenu = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== moreBtn) {
          dropdown.remove();
          document.removeEventListener('click', closeMenu);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    });
  }

  // Unnamed filter checkbox — sync initial state
  const unnamedCb = document.getElementById('filter-hide-unnamed');
  if (unnamedCb) {
    unnamedCb.checked = hideUnnamed;
  }

  // Radius slider — live label update only (no apply until Go button)
  radiusSlider.addEventListener('input', () => {
    radiusValue.textContent = radiusSlider.value;
  });

  // Apply Filters button — single point of apply + close
  $('#btn-apply-filters').addEventListener('click', () => {
    // Read filter checkboxes
    const active = [...filterPanel.querySelectorAll('.filter-options input:checked')].map(c => c.dataset.type).filter(Boolean);
    if (active.length === 0) {
      toast('Select at least one type to show', true);
      return;
    }
    const waterTypes = active.filter(t => t !== 'usgs');
    if (waterTypes.length > 0) savePrefs(waterTypes);
    updateFilters(active, userLat, userLon, showWaterDetail, showUSGSDetail);

    // Read unnamed toggle
    const unCb = document.getElementById('filter-hide-unnamed');
    const newHideUnnamed = unCb ? unCb.checked : hideUnnamed;
    const unnamedChanged = newHideUnnamed !== hideUnnamed;
    hideUnnamed = newHideUnnamed;
    localStorage.setItem('wwf_hide_unnamed', hideUnnamed ? 'true' : 'false');

    // Read radius
    const newRadius = parseInt(radiusSlider.value);
    const radiusChanged = newRadius !== radiusMiles;
    radiusMiles = newRadius;
    if (radiusChanged) updateRadius(radiusMiles, userLat, userLon);

    // Reload data if radius or unnamed filter changed
    if (radiusChanged || unnamedChanged) {
      loadData();
    }

    // Close the panel
    filterPanel.classList.add('hidden');
  });

  // Detail panel close
  $('#btn-close-detail').addEventListener('click', () => {
    detailPanel.classList.add('hidden');
    clearHighlight();
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
        }).catch(e => toast('Sign out failed — try again', true))
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
      errorEl.textContent = isSignUp ? (err.message || 'Sign up failed') : 'Incorrect email or password';
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

  // === Social Feed ===
  $('#btn-social').addEventListener('click', () => {
    if (!getUser()) { authModal.classList.remove('hidden'); return; }
    openSocialFeed();
  });
  $('#btn-close-social').addEventListener('click', () => {
    document.getElementById('social-panel').classList.add('hidden');
  });

  // === License Wallet ===
  $('#btn-licenses').addEventListener('click', () => {
    if (!getUser()) { authModal.classList.remove('hidden'); return; }
    openLicensePanel();
  });
  $('#btn-close-licenses').addEventListener('click', () => {
    licensePanel.classList.add('hidden');
  });

  // === Arsenal ===
  $('#btn-arsenal').addEventListener('click', async () => {
    if (!getUser()) { authModal.classList.remove('hidden'); return; }
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
  let arsenalSearchTimer = null;
  $('#arsenal-search').addEventListener('input', () => {
    arsenalFilters.search = $('#arsenal-search').value;
    clearTimeout(arsenalSearchTimer);
    arsenalSearchTimer = setTimeout(renderArsenal, 150);
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
        const safeData = { name: itemData.name, category: itemData.category, color: itemData.color, weight: itemData.weight, brand: itemData.brand, size: itemData.size, notes: itemData.notes };
        const updated = await updateArsenalItem(user.id, editId, safeData, photoFile, oldItem?.photo_path);
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

  // Swipe down to close detail panel — only from the handle bar
  let touchStartY = 0;
  const handle = $('#detail-handle');
  handle.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
    e.preventDefault(); // prevent scroll from also triggering
  }, { passive: false });
  handle.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 80) {
      detailPanel.classList.add('hidden');
    }
    e.preventDefault(); // prevent scroll during drag
  }, { passive: false });

  // Event delegation for lure card expand/collapse and USGS item clicks
  detailPanel.addEventListener('click', (e) => {
    // USGS nearby item click
    const usgsItem = e.target.closest('.nearby-usgs-item');
    if (usgsItem && usgsItem.dataset.siteCode) {
      document.dispatchEvent(new CustomEvent('show-usgs', { detail: usgsItem.dataset.siteCode }));
      return;
    }
    // Lure card expand/collapse
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
  return n === '' || n === 'unnamed' || n.startsWith('unnamed ') || n === 'unknown' || n === 'no name'
    || /^(Lake|Pond|River|Creek|Boat Landing|Fishing Pier) #\d+$/.test(name);
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
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// ===== License Wallet (localStorage, on-device) =====

const LICENSE_KEY = 'wwf_licenses';
const MAX_LICENSES = 4;

function getLicenses() {
  try {
    return JSON.parse(localStorage.getItem(LICENSE_KEY)) || [];
  } catch { return []; }
}

function saveLicenses(licenses) {
  try {
    localStorage.setItem(LICENSE_KEY, JSON.stringify(licenses));
  } catch (e) {
    toast('Storage full — try removing a license or using a smaller photo', true);
    console.warn('localStorage quota exceeded:', e);
  }
}

function openLicensePanel() {
  licensePanel.classList.remove('hidden');
  renderLicenseSlots();
}

function renderLicenseSlots() {
  const licenses = getLicenses();
  const slotsEl = document.getElementById('license-slots');
  if (!slotsEl) return;

  let html = '';

  // Render existing licenses
  for (let i = 0; i < licenses.length; i++) {
    const lic = licenses[i];
    html += `
      <div class="license-slot" data-idx="${i}">
        <div class="license-slot-header">
          <span>License ${i + 1}</span>
          <button class="license-slot-remove" onclick="window._removeLicense(${i})">Remove</button>
        </div>
        <div class="license-photo-area" onclick="window._changeLicensePhoto(${i})">
          ${lic.photo
            ? `<img src="${escapeAttr(lic.photo)}" alt="License ${i + 1}">`
            : `<div class="license-photo-placeholder">
                <svg viewBox="0 0 24 24" width="32" height="32"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" fill="currentColor"/></svg>
                Tap to add photo
              </div>`
          }
        </div>
        <input type="text" class="license-label-input" placeholder="Label (e.g. VA Fishing License, Trout Stamp...)"
          value="${escapeAttr(lic.label || '')}" onchange="window._updateLicenseLabel(${i}, this.value)">
      </div>
    `;
  }

  // Add slot button if under max
  if (licenses.length < MAX_LICENSES) {
    html += `
      <button class="btn-primary" style="width:100%;" onclick="window._addLicenseSlot()">
        + Add License (${licenses.length}/${MAX_LICENSES})
      </button>
    `;
  }

  if (licenses.length === 0) {
    html = `
      <p class="places-empty">No licenses saved yet</p>
      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="window._addLicenseSlot()">
        + Add Your First License
      </button>
    `;
  }

  slotsEl.innerHTML = html;
}

window._addLicenseSlot = function() {
  const licenses = getLicenses();
  if (licenses.length >= MAX_LICENSES) { toast('Maximum 4 licenses', true); return; }
  licenses.push({ photo: null, label: '' });
  saveLicenses(licenses);
  renderLicenseSlots();
};

window._removeLicense = function(idx) {
  const licenses = getLicenses();
  licenses.splice(idx, 1);
  saveLicenses(licenses);
  renderLicenseSlots();
  toast('License removed');
};

window._updateLicenseLabel = function(idx, value) {
  const licenses = getLicenses();
  if (licenses[idx]) {
    licenses[idx].label = value;
    saveLicenses(licenses);
  }
};

window._changeLicensePhoto = function(idx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async (e) => {
    input.remove();
    const file = e.target.files[0];
    if (!file) return;

    // Resize to keep localStorage manageable (max 600px wide)
    const blob = await resizeImage(file, 600);
    const reader2 = new FileReader();
    reader2.onload = (ev2) => {
      const licenses = getLicenses();
      if (licenses[idx]) {
        licenses[idx].photo = ev2.target.result;
        saveLicenses(licenses);
        renderLicenseSlots();
        toast('Photo saved');
      }
    };
    reader2.readAsDataURL(blob);
  };
  input.click();
};

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

  // Double-tap zoom is prevented via CSS touch-action: manipulation on interactive elements
  // No JS handler needed — the CSS approach doesn't block legitimate clicks
}

// ===== Service Worker =====

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      toast('App updated — reload for the latest version');
    });
  }
}

// ===== Start =====
init();
