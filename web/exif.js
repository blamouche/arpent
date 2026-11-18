// Écriture EXIF/GPS dans un JPEG, sans dépendance et sans recompression :
// on construit un segment APP1 « Exif » et on l'insère dans le fichier produit par le canvas.
// Balises lues par Panoramax : voir docs/API-PANORAMAX.md.

const ASCII = 2, BYTE = 1, LONG = 4, RATIONAL = 5, UNDEFINED = 7;

const enc = new TextEncoder();

function entry(tag, type, count, data) {
  return { tag, type, count, data };
}

function ascii(tag, s) {
  const bytes = [...enc.encode(s), 0];
  return entry(tag, ASCII, bytes.length, Uint8Array.from(bytes));
}

function bytes(tag, arr) {
  return entry(tag, BYTE, arr.length, Uint8Array.from(arr));
}

function undefinedBytes(tag, s) {
  const b = enc.encode(s);
  return entry(tag, UNDEFINED, b.length, b);
}

function long(tag, value) {
  const d = new Uint8Array(4);
  new DataView(d.buffer).setUint32(0, value);
  return entry(tag, LONG, 1, d);
}

/** pairs : [[numérateur, dénominateur], ...] */
function rationals(tag, pairs) {
  const d = new Uint8Array(pairs.length * 8);
  const v = new DataView(d.buffer);
  pairs.forEach(([n, den], i) => {
    v.setUint32(i * 8, Math.max(0, Math.round(n)));
    v.setUint32(i * 8 + 4, den);
  });
  return entry(tag, RATIONAL, pairs.length, d);
}

const rat = (value, den = 1000) => [Math.round(Math.abs(value) * den), den];

function dms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return [[d, 1], [m, 1], rat(s, 1_000_000)];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function localDate(d) {
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function offset(d) {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const a = Math.abs(minutes);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function ifdSize(entries) {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) if (e.data.length > 4) size += e.data.length + (e.data.length % 2);
  return size;
}

function writeIFD(buf, view, start, entries) {
  entries.sort((a, b) => a.tag - b.tag);
  view.setUint16(start, entries.length);
  let dataOffset = start + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = start + 2 + i * 12;
    view.setUint16(p, e.tag);
    view.setUint16(p + 2, e.type);
    view.setUint32(p + 4, e.count);
    if (e.data.length <= 4) {
      buf.set(e.data, p + 8);
    } else {
      view.setUint32(p + 8, dataOffset);
      buf.set(e.data, dataOffset);
      dataOffset += e.data.length + (e.data.length % 2);
    }
  });
  view.setUint32(start + 2 + entries.length * 12, 0); // pas d'IFD suivant
}

/**
 * info : { latitude, longitude, altitude?, accuracy?, heading?, headingRef?, speed? (m/s),
 *          course?, date: Date, make?, model?, software? }
 * Renvoie le segment APP1 complet (marqueur compris).
 */
