// wad-arg.mjs – the screen tests' WAD=: an IWAD of your own to check them
// against, never shipped. `WAD=/path/to/doom.wad npm run test:intermission`.
//
// Freedoom ships some of DOOM's screen graphics as empty 1×1 placeholders
// (WISPLAT, WIURH0/1, every WIA* animation), so those features can only be
// seen with id's WADs. Without WAD= the tests stand in for them by lending the
// placeholders a picture of Freedoom's own (lendPictures).
import fs from 'node:fs';
import path from 'node:path';
import { Wad } from '../src/wad.js';

/** The WAD named by WAD=, or null: { path, wad, doom2, idStyle (no DEHACKED: id's own layout) }. */
export function wadFromEnv() {
  const p = process.env.WAD;
  if (!p) return null;
  const file = path.resolve(p);
  if (!fs.existsSync(file)) throw new Error(`WAD=${p}: no such file`);
  const wad = new Wad(fs.readFileSync(file));
  const maps = wad.mapNames();
  return { path: file, name: path.basename(file), wad, doom2: maps.some((m) => m.startsWith('MAP')), idStyle: !wad.lump('DEHACKED') };
}

/** a lump that's only a placeholder: a picture of 1×1 (or nothing) */
export function placeholder(wad, name) {
  const l = wad.lump(name);
  if (!l) return true;
  if (l.size < 8) return true;
  const d = wad.data(l);
  return d[0] + d[1] * 256 <= 1 && d[2] + d[3] * 256 <= 1;
}

/** `base` with every lump `test` picks (and the WAD has) answered by the lump named `by`. */
export function lendPictures(base, test, by) {
  const w = Object.create(base);
  const stand = base.lump(by);
  w.lump = (n) => (test(n.toUpperCase()) && base.lump(n) ? stand : base.lump(n));
  return w;
}
