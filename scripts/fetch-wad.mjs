// fetch-wad.mjs – download Freedoom (BSD-licensed), extract freedoom1.wad and
// freedoom2.wad, and strip what this port never uses (PC-speaker sounds,
// demos) so the page downloads less.
//
//   node scripts/fetch-wad.mjs [--from path/to/freedoom-x.zip]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const VERSION = '0.13.0';
const URL_ZIP = `https://github.com/freedoom/freedoom/releases/download/v${VERSION}/freedoom-${VERSION}.zip`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/wads');

/** Pull one file out of a zip using only zlib (central directory walk). */
function unzipOne(zip, suffix) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen));
    if (name.endsWith(suffix)) {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = zip.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${suffix} not found in zip`);
}

/** Rewrite a WAD without PC-speaker sounds (DP*), demos or the GUS patch maps. */
function slim(wad) {
  const dv = new DataView(wad.buffer, wad.byteOffset, wad.byteLength);
  const n = dv.getInt32(4, true);
  const dir = dv.getInt32(8, true);
  const keep = [];
  let inGraphics = false; // never touch lumps inside S_/P_/F_ marker ranges
  for (let i = 0; i < n; i++) {
    const o = dir + i * 16;
    const pos = dv.getInt32(o, true);
    const size = dv.getInt32(o + 4, true);
    const name = new TextDecoder().decode(wad.subarray(o + 8, o + 16)).replace(/\0.*$/, '');
    if (/^(S|SS|P|PP|F|FF)_START$/.test(name)) inGraphics = true;
    if (/^(S|SS|P|PP|F|FF)_END$/.test(name)) inGraphics = false;
    if (!inGraphics && /^DP/.test(name) && size > 0) continue;
    if (/^(DEMO\d|DMXGUS|DMXGUSC)$/.test(name)) continue;
    keep.push({ name, data: wad.subarray(pos, pos + size) });
  }
  const body = keep.reduce((s, l) => s + l.data.length, 0);
  const out = Buffer.alloc(12 + body + keep.length * 16);
  wad.copy(out, 0, 0, 4);
  out.writeInt32LE(keep.length, 4);
  out.writeInt32LE(12 + body, 8);
  let p = 12;
  let d = 12 + body;
  for (const l of keep) {
    out.writeInt32LE(p, d);
    out.writeInt32LE(l.data.length, d + 4);
    out.write(l.name.padEnd(8, '\0'), d + 8, 8, 'latin1');
    Buffer.from(l.data).copy(out, p);
    p += l.data.length;
    d += 16;
  }
  return out;
}

const fromIdx = process.argv.indexOf('--from');
let zip;
if (fromIdx > 0) {
  zip = fs.readFileSync(process.argv[fromIdx + 1]);
} else {
  console.log(`downloading ${URL_ZIP}`);
  const resp = await fetch(URL_ZIP);
  if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
  zip = Buffer.from(await resp.arrayBuffer());
}
fs.mkdirSync(outDir, { recursive: true });
// Phase 1 is the DOOM-style game (episodes E1–E4); Phase 2 the DOOM II-style
// one (MAP01–MAP32, with the super shotgun and DOOM II's monsters).
for (const name of ['freedoom1.wad', 'freedoom2.wad']) {
  const wad = unzipOne(zip, name);
  const small = slim(wad);
  fs.writeFileSync(path.join(outDir, name), small);
  console.log(`public/wads/${name}: ${(wad.length / 1e6).toFixed(1)} MB → ${(small.length / 1e6).toFixed(1)} MB`);
}
// Freedoom's licence (BSD-3-Clause) travels with the WADs and with the story
// text the build derives from them (wads/freedoom-strings.json)
fs.writeFileSync(path.join(outDir, 'FREEDOOM-COPYING.txt'), unzipOne(zip, 'COPYING.txt'));
console.log('public/wads/FREEDOOM-COPYING.txt');
