import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { verifyChain } from '../src/ledger.js';
import { createProject, recordMeasurement, verifyPhotoAgainstClaim } from '../src/workflow.js';
import { readExif } from '../src/exif.js';
import { makeJpegWithExif, makeJpegWithoutExif } from './fixtures/jpeg.js';

const SITE = { lat: 23.0225, lng: 72.5714 };          // registered site
const NEARBY = { lat: 23.0234, lng: 72.5714 };        // ~100 m away
const NEXT_TOWN = { lat: 23.2156, lng: 72.6341 };     // ~22 km away
const NOW = new Date('2026-09-20T15:00:00.000Z');
const RECENT = '2026:09:20 14:05:33';

function dbWithSite(radius = 250) {
  const db = openDb(':memory:');
  createProject(db, {
    title: 'Widening of SH-41', budget: 24500000, department: 'PWD (Roads)',
    site_lat: SITE.lat, site_lng: SITE.lng, site_radius_m: radius,
  });
  return db;
}

const submit = (db, at, exif, over = {}) => recordMeasurement(db, {
  projectId: 1, role: 'JE', photo_url: '/uploads/x.jpg', photo_sha256: 'a'.repeat(64),
  lat: at.lat, lng: at.lng, note: 'chainage 12.4 km', exif, ...over,
}, NOW);

const exifAt = (p, takenAt = RECENT) =>
  readExif(makeJpegWithExif({ lat: p.lat, lng: p.lng, takenAt }));

// --- the geofence -----------------------------------------------------------------------------

test('an entry recorded on site is accepted and records its distance', () => {
  const db = dbWithSite();
  const r = submit(db, NEARBY, exifAt(NEARBY));
  assert.equal(r.verification.verdict, 'EXIF_CONFIRMED');
  assert.ok(r.distance_m > 80 && r.distance_m < 120, `${r.distance_m} m`);
  assert.equal(verifyChain(db).valid, true);
});

test('THE FRAUD THIS STOPS: an entry filed from 22 km away is refused', () => {
  const db = dbWithSite();
  assert.throws(() => submit(db, NEXT_TOWN, exifAt(NEXT_TOWN)),
    /from the registered site .* can only be recorded on site/s);
  assert.equal(verifyChain(db).length, 0, 'nothing reaches the ledger');
});

test('the refusal names the distance, so it can be disputed', () => {
  const db = dbWithSite();
  try { submit(db, NEXT_TOWN, exifAt(NEXT_TOWN)); assert.fail('should have thrown'); }
  catch (e) { assert.match(e.message, /2[0-9]\.[0-9] km/); assert.match(e.message, /250 m/); }
});

test('the radius is per project', () => {
  const wide = dbWithSite(30000);
  assert.ok(submit(wide, NEXT_TOWN, exifAt(NEXT_TOWN)).entry.seq === 1, '22 km is inside a 30 km fence');
});

test('a project with no registered site has no fence — and says so by recording no distance', () => {
  const db = openDb(':memory:');
  createProject(db, { title: 'Unmapped work', budget: 100000, department: 'PWD' });
  const r = submit(db, NEXT_TOWN, exifAt(NEXT_TOWN));
  assert.equal(r.distance_m, null);
  assert.equal(r.entry.seq, 1);
});

test('half-specified site coordinates are rejected rather than silently disabling the fence', () => {
  const db = openDb(':memory:');
  assert.throws(() => createProject(db, {
    title: 'X', budget: 1, department: 'PWD', site_lat: 200, site_lng: 72.5,
  }), /Site coordinates are out of range/);
});

// --- the photo's own account of itself --------------------------------------------------------

test('a photo whose EXIF GPS contradicts the claim is refused', () => {
  const db = dbWithSite();
  // Standing on site, but uploading a photo taken in the next town.
  assert.throws(() => submit(db, NEARBY, exifAt(NEXT_TOWN)),
    /photo's own GPS is .* from the location reported by this device/);
});

test('a photo with no EXIF is accepted but permanently marked UNVERIFIED', () => {
  const db = dbWithSite();
  const r = submit(db, NEARBY, readExif(makeJpegWithoutExif()));
  assert.equal(r.verification.verdict, 'UNVERIFIED');
  assert.equal(r.verification.exif_lat, null);

  const row = db.prepare('SELECT * FROM measurements WHERE seq = 1').get();
  assert.equal(row.photo_verified, 'UNVERIFIED');
});

test('the verdict is inside the hash — it cannot be upgraded afterwards', () => {
  const db = dbWithSite();
  submit(db, NEARBY, readExif(makeJpegWithoutExif()));
  assert.equal(verifyChain(db).valid, true);

  db.prepare(`UPDATE measurements SET photo_verified = 'EXIF_CONFIRMED' WHERE seq = 1`).run();

  const r = verifyChain(db);
  assert.equal(r.valid, false, 'laundering UNVERIFIED into CONFIRMED must break the chain');
  assert.ok(r.breaks[0].reasons.includes('ALTERED_PAYLOAD'));
});

test('a stale photo is refused', () => {
  const db = dbWithSite();
  assert.throws(() => submit(db, NEARBY, exifAt(NEARBY, '2026:08:01 09:00:00')),
    /taken .* day\(s\) ago/);
});

test('a photo with a capture time in the future is refused', () => {
  const db = dbWithSite();
  assert.throws(() => submit(db, NEARBY, exifAt(NEARBY, '2027:01:01 09:00:00')),
    /capture time in the future/);
});

test('GPS drift within tolerance is accepted', () => {
  const db = dbWithSite();
  // ~100 m of drift between the device fix and the photo's own GPS.
  const drifted = { lat: NEARBY.lat + 0.0009, lng: NEARBY.lng };
  const r = submit(db, NEARBY, exifAt(drifted));
  assert.equal(r.verification.verdict, 'EXIF_CONFIRMED');
  assert.ok(r.verification.drift_m < 200);
});

test('verifyPhotoAgainstClaim is pure and testable on its own', () => {
  const ok = verifyPhotoAgainstClaim(exifAt(SITE), SITE, NOW);
  assert.equal(ok.verdict, 'EXIF_CONFIRMED');
  assert.equal(ok.drift_m, 0);

  assert.equal(verifyPhotoAgainstClaim(null, SITE, NOW).verdict, 'UNVERIFIED');
  assert.equal(verifyPhotoAgainstClaim({ present: false }, SITE, NOW).verdict, 'UNVERIFIED');
});
