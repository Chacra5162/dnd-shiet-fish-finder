/**
 * Fishing guide — weather-aware bait/lure/technique recommendations.
 * Uses Open-Meteo API (free, no key) for current weather conditions.
 */

// ===== Weather via Open-Meteo =====

let weatherCache = null; // { lat, lon, data, timestamp }
const WEATHER_TTL = 30 * 60 * 1000; // 30 min

async function fetchWeather(lat, lon) {
  // Check cache (same general area + not stale)
  if (weatherCache &&
    Math.abs(weatherCache.lat - lat) < 0.1 &&
    Math.abs(weatherCache.lon - lon) < 0.1 &&
    Date.now() - weatherCache.timestamp < WEATHER_TTL) {
    return weatherCache.data;
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation', 'rain', 'weather_code', 'cloud_cover',
      'pressure_msl', 'surface_pressure', 'wind_speed_10m',
      'wind_direction_10m', 'wind_gusts_10m',
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/New_York',
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);

  const json = await res.json();
  const c = json.current;

  const weather = {
    temp: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precipitation: c.precipitation,
    cloudCover: c.cloud_cover,
    pressureMsl: c.pressure_msl,
    surfacePressure: c.surface_pressure,
    windSpeed: c.wind_speed_10m,
    windGusts: c.wind_gusts_10m,
    windDir: c.wind_direction_10m,
    weatherCode: c.weather_code,
    time: c.time,
  };

  // Derive fishing-relevant conditions
  weather.pressureTrend = getPressureTrend(weather.pressureMsl);
  weather.conditions = describeWeatherCode(weather.weatherCode);
  weather.fishActivity = rateFishActivity(weather);

  weatherCache = { lat, lon, data: weather, timestamp: Date.now() };
  return weather;
}

function describeWeatherCode(code) {
  const codes = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
  };
  return codes[code] || 'Unknown';
}

// Simplified pressure trend (without history, just rate current level)
function getPressureTrend(msl) {
  if (msl > 1022) return 'high';
  if (msl > 1013) return 'stable';
  if (msl > 1005) return 'falling';
  return 'low';
}

// General fish activity rating based on weather
function rateFishActivity(w) {
  let score = 50; // baseline

  // Barometric pressure — stable/slowly falling is best
  if (w.pressureTrend === 'stable') score += 15;
  else if (w.pressureTrend === 'falling') score += 10;
  else if (w.pressureTrend === 'high') score -= 5;
  else score -= 10; // low pressure

  // Cloud cover — overcast is generally better
  if (w.cloudCover > 70) score += 15;
  else if (w.cloudCover > 40) score += 10;
  else score -= 5; // bright sun

  // Wind — light wind stirs things up, too much shuts it down
  if (w.windSpeed >= 5 && w.windSpeed <= 15) score += 10;
  else if (w.windSpeed > 20) score -= 15;

  // Light rain is great, heavy rain not so much
  if (w.precipitation > 0 && w.precipitation < 0.1) score += 10;
  else if (w.precipitation > 0.3) score -= 10;

  // Temperature sweet spots (air temp as proxy)
  if (w.temp >= 55 && w.temp <= 80) score += 10;
  else if (w.temp < 40 || w.temp > 95) score -= 15;

  // Thunderstorms — dangerous + fish go deep
  if (w.weatherCode >= 95) score -= 25;

  return Math.max(0, Math.min(100, score));
}


// ===== Species Tackle Recommendations =====
// Returns { lures, baits, techniques, tips } based on species + weather

