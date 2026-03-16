/**
 * WaterWay Finder — Main App
 * PWA for discovering nearby water bodies with real-time USGS data.
 * Focused on Virginia & North Carolina.
 */

import { fetchWaterBodies, fetchUSGSSites, getFishingLinks, getCommonSpecies, getBBox, distanceMiles } from './api.js';
import { initMap, setMarkers, updateFilters, updateRadius, recenter, panTo, findNearbyUSGS } from './map.js';

// ===== State =====
let userLat = 37.54; // Default: Richmond, VA (central/eastern VA)
let userLon = -77.43;
let radiusMiles = 20;
let waterBodies = [];
let usgsSites = [];

// ===== DOM refs =====
const $ = (sel) => document.querySelector(sel);
const loadingScreen = $('#loading-screen');
const loadingStatus = $('#loading-status');
const filterPanel = $('#filter-panel');
const detailPanel = $('#detail-panel');
const detailContent = $('#detail-content');
const infoModal = $('#info-modal');
const toastContainer = $('#toast-container');
const radiusSlider = $('#radius-slider');
const radiusValue = $('#radius-value');

// ===== Init =====
async function init() {
  registerServiceWorker();
  setupEventListeners();

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

    const total = waterBodies.length + usgsSites.length;
    toast(`Found ${waterBodies.length} water bodies, ${usgsSites.length} USGS stations`);

  } catch (err) {
    console.error('Load error:', err);
    toast('Error loading data — try again later', true);
  }
}

// ===== Detail Panels =====

function showWaterDetail(wb, dist) {
  const nearbyUSGS = findNearbyUSGS(wb.lat, wb.lon, 10);
  const links = getFishingLinks(wb.lat, wb.lon, wb.type, wb.name);
  const species = getCommonSpecies(wb.type, wb.lat, wb.lon);
  const typeLabel = { lake: 'Lake / Reservoir', river: 'River', stream: 'Stream / Creek', pond: 'Pond' };

  let html = `
    <h2>${wb.name}</h2>
    <span class="detail-type-badge badge-${wb.type}">${typeLabel[wb.type] || wb.type}</span>
    <span style="color:var(--text-muted); font-size:0.85rem; margin-left:8px;">${dist.toFixed(1)} mi away</span>
  `;

  // Common species
  html += `
    <div class="detail-section">
      <h3>Common Species (${wb.type === 'lake' || wb.type === 'pond' ? 'Freshwater' : 'In Area'})</h3>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        ${species.map(s => `<span style="background:var(--bg-surface); padding:4px 10px; border-radius:6px; font-size:0.85rem;">${s}</span>`).join('')}
      </div>
    </div>
  `;

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
                <div class="label">${label}</div>
                <div class="value">${val}</div>
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
                <div class="station-name">${s.name}</div>
                <div class="station-dist">${s.dist.toFixed(1)} mi from ${wb.name}${dataStr}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Links
  html += `
    <div class="detail-section">
      <h3>Resources</h3>
      <div class="detail-links">
        ${links.map(l => `
          <a href="${l.url}" target="_blank" rel="noopener" class="detail-link">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>
            ${l.label}
          </a>
        `).join('')}
      </div>
    </div>
  `;

  // Coordinates
  html += `
    <div style="margin-top:16px; font-size:0.75rem; color:var(--text-muted);">
      ${wb.lat.toFixed(5)}, ${wb.lon.toFixed(5)}
    </div>
  `;

  detailContent.innerHTML = html;
  detailPanel.classList.remove('hidden');
  panTo(wb.lat, wb.lon, 13);
}

function showUSGSDetail(site, dist) {
  const links = getFishingLinks(site.lat, site.lon, 'river', site.name);

  let html = `
    <h2>${site.name}</h2>
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
                <div class="label">${d.name}</div>
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

  // USGS data page link
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
            ${l.label}
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

// ===== Event Listeners =====

function setupEventListeners() {
  // Filter panel
  $('#btn-filter').addEventListener('click', () => {
    filterPanel.classList.toggle('hidden');
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

// ===== Toast =====

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
