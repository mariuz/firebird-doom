// sql-smoke.mjs – run the game's SQL against the real Firebird WASM engine
// in Node: load a WAD, play some tics, render frames, and assert on data.
//
//   WAD=path/to/freedoom1.wad node scripts/sql-smoke.mjs [MAP]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wadPath = process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad');
const mapName = process.argv[2] ?? 'E1M1';
const sql = Object.fromEntries(
  ['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]),
);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

const t = () => performance.now();
const db = new FirebirdBrowser('memory://doom', { transport: new DirectTransport() });

let t0 = t();
await createSchema(db, sql);
console.log(`schema        ${(t() - t0).toFixed(0)} ms`);

const wad = new Wad(fs.readFileSync(wadPath));
t0 = t();
const res = await loadResources(db, wad);
console.log(`resources     ${(t() - t0).toFixed(0)} ms (${res.texDefs.length} textures, ${res.flats.length} flats)`);

t0 = t();
await loadMap(db, wad, res, mapName);
console.log(`map ${mapName}     ${(t() - t0).toFixed(0)} ms`);

const counts = (await db.query(
  `SELECT (SELECT COUNT(*) FROM linedefs) l, (SELECT COUNT(*) FROM sectors) s,
          (SELECT COUNT(*) FROM things) t, (SELECT COUNT(*) FROM things WHERE kind = 'monster') m,
          (SELECT COUNT(*) FROM things WHERE sector_id IS NULL) nosec
     FROM rdb$database`,
)).rows[0];
console.log(counts);
assert(counts.L > 0 && counts.S > 0, 'map geometry loaded');
assert(counts.NOSEC === 0, 'every thing located in a sector by the BSP walk');

const tic = (args) =>
  db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', args).then((r) => r.rows[0]);

let s = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
const start = { x: s.PX, y: s.PY };
console.log('start', start, 'health', s.HEALTH);

t0 = t();
for (let i = 0; i < 10; i++) s = await tic([2, 1, 0, 0, 0, 0, 0, 0]);
console.log(`20 tics walking ${(t() - t0).toFixed(0)} ms`);
const moved = Math.hypot(s.PX - start.x, s.PY - start.y);
assert(moved > 20, `player walked forward (${moved.toFixed(1)} units)`);

t0 = t();
s = await tic([4, 0, 0, 0, 1, 1, 0, 0]);
console.log(`fire+use       ${(t() - t0).toFixed(0)} ms; bullets ${s.BULLETS}`);
assert(s.BULLETS < 50, 'pistol consumed a bullet');

for (let i = 0; i < 3; i++) {
  t0 = t();
  const walls = await db.query('SELECT * FROM frame_walls ORDER BY col, depth', [], { rowMode: 'array' });
  const t1 = t();
  const sprites = await db.query('SELECT * FROM frame_sprites ORDER BY depth DESC', [], { rowMode: 'array' });
  const t2 = t();
  console.log(`frame ${i}: walls ${walls.rows.length} rows ${(t1 - t0).toFixed(0)} ms, sprites ${sprites.rows.length} rows ${(t2 - t1).toFixed(0)} ms`);
  if (i === 0) {
    const cols = new Set(walls.rows.map((r) => r[0]));
    assert(cols.size === 320, `every screen column has a wall slice (${cols.size}/320)`);
  }
  await tic([1, 0, 0, 0.3, 0, 0, 0, 0]);
}

const a = await db.query('SELECT COUNT(*) n, SUM(col * 1000 + line_id) h FROM frame_walls');
const b = await db.query('SELECT COUNT(*) n, SUM(col * 1000 + line_id) h FROM frame_walls_windowed');
assert(a.rows[0].N === b.rows[0].N && a.rows[0].H === b.rows[0].H,
  `procedural and window-function clipping agree (${a.rows[0].N} slices)`);

// turn around a full circle: every view must close every column
for (let a = 0; a < 8; a++) {
  await tic([1, 0, 0, Math.PI / 4, 0, 0, 0, 0]);
  const r = await db.query(
    'SELECT COUNT(DISTINCT col) c FROM frame_walls WHERE MAXVALUE(clip_top, open_top) >= MINVALUE(clip_bot, open_bot)',
  );
  assert(r.rows[0].C === 320, `heading ${a * 45}°: all columns closed by a wall`);
}

// open a door: stand in front of a DR door (special 1), face it, press USE
const door = (await db.query(
  `SELECT FIRST 1 l.x1, l.y1, l.dx, l.dy, l.len, l.back_sector, s.ceil_h
     FROM linedefs l JOIN sectors s ON s.id = l.back_sector
    WHERE l.special = 1 AND l.len > 32`)).rows[0];
if (door) {
  const nx = door.DY / door.LEN;  // the front side is to the right of v1→v2
  const ny = -door.DX / door.LEN;
  const px = door.X1 + door.DX / 2 + nx * 24;
  const py = door.Y1 + door.DY / 2 + ny * 24;
  await db.exec(`UPDATE things t SET x = ${px}, y = ${py}, momx = 0, momy = 0, angle = ${Math.atan2(-ny, -nx)},
                 sector_id = sector_at(${px}, ${py}) WHERE t.kind = 'player'`);
  await db.exec(`UPDATE things t SET z = (SELECT floor_h FROM sectors s WHERE s.id = t.sector_id) WHERE t.kind = 'player'`);
  await tic([1, 0, 0, 0, 0, 1, 0, 0]);
  await tic([30, 0, 0, 0, 0, 0, 0, 0]);
  const c = (await db.query('SELECT ceil_h FROM sectors WHERE id = ?', [door.BACK_SECTOR])).rows[0].CEIL_H;
  assert(c > door.CEIL_H + 32, `USE opened a door (ceiling ${door.CEIL_H} → ${c})`);
}

await db.close();
console.log('all good');
process.exit(0);
