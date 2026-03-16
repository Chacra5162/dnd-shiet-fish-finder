/**
 * API integrations: USGS Water Services + OpenStreetMap Overpass
 * Only fetches data relevant to the user's current location.
 */

import { STORES, getCached, setCache, getMultiCached } from './cache.js';

// ===== Overpass API (Water Bodies) =====

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function buildOverpassQuery(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:45];
(
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"="river"](${bbox});
  way["waterway"="stream"](${bbox});
  way["waterway"="creek"](${bbox});
  way["waterway"="canal"](${bbox});
  way["water"="lake"](${bbox});
  way["water"="pond"](${bbox});
  way["water"="reservoir"](${bbox});
  way["water"="river"](${bbox});
  node["natural"="water"](${bbox});
  node["waterway"="river"](${bbox});
  node["waterway"="stream"](${bbox});
);
out center tags;
`.trim();
}

function classifyWaterBody(tags) {
  const water = tags.water || '';
  const waterway = tags.waterway || '';
  const natural = tags.natural || '';
  const name = (tags.name || '').toLowerCase();

  if (water === 'lake' || water === 'reservoir' || name.includes('lake') || name.includes('reservoir')) return 'lake';
  if (water === 'pond' || name.includes('pond')) return 'pond';
  if (waterway === 'river' || water === 'river' || name.includes('river')) return 'river';
  if (waterway === 'stream' || waterway === 'creek' || name.includes('stream') || name.includes('creek') || name.includes('branch') || name.includes('run')) return 'stream';
  if (natural === 'water') return 'lake'; // default natural=water to lake

  return 'stream'; // default fallback
}

// Assess whether a water body is likely on private property
// Returns { likely: bool, confidence: 'high'|'medium'|'low', reason: string }
function assessPrivateProperty(wb) {
  const tags = wb.tags || {};
  const name = (wb.name || '').toLowerCase();

  // === Definite signals from OSM tags ===

  // Explicitly tagged private
  if (tags.access === 'private' || tags.access === 'no') {
    return { likely: true, confidence: 'high', reason: 'Tagged as private access in OpenStreetMap' };
  }

  // Explicitly public
  if (tags.access === 'yes' || tags.access === 'public' || tags.access === 'permissive') {
    return { likely: false, confidence: 'high', reason: 'Public access' };
  }

  // Part of a public park, wildlife area, or managed land
  if (tags.leisure === 'park' || tags.leisure === 'nature_reserve' ||
      tags.boundary === 'national_park' || tags.boundary === 'protected_area' ||
      tags.ownership === 'public' || tags.ownership === 'national' ||
      tags.ownership === 'state' || tags.ownership === 'municipal' ||
      tags.operator?.toLowerCase().includes('wildlife') ||
      tags.operator?.toLowerCase().includes('park') ||
      tags.operator?.toLowerCase().includes('corps of engineers') ||
      tags.operator?.toLowerCase().includes('forest service')) {
    return { likely: false, confidence: 'high', reason: 'Public land / managed area' };
  }

  // Tagged with fishing access
  if (tags.fishing === 'yes' || tags.sport === 'fishing' || tags.leisure === 'fishing') {
    return { likely: false, confidence: 'medium', reason: 'Fishing access indicated' };
  }

  // On a golf course or private club
  if (tags.leisure === 'golf_course' || tags.club || tags.access === 'members') {
    return { likely: true, confidence: 'high', reason: 'Golf course or private club' };
  }

  // Part of residential/commercial landuse
  if (tags.landuse === 'residential' || tags.landuse === 'commercial' ||
      tags.landuse === 'farmland' || tags.landuse === 'farmyard') {
    return { likely: true, confidence: 'medium', reason: `Located on ${tags.landuse} land` };
  }

  // === Heuristic signals ===

  // Unnamed ponds are very likely private farm/residential ponds
  if (wb.type === 'pond' && name.startsWith('pond #')) {
    return { likely: true, confidence: 'medium', reason: 'Unnamed pond — likely private property' };
  }

  // Names suggesting private ownership
  const privateNames = ['farm', 'estate', 'ranch', 'private', 'country club',
    'golf', 'subdivision', 'HOA', 'homeowner', 'community pond'];
  if (privateNames.some(p => name.includes(p))) {
    return { likely: true, confidence: 'medium', reason: 'Name suggests private property' };
  }

  // Names suggesting public access
  const publicNames = ['state park', 'national', 'wildlife', 'management area',
    'public', 'county park', 'city park', 'memorial', 'recreation',
    'reservoir', 'army corps', 'national forest'];
  if (publicNames.some(p => name.includes(p))) {
    return { likely: false, confidence: 'medium', reason: 'Name suggests public land' };
  }

  // Large well-known rivers are almost always public waterways
  if (wb.type === 'river') {
    return { likely: false, confidence: 'low', reason: 'Rivers are generally public waterways (verify bank access)' };
  }

  // Small unnamed water bodies — could be either
  if (name.startsWith('lake #') || name.startsWith('creek #')) {
    return { likely: true, confidence: 'low', reason: 'Unnamed water body — access uncertain, may be private' };
  }

  // Default: unknown — show caution for ponds, less so for others
  if (wb.type === 'pond') {
    return { likely: true, confidence: 'low', reason: 'Small ponds are often on private land' };
  }

  return { likely: false, confidence: 'low', reason: '' };
}

// Fetch from Overpass with fallback servers and retry
async function fetchOverpass(query) {
  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        lastError = new Error(`Overpass ${response.status} from ${url}`);
        continue;
      }
      return await response.json();
    } catch (e) {
      lastError = e;
      console.warn(`Overpass server failed (${url}):`, e.message);
    }
  }
  throw lastError || new Error('All Overpass servers failed');
}

// Generate a readable name for unnamed water bodies
let unnamedCounter = 0;
function generateName(type, lat, lon) {
  unnamedCounter++;
  const typeLabels = { lake: 'Lake', pond: 'Pond', river: 'River', stream: 'Creek' };
  const label = typeLabels[type] || 'Pond';
  // Use coords to make a short semi-unique ID
  const id = Math.abs(Math.round((lat * 1000 + lon * 1000) % 10000));
  return `${label} #${id}-${unnamedCounter}`;
}

