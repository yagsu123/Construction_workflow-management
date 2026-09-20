import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMetres, withinRadius, isValidLat, isValidLng, formatDistance } from '../src/geo.js';

const AHMEDABAD = [23.0225, 72.5714];
const MUMBAI = [19.0760, 72.8777];

test('haversine matches known reference distances', () => {
  // Published great-circle distance Ahmedabad–Mumbai is ~440 km.
  const km = haversineMetres(...AHMEDABAD, ...MUMBAI) / 1000;
  assert.ok(Math.abs(km - 440) < 5, `got ${km.toFixed(1)} km`);

  // One degree of latitude is ~111.2 km anywhere on the globe.
  assert.ok(Math.abs(haversineMetres(0, 0, 1, 0) / 1000 - 111.2) < 0.5);
  assert.ok(Math.abs(haversineMetres(45, 10, 46, 10) / 1000 - 111.2) < 0.5);

  // One degree of longitude shrinks with latitude: ~111 km at the equator, ~78.6 km at 45°.
  assert.ok(Math.abs(haversineMetres(0, 0, 0, 1) / 1000 - 111.3) < 0.5);
  assert.ok(Math.abs(haversineMetres(45, 0, 45, 1) / 1000 - 78.6) < 0.5);
});

test('identical points are zero, and the function is symmetric', () => {
  assert.equal(haversineMetres(...AHMEDABAD, ...AHMEDABAD), 0);
  assert.equal(
    Math.round(haversineMetres(...AHMEDABAD, ...MUMBAI)),
    Math.round(haversineMetres(...MUMBAI, ...AHMEDABAD)),
  );
});

test('the antimeridian is crossed the short way, not the long way', () => {
  // 0.002° apart across the date line — must be ~222 m, not ~40,000 km.
  const m = haversineMetres(0, 179.999, 0, -179.999);
  assert.ok(m > 200 && m < 250, `got ${m} m`);
});

test('poles do not blow up', () => {
  assert.ok(Number.isFinite(haversineMetres(90, 0, -90, 0)));
  assert.ok(Math.abs(haversineMetres(90, 0, -90, 0) / 1000 - 20015) < 20, 'half the circumference');
  assert.equal(Math.round(haversineMetres(90, 0, 90, 180)), 0, 'all longitudes meet at the pole');
});

test('withinRadius decides inclusion at the boundary', () => {
  const site = { lat: 23.0225, lng: 72.5714 };
  // ~0.0009° of latitude is ~100 m.
  const near = { lat: 23.0234, lng: 72.5714 };
  const far = { lat: 23.0325, lng: 72.5714 };          // ~1.1 km

  const a = withinRadius(near, site, 250);
  assert.equal(a.inside, true);
  assert.ok(a.distance_m > 80 && a.distance_m < 120, `got ${a.distance_m} m`);

  const b = withinRadius(far, site, 250);
  assert.equal(b.inside, false);
  assert.ok(b.distance_m > 1000);

  assert.equal(withinRadius(site, site, 0).inside, true, 'zero distance is inside a zero radius');
});

test('coordinate validation rejects out-of-range and non-numeric input', () => {
  assert.ok(isValidLat(0) && isValidLat(90) && isValidLat(-90) && isValidLat('23.5'));
  assert.ok(!isValidLat(91) && !isValidLat(-91) && !isValidLat('north'));
  assert.ok(!isValidLat(NaN) && !isValidLat(Infinity));
  // Number(null), Number('') and Number(false) are all 0 — none of these may pass as "0°".
  assert.ok(!isValidLat(null) && !isValidLat(undefined) && !isValidLat('') && !isValidLat(false));
  assert.ok(!isValidLat([]) && !isValidLat({}));

  assert.ok(isValidLng(180) && isValidLng(-180));
  assert.ok(!isValidLng(181) && !isValidLng('east'));
});

test('distances are formatted for humans', () => {
  assert.equal(formatDistance(340), '340 m');
  assert.equal(formatDistance(1200), '1.2 km');
});
