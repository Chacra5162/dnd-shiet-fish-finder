/**
 * My Arsenal — tackle inventory with photos.
 * CRUD against Supabase user_arsenal table + arsenal-photos storage bucket.
 */

const SUPABASE_URL = 'https://emgyewsetldhzxzskyji.supabase.co';

const CATEGORIES = {
  crankbait: 'Crankbait',
  jerkbait: 'Jerkbait',
  topwater: 'Topwater',
  spinnerbait: 'Spinnerbait',
  jig: 'Jig',
  soft_plastic: 'Soft Plastic',
  spoon: 'Spoon',
  blade: 'Blade Bait',
  fly: 'Fly',
  swimbait: 'Swimbait',
  live_bait: 'Live Bait / Natural',
  terminal_tackle: 'Terminal Tackle',
  other: 'Other',
};

// Get the supabase client from the global (loaded by supabase.js)
function getClient() {
  return window.supabase.createClient(SUPABASE_URL,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZ3lld3NldGxkaHp4enNreWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjQxNzIsImV4cCI6MjA4OTIwMDE3Mn0.gh3SR5XH4L-1RDHuz9euvgDFOUi70W2sxK5yPAua7IU'
  );
}

// Reuse the client singleton from supabase.js if possible
let _client = null;
function client() {
  if (!_client) _client = getClient();
  return _client;
}

// ===== CRUD =====

async function getArsenalItems(userId) {
  const { data, error } = await client()
    .from('user_arsenal')
    .select('*')
    .eq('user_id', userId)
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addArsenalItem(userId, item, photoFile) {
  let photoPath = null;

  // Upload photo if provided
  if (photoFile) {
    const ext = photoFile.name.split('.').pop().toLowerCase();
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await client()
      .storage.from('arsenal-photos')
      .upload(fileName, photoFile, { contentType: photoFile.type, upsert: false });
    if (uploadError) throw uploadError;
    photoPath = fileName;
  }

  const { data, error } = await client()
    .from('user_arsenal')
    .insert({
      user_id: userId,
      name: item.name,
      category: item.category,
      color: item.color || '',
      weight: item.weight || '',
      brand: item.brand || '',
      size: item.size || '',
      notes: item.notes || '',
      photo_path: photoPath,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateArsenalItem(userId, itemId, updates, newPhotoFile) {
  if (newPhotoFile) {
    const ext = newPhotoFile.name.split('.').pop().toLowerCase();
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await client()
      .storage.from('arsenal-photos')
      .upload(fileName, newPhotoFile, { contentType: newPhotoFile.type, upsert: false });
    if (uploadError) throw uploadError;
    updates.photo_path = fileName;
  }

  const { data, error } = await client()
    .from('user_arsenal')
    .update(updates)
    .eq('id', itemId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteArsenalItem(userId, itemId, photoPath) {
  // Delete photo from storage if exists
  if (photoPath) {
    await client().storage.from('arsenal-photos').remove([photoPath]).catch(() => {});
  }
  const { error } = await client()
    .from('user_arsenal')
    .delete()
    .eq('id', itemId)
    .eq('user_id', userId);
  if (error) throw error;
}

function getPhotoUrl(photoPath) {
  if (!photoPath) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/arsenal-photos/${photoPath}`;
}

// ===== Filtering / Sorting =====

function filterItems(items, { category, color, weight, search } = {}) {
  return items.filter(item => {
    if (category && category !== 'all' && item.category !== category) return false;
    if (color && !item.color.toLowerCase().includes(color.toLowerCase())) return false;
    if (weight && !item.weight.toLowerCase().includes(weight.toLowerCase())) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = `${item.name} ${item.brand} ${item.color} ${item.notes}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function getUniqueColors(items) {
  const colors = new Set();
  items.forEach(i => { if (i.color) colors.add(i.color); });
  return [...colors].sort();
}

function getUniqueWeights(items) {
  const weights = new Set();
  items.forEach(i => { if (i.weight) weights.add(i.weight); });
  return [...weights].sort();
}

export {
  CATEGORIES,
  getArsenalItems,
  addArsenalItem,
  updateArsenalItem,
  deleteArsenalItem,
  getPhotoUrl,
  filterItems,
  getUniqueColors,
  getUniqueWeights,
};
