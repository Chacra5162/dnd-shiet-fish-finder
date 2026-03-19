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
let attractorLayer = null;
let baseLayers = {};
let navionicsLayer = null;
let depthOverlay = null;
let depthMode = null; // null, 'ocean', 'nautical'
let currentBase = 'dark';
let allWaterBodies = [];
let allUSGSSites = [];
let allAttractors = [];
let activeFilters = new Set(['lake', 'river', 'stream', 'pond', 'boat_landing', 'fishing_pier', 'usgs', 'fish_attractor']);

// Color + size config for each water body type (used by circleMarkers on canvas)
const MARKER_STYLES = {
  lake:          { color: '#2980b9', radius: 10, weight: 2 },
  river:         { color: '#1abc9c', radius: 8,  weight: 2 },
  stream:        { color: '#27ae60', radius: 6,  weight: 2 },
  pond:          { color: '#8e44ad', radius: 7,  weight: 2 },
  boat_landing:  { color: '#e67e22', radius: 9,  weight: 2 },
  fishing_pier:    { color: '#9b59b6', radius: 9,  weight: 2 },
  usgs:            { color: '#e74c3c', radius: 9,  weight: 2 },
  fish_attractor:  { color: '#f39c12', radius: 8,  weight: 2 },
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

  // Base map layers
  baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  });
  baseLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  });
  baseLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17,
  });
  baseLayers.dark.addTo(map);

  // Map style switcher control
  addMapSwitcher();

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
  attractorLayer = L.layerGroup().addTo(map);
  userPlacesLayer = L.layerGroup().addTo(map);

  // Legend
  addLegend();

  return map;
}

function addMapSwitcher() {
  const switcher = L.control({ position: 'topright' });
  switcher.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-switcher');
    div.innerHTML = `
      <button class="map-switch-btn active" data-layer="dark" title="Dark map">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 01-4.4 2.26 5.403 5.403 0 01-3.14-9.8c-.44-.06-.9-.1-1.36-.1z" fill="currentColor"/></svg>
      </button>
      <button class="map-switch-btn" data-layer="satellite" title="Satellite view">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="currentColor"/></svg>
      </button>
      <button class="map-switch-btn" data-layer="topo" title="Topographic map">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z" fill="currentColor"/></svg>
      </button>
    `;
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-layer]');
      if (!btn) return;
      const layer = btn.dataset.layer;
      if (layer === currentBase) return;
      map.removeLayer(baseLayers[currentBase]);
      baseLayers[layer].addTo(map);
      currentBase = layer;
      div.querySelectorAll('.map-switch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    return div;
  };
  switcher.addTo(map);

  // Depth / Chart overlay control
  const depthCtrl = L.control({ position: 'topright' });
  depthCtrl.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-switcher depth-switcher');
    div.innerHTML = `
      <button class="map-switch-btn" data-depth="hydro" title="USGS Hydro — rivers, lakes, streams">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="currentColor"/></svg>
      </button>
      <button class="map-switch-btn" data-depth="ustopo" title="USGS Topo — contour lines">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z" fill="currentColor"/></svg>
      </button>
      <button class="map-switch-btn" data-depth="ocean" title="Ocean depth — coastal/bay bathymetry">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M2 17l2-1c2-2 4-2 6 0s4 2 6 0 4-2 6 0l2 1v2l-2-1c-2-2-4-2-6 0s-4 2-6 0-4-2-6 0l-2 1v-2zm0-5l2-1c2-2 4-2 6 0s4 2 6 0 4-2 6 0l2 1v2l-2-1c-2-2-4-2-6 0s-4 2-6 0-4-2-6 0l-2 1v-2zm0-5l2-1c2-2 4-2 6 0s4 2 6 0 4-2 6 0l2 1v2l-2-1c-2-2-4-2-6 0s-4 2-6 0-4-2-6 0l-2 1V7z" fill="currentColor"/></svg>
      </button>
      <button class="map-switch-btn" data-depth="nautical" title="NOAA Nautical — chart overlay">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" fill="currentColor"/></svg>
      </button>
    `;
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-depth]');
      if (!btn) return;
      const mode = btn.dataset.depth;
      toggleDepthOverlay(mode, div);
    });
    return div;
  };
  depthCtrl.addTo(map);
}