async function fetchWaterBodies(south, west, north, east) {
  // Check cache first for each grid cell
  const { cached, missing } = await getMultiCached(STORES.waterBodies, south, west, north, east);

  if (missing.length === 0) {
    return { data: dedupeWaterBodies(cached), fromCache: true };
  }

  // Fetch fresh data for the full bbox with fallback servers
  const query = buildOverpassQuery(south, west, north, east);
  const json = await fetchOverpass(query);

  const waterBodies = [];
  const seen = new Set();
  unnamedCounter = 0;

  for (const el of json.elements) {
    // Use center coords for ways/relations
    const lat = el.center?.lat || el.lat;
    const lon = el.center?.lon || el.lon;
    if (!lat || !lon) continue;

    const type = classifyWaterBody(el.tags || {});

    // Use OSM name if available, otherwise generate one
    let name = el.tags?.name;
    if (!name) {
      // Only include unnamed if it's a way or relation (has area/shape — skip random nodes)
      if (el.type === 'node') continue;
      name = generateName(type, lat, lon);
    }

    // Dedupe by name + approximate location
    const dedupeKey = `${name}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    waterBodies.push({
      id: el.id,
      name,
      type,
      lat,
      lon,
      tags: el.tags || {},
    });
  }

  // Cache per grid cell
  const gridMap = {};
  for (const wb of waterBodies) {
    const { getCellKey } = await import('./cache.js').then(m => ({ getCellKey: m.gridKey }));
    const key = getCellKey(wb.lat, wb.lon);
    if (!gridMap[key]) gridMap[key] = [];
    gridMap[key].push(wb);
  }

  for (const [key, items] of Object.entries(gridMap)) {
    const [lat, lon] = key.split('_').map(Number);
    await setCache(STORES.waterBodies, lat, lon, items);
  }

  return { data: dedupeWaterBodies([...cached, ...waterBodies]), fromCache: false };
}

function dedupeWaterBodies(items) {
  const seen = new Set();
  return items.filter(wb => {
    const key = `${wb.name}_${wb.lat.toFixed(3)}_${wb.lon.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


// ===== USGS Water Services API =====

const USGS_BASE = 'https://waterservices.usgs.gov/nwis/iv/';

// Parameter codes
const PARAMS = {
  '00010': { name: 'Water Temperature', unit: '°F', key: 'temp' },
  '00011': { name: 'Water Temperature', unit: '°F', key: 'temp' },
  '00060': { name: 'Discharge', unit: 'ft³/s', key: 'flow' },
  '00065': { name: 'Gauge Height', unit: 'ft', key: 'gauge' },
  '00045': { name: 'Precipitation', unit: 'in', key: 'precip' },
};

// USGS bbox limit is ~0.2 degrees wide. Split large areas into tiles.
const USGS_TILE_SIZE = 0.18; // degrees per tile (under 0.2 limit)

function splitBBox(south, west, north, east) {
  const tiles = [];
  for (let s = south; s < north; s += USGS_TILE_SIZE) {
    for (let w = west; w < east; w += USGS_TILE_SIZE) {
      tiles.push({
        south: s,
        west: w,
        north: Math.min(s + USGS_TILE_SIZE, north),
        east: Math.min(w + USGS_TILE_SIZE, east),
      });
    }
  }
  return tiles;
}

async function fetchUSGSTile(south, west, north, east) {
  const params = new URLSearchParams({
    format: 'json',
    bBox: `${west.toFixed(5)},${south.toFixed(5)},${east.toFixed(5)},${north.toFixed(5)}`,
    parameterCd: Object.keys(PARAMS).join(','),
    siteType: 'LK,ST,SP',
    siteStatus: 'active',
  });

  const response = await fetch(`${USGS_BASE}?${params}`);
  if (!response.ok) {
    console.warn(`USGS tile error ${response.status} for bbox ${west},${south},${east},${north}`);
    return [];
  }

  const json = await response.json();
  return parseUSGSResponse(json);
}

async function fetchUSGSSites(south, west, north, east) {
  // Check cache
  const { cached, missing } = await getMultiCached(STORES.usgs, south, west, north, east);

  if (missing.length === 0 && cached.length > 0) {
    // Still fetch current values (shorter cache)
    const withData = await enrichUSGSData(cached, south, west, north, east);
    return { data: withData, fromCache: true };
  }

  // Split into tiles that fit USGS bbox limit
  const tiles = splitBBox(south, west, north, east);
  const allSites = [];
  const seen = new Set();

  // Fetch tiles in parallel (max 4 concurrent to be polite)
  const batchSize = 4;
  for (let i = 0; i < tiles.length; i += batchSize) {
    const batch = tiles.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(t => fetchUSGSTile(t.south, t.west, t.north, t.east))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const site of r.value) {
          if (!seen.has(site.siteCode)) {
            seen.add(site.siteCode);
            allSites.push(site);
          }
        }
      }
    }
  }

  // Cache site locations per grid cell
  const gridMap = {};
  for (const site of allSites) {
    const { gridKey } = await import('./cache.js');
    const key = gridKey(site.lat, site.lon);
    if (!gridMap[key]) gridMap[key] = [];
    gridMap[key].push(site);
  }

  for (const [key, items] of Object.entries(gridMap)) {
    const [lat, lon] = key.split('_').map(Number);
    await setCache(STORES.usgs, lat, lon, items);
  }

  return { data: allSites, fromCache: false };
}

