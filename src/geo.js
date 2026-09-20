// Geodesy. Pure functions, no dependencies, no I/O.

const R_EARTH_M = 6_371_008.8;          // IUGG mean Earth radius
const rad = deg => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres between two WGS-84 points.
 *
 * Haversine rather than equirectangular: at PWD scale the difference is small, but haversine
 * stays correct near the poles and across the antimeridian, and costs nothing here. It ignores
 * the Earth's flattening (~0.3% worst case), which is far inside any geofence radius we use.
 */
export function haversineMetres(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Number(null), Number('') and Number(false) are all 0, which would sail through a naive
// range check as the equator. A missing coordinate must fail, not default to Null Island.
function numeric(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isValidLat(v) {
  const n = numeric(v);
  return n !== null && n >= -90 && n <= 90;
}

export function isValidLng(v) {
  const n = numeric(v);
  return n !== null && n >= -180 && n <= 180;
}

/**
 * Is `point` inside the circle of `radiusM` around `centre`?
 * @returns {{inside:boolean, distance_m:number, radius_m:number}}
 */
export function withinRadius({ lat, lng }, { lat: cLat, lng: cLng }, radiusM) {
  const distance_m = Math.round(haversineMetres(lat, lng, cLat, cLng));
  return { inside: distance_m <= radiusM, distance_m, radius_m: radiusM };
}

/** "1.2 km" / "340 m" — for messages people read. */
export function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
