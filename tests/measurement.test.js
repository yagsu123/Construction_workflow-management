import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.js';
import { verifyChain } from '../src/ledger.js';
import { recordMeasurement, act, WorkflowError } from '../src/workflow.js';
import { saveDataUrl, photoStillMatches, UPLOAD_DIR } from '../src/uploads.js';

// 1x1 px PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function freshDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO projects (code, title, budget, department, current_stage, stage_entered_at, created_at)
              VALUES ('P-1','Road', 100, 'PWD', 'DRAFT', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return db;
}
const mb = (over = {}) => ({ projectId: 1, role: 'JE', photo_url: '/uploads/x.png', photo_sha256: 'abc', lat: 23.0225, lng: 72.5714, note: 'pier 3', ...over });

test('saveDataUrl names the file after the hash of its own bytes', () => {
  const saved = saveDataUrl(PNG);
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.equal(saved.url, `/uploads/${saved.sha256}.png`);

  const onDisk = fs.readFileSync(path.join(UPLOAD_DIR, `${saved.sha256}.png`));
  assert.equal(createHash('sha256').update(onDisk).digest('hex'), saved.sha256);

  // identical photo deduplicates to the same file
  assert.equal(saveDataUrl(PNG).url, saved.url);
});

test('saveDataUrl rejects anything that is not an image data URL', () => {
  assert.throws(() => saveDataUrl('data:application/pdf;base64,AAAA'), /JPEG, PNG or WebP/);
  assert.throws(() => saveDataUrl('https://example.com/a.jpg'), /JPEG, PNG or WebP/);
  assert.throws(() => saveDataUrl(''), /JPEG, PNG or WebP/);
});

test('re-uploading a genuine photo repairs a file that was swapped on disk', () => {
  const first = saveDataUrl(PNG);
  const file = path.join(UPLOAD_DIR, path.basename(first.url));
  fs.writeFileSync(file, Buffer.from('a different photo entirely'));

  const again = saveDataUrl(PNG);
  assert.equal(again.sha256, first.sha256);
  assert.equal(photoStillMatches(again.url, again.sha256).matches, true,
    'dedup must verify the bytes, not just the filename');
});

test('photoStillMatches detects a swapped image file on disk', () => {
  const saved = saveDataUrl(PNG);
  assert.deepEqual(photoStillMatches(saved.url, saved.sha256), { present: true, matches: true, actual: saved.sha256 });

  const file = path.join(UPLOAD_DIR, path.basename(saved.url));
  fs.writeFileSync(file, Buffer.from('a different photo entirely'));
  const after = photoStillMatches(saved.url, saved.sha256);
  assert.equal(after.matches, false, 'swapping the file must be detected');
  saveDataUrl(PNG);   // restore, so a failed run cannot poison the next one

  assert.deepEqual(photoStillMatches('/uploads/missing.png', 'x'), { present: false, matches: false });
});

test('a measurement chains onto the same ledger as approvals', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  const { entry } = recordMeasurement(db, mb());
  assert.equal(entry.seq, 2);
  assert.equal(verifyChain(db).valid, true);
});

test('only the JE may record a measurement', () => {
  const db = freshDb();
  for (const role of ['AE', 'FIN', 'EE']) {
    assert.throws(() => recordMeasurement(db, mb({ role })), /Only the JE/);
  }
});

test('coordinates are validated', () => {
  const db = freshDb();
  assert.throws(() => recordMeasurement(db, mb({ lat: undefined })), /Latitude/);
  assert.throws(() => recordMeasurement(db, mb({ lat: 91 })), /Latitude/);
  assert.throws(() => recordMeasurement(db, mb({ lng: 181 })), /Longitude/);
  assert.throws(() => recordMeasurement(db, mb({ lat: 'north' })), /Latitude/);
});

test('a photo is required', () => {
  const db = freshDb();
  assert.throws(() => recordMeasurement(db, mb({ photo_url: '' })), /site photo is required/);
});

test('the measurement book closes once payment is triggered', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  act(db, { projectId: 1, role: 'AE', action: 'test_check' });
  act(db, { projectId: 1, role: 'FIN', action: 'verify' });
  act(db, { projectId: 1, role: 'EE', action: 'approve' });
  act(db, { projectId: 1, role: 'EE', action: 'trigger_payment' });
  assert.throws(() => recordMeasurement(db, mb()), /measurement book is closed/);
});

test('the photo hash is part of the ledger payload', () => {
  const db = freshDb();
  recordMeasurement(db, mb({ photo_sha256: 'a'.repeat(64) }));
  assert.equal(verifyChain(db).valid, true);

  // Point the record at a different photo without re-signing it.
  db.prepare(`UPDATE measurements SET photo_sha256 = ? WHERE seq = 1`).run('b'.repeat(64));
  const r = verifyChain(db);
  assert.equal(r.valid, false);
  assert.ok(r.breaks[0].reasons.includes('ALTERED_PAYLOAD'));
});