const SPECIES_DATA = {
  'Largemouth Bass': {
    lures: {
      cold: ['Jerkbait', 'Ned Rig', 'Blade Bait', 'Suspending Minnow'],
      mild: ['Spinnerbait', 'Crankbait', 'Jig & Trailer', 'Soft Plastic Worm', 'Chatterbait'],
      warm: ['Topwater Frog', 'Buzzbait', 'Plastic Worm (Texas Rig)', 'Swim Jig', 'Popper'],
      hot: ['Deep Diving Crankbait', 'Carolina Rig', 'Football Jig', 'Drop Shot'],
    },
    baits: ['Nightcrawlers', 'Shiners', 'Crawfish', 'Minnows', 'Crickets'],
    depthTips: {
      cold: 'Fish slow near bottom in 15-25ft',
      mild: 'Work transition zones 5-15ft, near structure',
      warm: 'Early/late topwater, midday shade & docks',
      hot: 'Deep structure 15-30ft, early morning best',
    },
  },
  'Smallmouth Bass': {
    lures: {
      cold: ['Tube Jig', 'Hair Jig', 'Blade Bait', 'Jigging Spoon'],
      mild: ['Ned Rig', 'Grub', 'Inline Spinner', 'Jerkbait', 'Crankbait'],
      warm: ['Topwater Popper', 'Tube Bait', 'Crankbait', 'Swimbait', 'Drop Shot'],
      hot: ['Deep Crankbait', 'Drop Shot', 'Football Jig', 'Finesse Worm'],
    },
    baits: ['Crawfish', 'Hellgrammites', 'Minnows', 'Leeches', 'Nightcrawlers'],
    depthTips: {
      cold: 'Slow presentation near rocky bottom 15-25ft',
      mild: 'Rocky points & current breaks 5-15ft',
      warm: 'Current seams, riffles, shade pockets',
      hot: 'Deeper pools 15-25ft, fish early & late',
    },
  },
  'Striped Bass': {
    lures: {
      cold: ['Jigging Spoon', 'Bucktail Jig', 'Umbrella Rig', 'Blade Bait'],
      mild: ['Bucktail Jig', 'Swimbait', 'Rattletrap', 'Topwater Plug'],
      warm: ['Topwater Plug', 'Popper', 'Swimbait', 'Umbrella Rig'],
      hot: ['Deep Jigging Spoon', 'Live Bait Rig', 'Downline Rig', 'Umbrella Rig'],
    },
    baits: ['Live Shad', 'Cut Bait (Bunker)', 'Eels', 'Bloodworms', 'Spot'],
    depthTips: {
      cold: 'Find bait schools with electronics 20-40ft',
      mild: 'Follow baitfish, work points & ledges 10-25ft',
      warm: 'Dawn/dusk surface blitzes, midday deep',
      hot: 'Thermocline depth 25-45ft, trolling effective',
    },
  },
  'Channel Catfish': {
    lures: {
      cold: ['Jig tipped with bait'],
      mild: ['Jig tipped with bait'],
      warm: ['Jig tipped with bait'],
      hot: ['Jig tipped with bait'],
    },
    baits: ['Chicken Liver', 'Stink Bait', 'Nightcrawlers', 'Cut Shad', 'Hot Dogs', 'Punch Bait'],
    depthTips: {
      cold: 'Deep holes 15-30ft, slow presentation',
      mild: 'Channel edges, near structure 8-20ft',
      warm: 'Flats & channel edges, night fishing excellent',
      hot: 'Deep channels, night fishing best',
    },
  },
  'Bluegill': {
    lures: {
      cold: ['Small Jig (1/32oz)', 'Ice Fly', 'Tiny Grub'],
      mild: ['Small Spinner', 'Beetle Spin', 'Micro Jig', 'Small Popper'],
      warm: ['Popper', 'Spider', 'Beetle Spin', 'Fly (Woolly Bugger)'],
      hot: ['Small Jig under float', 'Tiny Crankbait', 'Fly (Nymph)'],
    },
    baits: ['Worms (pieces)', 'Crickets', 'Wax Worms', 'Bread Balls', 'Corn'],
    depthTips: {
      cold: 'Deeper water 10-15ft, very slow',
      mild: 'Beds near shore 2-6ft during spawn',
      warm: 'Shallow cover, docks, brush piles 3-8ft',
      hot: 'Shade & deeper brush 6-12ft',
    },
  },
  'Crappie': {
    lures: {
      cold: ['Small Tube Jig', 'Hair Jig (1/16oz)', 'Tiny Grub'],
      mild: ['Crappie Jig', 'Small Minnow Bait', 'Tube Jig', 'Bobby Garland'],
      warm: ['Jig under Bobber', 'Small Crankbait', 'Road Runner'],
      hot: ['Deep Jig', 'Spider Rig Jigs', 'Small Spoon'],
    },
    baits: ['Minnows', 'Wax Worms', 'Small Shiners', 'Crickets'],
    depthTips: {
      cold: 'Suspend near structure 15-25ft',
      mild: 'Brush piles & docks 5-12ft, spider rig effective',
      warm: 'Spawning flats 3-8ft, then transition to docks',
      hot: 'Deep brush piles 15-25ft, early morning shallower',
    },
  },
  'Walleye': {
    lures: {
      cold: ['Blade Bait', 'Jigging Rap', 'Hair Jig'],
      mild: ['Jig & Minnow', 'Crankbait', 'Spinner Rig (Crawler Harness)'],
      warm: ['Crankbait (trolling)', 'Spinner Rig', 'Swimbait', 'Jig & Leech'],
      hot: ['Deep Crankbait', 'Bottom Bouncer', 'Live Bait Rig'],
    },
    baits: ['Minnows', 'Nightcrawlers', 'Leeches'],
    depthTips: {
      cold: 'Rocky points 10-20ft, jig very slowly',
      mild: 'Gravel flats & points 8-18ft, dawn/dusk best',
      warm: 'Current areas, dam tailwaters, trolling flats',
      hot: 'Deep structure 20-35ft, night fishing on flats',
    },
  },
  'Muskie': {
    lures: {
      cold: ['Jerkbait (slow)', 'Large Sucker Rig', 'Glide Bait'],
      mild: ['Bucktail Spinner', 'Jerkbait', 'Crankbait', 'Topwater (late)'],
      warm: ['Topwater (walk-the-dog)', 'Large Bucktail', 'Bull Dawg', 'Jerkbait'],
      hot: ['Deep Crankbait', 'Large Swimbait', 'Rubber Bait (slow roll)'],
    },
    baits: ['Large Suckers (live)', 'Large Shiners'],
    depthTips: {
      cold: 'Slow down, work deep weed edges 15-25ft',
      mild: 'Weed lines, points, figure-8 at boat',
      warm: 'Weed flats, topwater early/late, figure-8',
      hot: 'Deeper structure 20-30ft, dawn/dusk windows',
    },
  },
  'Rainbow Trout': {
    lures: {
      cold: ['Small Spoon', 'Inline Spinner (slow)', 'Nymph Fly'],
      mild: ['Inline Spinner (Rooster Tail)', 'Small Spoon', 'Dry Fly', 'Nymph'],
      warm: ['Inline Spinner', 'Small Crankbait', 'Fly (Streamer)', 'Nymph'],
      hot: ['Deep Nymph', 'Small Spoon (deep)', 'Fly (early AM only)'],
    },
    baits: ['PowerBait', 'Nightcrawlers', 'Salmon Eggs', 'Corn', 'Wax Worms'],
    depthTips: {
      cold: 'Pools & slow runs 3-8ft, dead drift',
      mild: 'Riffles & runs, drift presentation',
      warm: 'Shade, deeper pools, early morning feedlines',
      hot: 'Deep pools only, early morning — trout stress above 68F water',
    },
  },
  'Brown Trout': {
    lures: {
      cold: ['Jerkbait', 'Small Spoon', 'Streamer Fly', 'Nymph'],
      mild: ['Inline Spinner', 'Rapala', 'Streamer', 'Soft Hackle Fly'],
      warm: ['Streamer (sculpin)', 'Crankbait', 'Inline Spinner', 'Mouse Fly (night)'],
      hot: ['Deep Nymph', 'Streamer (early AM)', 'Small Spoon'],
    },
    baits: ['Nightcrawlers', 'Minnows', 'Crawfish', 'Salmon Eggs'],
    depthTips: {
      cold: 'Slow & deep near undercuts & logjams',
      mild: 'Undercuts, deeper runs, structure-oriented',
      warm: 'Night fishing effective, work shaded structure',
      hot: 'Deep pools dawn only — browns need cool water',
    },
  },
  'Brook Trout': {
    lures: {
      cold: ['Tiny Spoon', 'Small Nymph', 'Micro Jig'],
      mild: ['Small Inline Spinner', 'Dry Fly (Elk Hair Caddis)', 'Nymph'],
      warm: ['Dry Fly', 'Tiny Spinner', 'Small Worm (1/32 jig)'],
      hot: ['Deep Nymph only — brookies need water under 65F'],
    },
    baits: ['Small Worms', 'Wax Worms', 'Single Salmon Egg'],
    depthTips: {
      cold: 'Plunge pools, behind rocks 2-5ft',
      mild: 'Pocket water, small pools, headwater streams',
      warm: 'Spring-fed areas, shaded headwaters only',
      hot: 'Find cold tributary inputs — brook trout are very heat-sensitive',
    },
  },
  'Shad': {
    lures: {
      cold: ['Shad Dart (1/4oz)', 'Small Spoon', 'Shad Rig'],
      mild: ['Shad Dart', 'Small Jig', 'Flutter Spoon', 'Fly (Clouser Minnow)'],
      warm: ['Shad Dart', 'Small Spinner', 'Fly (shad pattern)'],
      hot: ['Deep Dart', 'Jigging Spoon'],
    },
    baits: ['Shad Darts (artificial best)', 'Small grubs'],
    depthTips: {
      cold: 'Below dams, deep channels',
      mild: 'Spring runs — below dams & rapids on rivers',
      warm: 'River channels, follow the schools',
      hot: 'Deep schooling areas, early morning surface',
    },
  },
  'White Perch': {
    lures: {
      cold: ['Small Jig', 'Blade Bait', 'Tiny Spoon'],
      mild: ['Small Spinner', 'Beetle Spin', 'Crappie Jig'],
      warm: ['Small Popper', 'Beetle Spin', 'Inline Spinner'],
      hot: ['Small Jig under float', 'Deep Beetle Spin'],
    },
    baits: ['Bloodworms', 'Minnows', 'Nightcrawler pieces', 'Grass Shrimp'],
    depthTips: {
      cold: 'School up deep 15-25ft',
      mild: 'Tributaries & shallows for spawn run',
      warm: 'Docks, rip rap, shallow structure 3-10ft',
      hot: 'Deeper structure 10-20ft, shade areas',
    },
  },
  'Sunfish': {
    lures: {
      cold: ['Micro Jig', 'Ice Fly'],
      mild: ['Tiny Spinner', 'Beetle Spin', 'Small Popper'],
      warm: ['Small Popper', 'Spider', 'Micro Jig'],
      hot: ['Jig under float', 'Tiny Grub'],
    },
    baits: ['Worm pieces', 'Crickets', 'Bread', 'Wax Worms'],
    depthTips: {
      cold: 'Slow near bottom 8-12ft',
      mild: 'Shallow beds 2-5ft during spawn',
      warm: 'Shade, docks, brush 3-8ft',
      hot: 'Deeper shade 6-12ft',
    },
  },
  'Herring': {
    lures: {
      cold: ['Sabiki Rig', 'Small Spoon'],
      mild: ['Sabiki Rig', 'Small Shad Dart', 'Tiny Spoon'],
      warm: ['Sabiki Rig', 'Cast Net (for bait)'],
      hot: ['Sabiki Rig'],
    },
    baits: ['Small pieces of shrimp', 'Fishbites'],
    depthTips: {
      cold: 'Deep channels',
      mild: 'Spring spawning runs up rivers',
      warm: 'Mid-water schools',
      hot: 'Deep schools, early morning surface',
    },
  },
  'Rock Bass': {
    lures: {
      cold: ['Small Jig', 'Tiny Grub'],
      mild: ['Small Spinner', 'Grub', 'Tube Jig', 'Beetle Spin'],
      warm: ['Small Crankbait', 'Inline Spinner', 'Tube Jig'],
      hot: ['Small Jig near rocks', 'Grub'],
    },
    baits: ['Nightcrawlers', 'Minnows', 'Crawfish', 'Crickets'],
    depthTips: {
      cold: 'Rocky pools 6-12ft',
      mild: 'Rocky runs & pools 3-8ft',
      warm: 'Rocky shaded areas, undercuts',
      hot: 'Deeper rocky pools',
    },
  },
  'Creek Chub': {
    lures: {
      cold: ['Micro Jig'],
      mild: ['Tiny Spinner', 'Micro Jig', 'Small Fly'],
      warm: ['Small Spinner', 'Dry Fly'],
      hot: ['Micro Jig'],
    },
    baits: ['Small worm pieces', 'Bread', 'Corn'],
    depthTips: {
      cold: 'Deeper pools',
      mild: 'Riffles & runs',
      warm: 'Shallow runs, pools',
      hot: 'Shaded pools',
    },
  },
};

