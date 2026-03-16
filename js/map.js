/**
 * Leaflet map management — markers, layers, radius circle.
 */

import { distanceMiles } from './api.js';

let map = null;
let userMarker = null;
let radiusCircle = null;
let waterLayer = null;
let usgsLayer = null;
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

function createMarkerIcon(type) {
  const cfg = MARKER_ICONS[type] || MARKER_ICONS.stream;
  return L.divIcon({
    className: `marker-water ${cfg.cls}`,
    html: `<span class="marker-icon-inner">${cfg.emoji}</span>`,
    iconSize: type === 'lake' ? [28, 28] : type === 'usgs' ? [26, 26] : type === 'river' ? [24, 24] : type === 'pond' ? [22, 22] : [20, 20],
    iconAnchor: type === 'lake' ? [14, 14] : type === 'usgs' ? [13, 13] : type === 'river' ? [12, 12] : type === 'pond' ? [11, 11] : [10, 10],
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
};
