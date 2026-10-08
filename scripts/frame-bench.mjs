// frame-bench.mjs – what a frame costs in Firebird: FRAME_WALLS, FRAME_SPRITES,
// FRAME_SECTORS and DOOM_TIC, from a spread of viewpoints on each map.
//   node scripts/frame-bench.mjs [MAP ...]          (WAD= picks the WAD, VIEWS= how many spots)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://fbench', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const maps = process.argv.slice(2).length ? process.argv.slice(2) : wad.mapNames().slice(0, 4);
const views = Number(process.env.VIEWS ?? 8);
const arr = { rowMode: 'array' };

const time = async (q) => {
  const t0 = performance.now();
  const r = await db.query(q, [], arr);
  return [performance.now() - t0, r.rows.length];
};

const total = { walls: 0, sprites: 0, sectors: 0, tic: 0, n: 0, rows: 0 };
for (const name of maps) {
  await loadMap(db, wad, res, name, { skill: 4 });
  await db.exec("UPDATE things SET st = 'chase', reaction = 99 WHERE kind = 'monster'");   // (all awake)
  await db.exec('UPDATE player SET health = 100000');
  // viewpoints: the start, then the middle of the biggest subsectors, each looking four ways
  const spots = (await db.query(`SELECT FIRST ${views} AVG(sg.x1) x, AVG(sg.y1) y, MIN(ss.sector_id) s
      FROM ssectors ss JOIN segs sg ON sg.id BETWEEN ss.first_seg AND ss.first_seg + ss.seg_count - 1
      GROUP BY ss.id ORDER BY COUNT(*) DESC, ss.id`)).rows;
  const m = { walls: 0, sprites: 0, sectors: 0, tic: 0, n: 0, rows: 0, worst: 0 };
  for (const s of spots) {
    for (const a of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      await db.exec(`UPDATE things SET x = ${s.X}, y = ${s.Y}, angle = ${a}, sector_id = sector_at(${s.X}, ${s.Y}),
          z = (SELECT floor_h FROM sectors WHERE id = sector_at(${s.X}, ${s.Y})) WHERE kind = 'player'`);
      const [tTic] = await time('SELECT * FROM doom_tic(1, 0, 0, 0, 0, 0, 0, 0)');
      const [tw, rows] = await time('SELECT * FROM frame_walls');
      const [ts] = await time('SELECT * FROM frame_sprites');
      const [tsec] = await time('SELECT * FROM frame_sectors');
      m.walls += tw; m.sprites += ts; m.sectors += tsec; m.tic += tTic; m.n++; m.rows += rows;
      m.worst = Math.max(m.worst, tw);
    }
  }
  console.log(`${name.padEnd(6)} frame_walls ${(m.walls / m.n).toFixed(1).padStart(6)} ms (worst ${m.worst.toFixed(0)}, ${(m.rows / m.n).toFixed(0)} slices)`
    + `  sprites ${(m.sprites / m.n).toFixed(1).padStart(5)}  sectors ${(m.sectors / m.n).toFixed(1).padStart(5)}  tic ${(m.tic / m.n).toFixed(1).padStart(5)} ms`);
  for (const k of ['walls', 'sprites', 'sectors', 'tic', 'n', 'rows']) total[k] += m[k];
}
console.log(`all    frame_walls ${(total.walls / total.n).toFixed(1).padStart(6)} ms (${(total.rows / total.n).toFixed(0)} slices)  sprites ${(total.sprites / total.n).toFixed(1)}  sectors ${(total.sectors / total.n).toFixed(1)}  tic ${(total.tic / total.n).toFixed(1)} ms`);
await db.close();
process.exit(0);
