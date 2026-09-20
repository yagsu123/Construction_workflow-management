// Minimal EXIF reader — enough to answer "where and when was this photo taken?"
//
// Zero dependencies, so this walks the JPEG/TIFF structure directly:
//
//   JPEG  SOI(FFD8) → segments → APP1(FFE1) whose payload starts "Exif\0\0"
//   TIFF  byte order ("II" little / "MM" big) → 0x002A → offset of IFD0
//   IFD0  tag 0x8825 → GPS IFD, tag 0x8769 → Exif IFD
//   GPS   0x0001 LatRef 'N'/'S', 0x0002 Lat, 0x0003 LngRef 'E'/'W', 0x0004 Lng,
//         0x0007 TimeStamp, 0x001D DateStamp
//   Exif  0x9003 DateTimeOriginal
//
// Everything is bounds-checked: this parses attacker-supplied bytes, and a malformed offset
// must return null rather than throw or read past the buffer.

const TAG = {
  GPS_IFD: 0x8825, EXIF_IFD: 0x8769,
  GPS_LAT_REF: 0x0001, GPS_LAT: 0x0002, GPS_LNG_REF: 0x0003, GPS_LNG: 0x0004,
  GPS_TIME: 0x0007, GPS_DATE: 0x001d,
  DATETIME_ORIGINAL: 0x9003,
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Locate the TIFF block inside a JPEG's APP1 segment. */
function findExifTiff(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;   // not a JPEG
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;                       // out of sync
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null;    // image data begins; no EXIF
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker === 0xe1 && buf.slice(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      return buf.slice(i + 10, i + 2 + len);
    }
    i += 2 + len;
  }
  return null;
}

function reader(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.slice(0, 2).toString('latin1');
  const le = order === 'II';
  if (!le && order !== 'MM') return null;

  const u16 = o => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : null);
  const u32 = o => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : null);

  if (u16(2) !== 0x002a) return null;
  return { tiff, u16, u32, ifd0: u32(4) };
}

/** Read one IFD into a Map of tag -> {type, count, valueOffset}. */
function readIfd(r, offset, depth = 0) {
  const out = new Map();
  if (depth > 2 || offset == null || offset + 2 > r.tiff.length) return out;
  const count = r.u16(offset);
  if (count == null || count > 512) return out;             // sanity cap

  for (let n = 0; n < count; n++) {
    const e = offset + 2 + n * 12;
    if (e + 12 > r.tiff.length) break;
    const tag = r.u16(e), type = r.u16(e + 2), num = r.u32(e + 4);
    if (tag == null || type == null || num == null) break;

    const size = (TYPE_SIZE[type] ?? 0) * num;
    // Values of 4 bytes or fewer are stored inline in the entry itself.
    const valueOffset = size <= 4 ? e + 8 : r.u32(e + 8);
    if (valueOffset == null || valueOffset + size > r.tiff.length) continue;
    out.set(tag, { type, count: num, valueOffset });
  }
  return out;
}

function rationals(r, entry) {
  if (!entry || entry.type !== 5) return null;
  const out = [];
  for (let i = 0; i < entry.count; i++) {
    const o = entry.valueOffset + i * 8;
    const num = r.u32(o), den = r.u32(o + 4);
    if (num == null || den == null || den === 0) return null;
    out.push(num / den);
  }
  return out;
}

function ascii(r, entry) {
  if (!entry || entry.type !== 2) return null;
  return r.tiff.slice(entry.valueOffset, entry.valueOffset + entry.count)
    .toString('latin1').replace(/\0.*$/, '').trim() || null;
}

/** [degrees, minutes, seconds] + hemisphere -> signed decimal degrees. */
function dmsToDecimal(dms, ref) {
  if (!dms || dms.length < 3) return null;
  const [d, m, s] = dms;
  if (![d, m, s].every(Number.isFinite)) return null;
  const sign = /^[SW]$/i.test(String(ref ?? '')) ? -1 : 1;
  return sign * (d + m / 60 + s / 3600);
}

/** "2026:09:20 14:05:33" -> ISO, or null. EXIF has no timezone, so treat it as UTC. */
function exifDateToIso(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  const d = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract what we care about. Never throws.
 *
 * @returns {{present:boolean, lat:number|null, lng:number|null,
 *            taken_at:string|null, make:string|null, model:string|null}}
 */
export function readExif(buffer) {
  const empty = { present: false, lat: null, lng: null, taken_at: null, make: null, model: null };
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const tiff = findExifTiff(buf);
    if (!tiff) return empty;
    const r = reader(tiff);
    if (!r) return empty;

    const ifd0 = readIfd(r, r.ifd0);
    const gps = ifd0.has(TAG.GPS_IFD) ? readIfd(r, r.u32(ifd0.get(TAG.GPS_IFD).valueOffset), 1) : new Map();
    const exif = ifd0.has(TAG.EXIF_IFD) ? readIfd(r, r.u32(ifd0.get(TAG.EXIF_IFD).valueOffset), 1) : new Map();

    const lat = dmsToDecimal(rationals(r, gps.get(TAG.GPS_LAT)), ascii(r, gps.get(TAG.GPS_LAT_REF)));
    const lng = dmsToDecimal(rationals(r, gps.get(TAG.GPS_LNG)), ascii(r, gps.get(TAG.GPS_LNG_REF)));

    let taken_at = exifDateToIso(ascii(r, exif.get(TAG.DATETIME_ORIGINAL)));
    if (!taken_at) {
      // Fall back to the GPS clock, which is UTC by definition.
      const date = ascii(r, gps.get(TAG.GPS_DATE));
      const time = rationals(r, gps.get(TAG.GPS_TIME));
      if (date && time?.length >= 3) {
        const p = n => String(Math.floor(n)).padStart(2, '0');
        taken_at = exifDateToIso(`${date} ${p(time[0])}:${p(time[1])}:${p(time[2])}`);
      }
    }

    const hasLat = lat !== null && lat >= -90 && lat <= 90;
    const hasLng = lng !== null && lng >= -180 && lng <= 180;

    return {
      present: hasLat && hasLng ? true : Boolean(taken_at),
      lat: hasLat ? lat : null,
      lng: hasLng ? lng : null,
      taken_at,
      make: ascii(r, ifd0.get(0x010f)),
      model: ascii(r, ifd0.get(0x0110)),
    };
  } catch {
    return empty;       // malformed input is "no EXIF", never a crash
  }
}
