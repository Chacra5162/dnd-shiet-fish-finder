/**
 * Location-based IndexedDB cache.
 * Keys are grid cells (~5 mile squares) so we only cache data near the user.
 */

const DB_NAME = 'waterway-finder';
const DB_VERSION = 3; // v3: upgrade handler now actually deletes old stores on version bump
const STORES = {
  waterBodies: 'water_bodies',
  usgs: 'usgs_sites',
  usgsCurrent: 'usgs_current',
};

// Cache TTLs in milliseconds
const TTL = {
  waterBodies: 30 * 24 * 60 * 60 * 1000,  // 30 days (water body locations rarely change)
  usgs: 30 * 24 * 60 * 60 * 1000,          // 30 days (site locations)
  usgsCurrent: 60 * 60 * 1000,             // 1 hour (real-time data)
};

// Grid cell size in degrees (~5 miles ≈ 0.07 degrees)
const GRID_SIZE = 0.07;

function gridKey(lat, lon) {
  const gLat = (Math.round(lat / GRID_SIZE) * GRID_SIZE).toFixed(3);
  const gLon = (Math.round(lon / GRID_SIZE) * GRID_SIZE).toFixed(3);
  return `${gLat}_${gLon}`;
}

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // On version upgrade, clear old stores to flush stale data
      if (e.oldVersion > 0 && e.oldVersion < DB_VERSION) {
        for (const store of Object.values(STORES)) {
          if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
        }
      }
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'gridKey' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null; // allow retry on failure
      reject(req.error);
    };
  });
  return _dbPromise;
}

async function getCached(storeName, lat, lon) {
  const db = await openDB();
  const key = gridKey(lat, lon);
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return resolve(null);
      const ttl = TTL[Object.keys(STORES).find(k => STORES[k] === storeName)] || TTL.waterBodies;
      if (Date.now() - record.timestamp > ttl) {
        resolve(null); // expired
      } else {
        resolve(record.data);
      }
    };
    req.onerror = () => resolve(null);
  });
}

async function setCache(storeName, lat, lon, data) {
  const db = await openDB();
  const key = gridKey(lat, lon);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put({ gridKey: key, data, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Get all grid cells that cover a bounding box
function getGridCells(south, west, north, east) {
  const cells = [];
  for (let i = 0; (south + i * GRID_SIZE) <= north; i++) {
    const lat = south + i * GRID_SIZE;
    for (let j = 0; (west + j * GRID_SIZE) <= east; j++) {
      const lon = west + j * GRID_SIZE;
      cells.push({ lat, lon, key: gridKey(lat, lon) });
    }
  }
  return cells;
}

// Get cached data for multiple grid cells, return { cached, missing }
// Reads all cells in parallel for speed
async function getMultiCached(storeName, south, west, north, east) {
  const cells = getGridCells(south, west, north, east);
  const cached = [];
  const missing = [];

  const results = await Promise.all(
    cells.map(cell => getCached(storeName, cell.lat, cell.lon).then(data => ({ cell, data })))
  );

  for (const { cell, data } of results) {
    if (data) {
      cached.push(...data);
    } else {
      missing.push(cell);
    }
  }

  return { cached, missing, allCells: cells };
}

// Batch write multiple grid cells in a single transaction (much faster on mobile)
async function setCacheBatch(storeName, entries) {
  if (entries.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const now = Date.now();
    for (const { key, data } of entries) {
      store.put({ gridKey: key, data, timestamp: now });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { STORES, getCached, setCache, setCacheBatch, getMultiCached, gridKey };
