/**
 * My Arsenal — tackle inventory with photos.
 * CRUD against Supabase user_arsenal table + arsenal-photos storage bucket.
 * Uses the shared Supabase client from supabase.js (same auth session).
 */

import { getClient, getSupabaseUrl } from './supabase.js';

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

function client() {
  return getClient();
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
    if (photoFile.size > 10 * 1024 * 1024) throw new Error('Photo must be under 10 MB');
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'];
    const rawExt = photoFile.name.split('.').pop().toLowerCase();
    const ext = ALLOWED_EXTS.includes(rawExt) ? rawExt : 'jpg';
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await client()
      .storage.from('arsenal-photos')
      .upload(fileName, photoFile, { contentType: 'image/jpeg', upsert: false });
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

async function updateArsenalItem(userId, itemId, updates, newPhotoFile, oldPhotoPath) {
  if (newPhotoFile) {
    if (newPhotoFile.size > 10 * 1024 * 1024) throw new Error('Photo must be under 10 MB');
    // Delete old photo if replacing
    if (oldPhotoPath) {
      await client().storage.from('arsenal-photos').remove([oldPhotoPath]).catch(() => {});
    }
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'];
    const rawExt = newPhotoFile.name.split('.').pop().toLowerCase();
    const ext = ALLOWED_EXTS.includes(rawExt) ? rawExt : 'jpg';
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await client()
      .storage.from('arsenal-photos')
      .upload(fileName, newPhotoFile, { contentType: 'image/jpeg', upsert: false });
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
  return `${getSupabaseUrl()}/storage/v1/object/public/arsenal-photos/${photoPath}`;
}

// ===== Filtering / Sorting =====

function filterItems(items, { category, color, weight, search } = {}) {
  return items.filter(item => {
    if (category && category !== 'all' && item.category !== category) return false;
    if (color && !(item.color || '').toLowerCase().includes(color.toLowerCase())) return false;
    if (weight && !(item.weight || '').toLowerCase().includes(weight.toLowerCase())) return false;
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