export function buildExifSegment(info) {
  const d = info.date;
  const ms = pad(d.getMilliseconds(), 3);

  const ifd0 = [
    ascii(0x0131, info.software || 'Arpent Web'), // Software
  ];
  if (info.make) ifd0.push(ascii(0x010f, info.make));
  if (info.model) ifd0.push(ascii(0x0110, info.model));
  const exifPtr = long(0x8769, 0);
  const gpsPtr = long(0x8825, 0);
  ifd0.push(exifPtr, gpsPtr);

  const exif = [
    undefinedBytes(0x9000, '0232'),            // ExifVersion
    ascii(0x9003, localDate(d)),               // DateTimeOriginal
    ascii(0x9004, localDate(d)),               // DateTimeDigitized
    ascii(0x9011, offset(d)),                  // OffsetTimeOriginal
    ascii(0x9291, ms),                         // SubSecTimeOriginal
    ascii(0x9292, ms),                         // SubSecTimeDigitized
  ];

  const utcSeconds = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
  const gps = [
    bytes(0x0000, [2, 3, 0, 0]),
    ascii(0x0001, info.latitude >= 0 ? 'N' : 'S'),
    rationals(0x0002, dms(info.latitude)),
    ascii(0x0003, info.longitude >= 0 ? 'E' : 'W'),
    rationals(0x0004, dms(info.longitude)),
    rationals(0x0007, [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], rat(utcSeconds)]),
    ascii(0x001d, `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())}`),
  ];
  if (Number.isFinite(info.altitude)) {
    gps.push(bytes(0x0005, [info.altitude >= 0 ? 0 : 1]), rationals(0x0006, [rat(info.altitude)]));
  }
  if (Number.isFinite(info.speed) && info.speed >= 0) {
    gps.push(ascii(0x000c, 'K'), rationals(0x000d, [rat(info.speed * 3.6)]));
  }
  if (Number.isFinite(info.course) && info.course >= 0) {
    gps.push(ascii(0x000e, 'T'), rationals(0x000f, [rat(info.course)]));
  }
  if (Number.isFinite(info.heading)) {
    gps.push(ascii(0x0010, info.headingRef || 'M'), rationals(0x0011, [rat(info.heading)]));
  }
  if (Number.isFinite(info.accuracy) && info.accuracy >= 0) {
    gps.push(rationals(0x001f, [rat(info.accuracy)])); // GPSHPositioningError
  }

  // Mise en page : en-tête TIFF (8 octets), IFD0, IFD Exif, IFD GPS.
  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdSize(ifd0);
  const gpsOffset = exifOffset + ifdSize(exif);
  const tiffSize = gpsOffset + ifdSize(gps);
  new DataView(exifPtr.data.buffer).setUint32(0, exifOffset);
  new DataView(gpsPtr.data.buffer).setUint32(0, gpsOffset);

  const tiff = new Uint8Array(tiffSize);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a]); // « MM », big-endian
  view.setUint32(4, ifd0Offset);
  writeIFD(tiff, view, ifd0Offset, ifd0);
  writeIFD(tiff, view, exifOffset, exif);
  writeIFD(tiff, view, gpsOffset, gps);

  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // « Exif\0\0 »
  const length = 2 + header.length + tiff.length;
  const segment = new Uint8Array(2 + length);
  segment.set([0xff, 0xe1, length >> 8, length & 0xff]);
  segment.set(header, 4);
  segment.set(tiff, 4 + header.length);
  return segment;
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

/**
 * Segment APP1 XMP portant l'inclinaison (pitch : 0 horizon, +90 ciel) et le roulis (bras gauche
 * vers le bas = -90) de la caméra, en degrés, dans l'espace de noms GPano que lit Panoramax.
 * Sans GPano:ProjectionType, la photo reste considérée comme plate. null si rien à écrire.
 */
export function buildXmpSegment({ pitch = null, roll = null } = {}) {
  const attrs = [];
  if (Number.isFinite(pitch)) attrs.push(`GPano:PosePitchDegrees="${pitch.toFixed(1)}"`);
  if (Number.isFinite(roll)) attrs.push(`GPano:PoseRollDegrees="${roll.toFixed(1)}"`);
  if (!attrs.length) return null;
  const packet = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + `<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" ${attrs.join(' ')}/>`
    + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const body = enc.encode(XMP_HEADER + packet);
  const length = 2 + body.length;
  const segment = new Uint8Array(2 + length);
  segment.set([0xff, 0xe1, length >> 8, length & 0xff]);
  segment.set(body, 4);
  return segment;
}

/**
 * Insère les segments (EXIF, puis XMP éventuel) dans un JPEG (Blob) en retirant un éventuel EXIF
 * existant. Les segments null sont ignorés.
 */
export async function withExif(jpeg, ...segments) {
  const buf = new Uint8Array(await jpeg.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG invalide');

  const head = [];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) break; // début des données image
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const seg = buf.subarray(i, i + 2 + len);
    const isExif = marker === 0xe1 && seg[4] === 0x45 && seg[5] === 0x78 && seg[6] === 0x69 && seg[7] === 0x66;
    if (!isExif) head.push(seg);
    i += 2 + len;
  }
  // APP0 (JFIF) reste en tête s'il existe, l'EXIF le suit.
  const parts = [buf.subarray(0, 2)];
  if (head[0] && head[0][1] === 0xe0) parts.push(head.shift());
  parts.push(...segments.filter(Boolean), ...head, buf.subarray(i));
  return new Blob(parts, { type: 'image/jpeg' });
}
