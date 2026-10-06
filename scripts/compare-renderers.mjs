// compare-renderers.mjs – BSP+solidsegs vs brute force: same pixels? how fast?
//   node scripts/compare-renderers.mjs [MAP ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap, setRenderer } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://cmp', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const maps = process.argv.slice(2).length ? process.argv.slice(2) : wad.mapNames();

async function frame(bsp) {
  await setRenderer(db, bsp);
  const t = performance.now();
  const rows = (await db.query('SELECT col, line_id, depth FROM frame_walls', [], { rowMode: 'array' })).rows;
  return { ms: performance.now() - t, keys: new Set(rows.map((r) => `${r[0]}:${r[1]}`)), n: rows.length };
}

let worst = 1;
const tot = { bsp: 0, brute: 0 };
for (const name of maps) {
  await loadMap(db, wad, res, name);
  const things = (await db.query("SELECT FIRST 6 x, y FROM things WHERE kind IN ('monster', 'item') ORDER BY id")).rows;
  const spots = [null, ...things];
  for (const spot of spots) {
    if (spot) await db.exec(`UPDATE things t SET x = ${spot.X + 1}, y = ${spot.Y + 1} WHERE t.kind = 'player'`);
    await db.exec(`UPDATE things t SET sector_id = sector_at(t.x, t.y) WHERE t.kind = 'player'`);
    await db.exec(`UPDATE player p SET view_z = (SELECT s.floor_h + 41 FROM things t JOIN sectors s ON s.id = t.sector_id WHERE t.id = p.thing_id)`);
    for (let a = 0; a < 4; a++) {
      await db.exec(`UPDATE things t SET angle = ${(a * Math.PI) / 2 + 0.3} WHERE t.kind = 'player'`);
      const b = await frame(true);
      const f = await frame(false);
      tot.bsp += b.ms;
      tot.brute += f.ms;
      let same = 0;
      for (const k of f.keys) if (b.keys.has(k)) same++;
      const agree = same / Math.max(f.keys.size, b.keys.size, 1);
      worst = Math.min(worst, agree);
      if (agree < 0.99) console.log(`  ${name} spot ${spots.indexOf(spot)} heading ${a}: agreement ${(agree * 100).toFixed(1)}% (bsp ${b.n}, brute ${f.n})`);
    }
  }
  console.log(`${name}: bsp ${tot.bsp.toFixed(0)} ms vs brute ${tot.brute.toFixed(0)} ms cumulative`);
}
console.log(`worst agreement ${(worst * 100).toFixed(2)}%, speed-up ${(tot.brute / tot.bsp).toFixed(2)}×`);
process.exit(worst >= 0.98 ? 0 : 1);
