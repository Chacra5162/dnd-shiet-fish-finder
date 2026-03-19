/**
 * API integrations: USGS Water Services + OpenStreetMap Overpass
 * Only fetches data relevant to the user's current location.
 */

import { STORES, getCached, setCache, setCacheBatch, getMultiCached, gridKey } from './cache.js';

// ===== Overpass API (Water Bodies) =====

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function buildOverpassQuery(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:20][maxsize:67108864];
(
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"~"river|stream|creek|canal"](${bbox});
  way["water"~"lake|pond|reservoir|river"](${bbox});
  nwr["leisure"="slipway"](${bbox});
  nwr["waterway"="boat_ramp"](${bbox});
  nwr["leisure"="fishing"](${bbox});
  nwr["man_made"="pier"]["access"!="private"]["access"!="no"](${bbox});
  way["leisure"="park"]["name"](${bbox});
  relation["leisure"="park"]["name"](${bbox});
  way["leisure"="nature_reserve"]["name"](${bbox});
  relation["leisure"="nature_reserve"]["name"](${bbox});
  relation["boundary"="protected_area"]["name"](${bbox});
  way["leisure"="recreation_ground"]["name"](${bbox});
);
out center tags;
`.trim();
}

function classifyWaterBody(tags) {
  const water = tags.water || '';
  const waterway = tags.waterway || '';
  const natural = tags.natural || '';
  const leisure = tags.leisure || '';
  const manMade = tags.man_made || '';
  const name = (tags.name || '').toLowerCase();

  // Boat landings / ramps / slipways
  if (leisure === 'slipway' || waterway === 'boat_ramp' || tags['seamark:type'] === 'harbour' ||
      name.includes('boat ramp') || name.includes('boat landing') || name.includes('launch ramp') || name.includes('slipway')) {
    return 'boat_landing';
  }

  // Fishing piers
  if ((manMade === 'pier' && (tags.fishing === 'yes' || leisure === 'fishing')) ||
      (leisure === 'fishing' && manMade === 'pier') ||
      name.includes('fishing pier') || name.includes('fish pier')) {
    return 'fishing_pier';
  }
  // General piers (likely fishing-relevant)
  if (manMade === 'pier') return 'fishing_pier';
  // Leisure=fishing without pier is a fishing spot — classify by other tags or default
  if (leisure === 'fishing' && manMade !== 'pier') {
    // Try to further classify, otherwise mark as fishing pier
    if (waterway || water || natural) {
      // Fall through to normal classification
    } else {
      return 'fishing_pier';
    }
  }

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
      const timeout = setTimeout(() => controller.abort(), 22000); // slightly longer than server timeout:20
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
      // Verify we got JSON, not an HTML error page (Overpass returns HTML on rate limit)
      const text = await response.text();
      if (text.startsWith('<')) {
        lastError = new Error(`Overpass returned HTML (rate limited?) from ${url}`);
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      lastError = e;
      console.warn(`Overpass server failed (${url}):`, e.message);
    }
  }
  throw lastError || new Error('All Overpass servers failed');
}

// Extract the best available name from OSM tags with multi-field fallback
function extractBestName(tags, type) {
  // Primary: explicit name tag
  if (tags.name) return tags.name;
  // Alternative / official names
  if (tags.alt_name) return tags.alt_name;
  if (tags.official_name) return tags.official_name;
  if (tags['name:en']) return tags['name:en'];
  // Operator often contains park/landing name (e.g., "Chesterfield County Parks - Robious Landing")
  if (tags.operator) {
    const op = tags.operator;
    // Extract meaningful part after dash/colon separators
    const parts = op.split(/\s*[-–:]\s*/);
    if (parts.length > 1) return parts[parts.length - 1].trim();
    // If short enough, use whole operator name
    if (op.length <= 40) return op;
  }
  // is_in tag contains containing area (e.g., "Robious Landing Park;Chesterfield;VA")
  if (tags.is_in) {
    const first = tags.is_in.split(';')[0].trim();
    if (first.length > 0 && first.length <= 50) return first;
  }
  // Description — use first line, truncated
  if (tags.description) {
    const desc = tags.description.split('\n')[0].trim();
    if (desc.length > 0) return desc.length > 50 ? desc.substring(0, 47) + '...' : desc;
  }
  // Destination tag (common on waterways)
  if (tags.destination) return tags.destination;
  // Wikipedia tag (e.g., "en:James River" → "James River")
  if (tags.wikipedia) {
    const wp = tags.wikipedia;
    const colonIdx = wp.indexOf(':');
    return colonIdx >= 0 ? wp.substring(colonIdx + 1) : wp;
  }
  // No usable name found
  return null;
}

// Generate a deterministic name for unnamed water bodies (same coords = same name always)
function generateName(type, lat, lon) {
  const typeLabels = { lake: 'Lake', pond: 'Pond', river: 'River', stream: 'Creek', boat_landing: 'Boat Landing', fishing_pier: 'Fishing Pier' };
  const label = typeLabels[type] || 'Pond';
  // Deterministic hash from coordinates — no counter, stable across calls
  const hash = Math.abs(Math.round(lat * 10000) * 31 + Math.round(lon * 10000)) % 100000;
  return `${label} #${hash}`;
}

