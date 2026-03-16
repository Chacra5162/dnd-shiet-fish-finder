/**
 * Community Board — posts, catch reports, photos per water body.
 * Uses the shared Supabase client from supabase.js.
 */

import { getClient, getSupabaseUrl } from './supabase.js';
const BUCKET = 'community-photos';

function client() {
  return getClient();
}

// Generate a stable key for a water body (same location = same board)
function generateWaterBodyKey(name, lat, lon) {
  return `${(name || '').toLowerCase().trim()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
}

// ===== CRUD =====

async function getCommunityPosts(waterBodyKey, limit = 50, offset = 0) {
  const { data, error } = await client()
    .from('community_posts')
    .select('id,user_id,display_name,water_body_key,water_body_name,water_body_lat,water_body_lon,post_type,body,photo_path,species,weight_lbs,length_in,created_at')
    .eq('water_body_key', waterBodyKey)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

async function addCommunityPost(userId, displayName, waterBody, postData, photoFile) {
  let photoPath = null;

  if (photoFile) {
    if (photoFile.size > 10 * 1024 * 1024) throw new Error('Photo must be under 10 MB');
    const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    if (photoFile.type && !ALLOWED_MIME.includes(photoFile.type)) throw new Error('Invalid file type — use JPG, PNG, GIF, or WebP');
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'];
    const rawExt = photoFile.name.split('.').pop().toLowerCase();
    const ext = ALLOWED_EXTS.includes(rawExt) ? rawExt : 'jpg';
    const fileName = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // Resize before upload (max 1200px wide)
    const resized = await resizeImage(photoFile, 1200);

    const { error: uploadError } = await client()
      .storage.from(BUCKET)
      .upload(fileName, resized, { contentType: 'image/jpeg', upsert: false });
    if (uploadError) throw uploadError;
    photoPath = fileName;
  }

  const key = generateWaterBodyKey(waterBody.name, waterBody.lat, waterBody.lon);

  const { data, error } = await client()
    .from('community_posts')
    .insert({
      user_id: userId,
      display_name: displayName,
      water_body_key: key,
      water_body_name: waterBody.name,
      water_body_lat: waterBody.lat,
      water_body_lon: waterBody.lon,
      post_type: postData.type || 'comment',
      body: postData.body || '',
      photo_path: photoPath,
      species: postData.species || null,
      weight_lbs: postData.weight || null,
      length_in: postData.length || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteCommunityPost(userId, postId, photoPath) {
  if (photoPath) {
    await client().storage.from(BUCKET).remove([photoPath]).catch(() => {});
  }
  const { error } = await client()
    .from('community_posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', userId);
  if (error) throw error;
}

function getCommunityPhotoUrl(photoPath) {
  if (!photoPath) return null;
  return `${getSupabaseUrl()}/storage/v1/object/public/${BUCKET}/${photoPath}`;
}

// ===== Image Resize =====

function resizeImage(file, maxWidth) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => resolve(file); // fallback: upload original file without resize
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.8);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Get recent posts across ALL water bodies (global feed)
async function getRecentPosts(limit = 30, offset = 0) {
  const { data, error } = await client()
    .from('community_posts')
    .select('id,user_id,display_name,water_body_key,water_body_name,water_body_lat,water_body_lon,post_type,body,photo_path,species,weight_lbs,length_in,created_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export {
  generateWaterBodyKey,
  getCommunityPosts,
  getRecentPosts,
  addCommunityPost,
  deleteCommunityPost,
  getCommunityPhotoUrl,
  resizeImage,
};
