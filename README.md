# DND Shiet Fish Finder

Fishing spot finder PWA for Virginia and North Carolina. Discover nearby lakes, rivers, streams, boat landings, and fishing piers with real-time USGS water data, NOAA tide predictions, species recommendations, and community catch reports.

## Stack

- Vanilla JavaScript ES modules (no framework, no build step)
- Leaflet.js with canvas renderer for map
- Supabase (auth, database, storage)
- NOAA CO-OPS API (tides)
- USGS Water Services API (gauges, flow, temperature)
- NWS Water Prediction Service (flood stage, forecasts)
- OpenStreetMap Overpass API (water body locations)
- Open-Meteo API (weather forecasts)
- Deployed to GitHub Pages as a PWA

## Supabase Setup

### Tables (with RLS enabled)

- `user_places` — saved favorites, visited, avoided locations
- `user_arsenal` — tackle inventory with photos
- `trip_plans` — planned fishing trips
- `community_posts` — per-location community board posts

### Storage Buckets

- `arsenal-photos` — tackle item photos (public read, auth write)
- `community-photos` — community post photos (public read, auth write)

### Required RLS Policies

All tables require:
- SELECT: `true` (public read for community_posts) or `auth.uid() = user_id`
- INSERT: `auth.uid() = user_id`
- DELETE: `auth.uid() = user_id`
- UPDATE: `auth.uid() = user_id` (where applicable)

## Local Development

Open `index.html` in a browser, or serve with any static file server:

```bash
npx serve .
```

No build step required. All JavaScript uses ES modules loaded directly by the browser.
