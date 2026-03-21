# Codebase Audit Summary

**Date:** 2026-03-20 (audit) | 2026-03-21 (all fixes applied)
**Scope:** Full-stack audit of dnd-shiet-fish-finder (vanilla JS SPA + Supabase)
**Agents:** Security Auditor, Performance Profiler, Architecture Critic, QA Specialist
**Status:** ALL FINDINGS RESOLVED (54/54 fixed across 2 commits)

---

## Executive Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security (OWASP) | 0 | 0 | 3 | 7 | 10 |
| Performance | 1 | 3 | 5 | 3 | 12 |
| Data Integrity & Architecture | 2 | 4 | 5 | 9 | 20 |
| QA / Logic Bugs | 2 | 5 | 3 | 2 | 12 |
| **Totals** | **5** | **12** | **16** | **21** | **54** |

**Overall security posture:** Strong. Consistent `escapeHtml`/`escapeAttr` usage, parameterized Supabase queries, SRI on CDN scripts, RLS enabled on all 7 tables. No critical security vulns found.

**Test coverage:** 0%. Zero test files, no test framework. Every function is untested.

**Architecture health:** 5/10. Working app with solid edge-case handling, but `app.js` is a 3190-line god module, utilities are duplicated 3x across files, and data logic is mixed with HTML rendering.

---

## Top 10 Priority Fixes

### 1. [PERF-Critical] Redundant solunar calculations in hot spots
**File:** `fishing.js:241` called from `app.js:367`
`calculateSolunarPeriods(wb.lat, wb.lon)` runs full trig/lunar math per water body (~200x). All bodies are within ~20mi so results are identical.
**Fix:** Compute once for center coords, pass as parameter.

### 2. [PERF-High] `unnamedWayIds.includes()` in nested loop — O(n*m*w)
**File:** `api.js:343`
Linear array scan inside relation member resolution loop.
**Fix:** Convert `unnamedWayIds` to a `Set` before the loop.

### 3. [PERF-High] Double USGS tile fetch on cache hit
**File:** `api.js:931-948`
`enrichUSGSData` re-fetches the same USGS API endpoints that `fetchUSGSSites` already called.
**Fix:** Share tile data between the two functions or cache it.

### 4. [PERF-High] IndexedDB opens separate transaction per grid cell read
**File:** `cache.js:107-125`
`getMultiCached` calls `getCached` per cell (6-12 transactions).
**Fix:** Single readonly transaction with multiple `get()` calls.

### 5. [DATA-Critical] `app.js` is a 3190-line god module
**File:** `app.js`
Contains state, geolocation, all UI rendering, event handlers, auth, and utilities in one file.
**Fix:** Extract into feature modules: `ui/waterDetail.js`, `ui/trips.js`, `ui/community.js`, `state.js`.

### 6. [DATA-Major] `updateTripPlan` passes raw updates object to Supabase
**File:** `supabase.js:193`
No field allowlisting — caller can set any column including `user_id`.
**Fix:** Whitelist mutable fields: `status`, `notes`, `trip_date`, `time_window`, `forecast`, `species`, `gear_checklist`.

### 7. [DATA-Major] `savePlace` crashes on null/undefined lat/lon
**File:** `supabase.js:101`
`place.lat.toFixed(5)` throws TypeError if lat is undefined.
**Fix:** Add guard: `if (typeof place.lat !== 'number') throw new Error('Invalid coordinates')`.

### 8. [SEC-Medium] No Content Security Policy
**File:** `index.html`
No CSP header or meta tag. Heavy `innerHTML` usage means a single escaping oversight enables XSS.
**Fix:** Add `<meta http-equiv="Content-Security-Policy" ...>` with locked-down `script-src`.

### 9. [QA-High] `escapeHtml` in `tripPlan.js` does not escape single quotes
**File:** `tripPlan.js:12`
Allows attribute breakout in single-quoted HTML contexts.
**Fix:** Add `.replace(/'/g, '&#39;')` to the chain.

### 10. [QA-High] `degToCompass` returns `undefined` for negative degrees
**File:** `fishing.js:2260`
JS `%` is remainder (not modulo), so `-2 % 16 = -2`, producing `dirs[-2] = undefined`.
**Fix:** `dirs[((Math.round(deg / 22.5) % 16) + 16) % 16]`.

---

## Security Audit (OWASP Top 10)

RLS verified enabled on all tables: `community_posts`, `fishing_regulations`, `gauge_alerts`, `profiles`, `trip_plans`, `user_arsenal`, `user_places`.

