// Photo storage for e-MB entries.
//
// The browser downscales the photo to a JPEG and sends it as a base64 data URL, which keeps
// this zero-dependency: no multipart parser needed. The file is named after the SHA-256 of its
// own bytes, so identical photos deduplicate and the filename IS the content fingerprint.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * @param {string} dataUrl  e.g. "data:image/jpeg;base64,/9j/4AA..."
 * @returns {{url:string, sha256:string, bytes:number}}
 */
export function saveDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Photo must be a JPEG, PNG or WebP data URL');

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw new Error('Photo is empty');
  if (buf.length > MAX_BYTES) throw new Error(`Photo is larger than ${MAX_BYTES / 1024 / 1024} MB after compression`);

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const filename = sha256 + EXT[m[1]];

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const dest = path.join(UPLOAD_DIR, filename);

  // Dedup, but verify rather than assume. A file named after a hash is not necessarily a file
  // WITH that hash any more - if someone swapped the bytes on disk, re-uploading the genuine
  // photo must restore it, not silently adopt the tampered copy.
  let write = true;
  if (fs.existsSync(dest)) {
    const onDisk = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    write = onDisk !== sha256;
  }
  if (write) fs.writeFileSync(dest, buf);

  return { url: `/uploads/${filename}`, sha256, bytes: buf.length };
}

/** Re-hash the stored file — proves the image on disk is still the one that was signed. */
export function photoStillMatches(photoUrl, expectedSha256) {
  const file = path.join(UPLOAD_DIR, path.basename(photoUrl));
  if (!fs.existsSync(file)) return { present: false, matches: false };
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { present: true, matches: actual === expectedSha256, actual };
}
