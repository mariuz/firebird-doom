// icons.mjs – the installed app's icons (public/manifest.webmanifest), made at build time from
// Freedoom's own art (BSD-3-Clause, as the WAD it's in; FREEDOOM-COPYING.txt ships beside it):
// the status bar's face looking ahead (STFST01), scaled up a whole number of times, no smoothing,
// on the page's background. Nothing of id's, and no picture kept in the repo.
import zlib from 'node:zlib';

const BG = [0x12, 0x0d, 0x0b];   // style.css's --bg

// the PNG writer: RGBA, 8 bits, one IDAT
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One icon SIZE square: the face at FILL of the side (a maskable icon keeps it in the safe zone) → RGBA */
export function iconPixels(wad, size, fill) {
  const face = wad.picture(wad.lump('STFST01'));
  const pal = wad.palette();
  const scale = Math.max(1, Math.floor((size * fill) / Math.max(face.w, face.h)));
  const ox = Math.floor((size - face.w * scale) / 2);
  const oy = Math.floor((size - face.h * scale) / 2);
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([...BG, 255], i * 4);
  for (let x = 0; x < face.w; x++) {
    for (let y = 0; y < face.h; y++) {
      const k = x * face.h + y;   // (column-major, as patches are)
      if (!face.alpha[k]) continue;
      const c = face.pix[k] * 3;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          px.set([pal[c], pal[c + 1], pal[c + 2], 255], ((oy + y * scale + dy) * size + ox + x * scale + dx) * 4);
        }
      }
    }
  }
  return px;
}

// the files the manifest and index.html name: [file, size, fill]
export const ICONS = [
  ['icons/icon-192.png', 192, 0.75], ['icons/icon-512.png', 512, 0.75],
  // (maskable: the platform may cut it to a circle – the face within the middle 80 %)
  ['icons/icon-maskable-512.png', 512, 0.55],
  ['icons/apple-touch-icon.png', 180, 0.7], ['icons/favicon-32.png', 32, 0.9],
];

/** every icon as PNG bytes: Map file → Buffer */
export function makeIcons(wad) {
  return new Map(ICONS.map(([file, size, fill]) => [file, encodePng(iconPixels(wad, size, fill), size, size)]));
}