async function fetchWaterBodies(south, west, north, east) {
  // Check cache first for each grid cell
  const { cached, missing } = await getMultiCached(STORES.waterBodies, south, west, north, east);

  if (missing.length === 0) {
    return { data: dedupeWaterBodies(cached), fromCache: true };
  }

  // Try to fetch fresh data — but fall back to partial cache if Overpass fails
  let json;
  try {
    const query = buildOverpassQuery(south, west, north, east);
    json = await fetchOverpass(query);
  } catch (e) {
    console.warn('Overpass fetch failed, using cached data:', e.message);
    // Return whatever we have cached — partial is better than nothing
    if (cached.length > 0) {
      return { data: dedupeWaterBodies(cached), fromCache: true, partial: true };
    }
    throw e; // No cache at all — propagate the error
  }

  if (json.remark) {
    console.warn('Overpass remark:', json.remark);
  }
  if (!json.elements?.length) {
    console.warn('Overpass returned 0 elements', json);
  }

  // --- Pass 1: Separate parks from water features ---
  const parks = [];
  const rawFeatures = [];
  const KEEP_KEYS = ['name', 'alt_name', 'water', 'waterway', 'natural', 'leisure',
    'man_made', 'access', 'ownership', 'owner', 'operator', 'fishing', 'sport',
    'boundary', 'landuse', 'club', 'is_in', 'description', 'wikipedia', 'wikidata',
    'tidal', 'destination'];
  const unnamedWayIds = []; // track unnamed waterway ways for parent relation lookup

  for (const el of (json.elements || [])) {
    const lat = el.center?.lat || el.lat;
    const lon = el.center?.lon || el.lon;
    if (!lat || !lon) continue;

    const tags = el.tags || {};
    const isPark = (tags.leisure === 'park' || tags.leisure === 'nature_reserve' ||
      tags.leisure === 'recreation_ground' || tags.boundary === 'protected_area') && tags.name;

    if (isPark) {
      parks.push({ name: tags.name, lat, lon });
      continue;
    }

    const type = classifyWaterBody(tags);
    let name = extractBestName(tags, type);
    const isUnnamed = !name;

    if (isUnnamed) {
      if (el.type === 'node') continue;
      // Track unnamed waterway ways for parent relation name resolution
      if (el.type === 'way' && (tags.waterway || tags.water === 'river')) {
        unnamedWayIds.push(el.id);
      }
      name = null; // will be resolved in pass 1.5 or pass 2
    }

    const keepTags = {};
    for (const k of KEEP_KEYS) {
      if (tags[k]) keepTags[k] = tags[k];
    }

    rawFeatures.push({ id: el.id, name, type, lat, lon, tags: keepTags, isUnnamed });
  }

  // --- Pass 1.5: Resolve unnamed waterway names from parent relations ---
  if (unnamedWayIds.length > 0) {
    try {
      const parentQuery = `[out:json][timeout:10];way(id:${unnamedWayIds.join(',')});(rel(bw)["name"]["waterway"];rel(bw)["name"]["natural"="water"];rel(bw)["name"]["water"];);out tags;`;
      const parentJson = await fetchOverpass(parentQuery);
      // Build map: relation id -> name, then map way membership
      if (parentJson.elements?.length) {
        // We need way->relation mapping, so do a second query to get members
        const relIds = parentJson.elements.map(r => r.id);
        const relNames = {};
        for (const r of parentJson.elements) {
          relNames[r.id] = r.tags.name;
        }
        // Query relation members to map ways to relation names
        const memberQuery = `[out:json][timeout:10];rel(id:${relIds.join(',')});out body;`;
        const memberJson = await fetchOverpass(memberQuery);
        const wayToName = {};
        if (memberJson.elements?.length) {
          for (const rel of memberJson.elements) {
            const relName = relNames[rel.id];
            if (!relName || !rel.members) continue;
            for (const m of rel.members) {
              if (m.type === 'way' && unnamedWayIds.includes(m.ref)) {
                wayToName[m.ref] = relName;
              }
            }
          }
        }
        // Apply resolved names to unnamed features
        for (const f of rawFeatures) {
          if (f.isUnnamed && wayToName[f.id]) {
            f.name = wayToName[f.id];
            f.isUnnamed = false;
          }
        }
      }
    } catch (e) {
      console.warn('Parent relation name lookup failed (non-fatal):', e.message);
    }
  }

  // --- Pass 2: Build park spatial index for fast proximity lookups ---
  const PARK_MATCH_DIST = 0.005; // ~0.35 miles — match unnamed features to parks
  const parkGrid = new Map();
  const parkGridSize = 0.01;
  for (const p of parks) {
    const gk = `${Math.floor(p.lat / parkGridSize)}_${Math.floor(p.lon / parkGridSize)}`;
    if (!parkGrid.has(gk)) parkGrid.set(gk, []);
    parkGrid.get(gk).push(p);
  }

  function findNearestPark(lat, lon) {
    const gx = Math.floor(lat / parkGridSize);
    const gy = Math.floor(lon / parkGridSize);
    let best = null, bestDist = PARK_MATCH_DIST;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = parkGrid.get(`${gx + dx}_${gy + dy}`);
        if (!cell) continue;
        for (const p of cell) {
          const d = Math.abs(p.lat - lat) + Math.abs(p.lon - lon);
          if (d < bestDist) { bestDist = d; best = p; }
        }
      }
    }
    return best;
  }

  // --- Pass 3: Name unnamed features from parks + group co-located features ---
  const CLUSTER_DIST = 0.003; // ~0.2 miles — group nearby unnamed features
  const clusterGrid = new Map();
  const cgSize = CLUSTER_DIST;

  // Group unnamed features into spatial clusters
  for (const f of rawFeatures) {
    if (!f.isUnnamed) continue;
    const gk = `${Math.floor(f.lat / cgSize)}_${Math.floor(f.lon / cgSize)}`;
    if (!clusterGrid.has(gk)) clusterGrid.set(gk, []);
    clusterGrid.get(gk).push(f);
  }

  // Merge adjacent grid cells and pick best name for each cluster
  const clusterVisited = new Set();
  const clusteredIds = new Set();

  for (const [key, items] of clusterGrid) {
    if (clusterVisited.has(key)) continue;
    clusterVisited.add(key);

    // Flood-fill adjacent cells
    const cluster = [...items];
    const [gx, gy] = key.split('_').map(Number);
    const queue = [[gx, gy]];
    while (queue.length > 0) {
      const [cx, cy] = queue.pop();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${cx + dx}_${cy + dy}`;
          if (clusterVisited.has(nk) || !clusterGrid.has(nk)) continue;
          clusterVisited.add(nk);
          cluster.push(...clusterGrid.get(nk));
          queue.push([cx + dx, cy + dy]);
        }
      }
    }

    if (cluster.length < 2) continue; // single features handled normally

    // This cluster has multiple unnamed features close together — merge them
    // Find centroid
    const cLat = cluster.reduce((s, f) => s + f.lat, 0) / cluster.length;
    const cLon = cluster.reduce((s, f) => s + f.lon, 0) / cluster.length;

    // Try to name from nearby park
    const park = findNearestPark(cLat, cLon);
    // Collect unique types for label
    const types = [...new Set(cluster.map(f => f.type))];
    const typeLabels = { boat_landing: 'Boat Landing', fishing_pier: 'Pier', lake: 'Lake', pond: 'Pond', river: 'River', stream: 'Creek' };
    const typeSummary = types.map(t => typeLabels[t] || t).join(' & ');

    const mergedName = park
      ? `${park.name} (${typeSummary})`
      : `${typeSummary} Area`;

    // Pick the "best" type: prefer boat_landing > fishing_pier > others
    const typePriority = ['boat_landing', 'fishing_pier', 'lake', 'river', 'pond', 'stream'];
    const bestType = typePriority.find(t => types.includes(t)) || types[0];

    // Pick richest tags from cluster
    const bestFeature = cluster.reduce((a, b) =>
      Object.keys(b.tags).length > Object.keys(a.tags).length ? b : a
    );

    // Mark all cluster members as consumed
    for (const f of cluster) clusteredIds.add(f.id);

    // Add the merged entry
    rawFeatures.push({
      id: bestFeature.id,
      name: mergedName,
      type: bestType,
      lat: cLat,
      lon: cLon,
      tags: bestFeature.tags,
      isUnnamed: false,
    });
  }

  // --- Pass 3.5: Associate unnamed features with nearby named water bodies ---
  // Build spatial index of named water features for proximity matching
  const WATER_MATCH_DIST = 0.008; // ~0.55 miles — match boat ramps to nearby rivers/lakes
  const namedWaters = rawFeatures.filter(f => !f.isUnnamed && !clusteredIds.has(f.id) &&
    (f.type === 'river' || f.type === 'lake' || f.type === 'stream'));
  const waterGrid = new Map();
  const wgSize = 0.01;
  for (const w of namedWaters) {
    const gk = `${Math.floor(w.lat / wgSize)}_${Math.floor(w.lon / wgSize)}`;
    if (!waterGrid.has(gk)) waterGrid.set(gk, []);
    waterGrid.get(gk).push(w);
  }

  function findNearestNamedWater(lat, lon) {
    const gx = Math.floor(lat / wgSize);
    const gy = Math.floor(lon / wgSize);
    let best = null, bestDist = WATER_MATCH_DIST;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = waterGrid.get(`${gx + dx}_${gy + dy}`);
        if (!cell) continue;
        for (const w of cell) {
          const d = Math.abs(w.lat - lat) + Math.abs(w.lon - lon);
          if (d < bestDist) { bestDist = d; best = w; }
        }
      }
    }
    return best;
  }

  // Name unnamed boat landings, piers, and other features from nearby water bodies
  for (const f of rawFeatures) {
    if (!f.isUnnamed || clusteredIds.has(f.id)) continue;
    const nearWater = findNearestNamedWater(f.lat, f.lon);
    if (nearWater) {
      const typeLabel = { boat_landing: 'Boat Landing', fishing_pier: 'Fishing Pier', river: 'River', stream: 'Creek', lake: 'Lake', pond: 'Pond' };
      f.name = `${nearWater.name} - ${typeLabel[f.type] || f.type}`;
      f.isUnnamed = false;
    }
  }

  // --- Pass 4: Finalize all features (name remaining unnamed, dedupe) ---
  const waterBodies = [];
  const seen = new Set();

  for (const f of rawFeatures) {
    if (clusteredIds.has(f.id)) continue; // already merged into a cluster

    let name = f.name;
    if (!name) {
      // Try park proximity for lone unnamed features
      const park = findNearestPark(f.lat, f.lon);
      if (park) {
        const typeLabel = { boat_landing: 'Boat Landing', fishing_pier: 'Pier', lake: 'Lake', pond: 'Pond', river: 'River', stream: 'Creek' };
        name = `${park.name} - ${typeLabel[f.type] || f.type}`;
      } else {
        name = generateName(f.type, f.lat, f.lon);
      }
    }

    const dedupeKey = `${name}_${f.lat.toFixed(3)}_${f.lon.toFixed(3)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    waterBodies.push({
      id: f.id,
      name,
      type: f.type,
      lat: f.lat,
      lon: f.lon,
      tags: f.tags,
    });
  }

  // Cache per grid cell (single batch transaction for speed on mobile)
  const gridMap = {};
  for (const wb of waterBodies) {
    const k = gridKey(wb.lat, wb.lon);
    if (!gridMap[k]) gridMap[k] = [];
    gridMap[k].push(wb);
  }

  const entries = Object.entries(gridMap).map(([key, data]) => ({ key, data }));
  await setCacheBatch(STORES.waterBodies, entries);

  return { data: dedupeWaterBodies([...cached, ...waterBodies]), fromCache: false };
}

function dedupeWaterBodies(items) {
  // First pass: exact coordinate dedupe
  const seen = new Set();
  const unique = items.filter(wb => {
    const key = `${wb.name}_${wb.lat.toFixed(4)}_${wb.lon.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Second pass: collapse same-named water bodies into a single representative point.
  // A creek named "Big Creek" may appear as 20+ OSM segments along its length —
  // keep only the most central point per name per cluster.
  const collapsed = collapseByName(unique);

  // Third pass: merge nearby entries that refer to the same water body but have different types.
  // E.g., "James River" (river) + "James River - Boat Landing" (boat_landing) within 0.5 mi → single entry.
  return mergeColocated(collapsed);
}

// For named entries: group by exact name + type, then cluster spatially.
// Within each cluster, keep the point closest to the cluster centroid.
// For unnamed entries (generated names), use tighter proximity dedupe.
function collapseByName(items) {
  const named = [];    // has a real OSM name
  const unnamed = [];  // generated name like "Creek #12345"

  for (const wb of items) {
    if (/^(Lake|Pond|River|Creek|Boat Landing|Fishing Pier) #\d+$/.test(wb.name)) {
      unnamed.push(wb);
    } else {
      named.push(wb);
    }
  }

  // --- Named: group by (name + type), then spatial clustering ---
  const groups = new Map();
  for (const wb of named) {
    const key = `${wb.name}|||${wb.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(wb);
  }

  const result = [];

  for (const [, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Spatial clustering: merge points within ~2 miles of each other
    const clusters = spatialCluster(group, 0.03); // ~2 miles in degrees
    for (const cluster of clusters) {
      result.push(pickRepresentative(cluster));
    }
  }

  // --- Unnamed: proximity dedupe at ~0.5 mile resolution ---
  const unnamedSeen = new Set();
  for (const wb of unnamed) {
    // Round to ~0.5 mile grid
    const key = `${wb.type}_${wb.lat.toFixed(2)}_${wb.lon.toFixed(2)}`;
    if (unnamedSeen.has(key)) continue;
    unnamedSeen.add(key);
    result.push(wb);
  }

  return result;
}

// Grid-based spatial clustering — O(n) instead of O(n²).
// Buckets points into grid cells of `threshold` size, then merges adjacent cells.
function spatialCluster(points, threshold) {
  const grid = new Map();
  for (const p of points) {
    const gx = Math.floor(p.lat / threshold);
    const gy = Math.floor(p.lon / threshold);
    const key = `${gx}_${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  // Merge adjacent grid cells into clusters using flood-fill
  const visited = new Set();
  const clusters = [];

  for (const [key, pts] of grid) {
    if (visited.has(key)) continue;
    visited.add(key);
    const cluster = [...pts];
    const [gx, gy] = key.split('_').map(Number);
    const queue = [[gx, gy]];

    while (queue.length > 0) {
      const [cx, cy] = queue.pop();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${cx + dx}_${cy + dy}`;
          if (visited.has(nk) || !grid.has(nk)) continue;
          visited.add(nk);
          cluster.push(...grid.get(nk));
          queue.push([cx + dx, cy + dy]);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// From a cluster of same-name water bodies, pick the best representative:
// - Prefer entries with the most OSM tags (richer data)
// - Among ties, pick the one closest to the cluster centroid
function pickRepresentative(cluster) {
  if (cluster.length === 1) return cluster[0];

  // Centroid
  const cLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
  const cLon = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;

  // Score: tag count (more tags = richer data), then distance to centroid as tiebreaker
  return cluster.reduce((best, wb) => {
    const bestTags = Object.keys(best.tags || {}).length;
    const wbTags = Object.keys(wb.tags || {}).length;
    if (wbTags > bestTags) return wb;
    if (wbTags < bestTags) return best;
    // Tiebreak: closer to centroid
    const bestDist = (best.lat - cLat) ** 2 + (best.lon - cLon) ** 2;
    const wbDist = (wb.lat - cLat) ** 2 + (wb.lon - cLon) ** 2;
    return wbDist < bestDist ? wb : best;
  });
}

// Merge co-located entries that clearly refer to the same place.
// A "James River - Boat Landing" next to "James River" should be one entry.
// A generic "Boat Landing #xxx" next to "James River" should merge into "James River".
function mergeColocated(items) {
  const MERGE_DIST = 0.008; // ~0.55 miles
  const grid = new Map();
  const gSize = 0.01;

  // Index all items by grid cell
  for (let i = 0; i < items.length; i++) {
    const wb = items[i];
    const gk = `${Math.floor(wb.lat / gSize)}_${Math.floor(wb.lon / gSize)}`;
    if (!grid.has(gk)) grid.set(gk, []);
    grid.get(gk).push(i);
  }

  // Extract base water name: "James River - Boat Landing" → "james river"
  function baseName(name) {
    return (name || '').toLowerCase()
      .replace(/\s*-\s*(boat landing|boat ramp|fishing pier|pier|ramp|landing|creek|river|lake|stream)$/i, '')
      .replace(/\s*\(.*\)$/, '')
      .trim();
  }

  const genericPattern = /^(lake|pond|river|creek|boat landing|fishing pier) #\d+$/;
  const areaPattern = /\b(area|& )/.test.bind(/\b(area|& )/);

  // Check if two entries refer to the same water body — conservative to avoid eating distinct lakes
  function sameWater(a, b, typeA, typeB) {
    const ba = baseName(a);
    const bb = baseName(b);
    if (!ba || !bb) return false;
    // Exact base match: "James River" and "James River - Boat Landing"
    if (ba === bb) return true;
    // One is a sub-name of the other: "James River" ↔ "James River - Boat Landing"
    if (ba.includes(bb) || bb.includes(ba)) return true;
    // Access point (boat_landing/pier) with generic name near a named water body — merge
    const aGeneric = genericPattern.test(ba) || areaPattern(ba);
    const bGeneric = genericPattern.test(bb) || areaPattern(bb);
    const accessTypes = ['boat_landing', 'fishing_pier'];
    if (aGeneric && accessTypes.includes(typeA) && !bGeneric) return true;
    if (bGeneric && accessTypes.includes(typeB) && !aGeneric) return true;
    // Do NOT merge two standalone water bodies just because one is unnamed —
    // "Lake #123" near "Rock Creek Lake" are likely different lakes
    return false;
  }

  // Type priority: prefer boat_landing > fishing_pier > river > lake > stream > pond
  const typePri = { boat_landing: 6, fishing_pier: 5, river: 4, lake: 3, stream: 2, pond: 1 };

  const merged = new Set(); // indices consumed by merges
  const result = [];

  for (let i = 0; i < items.length; i++) {
    if (merged.has(i)) continue;
    const wb = items[i];
    const gx = Math.floor(wb.lat / gSize);
    const gy = Math.floor(wb.lon / gSize);

    // Find nearby items to merge with
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx}_${gy + dy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i || merged.has(j)) continue;
          const other = items[j];
          const dist = Math.abs(wb.lat - other.lat) + Math.abs(wb.lon - other.lon);
          if (dist < MERGE_DIST && sameWater(wb.name, other.name, wb.type, other.type)) {
            candidates.push(j);
          }
        }
      }
    }

    if (candidates.length === 0) {
      result.push(wb);
      continue;
    }

    // Merge: pick the best entry from this group
    const group = [wb, ...candidates.map(j => items[j])];
    for (const j of candidates) merged.add(j);

    // Pick the entry with the best (most specific real) name
    // Prefer named > generic, then prefer boat_landing/fishing_pier type, then most tags
    const best = group.reduce((a, b) => {
      const aGeneric = /^(Lake|Pond|River|Creek|Boat Landing|Fishing Pier) #\d+$/.test(a.name) || a.name.endsWith(' Area');
      const bGeneric = /^(Lake|Pond|River|Creek|Boat Landing|Fishing Pier) #\d+$/.test(b.name) || b.name.endsWith(' Area');
      if (aGeneric && !bGeneric) return b;
      if (!aGeneric && bGeneric) return a;
      // Both named or both generic — prefer the one with access infrastructure
      const aPri = typePri[a.type] || 0;
      const bPri = typePri[b.type] || 0;
      if (aPri !== bPri) return bPri > aPri ? b : a;
      // More tags = richer data
      return Object.keys(b.tags || {}).length > Object.keys(a.tags || {}).length ? b : a;
    });

    // Merge tags from all entries and keep the best type info
    const allTypes = [...new Set(group.map(g => g.type))];
    const hasAccess = allTypes.some(t => t === 'boat_landing' || t === 'fishing_pier');
    const mergedTags = { ...best.tags };
    for (const g of group) {
      for (const [k, v] of Object.entries(g.tags || {})) {
        if (!mergedTags[k]) mergedTags[k] = v;
      }
    }

    // If the best name is a sub-name like "James River - Boat Landing", use the parent name
    // but keep the type as boat_landing for the access indicator
    let finalName = best.name;
    const dashIdx = finalName.indexOf(' - ');
    if (dashIdx > 0 && hasAccess) {
      // Keep the full name with the access suffix
    } else if (dashIdx > 0) {
      finalName = finalName.substring(0, dashIdx);
    }

    result.push({
      ...best,
      name: finalName,
      type: hasAccess ? (allTypes.includes('boat_landing') ? 'boat_landing' : 'fishing_pier') : best.type,
      tags: mergedTags,
    });
  }

  return result;
}


// ===== USGS Water Services API =====

const USGS_BASE = 'https://waterservices.usgs.gov/nwis/iv/';

// Parameter codes
const PARAMS = {
  '00010': { name: 'Water Temperature', unit: '°C', key: 'tempC', convert: true },
  '00011': { name: 'Water Temperature', unit: '°F', key: 'temp' },
  '00060': { name: 'Discharge', unit: 'ft³/s', key: 'flow' },
  '00065': { name: 'Gauge Height', unit: 'ft', key: 'gauge' },
  '00045': { name: 'Precipitation', unit: 'in', key: 'precip' },
};

// USGS bbox limit is ~0.2° for unfiltered queries, but siteType-filtered
// queries accept larger boxes. We use siteType='LK,ST,SP' so 0.5° is safe.
const USGS_TILE_SIZE = 0.5; // degrees per tile

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

  const response = await fetchWithTimeout(`${USGS_BASE}?${params}`, 15000);
  if (!response.ok) {
    console.warn(`USGS tile error ${response.status} for bbox ${west},${south},${east},${north}`);
    return [];
  }

  const json = await response.json();
  return parseUSGSResponse(json);
}

// Shared helper: fetch all USGS tiles for a bbox, deduped by siteCode
async function fetchAllUSGSTiles(south, west, north, east) {
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
  return allSites;
}

async function fetchUSGSSites(south, west, north, east) {
  // Check cache
  const { cached, missing } = await getMultiCached(STORES.usgs, south, west, north, east);

  if (missing.length === 0 && cached.length > 0) {
    // Still fetch current values (shorter cache)
    const withData = await enrichUSGSData(cached, south, west, north, east);
    return { data: withData, fromCache: true };
  }

  const allSites = await fetchAllUSGSTiles(south, west, north, east);

  // Cache site locations per grid cell
  const gridMap = {};
  for (const site of allSites) {
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
  const cachedCurrent = await getCached(STORES.usgsCurrent, (south + north) / 2, (west + east) / 2);

  if (cachedCurrent) {
    return mergeSitesWithData(sites, cachedCurrent);
  }

  try {
    const allFresh = await fetchAllUSGSTiles(south, west, north, east);

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
    let val = parseFloat(latest.value);
    if (isNaN(val) || val < -900) continue; // USGS uses -999999 for no data

    // Convert °C to °F for consistent display
    const displayUnit = paramInfo.convert ? '°F' : paramInfo.unit;
    if (paramInfo.convert) val = Math.round((val * 9 / 5 + 32) * 10) / 10;

    // Use 'temp' as the key for both C and F params; prefer °F if both exist
    const storeKey = paramInfo.key === 'tempC' ? 'temp' : paramInfo.key;
    if (storeKey === 'temp' && site.data.temp && paramInfo.key === 'tempC') continue; // prefer native °F

    site.data[storeKey] = {
      value: val,
      unit: displayUnit,
      name: paramInfo.name,
      dateTime: latest.dateTime,
    };
  }

  return Array.from(siteMap.values()).filter(s => !isNaN(s.lat) && !isNaN(s.lon));
}


// ===== Fishing Resources (VA/NC specific) =====

// getSpecialRegulations removed — now served from Supabase fishing_regulations table

function getFishingLinks(lat, lon, waterType, waterName) {
  const inVA = lat >= 36.54 && lat <= 39.47 && lon >= -83.68 && lon <= -75.24;
  const inNC = lat >= 33.84 && lat <= 36.59 && lon >= -84.32 && lon <= -75.46;

  const links = [];

  if (inVA) {
    // Regional fishing reports
    if (lon < -80) {
      links.push({ label: 'VA DWR Southwest Region Fishing Report', url: 'https://dwr.virginia.gov/fishing/fishing-reports/' });
    } else if (lon < -78) {
      links.push({ label: 'VA DWR Central/Piedmont Fishing Report', url: 'https://dwr.virginia.gov/fishing/fishing-reports/' });
    } else {
      links.push({ label: 'VA DWR Tidewater/Eastern Fishing Report', url: 'https://dwr.virginia.gov/fishing/fishing-reports/' });
    }
    // Trout stocking schedule — only for mountain/trout areas
    if (lon < -78.5 || waterName.toLowerCase().includes('trout') || waterName.toLowerCase().includes('stocked')) {
      links.push({
        label: 'VA Trout Stocking Schedule — Check Recent Stockings',
        url: 'https://dwr.virginia.gov/fishing/trout-stocking-schedule/',
      });
    }
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
function getCommonSpecies(waterType, lat, lon, waterName) {
  const eastern = lon > -78;
  const mountain = lon < -80;
  const coastal = lon > -76.5; // tidal/coastal — speckled trout, redfish, flounder territory
  // Tidal zone: eastern rivers between the fall line (~Richmond) and the Chesapeake Bay
  const tidal = eastern && !mountain && lon > -77.8;
  const nameLower = (waterName || '').toLowerCase();

  // Tidal rivers (James, Chickahominy, Rappahannock, York, etc.) have a distinct fishery
  const isTidalRiver = tidal && (waterType === 'river' || waterType === 'boat_landing') &&
    (nameLower.includes('james') || nameLower.includes('chickahominy') ||
     nameLower.includes('rappahannock') || nameLower.includes('york') ||
     nameLower.includes('mattaponi') || nameLower.includes('pamunkey') ||
     nameLower.includes('appomattox') || nameLower.includes('elizabeth') ||
     nameLower.includes('nansemond') || (!nameLower || nameLower.startsWith('river #')));

  if (isTidalRiver) {
    return ['Blue Catfish', 'Striped Bass', 'Largemouth Bass', 'Snakehead', 'Flathead Catfish',
      'Channel Catfish', 'White Perch', 'American Shad', 'Hickory Shad', 'Longnose Gar',
      'White Catfish', 'Carp', 'Herring'];
  }

  const species = {
    lake: eastern
      ? ['Largemouth Bass', 'Blue Catfish', 'Channel Catfish', 'Bluegill', 'Crappie', 'Striped Bass', 'White Perch', 'Carp']
      : mountain
        ? ['Smallmouth Bass', 'Largemouth Bass', 'Striped Bass', 'Muskie', 'Rainbow Trout', 'Brown Trout', 'Walleye']
        : ['Largemouth Bass', 'Striped Bass', 'Smallmouth Bass', 'Crappie', 'Bluegill', 'Channel Catfish', 'Carp'],
    river: eastern
      ? (coastal
        ? ['Striped Bass', 'Blue Catfish', 'Speckled Trout', 'Red Drum', 'Flounder', 'White Perch', 'American Shad', 'Hickory Shad', 'Spot', 'Croaker']
        : ['Striped Bass', 'Blue Catfish', 'American Shad', 'Hickory Shad', 'White Perch', 'Largemouth Bass', 'Channel Catfish', 'Flathead Catfish', 'Snakehead', 'Longnose Gar', 'Herring', 'Carp'])
      : mountain
        ? ['Smallmouth Bass', 'Spotted Bass', 'Rainbow Trout', 'Brown Trout', 'Brook Trout', 'Muskie']
        : ['Smallmouth Bass', 'Spotted Bass', 'Channel Catfish', 'Largemouth Bass', 'Striped Bass', 'Sunfish', 'Carp'],
    stream: mountain
      ? ['Brook Trout', 'Rainbow Trout', 'Brown Trout']
      : (coastal
        ? ['Speckled Trout', 'Red Drum', 'Flounder', 'White Perch']
        : ['Sunfish', 'Smallmouth Bass', 'Creek Chub', 'Bluegill', 'Rock Bass']),
    pond: ['Largemouth Bass', 'Bluegill', 'Channel Catfish', 'Crappie', 'Carp'],
    boat_landing: eastern
      ? (coastal
        ? ['Striped Bass', 'Blue Catfish', 'Speckled Trout', 'Red Drum', 'Flounder']
        : ['Blue Catfish', 'Striped Bass', 'Largemouth Bass', 'Snakehead', 'Flathead Catfish', 'Channel Catfish', 'Crappie'])
      : ['Largemouth Bass', 'Smallmouth Bass', 'Striped Bass', 'Channel Catfish', 'Crappie'],
    fishing_pier: coastal
      ? ['Speckled Trout', 'Red Drum', 'Flounder', 'Spot', 'Croaker', 'Bluefish', 'Sheepshead']
      : eastern
        ? ['Striped Bass', 'Blue Catfish', 'White Perch', 'Channel Catfish', 'Crappie']
        : ['Largemouth Bass', 'Channel Catfish', 'Bluegill', 'Crappie', 'Smallmouth Bass'],
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

// ===== Timeout Helper (compat with iOS Safari <16) =====

function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ===== USGS Flood Stage & Forecast =====

// Shared: fetch the NWS gauge object for a USGS site (single HTTP call)
async function fetchNWSGaugeData(siteCode) {
  try {
    const url = `https://api.water.noaa.gov/nwps/v1/gauges?identifier=USGS-${siteCode}`;
    const resp = await fetchWithTimeout(url, 8000);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.gauges?.[0] || null;
  } catch (e) {
    console.warn('NWS gauge fetch failed for', siteCode, e.message);
    return null;
  }
}

// NWS flood stage categories for a USGS site
// Accepts a pre-fetched gauge object to avoid duplicate HTTP calls
function extractFloodStage(gauge) {
  if (!gauge) return null;

  const nwsId = gauge.lid || gauge.id;
  const floodCats = gauge.flood?.categories || gauge.floodCategories;
  const status = gauge.observed || gauge.status?.observed;

  // Try to get thresholds from the gauge data
  const thresholds = {};
  if (floodCats) {
    if (floodCats.action?.stage != null) thresholds.action = floodCats.action.stage;
    if (floodCats.minor?.stage != null) thresholds.minor = floodCats.minor.stage;
    if (floodCats.moderate?.stage != null) thresholds.moderate = floodCats.moderate.stage;
    if (floodCats.major?.stage != null) thresholds.major = floodCats.major.stage;
  }

  return {
    nwsId,
    thresholds,
    currentStage: status?.primary?.value ?? null,
    currentCategory: status?.floodCategory?.toLowerCase() ?? null,
  };
}

// Determine flood category from gauge height and thresholds
function getFloodCategory(gaugeHeight, thresholds) {
  if (!thresholds || gaugeHeight == null) return null;
  if (thresholds.major != null && gaugeHeight >= thresholds.major) return 'major';
  if (thresholds.moderate != null && gaugeHeight >= thresholds.moderate) return 'moderate';
  if (thresholds.minor != null && gaugeHeight >= thresholds.minor) return 'flood';
  if (thresholds.action != null && gaugeHeight >= thresholds.action) return 'action';
  return 'normal';
}

// Fetch 6 hours of recent USGS data for trend analysis
async function fetchRecentUSGSData(siteCode) {
  try {
    const params = new URLSearchParams({
      format: 'json',
      sites: siteCode,
      parameterCd: '00060,00065', // flow + gauge height
      period: 'PT8H', // 8 hours of history (gives us good trend data)
    });

    const resp = await fetchWithTimeout(`${USGS_BASE}?${params}`, 10000);
    if (!resp.ok) return null;
    const json = await resp.json();

    const timeSeries = json?.value?.timeSeries || [];
    const result = { flow: [], gauge: [] };

    for (const ts of timeSeries) {
      const paramCode = ts.variable?.variableCode?.[0]?.value;
      const key = paramCode === '00060' ? 'flow' : paramCode === '00065' ? 'gauge' : null;
      if (!key) continue;

      const values = ts.values?.[0]?.value || [];
      for (const v of values) {
        const val = parseFloat(v.value);
        if (isNaN(val) || val < -900) continue;
        result[key].push({
          time: new Date(v.dateTime).getTime(),
          value: val,
        });
      }
    }

    return result;
  } catch (e) {
    console.warn('Recent USGS data fetch failed for', siteCode, e.message);
    return null;
  }
}

// NWS river forecast — predicted stages for the next 6+ hours
// Accepts a pre-fetched gauge object to avoid duplicate HTTP calls
async function extractNWSForecast(gauge) {
  try {
    if (!gauge) return null;
    const nwsId = gauge.lid || gauge.id;
    if (!nwsId) return null;

    // Fetch forecast from NWS
    const fcstUrl = `https://api.water.noaa.gov/nwps/v1/gauges/${nwsId}/stageflow`;
    const fcstResp = await fetchWithTimeout(fcstUrl, 8000);
    if (!fcstResp.ok) return null;
    const fcstData = await fcstResp.json();

    // Extract forecast points
    const forecasts = fcstData?.forecast?.data || fcstData?.data || [];
    if (!Array.isArray(forecasts) || forecasts.length === 0) return null;

    const now = Date.now();
    const sixHoursOut = now + 6 * 60 * 60 * 1000;

    // Filter to next 6 hours
    const upcoming = forecasts
      .map(pt => ({
        time: new Date(pt.validTime || pt.time).getTime(),
        stage: (typeof pt.primary === 'number' ? pt.primary : pt.primary?.value) ?? pt.stage ?? pt.value ?? null,
        flow: (typeof pt.secondary === 'number' ? pt.secondary : pt.secondary?.value) ?? pt.flow ?? null,
      }))
      .filter(pt => pt.time >= now && pt.time <= sixHoursOut && pt.stage != null)
      .sort((a, b) => a.time - b.time);

    return upcoming.length > 0 ? upcoming : null;
  } catch (e) {
    console.warn('NWS forecast fetch failed for gauge', gauge?.lid || gauge?.id, e.message);
    return null;
  }
}

// Analyze recent data to compute trend and 6-hour projection
function analyzeTrend(recentData) {
  if (!recentData) return null;

  const result = {};

  for (const key of ['gauge', 'flow']) {
    const points = recentData[key];
    if (!points || points.length < 4) continue;

    // Use last 6 hours of data points
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const recent = points.filter(p => p.time >= sixHoursAgo);
    if (recent.length < 3) continue;

    const first = recent[0];
    const last = recent[recent.length - 1];
    const totalChange = last.value - first.value;
    const hoursSpan = (last.time - first.time) / (1000 * 60 * 60);
    if (hoursSpan < 0.5) continue;

    const ratePerHour = totalChange / hoursSpan;

    // Simple linear projection 6 hours out
    const projected = last.value + (ratePerHour * 6);

    // Determine trend direction
    let trend = 'stable';
    const threshold = key === 'flow' ? 5 : 0.05; // ft³/s or ft
    if (ratePerHour > threshold) trend = 'rising';
    else if (ratePerHour < -threshold) trend = 'falling';

    result[key] = {
      current: last.value,
      change6h: totalChange,
      ratePerHour,
      trend,
      projected6h: Math.max(0, projected),
      points: recent,
      unit: key === 'flow' ? 'ft³/s' : 'ft',
    };
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Format flood stage HTML for the detail panel
function getFloodStageHtml(floodData, gaugeHeight) {
  if (!floodData) return '';

  const thresholds = floodData.thresholds || {};
  const hasThresholds = Object.keys(thresholds).length > 0;
  const category = floodData.currentCategory || getFloodCategory(gaugeHeight, thresholds);

  const catColors = {
    normal: { bg: 'rgba(46,204,113,0.12)', border: 'rgba(46,204,113,0.3)', color: '#2ecc71', label: 'Normal' },
    action: { bg: 'rgba(241,196,15,0.12)', border: 'rgba(241,196,15,0.3)', color: '#f1c40f', label: 'Action Stage' },
    flood:  { bg: 'rgba(243,156,18,0.15)', border: 'rgba(243,156,18,0.3)', color: '#f39c12', label: 'Flood Stage' },
    moderate: { bg: 'rgba(231,76,60,0.15)', border: 'rgba(231,76,60,0.3)', color: '#e74c3c', label: 'Moderate Flood' },
    major:  { bg: 'rgba(192,57,43,0.2)', border: 'rgba(192,57,43,0.4)', color: '#c0392b', label: 'Major Flood' },
  };
  const cat = catColors[category] || catColors.normal;

  let html = `
    <div class="detail-section">
      <h3>Flood Status</h3>
      <div class="flood-status-badge" style="background:${cat.bg};border:1px solid ${cat.border};color:${cat.color};padding:10px 14px;border-radius:8px;margin-bottom:8px;">
        <strong style="font-size:0.95rem;">${cat.label}</strong>
        ${gaugeHeight != null ? `<span style="float:right;font-size:0.85rem;">${gaugeHeight.toFixed(2)} ft</span>` : ''}
      </div>
  `;

  if (hasThresholds) {
    html += `<div class="flood-thresholds" style="display:flex;flex-wrap:wrap;gap:6px;">`;
    const stages = [
      { key: 'action', label: 'Action', color: '#f1c40f' },
      { key: 'minor', label: 'Minor Flood', color: '#f39c12' },
      { key: 'moderate', label: 'Moderate', color: '#e74c3c' },
      { key: 'major', label: 'Major', color: '#c0392b' },
    ];
    for (const s of stages) {
      if (thresholds[s.key] != null) {
        const active = gaugeHeight != null && gaugeHeight >= thresholds[s.key];
        html += `<span style="padding:3px 10px;border-radius:10px;font-size:0.75rem;font-weight:600;
          background:${active ? s.color : 'var(--bg-surface)'};
          color:${active ? '#fff' : 'var(--text-muted)'};">
          ${s.label}: ${thresholds[s.key]} ft
        </span>`;
      }
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// Format trend + projection HTML
function getTrendHtml(trendData, nwsForecast) {
  if (!trendData && !nwsForecast) return '';

  let html = `<div class="detail-section"><h3>6-Hour Outlook</h3>`;

  // Trend analysis from USGS historical data
  if (trendData) {
    for (const key of ['gauge', 'flow']) {
      const t = trendData[key];
      if (!t) continue;

      const label = key === 'gauge' ? 'Gauge Height' : 'Discharge';
      const arrow = t.trend === 'rising' ? '&#9650;' : t.trend === 'falling' ? '&#9660;' : '&#9654;';
      const tColor = t.trend === 'rising' ? '#e74c3c' : t.trend === 'falling' ? '#3498db' : '#2ecc71';
      const changeSign = t.change6h >= 0 ? '+' : '';

      html += `
        <div style="background:var(--bg-surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-weight:600;font-size:0.85rem;">${label}</span>
            <span style="color:${tColor};font-weight:700;font-size:0.85rem;">${arrow} ${t.trend.charAt(0).toUpperCase() + t.trend.slice(1)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:0.8rem;">
            <div>
              <div style="color:var(--text-muted);font-size:0.68rem;text-transform:uppercase;">Now</div>
              <div style="font-weight:600;">${t.current.toFixed(key === 'gauge' ? 2 : 0)} ${t.unit}</div>
            </div>
            <div>
              <div style="color:var(--text-muted);font-size:0.68rem;text-transform:uppercase;">Change (6h)</div>
              <div style="font-weight:600;color:${tColor};">${changeSign}${t.change6h.toFixed(key === 'gauge' ? 2 : 0)} ${t.unit}</div>
            </div>
            <div>
              <div style="color:var(--text-muted);font-size:0.68rem;text-transform:uppercase;">Projected</div>
              <div style="font-weight:600;">${t.projected6h.toFixed(key === 'gauge' ? 2 : 0)} ${t.unit}</div>
            </div>
          </div>
      `;

      // Mini sparkline using the historical points
      if (t.points && t.points.length >= 3) {
        html += renderSparkline(t.points, t.projected6h, key);
      }

      html += `</div>`;
    }
  }

  // NWS official forecast
  if (nwsForecast && nwsForecast.length > 0) {
    html += `
      <div style="background:var(--bg-surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">
        <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px;color:var(--accent);">NWS River Forecast</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
    `;
    for (const pt of nwsForecast.slice(0, 4)) {
      const time = new Date(pt.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      html += `
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;">
          <span style="color:var(--text-muted);">${time}</span>
          <span style="font-weight:600;">${pt.stage != null ? pt.stage.toFixed(2) + ' ft' : ''}${pt.flow != null ? ' / ' + Math.round(pt.flow) + ' ft³/s' : ''}</span>
        </div>
      `;
    }
    html += `</div></div>`;
  }

  // Fishing guidance based on trend
  if (trendData) {
    const gaugeTrend = trendData.gauge?.trend;
    const flowTrend = trendData.flow?.trend;
    let guidance = '';

    if (gaugeTrend === 'rising' || flowTrend === 'rising') {
      const rate = trendData.gauge?.ratePerHour || 0;
      if (rate > 0.5) {
        guidance = 'Water is rising rapidly — dangerous wading conditions. Fish may move to banks and eddies. Consider postponing.';
      } else {
        guidance = 'Water is rising — fish often feed aggressively on rising water. Target current seams and newly flooded banks. Use heavier weights.';
      }
    } else if (gaugeTrend === 'falling' || flowTrend === 'falling') {
      guidance = 'Water is falling — excellent fishing conditions. Fish concentrate in deeper pools and channel bends as water recedes. Great time to fish.';
    } else {
      guidance = 'Stable conditions — predictable fishing. Target structure and normal holding water. Standard presentations should work well.';
    }

    html += `
      <div style="background:rgba(52,152,219,0.08);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:10px 14px;font-size:0.82rem;line-height:1.4;">
        <strong style="color:var(--accent);display:block;margin-bottom:3px;">Fishing Guidance</strong>
        ${guidance}
      </div>
    `;
  }

  html += `</div>`;
  return html;
}

// Render a tiny sparkline from data points + projected value
function renderSparkline(points, projected, key) {
  if (points.length < 3) return '';

  const histValues = points.map(p => p.value);
  const values = [...histValues, projected]; // history + projection
  // Compute y-axis range from historical points only so the projected
  // value doesn't distort the scale; the projected dot clips to bounds.
  const min = Math.min(...histValues);
  const max = Math.max(...histValues);
  const range = max - min || 1;
  const w = 280;
  const h = 40;
  const padding = 2;

  const totalPoints = values.length;
  const coords = values.map((v, i) => {
    const x = padding + (i / (totalPoints - 1)) * (w - 2 * padding);
    // Clamp y to chart bounds (projected value may exceed historical range)
    const normalized = Math.max(0, Math.min(1, (v - min) / range));
    const y = h - padding - normalized * (h - 2 * padding);
    return `${x},${y}`;
  });

  // Split into history and projection
  const historyPath = coords.slice(0, -1).join(' ');
  const lastHistX = padding + ((totalPoints - 2) / (totalPoints - 1)) * (w - 2 * padding);
  const lastHistY = h - padding - ((values[totalPoints - 2] - min) / range) * (h - 2 * padding);
  const projX = coords[coords.length - 1];

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;margin-top:6px;display:block;" preserveAspectRatio="none">
      <polyline points="${historyPath}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
      <line x1="${lastHistX}" y1="${lastHistY}" x2="${projX.split(',')[0]}" y2="${projX.split(',')[1]}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.6"/>
      <circle cx="${projX.split(',')[0]}" cy="${projX.split(',')[1]}" r="3" fill="var(--accent)" opacity="0.6"/>
      <text x="${w - padding}" y="${padding + 8}" text-anchor="end" fill="var(--text-muted)" font-size="8">projected</text>
    </svg>
  `;
}

async function fetchWaterTempHistory(siteCode) {
  try {
    const params = new URLSearchParams({
      format: 'json',
      sites: siteCode,
      parameterCd: '00010,00011', // both C and F
      period: 'P7D',
    });
    const resp = await fetchWithTimeout(`${USGS_BASE}?${params}`, 15000);
    if (!resp.ok) return null;
    const json = await resp.json();

    const timeSeries = json?.value?.timeSeries || [];
    const temps = [];

    for (const ts of timeSeries) {
      const paramCode = ts.variable?.variableCode?.[0]?.value;
      const isCelsius = paramCode === '00010';
      const values = ts.values?.[0]?.value || [];

      for (const v of values) {
        let val = parseFloat(v.value);
        if (isNaN(val) || val < -900) continue;
        if (isCelsius) val = Math.round((val * 9 / 5 + 32) * 10) / 10;
        temps.push({ time: new Date(v.dateTime).getTime(), temp: val });
      }
      if (temps.length > 0) break; // prefer first matching series
    }

    return temps.length > 0 ? temps : null;
  } catch (e) {
    console.warn('Water temp history fetch failed:', e.message);
    return null;
  }
}

function getWaterTempChartHtml(temps) {
  if (!temps || temps.length < 10) return '';

  // Downsample to ~48 points (one per 3-4 hours over 7 days)
  const step = Math.max(1, Math.floor(temps.length / 48));
  const sampled = temps.filter((_, i) => i % step === 0);
  if (sampled.length < 2) return '';

  const values = sampled.map(t => t.temp);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 300, h = 60, pad = 2;

  const points = sampled.map((t, i) => {
    const x = pad + (i / (sampled.length - 1)) * (w - 2 * pad);
    const y = pad + (h - 2 * pad) * (1 - (t.temp - min) / range);
    return `${x},${y}`;
  }).join(' ');

  const latest = values[values.length - 1];
  const oldest = values[0];
  const trend = latest > oldest + 1 ? 'rising' : latest < oldest - 1 ? 'falling' : 'stable';
  const trendColor = trend === 'rising' ? '#e74c3c' : trend === 'falling' ? '#3498db' : '#2ecc71';
  const trendArrow = trend === 'rising' ? '&#9650;' : trend === 'falling' ? '&#9660;' : '&#9654;';

  return `
    <div class="detail-section">
      <h3>Water Temperature — 7 Day Trend</h3>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-size:1.1rem;font-weight:700;color:#e67e22;">${latest.toFixed(1)}°F</span>
        <span style="font-size:0.82rem;color:${trendColor};font-weight:600;">${trendArrow} ${trend.charAt(0).toUpperCase() + trend.slice(1)} (${min.toFixed(1)}–${max.toFixed(1)}°F range)</span>
      </div>
      <div style="background:var(--bg-surface);border-radius:8px;padding:8px 10px 4px;">
        <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block;" preserveAspectRatio="none">
          <polyline points="${points}" fill="none" stroke="#e67e22" stroke-width="2" stroke-linejoin="round"/>
          <polygon points="${pad},${h} ${points} ${w - pad},${h}" fill="rgba(230,126,34,0.1)"/>
          ${(min <= 68 && max >= 50) ? (() => { const y68 = pad + (h - 2 * pad) * (1 - (68 - min) / range); return `<line x1="${pad}" y1="${y68}" x2="${w - pad}" y2="${y68}" stroke="#e74c3c" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/><text x="${w - pad}" y="${y68 - 3}" text-anchor="end" fill="#e74c3c" font-size="7" opacity="0.7">68\u00B0F stress</text>`; })() : ''}
        </svg>
        <div style="display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-muted);margin-top:2px;">
          <span>7 days ago</span><span>Now</span>
        </div>
      </div>
    </div>
  `;
}

// ===== NC Fish Attractors (NCWRC ArcGIS Feature Service) =====

const NC_ATTRACTORS_URL = 'https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query';

async function fetchFishAttractors(south, west, north, east) {
  // Only fetch for NC area (lat 33.8-36.6)
  if (south > 36.6 || north < 33.8) return [];

  const params = new URLSearchParams({
    where: `Latitude >= ${south} AND Latitude <= ${north} AND Longitude >= ${west} AND Longitude <= ${east}`,
    outFields: 'Latitude,Longitude,Attractor_Type,Structure1,Structure1_Quantity,Full_Pool_Depth_Ft,Waterbody,Installed_With_Buoy',
    f: 'json',
    outSR: '4326',
    resultRecordCount: '500',
  });

  try {
    const res = await fetchWithTimeout(`${NC_ATTRACTORS_URL}?${params}`, 12000);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.features || []).map(f => {
      const a = f.attributes;
      return {
        lat: a.Latitude,
        lon: a.Longitude,
        type: 'fish_attractor',
        name: `${a.Waterbody || 'Unknown'} - ${a.Structure1 || a.Attractor_Type || 'Fish Attractor'}`,
        structure: a.Structure1 || a.Attractor_Type,
        quantity: a.Structure1_Quantity,
        depth: a.Full_Pool_Depth_Ft,
        waterbody: a.Waterbody,
        hasBuoy: a.Installed_With_Buoy === 'Yes',
      };
    }).filter(a => a.lat && a.lon);
  } catch (e) {
    console.warn('Fish attractors fetch failed:', e.message);
    return [];
  }
}

export {
  fetchWaterBodies,
  fetchUSGSSites,
  fetchFishAttractors,
  getFishingLinks,

  getCommonSpecies,
  getBBox,
  distanceMiles,
  assessPrivateProperty,
  fetchNWSGaugeData,
  extractFloodStage,
  fetchRecentUSGSData,
  extractNWSForecast,
  analyzeTrend,
  getFloodStageHtml,
  getTrendHtml,
  fetchWaterTempHistory,
  getWaterTempChartHtml,
};