function getTempBracket(airTemp) {
  if (airTemp < 45) return 'cold';
  if (airTemp < 65) return 'mild';
  if (airTemp < 85) return 'warm';
  return 'hot';
}

function getRecommendation(species, weather) {
  const data = SPECIES_DATA[species];
  if (!data) return null;

  const bracket = getTempBracket(weather.temp);
  const lures = data.lures[bracket] || data.lures.mild;
  const depthTip = data.depthTips[bracket] || '';

  // Weather-specific tips
  const tips = [];

  if (weather.pressureTrend === 'falling') {
    tips.push('Falling barometer — fish tend to feed aggressively before a front');
  } else if (weather.pressureTrend === 'low') {
    tips.push('Low pressure — fish may be sluggish, slow your presentation');
  } else if (weather.pressureTrend === 'stable') {
    tips.push('Stable pressure — consistent bite likely');
  } else {
    tips.push('High pressure — fish may hold tight to cover, finesse approach');
  }

  if (weather.cloudCover > 70) {
    tips.push('Overcast skies — fish more willing to roam & chase, great conditions');
  } else if (weather.cloudCover < 20) {
    tips.push('Clear skies — target shade, cover, and deeper water');
  }

  if (weather.windSpeed >= 8 && weather.windSpeed <= 18) {
    tips.push(`Wind ${weather.windSpeed} mph — creates ripple that helps hide your line, fish windblown banks`);
  } else if (weather.windSpeed > 18) {
    tips.push(`Strong wind ${weather.windSpeed} mph — tough conditions, fish sheltered spots`);
  }

  if (weather.precipitation > 0 && weather.precipitation < 0.15) {
    tips.push('Light rain — excellent! Breaks surface tension, washes food in');
  } else if (weather.precipitation >= 0.15) {
    tips.push('Rain — muddy water likely, use brighter colors & rattling baits');
  }

  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 8) {
    tips.push('Early morning — prime feeding window');
  } else if (hour >= 17 && hour <= 20) {
    tips.push('Evening — fish moving shallow to feed');
  } else if (hour >= 11 && hour <= 14) {
    tips.push('Midday — fish often deeper or holding tight to structure');
  }

  return {
    species,
    bracket,
    lures,
    baits: data.baits,
    depthTip,
    tips,
    activity: weather.fishActivity,
  };
}