function toggleDepthOverlay(mode, container) {
  // Remove existing overlay
  if (depthOverlay) {
    map.removeLayer(depthOverlay);
    depthOverlay = null;
  }

  // Toggle off if same mode clicked again
  if (depthMode === mode) {
    depthMode = null;
    container.querySelectorAll('.map-switch-btn').forEach(b => b.classList.remove('active'));
    return;
  }

  depthMode = mode;
  container.querySelectorAll('.map-switch-btn').forEach(b => b.classList.remove('active'));
  container.querySelector(`[data-depth="${mode}"]`).classList.add('active');

  if (mode === 'hydro') {
    // USGS Hydro — detailed water features (rivers, lakes, streams) with surrounding topo
    // Works everywhere in the US, shows stream/river detail with shaded relief
    depthOverlay = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; USGS The National Map',
      maxZoom: 16,
      opacity: 0.8,
    }).addTo(map);
  } else if (mode === 'ustopo') {
    // USGS Topo — full topographic map with contour lines around all water bodies
    // Shows elevation contours, water features, roads — works everywhere in the US
    depthOverlay = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; USGS The National Map',
      maxZoom: 16,
      opacity: 0.85,
    }).addTo(map);
  } else if (mode === 'ocean') {
    // Esri Ocean basemap — underwater topography + depth shading for coastal/bay areas
    const oceanBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, GEBCO, NOAA',
      maxZoom: 16,
      opacity: 0.7,
    });
    const oceanRef = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
      opacity: 0.9,
    });
    depthOverlay = L.layerGroup([oceanBase, oceanRef]).addTo(map);
  } else if (mode === 'nautical') {
    // NOAA ENC — navigational chart with depth soundings, contours, channels
    // Only covers navigable waterways (coastal, bay, major tidal rivers)
    depthOverlay = L.tileLayer('', {
      maxZoom: 18,
      opacity: 0.75,
      attribution: '&copy; NOAA Office of Coast Survey',
    });
    depthOverlay.getTileUrl = function(coords) {
      const tileSize = 256;
      const nwPoint = coords.scaleBy(L.point(tileSize, tileSize));
      const sePoint = nwPoint.add(L.point(tileSize, tileSize));
      const nw = map.unproject(nwPoint, coords.z);
      const se = map.unproject(sePoint, coords.z);
      const toMerc = (lat, lon) => {
        const x = lon * 20037508.34 / 180;
        let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
        y = y * 20037508.34 / 180;
        return [x, y];
      };
      const [x1, y1] = toMerc(se.lat, nw.lng);
      const [x2, y2] = toMerc(nw.lat, se.lng);
      return `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/export?bbox=${x1},${y1},${x2},${y2}&bboxSR=3857&imageSR=3857&size=${tileSize},${tileSize}&format=png&transparent=true&f=image`;
    };
    depthOverlay.addTo(map);
  }
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
      <div class="legend-item"><div class="legend-dot" style="background:#f39c12"></div> Fish Attractor</div>
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

// ===== Fish Attractors =====

function setAttractors(attractors, onClickAttractor) {
  allAttractors = attractors;
  renderAttractors(onClickAttractor);
}

function renderAttractors(onClickAttractor) {
  if (!attractorLayer) return;
  attractorLayer.clearLayers();
  if (!activeFilters.has('fish_attractor')) return;

  const style = MARKER_STYLES.fish_attractor;
  for (const a of allAttractors) {
    const marker = L.circleMarker([a.lat, a.lon], {
      renderer: canvasRenderer,
      radius: style.radius,
      fillColor: style.color,
      fillOpacity: 0.9,
      color: '#fff',
      weight: style.weight,
    });

    const tip = `${a.structure || 'Fish Attractor'}${a.depth ? ' (' + a.depth + ' ft)' : ''} - ${a.waterbody || ''}`;
    marker.bindTooltip(tip, { direction: 'top', offset: [0, -style.radius] });

    if (onClickAttractor) {
      marker.on('click', () => onClickAttractor(a));
    }
    attractorLayer.addLayer(marker);
  }
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
  setAttractors,
  highlightMarker,
  clearHighlight,
};
