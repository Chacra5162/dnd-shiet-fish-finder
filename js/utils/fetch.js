/**
 * Shared fetch timeout helper (compat with iOS Safari <16).
 */

export function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
