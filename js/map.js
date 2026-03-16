/**
 * Leaflet map management — markers, layers, radius circle.
 */

import { distanceMiles } from './api.js';

let map = null;
let userMarker = null;
let radiusCircle = null;
let waterLayer = null;
let usgsLayer = null;
let userPlacesLayer = null;
let allWaterBodies = [];
let allUSGSSites = [];
let activeFilters = new Set(['lake', 'river', 'stream', 'pond', 'usgs']);

const MARKER_ICONS = {
  lake: { emoji: '~', cls: 'marker-lake' },
  river: { emoji: '~', cls: 'marker-river' },
  stream: { emoji: '~', cls: 'marker-stream' },
  pond: { emoji: '~', cls: 'marker-pond' },
  usgs: { emoji: '!', cls: 'marker-usgs' },
};

// SVG icons for user place statuses
const USER_PLACE_ICONS = {
  favorite: {
    svg: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="#1a1a2e" stroke="#1a1a2e" stroke-width="0.5"/></svg>',
    cls: 'marker-user-favorite',
  },
  visited: {
    svg: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#1a1a2e" stroke="#1a1a2e" stroke-width="0.5"/></svg>',
    cls: 'marker-user-visited',
  },
  avoid: {
    svg: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" fill="#1a1a2e" stroke="#1a1a2e" stroke-width="0.5"/></svg>',
    cls: 'marker-user-avoid',
  },
};

function createMarkerIcon(type) {
  const cfg = MARKER_ICONS[type] || MARKER_ICONS.stream;
  return L.divIcon({
    className: `marker-water ${cfg.cls}`,
    html: `<span class="marker-icon-inner">${cfg.emoji}</span>`,
    iconSize: type === 'lake' ? [28, 28] : type === 'usgs' ? [26, 26] : type === 'river' ? [24, 24] : type === 'pond' ? [22, 22] : [20, 20],
    iconAnchor: type === 'lake' ? [14, 14] : type === 'usgs' ? [13, 13] : type === 'river' ? [12, 12] : type === 'pond' ? [11, 11] : [10, 10],
  });
}

function createUserPlaceIcon(status) {
  const cfg = USER_PLACE_ICONS[status] || USER_PLACE_ICONS.favorite;
  return L.divIcon({
    className: `marker-user-place ${cfg.cls}`,
    html: cfg.svg,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function initMap(lat, lon, radiusMiles) {
  map = L.map('map', {
    center: [lat, lon],
    zoom: 11,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // User location marker
  userMarker = L.circleMarker([lat, lon], {
    radius: 8,
    fillColor: '#3498db',
    fillOpacity: 1,
    color: '#fff',
    weight: 3,
  }).addTo(map).bindPopup('You are here');

  // Radius circle
  radiusCircle = L.circle([lat, lon], {
    radius: radiusMiles * 1609.34, // miles to meters
    color: '#3498db',
    fillColor: '#3498db',
    fillOpacity: 0.04,
    weight: 1,
    dashArray: '6 4',
  }).addTo(map);

  // Layer groups
  waterLayer = L.layerGroup().addTo(map);
  usgsLayer = L.layerGroup().addTo(map);
  userPlacesLayer = L.layerGroup().addTo(map);

  // Legend
  addLegend();

  return map;
}

function addLegend() {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <h4>Water Bodies</h4>
      <div class="legend-item"><div class="legend-dot" style="background:var(--lake)"></div> Lake / Reservoir</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--river)"></div> River</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--stream)"></div> Stream / Creek</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--pond)"></div> Pond</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--usgs)"></div> USGS Station</div>
      <h4 style="margin-top:6px;">My Places</h4>
      <div class="legend-item"><div class="legend-dot" style="background:#f1c40f"></div> Favorite</div>
      <div class="legend-item"><div class="legend-dot" style="background:#2ecc71"></div> Visited</div>
      <div class="legend-item"><div class="legend-dot" style="background:#e74c3c"></div> Avoid</div>
    `;
    return div;
  };
  legend.addTo(map);
}

function setMarkers(waterBodies, usgsSites, userLat, userLon, onClickWater, onClickUSGS) {
  allWaterBodies = waterBodies;
  allUSGSSites = usgsSites;

  renderMarkers(userLat, userLon, onClickWater, onClickUSGS);
}

function renderMarkers(userLat, userLon, onClickWater, onClickUSGS) {
  waterLayer.clearLayers();
  usgsLayer.clearLayers();

  // Water bodies
  for (const wb of allWaterBodies) {
    if (!activeFilters.has(wb.type)) continue;

    const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
    const marker = L.marker([wb.lat, wb.lon], {
      icon: createMarkerIcon(wb.type),
      title: wb.name,
    });

    marker.bindTooltip(wb.name, {
      direction: 'top',
      offset: [0, -10],
      className: 'leaflet-tooltip',
    });

    marker.on('click', () => onClickWater(wb, dist));
    waterLayer.addLayer(marker);
  }

  // USGS sites
  if (activeFilters.has('usgs')) {
    for (const site of allUSGSSites) {
      const dist = distanceMiles(userLat, userLon, site.lat, site.lon);
      const marker = L.marker([site.lat, site.lon], {
        icon: createMarkerIcon('usgs'),
        title: site.name,
      });

      marker.bindTooltip(`USGS: ${site.name}`, {
        direction: 'top',
        offset: [0, -10],
      });

      marker.on('click', () => onClickUSGS(site, dist));
      usgsLayer.addLayer(marker);
    }
  }
}

function updateFilters(filters, userLat, userLon, onClickWater, onClickUSGS) {
  activeFilters = new Set(filters);
  renderMarkers(userLat, userLon, onClickWater, onClickUSGS);
}

function updateRadius(radiusMiles, lat, lon) {
  if (radiusCircle) {
    radiusCircle.setRadius(radiusMiles * 1609.34);
  }
}

function recenter(lat, lon) {
  if (map) {
    map.setView([lat, lon], map.getZoom());
  }
}

function panTo(lat, lon, zoom) {
  if (map) {
    map.setView([lat, lon], zoom || map.getZoom(), { animate: true });
  }
}

// Render user place markers (favorites, visited, avoid) on the map
function setUserPlaceMarkers(places, onClickPlace) {
  if (!userPlacesLayer) return;
  userPlacesLayer.clearLayers();

  for (const place of places) {
    const icon = createUserPlaceIcon(place.status);
    const marker = L.marker([place.lat, place.lon], {
      icon,
      title: `${place.place_name} (${place.status})`,
      zIndexOffset: 500, // above regular markers
    });

    const statusLabel = place.status === 'favorite' ? 'Favorite' : place.status === 'visited' ? 'Visited' : 'Avoid';
    marker.bindTooltip(`${statusLabel}: ${place.place_name}`, {
      direction: 'top',
      offset: [0, -14],
      className: 'leaflet-tooltip',
    });

    if (onClickPlace) {
      marker.on('click', () => onClickPlace(place));
    }

    userPlacesLayer.addLayer(marker);
  }
}

// Find USGS sites near a given water body
function findNearbyUSGS(lat, lon, maxMiles = 5) {
  return allUSGSSites
    .map(site => ({
      ...site,
      dist: distanceMiles(lat, lon, site.lat, site.lon),
    }))
    .filter(s => s.dist <= maxMiles)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);
}

export {
  initMap,
  setMarkers,
  updateFilters,
  updateRadius,
  recenter,
  panTo,
  findNearbyUSGS,
  setUserPlaceMarkers,
};
