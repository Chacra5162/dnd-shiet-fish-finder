/**
 * Leaflet map management — markers, layers, radius circle.
 * Uses canvas renderer + circleMarkers for performance with many markers.
 */

import { distanceMiles } from './api.js';

let map = null;
let canvasRenderer = null;
let userMarker = null;
let radiusCircle = null;
let waterLayer = null;
let usgsLayer = null;
let userPlacesLayer = null;
let allWaterBodies = [];
let allUSGSSites = [];
let activeFilters = new Set(['lake', 'river', 'stream', 'pond', 'boat_landing', 'fishing_pier', 'usgs']);

// Color + size config for each water body type (used by circleMarkers on canvas)
const MARKER_STYLES = {
  lake:          { color: '#2980b9', radius: 10, weight: 2 },
  river:         { color: '#1abc9c', radius: 8,  weight: 2 },
  stream:        { color: '#27ae60', radius: 6,  weight: 2 },
  pond:          { color: '#8e44ad', radius: 7,  weight: 2 },
  boat_landing:  { color: '#e67e22', radius: 9,  weight: 2 },
  fishing_pier:  { color: '#9b59b6', radius: 9,  weight: 2 },
  usgs:          { color: '#e74c3c', radius: 9,  weight: 2 },
};
const DEFAULT_STYLE = { color: '#27ae60', radius: 6, weight: 2 };

// SVG divIcons only for user place markers (small count, need distinct shapes)
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
  // Canvas renderer — draws all circleMarkers to a single <canvas>, much faster than DOM
  canvasRenderer = L.canvas({ padding: 0.5 });

  map = L.map('map', {
    center: [lat, lon],
    zoom: 11,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // User location marker — pulsing blue dot
  userMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'user-location-marker',
      html: '<div class="user-pulse-ring"></div><div class="user-dot"></div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    }),
    zIndexOffset: 1000,
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
      <div class="legend-item"><div class="legend-dot" style="background:var(--boat-landing)"></div> Boat Landing</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--fishing-pier)"></div> Fishing Pier</div>
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

  // Water bodies — canvas circleMarkers (fast)
  for (const wb of allWaterBodies) {
    if (!activeFilters.has(wb.type)) continue;

    const style = MARKER_STYLES[wb.type] || DEFAULT_STYLE;
    const marker = L.circleMarker([wb.lat, wb.lon], {
      renderer: canvasRenderer,
      radius: style.radius,
      fillColor: style.color,
      fillOpacity: 0.85,
      color: '#fff',
      weight: style.weight,
    });

    marker.bindTooltip(wb.name, {
      direction: 'top',
      offset: [0, -style.radius],
      className: 'leaflet-tooltip',
    });

    marker.on('click', () => {
      const dist = distanceMiles(userLat, userLon, wb.lat, wb.lon);
      onClickWater(wb, dist);
    });
    waterLayer.addLayer(marker);
  }

  // USGS sites — canvas circleMarkers
  if (activeFilters.has('usgs')) {
    const usgsStyle = MARKER_STYLES.usgs;
    for (const site of allUSGSSites) {
      const marker = L.circleMarker([site.lat, site.lon], {
        renderer: canvasRenderer,
        radius: usgsStyle.radius,
        fillColor: usgsStyle.color,
        fillOpacity: 0.85,
        color: '#fff',
        weight: usgsStyle.weight,
      });

      marker.bindTooltip(`USGS: ${site.name}`, {
        direction: 'top',
        offset: [0, -usgsStyle.radius],
      });

      marker.on('click', () => {
        const dist = distanceMiles(userLat, userLon, site.lat, site.lon);
        onClickUSGS(site, dist);
      });
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
// These use divIcons (small count) so they get distinct shapes
function setUserPlaceMarkers(places, onClickPlace) {
  if (!userPlacesLayer) return;
  userPlacesLayer.clearLayers();

  for (const place of places) {
    const icon = createUserPlaceIcon(place.status);
    const marker = L.marker([place.lat, place.lon], {
      icon,
      title: `${place.place_name} (${place.status})`,
      zIndexOffset: 500,
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

// ===== Highlight selected marker =====
let highlightLayer = null;

function highlightMarker(lat, lon, color) {
  clearHighlight();
  const c = color || '#f1c40f';
  highlightLayer = L.layerGroup().addTo(map);

  // Outer pulsing ring
  L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'highlight-pulse-wrapper',
      html: `<div class="highlight-ring" style="border-color:${c};box-shadow:0 0 20px ${c}"></div>`,
      iconSize: [80, 80],
      iconAnchor: [40, 40],
    }),
    zIndexOffset: 900,
    interactive: false,
  }).addTo(highlightLayer);

  // Bouncing pin
  L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'highlight-pin-wrapper',
      html: `<div class="highlight-pin" style="background:${c}"><div class="highlight-pin-dot"></div></div>`,
      iconSize: [24, 40],
      iconAnchor: [12, 40],
    }),
    zIndexOffset: 950,
    interactive: false,
  }).addTo(highlightLayer);
}

function clearHighlight() {
  if (highlightLayer) {
    highlightLayer.remove();
    highlightLayer = null;
  }
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
  highlightMarker,
  clearHighlight,
};