async function enrichUSGSData(sites, south, west, north, east) {
  // Check if we have recent current data
  const cacheKey = `current_${south.toFixed(2)}_${west.toFixed(2)}`;
  const cachedCurrent = await getCached(STORES.usgsCurrent, (south + north) / 2, (west + east) / 2);

  if (cachedCurrent) {
    return mergeSitesWithData(sites, cachedCurrent);
  }

  try {
    const tiles = splitBBox(south, west, north, east);
    const allFresh = [];
    const seen = new Set();

    const batchSize = 4;
    for (let i = 0; i < tiles.length; i += batchSize) {
      const batch = tiles.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(t => fetchUSGSTile(t.south, t.west, t.north, t.east))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const site of r.value) {
            if (!seen.has(site.siteCode)) {
              seen.add(site.siteCode);
              allFresh.push(site);
            }
          }
        }
      }
    }

    await setCache(STORES.usgsCurrent, (south + north) / 2, (west + east) / 2, allFresh);

    return allFresh.length > 0 ? allFresh : sites;
  } catch {
    return sites;
  }
}

function mergeSitesWithData(sites, freshData) {
  const dataMap = new Map(freshData.map(s => [s.siteCode, s]));
  return sites.map(site => dataMap.get(site.siteCode) || site);
}

function parseUSGSResponse(json) {
  const timeSeries = json?.value?.timeSeries || [];
  const siteMap = new Map();

  for (const ts of timeSeries) {
    const info = ts.sourceInfo;
    const code = info?.siteCode?.[0]?.value;
    if (!code) continue;

    if (!siteMap.has(code)) {
      siteMap.set(code, {
        siteCode: code,
        name: info.siteName || 'Unknown Station',
        lat: parseFloat(info.geoLocation?.geogLocation?.latitude),
        lon: parseFloat(info.geoLocation?.geogLocation?.longitude),
        type: 'usgs',
        data: {},
      });
    }

    const site = siteMap.get(code);
    const paramCode = ts.variable?.variableCode?.[0]?.value;
    const paramInfo = PARAMS[paramCode];
    if (!paramInfo) continue;

    const values = ts.values?.[0]?.value;
    if (!values || values.length === 0) continue;

    const latest = values[values.length - 1];
    const val = parseFloat(latest.value);
    if (isNaN(val) || val < -900) continue; // USGS uses -999999 for no data

    site.data[paramInfo.key] = {
      value: val,
      unit: paramInfo.unit,
      name: paramInfo.name,
      dateTime: latest.dateTime,
    };
  }

  return Array.from(siteMap.values()).filter(s => !isNaN(s.lat) && !isNaN(s.lon));
}


