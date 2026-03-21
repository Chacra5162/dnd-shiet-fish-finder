/**
 * Supabase client — auth + user places (favorites, visited, avoid).
 * Uses the Supabase JS CDN bundle loaded in index.html.
 */

const SUPABASE_URL = 'https://emgyewsetldhzxzskyji.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZ3lld3NldGxkaHp4enNreWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjQxNzIsImV4cCI6MjA4OTIwMDE3Mn0.gh3SR5XH4L-1RDHuz9euvgDFOUi70W2sxK5yPAua7IU';

let supabase = null;
let currentUser = null;
let onAuthChangeCallback = null;

function getClient() {
  if (!supabase) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ===== Auth =====

async function initAuth(onAuthChange) {
  onAuthChangeCallback = onAuthChange;
  const client = getClient();

  // Listen for auth state changes
  client.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    if (onAuthChangeCallback) onAuthChangeCallback(currentUser, event);
  });

  // Check existing session
  const { data: { session }, error: sessError } = await client.auth.getSession();
  if (sessError) {
    console.warn('Session restore error:', sessError.message);
    // Surface to UI so user knows to re-authenticate
    setTimeout(() => {
      if (typeof window !== 'undefined' && typeof window.toast === 'function') {
        window.toast('Session expired — please sign in again', true);
      }
    }, 1000);
  }
  currentUser = session?.user || null;
  if (onAuthChangeCallback) onAuthChangeCallback(currentUser, 'INITIAL');
  return currentUser;
}

async function signUp(email, password, displayName) {
  const client = getClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const client = getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  const client = getClient();
  const { error } = await client.auth.signOut();
  if (error) throw error;
  currentUser = null;
}

function getUser() {
  return currentUser;
}

// ===== User Places =====

// Get places near a location (for showing on map)
async function getUserPlacesNear(lat, lon, radiusDeg = 0.3) {
  if (!currentUser) return [];
  const client = getClient();
  const { data, error } = await client
    .from('user_places')
    .select('*')
    .eq('user_id', currentUser.id)
    .gte('lat', lat - radiusDeg)
    .lte('lat', lat + radiusDeg)
    .gte('lon', lon - radiusDeg)
    .lte('lon', lon + radiusDeg);
  if (error) throw error;
  return data || [];
}

async function savePlace(place, status, notes = '') {
  if (!currentUser) throw new Error('Not signed in');
  if (typeof place.lat !== 'number' || typeof place.lon !== 'number' || isNaN(place.lat) || isNaN(place.lon)) {
    throw new Error('Invalid coordinates');
  }
  const VALID_TYPES = ['lake', 'river', 'stream', 'pond', 'boat_landing', 'fishing_pier'];
  if (!VALID_TYPES.includes(place.type)) {
    throw new Error(`Invalid place type: ${place.type}`);
  }
  const client = getClient();

  // Upsert based on unique constraint
  const { data, error } = await client
    .from('user_places')
    .upsert({
      user_id: currentUser.id,
      place_name: place.name,
      place_type: place.type,
      lat: parseFloat(place.lat.toFixed(5)),
      lon: parseFloat(place.lon.toFixed(5)),
      osm_id: place.id || null,
      status,
      notes,
      visited_at: status === 'visited' ? new Date().toISOString() : null,
    }, {
      onConflict: 'user_id,place_name,lat,lon,status',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function removePlace(placeId) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { error } = await client
    .from('user_places')
    .delete()
    .eq('id', placeId)
    .eq('user_id', currentUser.id);
  if (error) throw error;
}

async function updatePlaceNotes(placeId, notes) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { data, error } = await client
    .from('user_places')
    .update({ notes })
    .eq('id', placeId)
    .eq('user_id', currentUser.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ===== Trip Plans =====

async function saveTripPlan(plan) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { data, error } = await client
    .from('trip_plans')
    .insert({
      user_id: currentUser.id,
      place_name: plan.placeName,
      place_type: plan.placeType,
      lat: plan.lat,
      lon: plan.lon,
      osm_id: plan.osmId || null,
      trip_date: plan.tripDate,
      time_window: plan.timeWindow,
      forecast: plan.forecast || null,
      traffic_estimate: plan.trafficEstimate || null,
      traffic_description: plan.trafficDescription || null,
      species: plan.species || [],
      gear_checklist: plan.gearChecklist || null,
      notes: plan.notes || '',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getUserTripPlans(includeOld = false) {
  if (!currentUser) return [];
  const client = getClient();
  let query = client
    .from('trip_plans')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('trip_date', { ascending: true });
  if (!includeOld) {
    const today = new Date().toISOString().split('T')[0];
    query = query.gte('trip_date', today);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function updateTripPlan(id, updates) {
  if (!currentUser) throw new Error('Not signed in');
  const ALLOWED = ['status', 'notes', 'trip_date', 'time_window', 'forecast', 'species', 'gear_checklist', 'traffic_estimate', 'traffic_description'];
  const safe = {};
  for (const key of ALLOWED) { if (key in updates) safe[key] = updates[key]; }
  const client = getClient();
  const { data, error } = await client
    .from('trip_plans')
    .update(safe)
    .eq('id', id)
    .eq('user_id', currentUser.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteTripPlan(id) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { error } = await client
    .from('trip_plans')
    .delete()
    .eq('id', id)
    .eq('user_id', currentUser.id);
  if (error) throw error;
}

// ===== Fishing Regulations =====

let _regulationsCache = null;
let _regulationsCacheTime = 0;

async function fetchAllRegulations() {
  if (_regulationsCache && Date.now() - _regulationsCacheTime < 3600000) return _regulationsCache;
  const client = getClient();
  const { data, error } = await client
    .from('fishing_regulations')
    .select('water_body_pattern,rule_text,rule_type,species,source_url,updated_at')
    .eq('active', true);
  if (error) { console.warn('Regulations fetch error:', error); return []; }
  _regulationsCache = data || [];
  _regulationsCacheTime = Date.now();
  return _regulationsCache;
}

function getRegulationsForWater(allRegs, waterName) {
  const n = (waterName || '').toLowerCase();
  return allRegs.filter(r => n.includes(r.water_body_pattern));
}

// ===== Gauge Alerts =====

async function getUserGaugeAlerts() {
  if (!currentUser) return [];
  const client = getClient();
  const { data, error } = await client
    .from('gauge_alerts')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function saveGaugeAlert(alert) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { data, error } = await client
    .from('gauge_alerts')
    .insert({
      user_id: currentUser.id,
      site_code: alert.site_code,
      site_name: alert.site_name,
      parameter: alert.parameter,
      condition: alert.condition,
      threshold: alert.threshold,
      unit: alert.unit,
      enabled: alert.enabled ?? true,
    })
    .select().single();
  if (error) throw error;
  return data;
}

async function deleteGaugeAlert(alertId) {
  if (!currentUser) throw new Error('Not signed in');
  const client = getClient();
  const { error } = await client
    .from('gauge_alerts')
    .delete()
    .eq('id', alertId)
    .eq('user_id', currentUser.id);
  if (error) throw error;
}

function getSupabaseUrl() {
  return SUPABASE_URL;
}

export {
  getClient,
  getSupabaseUrl,
  initAuth,
  signUp,
  signIn,
  signOut,
  getUser,
  getUserPlacesNear,
  savePlace,
  removePlace,
  updatePlaceNotes,
  saveTripPlan,
  getUserTripPlans,
  updateTripPlan,
  deleteTripPlan,
  fetchAllRegulations,
  getRegulationsForWater,
  getUserGaugeAlerts,
  saveGaugeAlert,
  deleteGaugeAlert,
};
