/**
 * Shared HTML escaping utilities.
 */

export function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeAttr(str) {
  return escapeHtml(str);
}
