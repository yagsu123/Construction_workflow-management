import test from 'node:test';
import assert from 'node:assert/strict';
import { readExif } from '../src/exif.js';
import { makeJpegWithExif, makeJpegWithoutExif } from './fixtures/jpeg.js';

test('GPS and capture time are read in both TIFF byte orders', () => {
  for (const endian of ['II', 'MM']) {
    const r = readExif(makeJpegWithExif({
      lat: 23.0225, lng: 72.5714, takenAt: '2026:09:20 14:05:33', endian,
    }));
    assert.equal(r.present, true, endian);
    assert.ok(Math.abs(r.lat - 23.0225) < 1e-4, `${endian} lat ${r.lat}`);
    assert.ok(Math.abs(r.lng - 72.5714) < 1e-4, `${endian} lng ${r.lng}`);
    assert.equal(r.taken_at, '2026-09-20T14:05:33.000Z');
    assert.equal(r.make, 'DemoPhone');
  }
});

test('southern and western hemispheres come back negative', () => {
  const r = readExif(makeJpegWithExif({ lat: -33.8688, lng: -70.6693, takenAt: '2026:01:02 03:04:05' }));
  assert.ok(r.lat < 0 && Math.abs(r.lat + 33.8688) < 1e-4);
  assert.ok(r.lng < 0 && Math.abs(r.lng + 70.6693) < 1e-4);
});

test('a JPEG with no EXIF reports absence, not failure', () => {
  const r = readExif(makeJpegWithoutExif());
  assert.equal(r.present, false);
  assert.equal(r.lat, null);
  assert.equal(r.taken_at, null);
});

test('EXIF with a time but no GPS is still usable', () => {
  const r = readExif(makeJpegWithExif({ takenAt: '2026:09:20 09:00:00' }));
  assert.equal(r.present, true, 'a capture time alone counts as present');
  assert.equal(r.lat, null);
  assert.equal(r.taken_at, '2026-09-20T09:00:00.000Z');
});

test('malformed input never throws — it reports no EXIF', () => {
  const cases = [
    Buffer.alloc(0),
    Buffer.from('not a jpeg at all'),
    Buffer.from([0xff, 0xd8]),                              // SOI then nothing
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]),      // APP1 with no payload
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]), // length past the end
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x58, 0x58, 0x2a, 0]), // bad byte order
  ];
  for (const [i, buf] of cases.entries()) {
    const r = readExif(buf);
    assert.equal(r.present, false, `case ${i}`);
    assert.equal(r.lat, null, `case ${i}`);
  }
});

test('a truncated EXIF block does not read past the buffer', () => {
  const full = makeJpegWithExif({ lat: 23.0225, lng: 72.5714, takenAt: '2026:09:20 14:05:33' });
  for (let cut = 12; cut < full.length; cut += 7) {
    const r = readExif(full.slice(0, cut));          // must not throw at any truncation point
    assert.ok(r.present === true || r.present === false);
  }
});

test('offsets pointing outside the TIFF block are ignored', () => {
  const buf = makeJpegWithExif({ lat: 23.0225, lng: 72.5714, takenAt: '2026:09:20 14:05:33' });
  // Corrupt the IFD0 offset in the TIFF header to point far past the end.
  const tiffStart = buf.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6;
  buf.writeUInt32LE(0x7fffffff, tiffStart + 4);
  const r = readExif(buf);
  assert.equal(r.lat, null);
  assert.equal(r.present, false);
});
