# Audit Fix Tasks — DND Shiet Fish Finder

Generated 2026-03-16 from comprehensive 5-pass audit.
Each task has an ID, severity, file(s), description, and specific fix instructions.

---

## PHASE 1 — Critical Security + Data Bugs (fix immediately)

### TASK-S2: Escape water_body_lat/lon in social feed rendering
- **Severity:** Critical
- **File:** `js/app.js` — `renderSocialFeed` function (~line 1131)
- **Issue:** `post.water_body_lat` and `post.water_body_lon` inserted raw into data-attributes. Attacker can craft a community post via Supabase API with lat containing `" onmouseover="alert(1)"`.
- **Fix:** Wrap with `escapeAttr(String(post.water_body_lat))` and same for lon. Also do this in `renderCommunityPosts` for consistency.

### TASK-S3: Escape link URLs in detail panels
- **Severity:** Critical
- **File:** `js/app.js` — `showWaterDetail` (~line 782) and `showUSGSDetail` (~line 1294)
- **Issue:** `l.url` from `getFishingLinks()` inserted raw into `href` attributes.
- **Fix:** Change `href="${l.url}"` to `href="${escapeAttr(l.url)}"` in all link rendering.

### TASK-T5: Fix NWS flood category key — "minor" not "flood"
- **Severity:** Critical
- **File:** `js/api.js` — `extractFloodStage` function (~line 748)
- **Issue:** Code reads `floodCats.flood?.stage` but NWPS v1 API uses key `"minor"` for the first flood threshold. Minor flood threshold is always null, skipping from action directly to moderate.
- **Fix:** Change `floodCats.flood?.stage` to `floodCats.minor?.stage`. Update `getFloodCategory` and `getFloodStageHtml` to use 'minor' label instead of 'flood'.

### TASK-T6: Fix NWS stageflow forecast parsing
- **Severity:** Critical
- **File:** `js/api.js` — `extractNWSForecast` function (~line 835)
- **Issue:** `pt.primary?.value` fails when NWPS returns primary as a plain number (not an object). All forecast points get stage=null and are filtered out. NWS forecast panel always empty.
- **Fix:** Change to `(typeof pt.primary === 'number' ? pt.primary : pt.primary?.value) ?? pt.stage ?? null`. Same pattern for `pt.secondary`.

### TASK-O1: Remove duplicate SPECIES_DATA entries
- **Severity:** Critical (data correctness)
- **File:** `js/fishing.js`
- **Issue:** Hickory Shad, Carp, and Spotted Bass each defined twice in SPECIES_DATA. JS silently keeps last definition, first is dead code.
- **Fix:** Find and remove the first (earlier) occurrences of all three. Keep only the later, more complete entries.

---

## PHASE 2 — High Security + Missing Timeouts

### TASK-S4: Add file size limit on photo uploads
- **Severity:** High
- **File:** `js/arsenal.js` (addArsenalItem, updateArsenalItem), `js/community.js` (addCommunityPost)
- **Fix:** Add `if (photoFile.size > 10 * 1024 * 1024) throw new Error('Photo must be under 10 MB');` before upload. Also apply resizeImage to arsenal photos (currently only community does resize).

### TASK-S5: Add SRI hashes to CDN script/link tags
- **Severity:** High
- **File:** `index.html` lines 14-15, 480-481
- **Fix:** Compute SHA-384 hashes for Leaflet CSS, Leaflet JS, and Supabase JS. Add `integrity="sha384-..."` and `crossorigin="anonymous"` to each tag.

### TASK-S7: Escape license photo src attribute
- **Severity:** High
- **File:** `js/app.js` — `renderLicenseSlots` (~line 2354)
- **Fix:** Change `<img src="${lic.photo}"` to `<img src="${escapeAttr(lic.photo)}"`. Add validation that photo starts with `data:image/`.

### TASK-S10: Escape trip plan summary HTML fields
- **Severity:** Medium
- **File:** `js/tripPlan.js` — `getTripSummaryCardHtml` (~line 385)
- **Issue:** `plan.place_name`, `plan.status`, `plan.notes`, species array items all unescaped. `escapeHtml` is not available in tripPlan.js.
- **Fix:** Either import escapeHtml from app.js (export it first), or add a local copy. Wrap all user-data fields.

