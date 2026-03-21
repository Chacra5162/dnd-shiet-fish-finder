/**
 * Shared photo upload validation.
 */

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'];

export function validatePhoto(file, maxSizeMB = 10) {
  if (file.size > maxSizeMB * 1024 * 1024) {
    throw new Error(`Photo must be under ${maxSizeMB} MB`);
  }
  if (!file.type || !ALLOWED_MIME.includes(file.type)) {
    throw new Error('Invalid file type — use JPG, PNG, GIF, or WebP');
  }
  const rawExt = file.name.split('.').pop().toLowerCase();
  const ext = ALLOWED_EXTS.includes(rawExt) ? rawExt : 'jpg';
  return { ext, contentType: file.type };
}