function getWeatherCardHtml(weather) {
  const activityColor = weather.fishActivity >= 70 ? '#2ecc71'
    : weather.fishActivity >= 45 ? '#f39c12'
    : '#e74c3c';
  const activityLabel = weather.fishActivity >= 70 ? 'Excellent'
    : weather.fishActivity >= 55 ? 'Good'
    : weather.fishActivity >= 40 ? 'Fair'
    : 'Poor';

  const windDirLabel = degToCompass(weather.windDir);

  return `
    <div class="detail-section">
      <h3>Current Weather</h3>
      <div class="data-grid">
        <div class="data-card">
          <div class="label">Temperature</div>
          <div class="value temp">${weather.temp}°F</div>
          <div style="font-size:0.65rem;color:var(--text-muted)">Feels ${weather.feelsLike}°F</div>
        </div>
        <div class="data-card">
          <div class="label">Fish Activity</div>
          <div class="value" style="color:${activityColor}">${weather.fishActivity}/100</div>
          <div style="font-size:0.65rem;color:${activityColor}">${activityLabel}</div>
        </div>
        <div class="data-card">
          <div class="label">Conditions</div>
          <div class="value" style="font-size:0.9rem">${weather.conditions}</div>
        </div>
        <div class="data-card">
          <div class="label">Wind</div>
          <div class="value" style="font-size:0.9rem">${weather.windSpeed} mph ${windDirLabel}</div>
          <div style="font-size:0.65rem;color:var(--text-muted)">Gusts ${weather.windGusts} mph</div>
        </div>
        <div class="data-card">
          <div class="label">Pressure</div>
          <div class="value" style="font-size:0.9rem">${weather.pressureMsl} mb</div>
          <div style="font-size:0.65rem;color:var(--text-muted)">${weather.pressureTrend}</div>
        </div>
        <div class="data-card">
          <div class="label">Cloud Cover</div>
          <div class="value" style="font-size:0.9rem">${weather.cloudCover}%</div>
        </div>
      </div>
    </div>
  `;
}

function getRecommendationHtml(rec) {
  return `
    <div class="detail-section tackle-rec">
      <h3>Recommended for ${rec.species}</h3>
      <div class="rec-subsection">
        <h4>Lures & Artificials</h4>
        <div class="rec-tags">
          ${rec.lures.map(l => `<span class="rec-tag lure-tag">${l}</span>`).join('')}
        </div>
      </div>
      <div class="rec-subsection">
        <h4>Live/Natural Bait</h4>
        <div class="rec-tags">
          ${rec.baits.map(b => `<span class="rec-tag bait-tag">${b}</span>`).join('')}
        </div>
      </div>
      <div class="rec-subsection">
        <h4>Depth & Approach</h4>
        <p class="rec-depth-tip">${rec.depthTip}</p>
      </div>
      <div class="rec-subsection">
        <h4>Conditions Tips</h4>
        <ul class="rec-tips">
          ${rec.tips.map(t => `<li>${t}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;
}

function degToCompass(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

export {
  fetchWeather,
  getRecommendation,
  getWeatherCardHtml,
  getRecommendationHtml,
  SPECIES_DATA,
};
