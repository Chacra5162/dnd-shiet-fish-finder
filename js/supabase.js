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
  const { data: { session } } = await client.auth.getSession();
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

async function getUserPlaces() {
  if (!currentUser) return [];
  const client = getClient();
  const { data, error } = await client
    .from('user_places')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

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

// Get all statuses for a specific water body (by name + location)
async function getPlaceStatuses(placeName, lat, lon) {
  if (!currentUser) return [];
  const client = getClient();
  const { data, error } = await client
    .from('user_places')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('place_name', placeName)
    .gte('lat', lat - 0.001)
    .lte('lat', lat + 0.001)
    .gte('lon', lon - 0.001)
    .lte('lon', lon + 0.001);
  if (error) throw error;
  return data || [];
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
  const client = getClient();
  const { data, error } = await client
    .from('trip_plans')
    .update(updates)
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

export {
  getClient,
  initAuth,
  signUp,
  signIn,
  signOut,
  getUser,
  getUserPlaces,
  getUserPlacesNear,
  savePlace,
  removePlace,
  updatePlaceNotes,
  getPlaceStatuses,
  saveTripPlan,
  getUserTripPlans,
  updateTripPlan,
  deleteTripPlan,
};
