/**
 * Shared geographic utility functions.
 */

export function distanceMiles(lat1, lon1, lat2, lon2) {
  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return NaN;
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function milesToDegrees(miles, lat) {
  const latDeg = miles / 69.0; // 1 degree lat ~ 69 miles
  const lonDeg = miles / (69.0 * Math.cos(lat * Math.PI / 180));
  return { latDeg, lonDeg };
}

export function getBBox(lat, lon, radiusMiles) {
  const { latDeg, lonDeg } = milesToDegrees(radiusMiles, lat);
  return {
    south: lat - latDeg,
    north: lat + latDeg,
    west: lon - lonDeg,
    east: lon + lonDeg,
  };
}
