// Builds a real JPEG container with a real EXIF APP1 segment, so the parser is exercised
// against actual byte layout rather than a mock. Supports both TIFF byte orders.

function dms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = (a - d - m / 60) * 3600;
  return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
}

export function makeJpegWithExif({
  lat = null, lng = null, takenAt = null,      // takenAt: "YYYY:MM:DD HH:MM:SS"
  endian = 'II', make = 'DemoPhone', model = 'DP-1',
} = {}) {
  const le = endian === 'II';
  const u16 = v => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const u32 = v => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; };
  const str = s => Buffer.from(s + '\0', 'latin1');
  const rats = pairs => Buffer.concat(pairs.map(([n, d]) => Buffer.concat([u32(n), u32(d)])));

  const hasGps = lat !== null && lng !== null;

  // --- data blobs, placed after all IFDs -----------------------------------------------------
  const makeB = str(make), modelB = str(model);
  const latB = hasGps ? rats(dms(lat)) : Buffer.alloc(0);
  const lngB = hasGps ? rats(dms(lng)) : Buffer.alloc(0);
  const dateStampB = hasGps && takenAt ? str(takenAt.slice(0, 10)) : Buffer.alloc(0);
  const dtoB = takenAt ? str(takenAt) : Buffer.alloc(0);

  const ifd0Count = 2 + (hasGps ? 1 : 0) + (takenAt ? 1 : 0);
  const gpsCount = hasGps ? (dateStampB.length ? 5 : 4) : 0;
  const exifCount = takenAt ? 1 : 0;

  const ifd0At = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsAt = ifd0At + ifd0Size;
  const gpsSize = hasGps ? 2 + gpsCount * 12 + 4 : 0;
  const exifAt = gpsAt + gpsSize;
  const exifSize = exifCount ? 2 + exifCount * 12 + 4 : 0;

  let cursor = exifAt + exifSize;
  const place = b => { const at = cursor; cursor += b.length; return at; };
  const makeAt = place(makeB), modelAt = place(modelB);
  const latAt = place(latB), lngAt = place(lngB);
  const dateStampAt = place(dateStampB), dtoAt = place(dtoB);

  // An entry: tag, type, count, then either an inline value (<=4 bytes) or an offset.
  const entry = (tag, type, count, valueBuf, offset) => {
    const head = Buffer.concat([u16(tag), u16(type), u32(count)]);
    if (valueBuf) {
      const pad = Buffer.alloc(4);
      valueBuf.copy(pad, 0, 0, Math.min(4, valueBuf.length));
      return Buffer.concat([head, pad]);
    }
    return Buffer.concat([head, u32(offset)]);
  };

  const ifd0Entries = [
    entry(0x010f, 2, makeB.length, null, makeAt),
    entry(0x0110, 2, modelB.length, null, modelAt),
    ...(hasGps ? [entry(0x8825, 4, 1, null, gpsAt)] : []),
    ...(takenAt ? [entry(0x8769, 4, 1, null, exifAt)] : []),
  ];
  const ifd0 = Buffer.concat([u16(ifd0Count), ...ifd0Entries, u32(0)]);

  const gpsEntries = hasGps ? [
    entry(0x0001, 2, 2, Buffer.from((lat >= 0 ? 'N' : 'S') + '\0', 'latin1')),
    entry(0x0002, 5, 3, null, latAt),
    entry(0x0003, 2, 2, Buffer.from((lng >= 0 ? 'E' : 'W') + '\0', 'latin1')),
    entry(0x0004, 5, 3, null, lngAt),
    ...(dateStampB.length ? [entry(0x001d, 2, dateStampB.length, null, dateStampAt)] : []),
  ] : [];
  const gpsIfd = hasGps ? Buffer.concat([u16(gpsCount), ...gpsEntries, u32(0)]) : Buffer.alloc(0);

  const exifIfd = exifCount
    ? Buffer.concat([u16(1), entry(0x9003, 2, dtoB.length, null, dtoAt), u32(0)])
    : Buffer.alloc(0);

  const tiff = Buffer.concat([
    Buffer.from(endian, 'latin1'), u16(0x002a), u32(ifd0At),
    ifd0, gpsIfd, exifIfd,
    makeB, modelB, latB, lngB, dateStampB, dtoB,
  ]);

  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(app1Payload.length + 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),                       // SOI
    Buffer.from([0xff, 0xe1]), app1Len, app1Payload, // APP1 / EXIF
    Buffer.from([0xff, 0xdb]), Buffer.from([0x00, 0x04, 0x00, 0x00]),  // a stub DQT
    Buffer.from([0xff, 0xd9]),                       // EOI
  ]);
}

/** A valid JPEG with no EXIF at all. */
export function makeJpegWithoutExif() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xdb]), Buffer.from([0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