### TASK-T7: Add timeout to fetchUSGSTile
- **Severity:** High
- **File:** `js/api.js` — `fetchUSGSTile` (~line 440)
- **Fix:** Change bare `fetch(url)` to `fetchWithTimeout(url, 15000)`. The helper already exists in the same file.

### TASK-T8: Add timeout to fetchTidePredictions
- **Severity:** High
- **File:** `js/fishing.js` — `fetchTidePredictions` (~line 342)
- **Fix:** Import `fetchWithTimeout` from api.js or add an AbortController with 10s timeout.

### TASK-T9: Add timeout to fetchWeather and fetchForecast
- **Severity:** High
- **Files:** `js/fishing.js` (fetchWeather ~line 37), `js/tripPlan.js` (fetchForecast ~line 40)
- **Fix:** Same pattern — add AbortController timeouts (10s for weather, 15s for forecast).

---

## PHASE 3 — Traceability + Code Quality

### TASK-T1: Add .catch() to signOut
- **Severity:** Medium
- **File:** `js/app.js` (~line 1923)
- **Fix:** Add `.catch(e => toast('Sign out failed', true))` to the `signOut().then(...)` chain.

### TASK-T2: Check getSession error
- **Severity:** Medium
- **File:** `js/supabase.js` (~line 33)
- **Fix:** Destructure error: `const { data: { session }, error } = await client.auth.getSession(); if (error) console.warn('Session error:', error);`

### TASK-S8: Move USGS siteCode to data-attribute
- **Severity:** Medium
- **File:** `js/app.js` (~line 764)
- **Fix:** Change inline `onclick="document.dispatchEvent(new CustomEvent('show-usgs', {detail:'${s.siteCode}'}))"` to use `data-site-code="${escapeAttr(s.siteCode)}"` with event delegation.

### TASK-S9: Add MIME type validation on file uploads
- **Severity:** Medium
- **Files:** `js/arsenal.js`, `js/community.js`
- **Fix:** Check `photoFile.type` against allowed MIME list before upload.

---

## PHASE 4 — Optimization + Dead Code Cleanup

### TASK-O2: Remove dead exports from fishing.js
- **Files:** `js/fishing.js`
- **Fix:** Remove `LURE_DB` and `getTroutStressWarning` from export list.

### TASK-O4: Remove dead CSS marker classes
- **File:** `css/style.css` lines 184-226
- **Fix:** Delete `.marker-water`, `.marker-lake`, `.marker-river`, `.marker-stream`, `.marker-pond`, `.marker-boat-landing`, `.marker-fishing-pier`, `.marker-usgs`, `.marker-icon-inner`, `@keyframes usgs-pulse`.

### TASK-O5: Remove dead cache.js export
- **File:** `js/cache.js`
- **Fix:** Remove `getGridCells` from export list.

### TASK-T4: Remove dead supabase.js export
- **File:** `js/supabase.js`
- **Fix:** Remove `getPlaceStatuses` from export list and from app.js import.

### TASK-O6: Consolidate weather code description functions
- **Files:** `js/fishing.js`, `js/tripPlan.js`
- **Fix:** Export `describeWeatherCode` from fishing.js, import in tripPlan.js, remove `describeCode`.

### TASK-O7: Extract shared image resize utility
- **Files:** `js/community.js`, `js/app.js`
- **Fix:** Export `resizeImage` from community.js, import in app.js for license photo resize.

### TASK-O8: Extract shared post card HTML renderer
- **File:** `js/app.js`
- **Fix:** Create `renderPostCardHtml(post, { showDelete, showLocation })` used by both `renderCommunityPosts` and `renderSocialFeed`.

### TASK-O9: Extract place lookup helper
- **File:** `js/app.js`
- **Fix:** Create `findWaterBodyByCoords(name, lat, lon, tolerance)` to replace 5 duplicated filter patterns.

### TASK-O10: Replace escapeHtml DOM allocation with string replacement
- **File:** `js/app.js` (~line 2265)
- **Fix:** Change to `(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')`.

### TASK-O11: Debounce arsenal search
- **File:** `js/app.js` (~line 2069)
- **Fix:** Add 150ms debounce: `clearTimeout(timer); timer = setTimeout(renderArsenal, 150);`

### TASK-S13: Normalize auth error messages
- **File:** `js/app.js` — auth form submit handler
- **Fix:** Replace verbatim Supabase error with generic "Incorrect email or password" for signIn failures.