| # | Sev | Category | Location | Finding |
|---|-----|----------|----------|---------|
| S1 | Low | Data Exposure | supabase.js:6-7 | Supabase anon key in client (by design; RLS verified on all 7 tables) |
| S2 | Med | Misconfiguration | index.html | No Content Security Policy |
| S3 | Med | XSS (pattern) | fishing.js:2193+ | HTML render functions omit escapeHtml on non-user data |
| S4 | Low | Access Control | supabase.js:253 | Spread operator allows extra fields in gauge_alerts insert |
| S5 | Med | Validation | Multiple | No client-side validation on DB inserts; unwhitelisted updateTripPlan |
| S6 | Low | File Upload | community.js:49 | MIME check bypassed when file.type is empty |
| S7 | Low | XSS | app.js:1449 | Photo viewer sets img.src without URL scheme check |
| S8 | Low | XSS | app.js:447 | JSON in data attributes (correctly escaped — informational) |
| S9 | Low | Auth | app.js:2651 | No client-side brute-force protection |
| S10 | Low | Tampering | app.js:30 | localStorage parsed without validation (low impact) |

**Clean areas:** No SQL injection (parameterized queries). No XXE (no XML parsing). No eval/document.write. CDN libs use SRI hashes. No user-controlled fetch URLs.

---

## Performance Audit

| # | Sev | Category | Location | Finding | Impact |
|---|-----|----------|----------|---------|--------|
| P1 | Crit | Hot Path | fishing.js:241 | Solunar calc per water body in hot spots | O(n) trig -> O(1) |
| P2 | High | Complexity | api.js:343 | Array.includes() in nested loop | O(n*m*w) -> O(n*m) |
| P3 | High | Redundancy | api.js:940 | Double USGS tile fetch on cache hit | -1-4 API calls |
| P4 | High | IndexedDB | cache.js:107 | Separate transaction per grid cell read | 6-12 txns -> 1 |
| P5 | Med | Complexity | app.js:35 | Linear scan for water body lookup | O(n) -> O(1) |
| P6 | Med | Hot Path | map.js:406 | Haversine for all USGS sites per WB | 6000 -> ~30 calcs |
| P7 | Med | Render | app.js:1187 | Massive innerHTML + multiple reflows | 5+ -> 1-2 reflows |
| P8 | Med | Memory | app.js:400 | Per-item click listeners on hot spots | 25 closures -> 1 |
| P9 | Med | IndexedDB | api.js:922 | Individual setCache per USGS grid cell | n txns -> 1 |
| P10 | Low | Hot Path | app.js:652 | Multiple .includes() keyword scans | Marginal |
| P11 | Low | Hot Path | sw.js:83 | LRU eviction enumerates all 1500 tiles | Every write -> every 50th |
| P12 | Low | Bundle | fishing.js:755 | 750-line LURE_DB loaded eagerly | -30KB initial parse |

---

## Data Integrity & Architecture Audit

### Data Integrity

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D1 | Major | supabase.js:253 | saveGaugeAlert spread allows field injection |
| D2 | Major | supabase.js:193 | updateTripPlan passes raw updates — no field whitelist |
| D3 | Major | supabase.js:101 | savePlace crashes on null lat/lon |
| D4 | Major | supabase.js:100 | No validation of place.type against allowed enum |
| D5 | Minor | community.js:79 | Post body has no length limit |
| D6 | Minor | app.js:1400 | weight_lbs/length_in accept negative or huge values |

### API Contract Issues

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D7 | Major | api.js:187 | Overpass HTML error silently treated as rate limit |
| D8 | Minor | api.js:1003 | USGS sites with NaN coords silently dropped (no logging) |
| D9 | Minor | app.js:939-946 | NOAA/depth API errors fully swallowed |
| D10 | Minor | tripPlan.js:54 | fetchForecast doesn't validate hourly array lengths |

### State Management

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D11 | Major | app.js:493 | Stale userPlaces after concurrent save (push after await) |
| D12 | Minor | app.js:1217 | _currentWeather persists across detail panels (stale for new location) |
| D13 | Minor | app.js:1258 | communityCurrentWb can change between form open and submit |

### Error Handling

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D14 | Major | supabase.js:34 | initAuth swallows session restore errors silently |
| D15 | Minor | app.js:203 | loadUserPlaces catches errors with no UI feedback |
| D16 | Minor | community.js:91 | deleteCommunityPost doesn't verify row was deleted |

### Coupling & Modularity

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D17 | Crit | app.js | 3190-line god module — SRP violation |
| D18 | Major | Multiple | HTML rendering mixed with data logic in tripPlan.js, fishing.js, api.js |
| D19 | Minor | 3 files | fetchWithTimeout duplicated in api.js, fishing.js, tripPlan.js |
| D20 | Minor | 2 files | escapeHtml duplicated in app.js and tripPlan.js |

