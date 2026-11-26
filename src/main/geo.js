'use strict';
// Offline reverse geocoding: GPS coordinates -> "City", "Country".
// Uses a bundled GeoNames city list (CC BY 4.0) bucketed into a 1° grid.
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'cities.tsv');
let grid = null;
let regionNames = null;

function countryName(code) {
  if (!code) return null;
  try {
    if (!regionNames) regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function load() {
  if (grid) return grid;
  grid = new Map();
  const text = fs.readFileSync(DATA_FILE, 'utf8');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line) continue;
    const [name, cc, la, lo, pop] = line.split('\t');
    const lat = +la;
    const lon = +lo;
    const key = cellKey(lat, lon);
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push({ name, cc, lat, lon, pop: +pop });
  }
  return grid;
}

function cellKey(lat, lon) {
  return Math.floor(lat) * 1000 + Math.floor(lon);
}

// Great-circle distance in km.
function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @returns {{city: string, country: string, countryCode: string} | null}
 * Prefers a larger town within 12 km over the very nearest village so that
 * photos taken across one city group together.
 */
function reverseGeocode(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const g = load();
  const candidates = [];
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let x = lo + dx;
      if (x < -180) x += 360;
      if (x >= 180) x -= 360;
      const b = g.get((la + dy) * 1000 + x);
      if (b) for (const c of b) candidates.push(c);
    }
  }
  let nearest = null;
  let nearestD = Infinity;
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const d = distanceKm(lat, lon, c.lat, c.lon);
    if (d < nearestD) {
      nearestD = d;
      nearest = c;
    }
    if (d <= 12) {
      // Big places win unless much farther away.
      const score = Math.log10(c.pop + 10) - d / 4;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  const pick = best || (nearestD <= 60 ? nearest : null);
  if (!pick) {
    // Far from any town (sea, wilderness): fall back to the nearest country, if close-ish.
    if (nearest && nearestD <= 200) return { city: null, country: countryName(nearest.cc), countryCode: nearest.cc };
    return null;
  }
  return { city: pick.name, country: countryName(pick.cc), countryCode: pick.cc };
}

module.exports = { reverseGeocode, distanceKm, countryName };
