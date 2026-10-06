// physics-test.mjs – crushers and 3D projectile aiming, in the real engine.
//
//   node scripts/physics-test.mjs                                  (Phase 1)
//   WAD=public/wads/freedoom2.wad node scripts/physics-test.mjs    (Phase 2, adds a floor crusher)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://physics', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const maps = wad.mapNames();

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const one = async (q) => (await db.query(q)).rows[0];
const tic = (n = 1) => db.query(`SELECT * FROM doom_tic(${n}, 0, 0, 0, 0, 0, 0, 0)`);
const spawn = async (type, x, y, z = null, ang = 0) =>
  (await db.query(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
      EXECUTE PROCEDURE spawn_thing(${type}, ${x}, ${y}, ${z ?? 'NULL'}, ${ang}) RETURNING_VALUES id; SUSPEND; END`)).rows[0].ID;
/** A point inside a sector: the centre of one of its (convex) subsectors. */
const inside = (sec) => one(`SELECT FIRST 1 AVG(sg.x1) x, AVG(sg.y1) y FROM ssectors ss
                               JOIN segs sg ON sg.id BETWEEN ss.first_seg AND ss.first_seg + ss.seg_count - 1
                              WHERE ss.sector_id = ${sec} GROUP BY ss.id ORDER BY COUNT(*) DESC`);
const quiet = () => db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE kind = 'monster'`);

// ── crushers ───────────────────────────────────────────────────────────
const crushMap = maps.find((m) => wad.map(m).linedefs.some((l) => [6, 25, 73, 77].includes(l.special) && l.tag > 0));
if (crushMap) {
  await loadMap(db, wad, res, crushMap);
  await db.exec('UPDATE player SET health = 100000');
  await quiet();
  const line = await one(`SELECT FIRST 1 l.id, l.special, l.tag FROM linedefs l WHERE l.special IN (6, 25, 73, 77) AND l.tag > 0`);
  const sec = await one(`SELECT FIRST 1 s.id, s.floor_h, s.ceil_h FROM sectors s WHERE s.tag = ${line.TAG} ORDER BY s.ceil_h - s.floor_h DESC`);
  const at = await inside(sec.ID);
  const imp = await spawn(3001, at.X, at.Y);
  await db.exec(`UPDATE things SET st = 'idle', flags = 8, hp = 10000 WHERE id = ${imp}`);  // deaf, tough, stays put
  const corpse = await spawn(3004, at.X + 4, at.Y + 4);
  await db.exec(`UPDATE things SET st = 'dead', solid = 0, frame = 'L' WHERE id = ${corpse}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${line.ID}, 'walk')`);
  const spd = [6, 77].includes(line.SPECIAL) ? 2 : 1;
  let low = sec.CEIL_H;
  let rose = false;
  let ticks = 0;
  const sounds = new Set();
  // down (slowed while it crushes), and back up
  const limit = Math.ceil(((sec.CEIL_H - sec.FLOOR_H) / spd) * 10) + 200;
  for (; ticks < limit && !rose; ticks++) {
    await tic();
    const c = (await one(`SELECT ceil_h FROM sectors WHERE id = ${sec.ID}`)).CEIL_H;
    if (c < low) low = c;
    else if (c > low + 4) rose = true;
    if (ticks % 20 === 0) for (const r of (await db.query("SELECT DISTINCT sound FROM sound_events WHERE sound = 'DSSTNMOV'")).rows) sounds.add(r.SOUND);
  }
  const impNow = await one(`SELECT hp, st FROM things WHERE id = ${imp}`);
  const gib = await one(`SELECT sprite, height, solid FROM things WHERE id = ${corpse}`);
  assert(Math.abs(low - (sec.FLOOR_H + 8)) < 0.01, `${crushMap}: crusher (type ${line.SPECIAL}) comes down to floor + 8 (${sec.CEIL_H} → ${low})`);
  assert(rose, `${crushMap}: …and goes back up, round and round (cycle took ${ticks} tics)`);
  assert(!impNow || impNow.HP < 10000, `${crushMap}: an imp under it is crushed (${impNow ? 10000 - impNow.HP : 'all'} damage)`);
  assert(gib.SPRITE?.trim() === 'POL5' && gib.HEIGHT === 0, `${crushMap}: a corpse under it turns to gibs`);
  assert(sounds.has('DSSTNMOV'), `${crushMap}: it grinds (DSSTNMOV)`);

  // stop it, and start it again
  await db.exec(`UPDATE linedefs SET special = 57 WHERE id = ${line.ID}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${line.ID}, 'walk')`);
  const c0 = (await one(`SELECT ceil_h FROM sectors WHERE id = ${sec.ID}`)).CEIL_H;
  await tic(20);
  const c1 = (await one(`SELECT ceil_h FROM sectors WHERE id = ${sec.ID}`)).CEIL_H;
  assert(c0 === c1, `${crushMap}: a stop-crusher line (57) freezes it (${c0} → ${c1})`);
  await db.exec(`UPDATE linedefs SET special = ${line.SPECIAL} WHERE id = ${line.ID}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${line.ID}, 'walk')`);
  await tic(20);
  const c2 = (await one(`SELECT ceil_h FROM sectors WHERE id = ${sec.ID}`)).CEIL_H;
  assert(c2 !== c1, `${crushMap}: triggering it again resumes it (${c1} → ${c2})`);
} else console.log('(no crusher in this WAD)');

// floor crushers (DOOM II maps)
const floorMap = maps.find((m) => wad.map(m).linedefs.some((l) => [55, 56, 65, 94].includes(l.special) && l.tag > 0));
if (floorMap) {
  await loadMap(db, wad, res, floorMap);
  await db.exec('UPDATE player SET health = 100000');
  await quiet();
  const line = await one(`SELECT FIRST 1 l.id, l.special, l.tag FROM linedefs l WHERE l.special IN (55, 56, 65, 94) AND l.tag > 0`);
  const sec = await one(`SELECT FIRST 1 s.id, s.floor_h, s.ceil_h FROM sectors s WHERE s.tag = ${line.TAG}`);
  const at = await inside(sec.ID);
  const imp = await spawn(3001, at.X, at.Y);
  await db.exec(`UPDATE things SET st = 'idle', flags = 8, hp = 10000 WHERE id = ${imp}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${line.ID}, '${[55, 65].includes(line.SPECIAL) ? 'use' : 'walk'}')`);
  await tic(Math.ceil(sec.CEIL_H - sec.FLOOR_H) + 20);
  const f = (await one(`SELECT floor_h FROM sectors WHERE id = ${sec.ID}`)).FLOOR_H;
  const impNow = await one(`SELECT hp FROM things WHERE id = ${imp}`);
  assert(Math.abs(f - (sec.CEIL_H - 8)) < 0.01, `${floorMap}: floor crusher (type ${line.SPECIAL}) rises to ceiling − 8 (${sec.FLOOR_H} → ${f})`);
  assert(!impNow || impNow.HP < 10000, `${floorMap}: …squeezing an imp riding it (${impNow ? 10000 - impNow.HP : 'all'} damage)`);
}

// ── 3D projectile aiming ───────────────────────────────────────────────
await loadMap(db, wad, res, maps[0]);
await db.exec('UPDATE player SET health = 100000');
await quiet();
const p = await one(`SELECT t.id, t.x, t.y, t.z, t.angle FROM things t WHERE t.kind = 'player'`);

// monster missiles: momz = height difference / tics of flight
await db.exec(`EXECUTE PROCEDURE monster_missile(-1, 9000, ${p.X}, ${p.Y}, ${p.Z}, 20, 0, ${p.X + 320}, ${p.Y}, ${p.Z + 64})`);
const m1 = await one(`SELECT FIRST 1 momz FROM things WHERE thing_type = 9000 ORDER BY id DESC`);
assert(Math.abs(m1.MOMZ - 2) < 1e-9, `monster fireball climbs to its target: 64 up over 320 at speed 10 → momz ${m1.MOMZ}`);
await db.exec('DELETE FROM things WHERE thing_type = 9000');

/** A place for a target 300 units out at angle off the player's facing, with a clear line. */
async function target(off, lift = 0) {
  const a = p.ANGLE + off;
  const x = p.X + Math.cos(a) * 300;
  const y = p.Y + Math.sin(a) * 300;
  const id = await spawn(3001, x, y);
  await db.exec(`UPDATE things SET st = 'idle', flags = 8, z = z + ${lift} WHERE id = ${id}`);
  const t = await one(`SELECT z, height FROM things WHERE id = ${id}`);
  const seen = (await one(`SELECT check_sight(${p.X}, ${p.Y}, ${p.Z + 32}, ${x}, ${y}, ${t.Z + t.HEIGHT / 2}) s FROM rdb$database`)).S;
  return { id, x, y, z: t.Z, h: t.HEIGHT, seen };
}
const fire = async () => {
  await db.exec(`EXECUTE PROCEDURE fire_missile(9003, ${p.ID}, ${p.X}, ${p.Y}, ${p.Z}, ${p.ANGLE})`);
  return one(`SELECT FIRST 1 id, angle, momz FROM things WHERE thing_type = 9003 ORDER BY id DESC`);
};

// nothing in front: level, straight ahead
let r = await fire();
assert(Math.abs(r.MOMZ) < 1e-9 && Math.abs(r.ANGLE - p.ANGLE) < 1e-9, 'no target: the rocket flies level and straight');
await db.exec('DELETE FROM things WHERE thing_type = 9003');

// a target above: autoaim pitches up at its middle
let t = await target(0, 24);
if (t.seen) {
  r = await fire();
  const want = 20 * ((t.z + t.h / 2 - (p.Z + 32)) / 300);
  assert(Math.abs(r.MOMZ - want) < 0.05, `autoaim: rocket climbs at an imp 24 units up (momz ${r.MOMZ.toFixed(3)}, expected ${want.toFixed(3)})`);
} else console.log('(no clear line ahead for the autoaim test)');
await db.exec(`DELETE FROM things WHERE thing_type = 9003 OR id = ${t.id}`);

// a target just off the crosshair: found on the +5.625° try
t = await target(0.07);
if (t.seen) {
  r = await fire();
  assert(Math.abs(r.ANGLE - (p.ANGLE + 0.09817)) < 1e-4, `autoaim: an imp 4° off is found on the 5.625° try (rocket turned ${((r.ANGLE - p.ANGLE) * 180 / Math.PI).toFixed(3)}°)`);
} else console.log('(no clear line for the off-axis autoaim test)');
await db.exec(`DELETE FROM things WHERE thing_type = 9003 OR id = ${t.id}`);

// a fireball diving into the floor explodes there
const floorZ = (await one(`SELECT s.floor_h f FROM sectors s WHERE s.id = sector_at(${p.X}, ${p.Y})`)).F;
const fb = await spawn(9000, p.X + 40, p.Y, floorZ + 40);
await db.exec(`UPDATE things SET momx = 0, momy = 0, momz = -6, owner_id = -1 WHERE id = ${fb}`);
await tic(10);
const fbNow = await one(`SELECT st, z FROM things WHERE id = ${fb}`);
assert(fbNow && fbNow.ST === 'dying' && Math.abs(fbNow.Z - floorZ) < 0.01, `a fireball diving into the floor explodes on it (z ${fbNow?.Z} = floor ${floorZ})`);

// one climbing into a sky ceiling simply disappears
const sky = await one(`SELECT FIRST 1 t.x, t.y, s.floor_h FROM things t JOIN sectors s ON s.id = t.sector_id
                        WHERE s.sky = 1 AND t.kind IN ('item', 'decor', 'monster')`);
if (sky) {
  const sb = await spawn(9000, sky.X, sky.Y, sky.FLOOR_H + 40);
  await db.exec(`UPDATE things SET momx = 0, momy = 0, momz = 50, owner_id = -1 WHERE id = ${sb}`);
  await tic(12);
  const sbNow = await one(`SELECT st FROM things WHERE id = ${sb}`);
  assert(!sbNow, 'a fireball flying into the sky vanishes without exploding');
} else console.log('(no thing under open sky on this map)');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'physics ok');
process.exit(failures ? 1 : 0);