// ===== Fishing Resources (VA/NC specific) =====

function getFishingLinks(lat, lon, waterType, waterName) {
  const inVA = lat >= 36.54 && lat <= 39.47 && lon >= -83.68 && lon <= -75.24;
  const inNC = lat >= 33.84 && lat <= 36.59 && lon >= -84.32 && lon <= -75.46;

  const links = [];

  if (inVA) {
    links.push({
      label: 'VA DWR Fishing Reports',
      url: 'https://dwr.virginia.gov/fishing/fishing-reports/',
    });
    links.push({
      label: 'VA Trout Stocking Schedule',
      url: 'https://dwr.virginia.gov/fishing/trout-stocking-schedule/',
    });
    links.push({
      label: 'VA Fishing Regulations',
      url: 'https://dwr.virginia.gov/fishing/regulations/',
    });

    // Eastern VA specific
    if (lon > -78) {
      links.push({
        label: 'VA Saltwater Fishing',
        url: 'https://mrc.virginia.gov/Regulations/swfishregs.shtm',
      });
    }
  }

  if (inNC) {
    links.push({
      label: 'NC Wildlife Fishing',
      url: 'https://www.ncwildlife.org/fishing',
    });
    links.push({
      label: 'NC Trout Fishing',
      url: 'https://www.ncwildlife.org/fishing/trout-fishing-in-nc',
    });
    links.push({
      label: 'NC Fishing Regulations',
      url: 'https://www.ncwildlife.org/licensing/regulations',
    });
  }

  // Directions
  links.push({
    label: `Google Maps Directions`,
    url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`,
    icon: 'google',
  });
  links.push({
    label: `Apple Maps Directions`,
    url: `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`,
    icon: 'apple',
  });

  return links;
}

// Species commonly found in VA/NC waters
function getCommonSpecies(waterType, lat, lon) {
  const eastern = lon > -78;
  const mountain = lon < -80;

  const species = {
    lake: eastern
      ? ['Largemouth Bass', 'Channel Catfish', 'Bluegill', 'Crappie', 'Striped Bass', 'White Perch']
      : mountain
        ? ['Smallmouth Bass', 'Walleye', 'Muskie', 'Rainbow Trout', 'Brown Trout']
        : ['Largemouth Bass', 'Striped Bass', 'Walleye', 'Catfish', 'Crappie', 'Bluegill'],
    river: eastern
      ? ['Striped Bass', 'Shad', 'Catfish', 'Largemouth Bass', 'Herring']
      : mountain
        ? ['Smallmouth Bass', 'Rainbow Trout', 'Brown Trout', 'Brook Trout', 'Muskie']
        : ['Smallmouth Bass', 'Catfish', 'Largemouth Bass', 'Striped Bass', 'Sunfish'],
    stream: mountain
      ? ['Brook Trout', 'Rainbow Trout', 'Brown Trout']
      : ['Sunfish', 'Smallmouth Bass', 'Creek Chub', 'Bluegill', 'Rock Bass'],
    pond: ['Largemouth Bass', 'Bluegill', 'Channel Catfish', 'Crappie'],
  };

  return species[waterType] || species.pond;
}


// ===== Bounding Box Utilities =====

function milesToDegrees(miles, lat) {
  const latDeg = miles / 69.0; // 1 degree lat ≈ 69 miles
  const lonDeg = miles / (69.0 * Math.cos(lat * Math.PI / 180));
  return { latDeg, lonDeg };
}

function getBBox(lat, lon, radiusMiles) {
  const { latDeg, lonDeg } = milesToDegrees(radiusMiles, lat);
  return {
    south: lat - latDeg,
    north: lat + latDeg,
    west: lon - lonDeg,
    east: lon + lonDeg,
  };
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export {
  fetchWaterBodies,
  fetchUSGSSites,
  getFishingLinks,
  getCommonSpecies,
  getBBox,
  distanceMiles,
  assessPrivateProperty,
};