### Data Flow Issues

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| D21 | Major | api.js:555 | Cache merge can duplicate water bodies (toFixed precision mismatch: 4 vs 3) |
| D22 | Major | tripPlan.js:66 | NaN forecast values propagate to DB on incomplete API response |
| D23 | Minor | supabase.js:215 | Regulations cache has no TTL (stale for entire session) |
| D24 | Minor | cache.js:83 | IndexedDB quota exceeded crashes the load pipeline |

---

## QA Audit — Logic Bugs & Edge Cases

### Active Bugs

| # | Sev | Location | Bug |
|---|-----|----------|-----|
| Q1 | Crit | supabase.js:101 | `place.lat.toFixed(5)` crashes on undefined lat/lon |
| Q2 | Crit | supabase.js:253 | saveGaugeAlert field injection via spread |
| Q3 | High | community.js:15 | `generateWaterBodyKey` crashes on null lat/lon |
| Q4 | High | api.js:23,40-78 | Overpass queries for canals but classifyWaterBody never returns "canal" |
| Q5 | High | fishing.js:129 | rateFishActivity depends on system clock — non-deterministic |
| Q6 | High | api.js:1027 | `getCommonSpecies` crashes on undefined waterName |
| Q7 | High | tripPlan.js:12 | escapeHtml missing single-quote escape |
| Q8 | Med | tripPlan.js:100 | formatDate throws on invalid date strings |
| Q9 | Med | fishing.js:2260 | degToCompass returns undefined for negative degrees |
| Q10 | Med | api.js:1530 | analyzeTrend clamps tidal gauge values to 0 (incorrect for coastal) |
| Q11 | Low | tripPlan.js:140 | nthWeekday returns null for 5th occurrence — pushed into holidays array |
| Q12 | Low | fishing.js:653 | findHighsLows skips first/last prediction points |

### Test Coverage

**Current:** 0% — no test framework, no test files, no mocks.

**Recommended test suites (5 integration tests):**
1. Search-to-Detail flow (classify -> weather -> species -> recommendations)
2. Trip Planning pipeline (forecast -> traffic -> gear -> DB save)
3. Auth + User Places round-trip (signup -> save -> reload -> remove)
4. Community Posts lifecycle (upload validation -> key generation -> CRUD -> cleanup)
5. Cache layer (TTL expiry -> grid coverage -> batch writes)

**Most testable pure functions (immediate unit test candidates):**
- `classifyWaterBody(tags)` — 10+ edge cases documented
- `assessPrivateProperty(wb)` — 6+ edge cases
- `extractBestName(tags, type)` — 6+ edge cases
- `distanceMiles(lat1, lon1, lat2, lon2)` — boundary cases
- `gridKey(lat, lon)` — NaN handling
- `degToCompass(deg)` — negative degrees
- `formatDate(d)` — invalid input
- `generateWaterBodyKey(name, lat, lon)` — null handling
- `rateFishActivity(weather)` — determinism
- `analyzeTrend(values)` — coastal gauges

---

## Recommended Action Plan

### Phase 1: Quick Wins (low effort, high impact)
1. Fix `degToCompass` negative degree bug (1 line)
2. Fix `escapeHtml` in tripPlan.js to escape single quotes (1 line)
3. Convert `unnamedWayIds` to Set in api.js (2 lines)
4. Compute solunar once in `loadHotSpots` (3 lines)
5. Add type guard to `savePlace` for lat/lon (2 lines)
6. Add null guard to `generateWaterBodyKey` (1 line)
7. Use `setCacheBatch` for USGS sites (swap 1 call)

### Phase 2: Hardening (medium effort)
8. Add field whitelisting to `updateTripPlan` and `saveGaugeAlert`
9. Add CSP meta tag to index.html
10. Batch IndexedDB reads in `getMultiCached`
11. Validate forecast response shape before saving
12. Clear `_currentWeather` on detail panel open
13. Add toast feedback for swallowed auth/load errors
14. Fix MIME type check to reject empty types

### Phase 3: Architecture (higher effort)
15. Extract shared utils: `fetchWithTimeout`, `escapeHtml`, `distanceMiles`
16. Split `app.js` into feature modules
17. Separate data logic from HTML rendering
18. Add test framework (Vitest) + unit tests for pure functions
19. Add integration tests for the 5 critical flows
20. Add TTL to regulations cache

---

*Generated by multi-agent audit: Security Auditor, Performance Profiler, Architecture Critic, QA Specialist*
*54 total findings across 4 domains*
