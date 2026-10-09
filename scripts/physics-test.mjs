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

// hitscan in 3D: a level shot passes under an imp whose feet are just above the
// shot line; the right slope hits it
t = await target(0, 0);
await db.exec(`UPDATE things SET z = ${p.Z + 32 + 12}, hp = 10000 WHERE id = ${t.id}`);
t = { ...t, z: p.Z + 32 + 12 };
t.seen = (await one(`SELECT check_sight(${p.X}, ${p.Y}, ${p.Z + 32}, ${t.x}, ${t.y}, ${t.z + t.h / 2}) s FROM rdb$database`)).S;
if (t.seen) {
  const shot = async (slope) => (await db.query(`EXECUTE BLOCK RETURNS (h SMALLINT) AS BEGIN
      EXECUTE PROCEDURE hitscan(${p.X}, ${p.Y}, ${p.Z + 32}, ${p.ANGLE}, 2048, 10, ${p.ID}, ${slope}) RETURNING_VALUES h;
      SUSPEND; END`)).rows[0].H;
  const slope = (t.z + t.h / 2 - (p.Z + 32)) / 300;
  assert((await shot(0)) === 0, 'hitscan: a level shot passes under an imp hovering just above it');
  assert((await shot(slope)) === 1, `hitscan: the same shot at slope ${slope.toFixed(3)} hits it`);

  // the pistol finds that slope itself (P_BulletSlope)
  const hp0 = (await one(`SELECT hp FROM things WHERE id = ${t.id}`)).HP;
  for (let i = 0; i < 3; i++) await db.query('SELECT * FROM doom_tic(15, 0, 0, 0, 1, 0, 2, 0)');
  const hp1 = (await one(`SELECT hp FROM things WHERE id = ${t.id}`)).HP;
  assert(hp1 < hp0, `pistol autoaims up at the raised imp (${hp0 - hp1} damage in 3 shots)`);

  // …but not beyond DOOM's aiming window
  await db.exec(`UPDATE things SET z = z + 400, hp = 10000 WHERE id = ${t.id}`);
  for (let i = 0; i < 3; i++) await db.query('SELECT * FROM doom_tic(15, 0, 0, 0, 1, 0, 0, 0)');
  const hp2 = (await one(`SELECT hp FROM things WHERE id = ${t.id}`)).HP;
  assert(hp2 === 10000, 'pistol does not reach an imp far above the aiming window');
} else console.log('(no clear line ahead for the hitscan test)');
await db.exec(`DELETE FROM things WHERE id = ${t.id}`);

// a fireball diving into the floor explodes there
const floorZ = (await one(`SELECT s.floor_h f FROM sectors s WHERE s.id = sector_at(${p.X}, ${p.Y})`)).F;
const fb = await spawn(9000, p.X + 40, p.Y, floorZ + 40);
await db.exec(`UPDATE things SET momx = 0, momy = 0, momz = -6, owner_id = -1 WHERE id = ${fb}`);
await tic(10);
const fbNow = await one(`SELECT st, z FROM things WHERE id = ${fb}`);
assert(fbNow && fbNow.ST === 'dying' && Math.abs(fbNow.Z - floorZ) < 0.01, `a fireball diving into the floor explodes on it (z ${fbNow?.Z} = floor ${floorZ})`);

// one climbing into a sky ceiling simply disappears
const sky = await one(`SELECT FIRST 1 t.x, t.y, s.floor_h, s.ceil_h FROM things t JOIN sectors s ON s.id = t.sector_id
                        WHERE s.sky = 1 AND t.kind IN ('item', 'decor', 'monster')
                        ORDER BY s.ceil_h - s.floor_h, t.id`);
if (sky) {
  const sb = await spawn(9000, sky.X, sky.Y, sky.FLOOR_H + 40);
  await db.exec(`UPDATE things SET momx = 0, momy = 0, momz = 50, owner_id = -1 WHERE id = ${sb}`);
  await tic(Math.ceil((sky.CEIL_H - sky.FLOOR_H) / 50) + 4);   // however tall the sky is
  const sbNow = await one(`SELECT st FROM things WHERE id = ${sb}`);
  assert(!sbNow, 'a fireball flying into the sky vanishes without exploding');
} else console.log('(no thing under open sky on this map)');

// ── sound propagation (P_NoiseAlert) ───────────────────────────────────
{
  await loadMap(db, wad, res, maps[0]);
  const resetNoise = () => db.exec('UPDATE sectors SET sound_heard = 0; UPDATE game SET noise_sector = NULL');
  const pl = await one(`SELECT t.sector_id sec, t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`);
  const flood = async () => {
    await resetNoise();
    const t0 = performance.now();
    await db.exec(`EXECUTE PROCEDURE noise_alert(${pl.SEC}, 1000)`);
    return performance.now() - t0;
  };
  const ms = await flood();
  const heard = (await one('SELECT COUNT(*) n FROM sectors WHERE sound_heard = 1')).N;
  const total = (await one('SELECT COUNT(*) n FROM sectors')).N;
  assert(heard > 1 && heard < total, `${maps[0]}: a shot is heard in ${heard} of ${total} sectors (${ms.toFixed(0)} ms)`);
  assert((await one('SELECT MAX(blocks) m FROM sound_flood')).M <= 1, 'sound never crosses two sound-blocking lines');

  // a closed door stops it; open, it carries on
  const door = await one(`SELECT FIRST 1 d.id, d.floor_h, d.ceil_h FROM linedefs l
                            JOIN sectors d ON d.id = l.back_sector
                            JOIN sectors n ON n.id = l.front_sector
                           WHERE l.special IN (1, 26, 27, 28, 31) AND d.ceil_h <= d.floor_h AND n.sound_heard = 1`);
  if (door) {
    assert((await one(`SELECT sound_heard h FROM sectors WHERE id = ${door.ID}`)).H === 0, 'a closed door keeps the sound out');
    await db.exec(`UPDATE sectors SET ceil_h = floor_h + 72 WHERE id = ${door.ID}`);
    await flood();
    assert((await one(`SELECT sound_heard h FROM sectors WHERE id = ${door.ID}`)).H === 1, 'the same door, open, lets it through');
    await db.exec(`UPDATE sectors SET ceil_h = ${door.CEIL_H} WHERE id = ${door.ID}`);
  } else console.log('(no closed door next to a heard sector here)');

  // soundblock lines: wherever the sound crossed one, it went no further than one more open line
  const sb = await one(`SELECT COUNT(*) n FROM linedefs WHERE BIN_AND(flags, 64) = 64 AND back_sector IS NOT NULL`);
  if (sb.N > 0) {
    const crossed = (await one('SELECT COUNT(*) n FROM sound_flood WHERE blocks = 1')).N;
    console.log(`(${sb.N} sound-blocking lines on ${maps[0]}; sound crossed one into ${crossed} sectors)`);
  }

  // gunfire wakes an idle monster that heard it but cannot see the player,
  // and not one in a sector the sound never reached
  await resetNoise();
  await db.exec('UPDATE player SET health = 100000');
  await db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE kind = 'monster'`);
  await db.exec(`EXECUTE PROCEDURE noise_alert(${pl.SEC}, 1000)`);
  const heardSet = new Set((await db.query('SELECT id FROM sectors WHERE sound_heard = 1')).rows.map((r) => r.ID));
  await resetNoise();
  /** An imp, idle and not deaf, placed in a sector chosen by PICK, out of the player's sight. */
  async function placeImp(pick) {
    const secs = (await db.query('SELECT id FROM sectors WHERE ceil_h - floor_h >= 64 ORDER BY id')).rows.map((r) => r.ID).filter(pick);
    for (const s of secs) {
      const at = await inside(s);
      if (!at || (await one(`SELECT sector_at(${at.X}, ${at.Y}) s FROM rdb$database`)).S !== s) continue;
      const fz = (await one(`SELECT floor_h f FROM sectors WHERE id = ${s}`)).F;
      const seen = (await one(`SELECT check_sight(${at.X}, ${at.Y}, ${fz + 40}, ${pl.X}, ${pl.Y}, ${pl.Z + 41}) v FROM rdb$database`)).V;
      if (seen) continue;
      const id = await spawn(3001, at.X, at.Y);
      await db.exec(`UPDATE things SET st = 'idle', flags = 0 WHERE id = ${id}`);
      return id;
    }
    return null;
  }
  const hearer = await placeImp((s) => heardSet.has(s) && s !== pl.SEC);
  const deaf = await placeImp((s) => !heardSet.has(s));
  if (hearer) {
    await db.exec('UPDATE player SET weapon_y = 0, weapon_down = 0, pending_weapon = 0');   // (the weapon up and ready)
    await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 1, 0, 0, 0)');       // one shot
    await tic(16);
    const st = (await one(`SELECT st FROM things WHERE id = ${hearer}`)).ST;
    assert(st !== 'idle', `gunfire wakes a monster out of sight in a sector the sound reached (${st})`);
    if (deaf) {
      const st2 = (await one(`SELECT st FROM things WHERE id = ${deaf}`)).ST;
      assert(st2 === 'idle', `…but not one in a sector it never reached (${st2})`);
    }
  } else console.log('(nowhere out of sight in earshot to put a monster)');

  // ambush monsters in earshot still need to see you
  await resetNoise();
  const amb = await placeImp((s) => heardSet.has(s) && s !== pl.SEC);
  if (amb) {
    await db.exec(`UPDATE things SET flags = 8 WHERE id = ${amb}`);
    await db.exec('UPDATE player SET weapon_y = 0, weapon_down = 0, pending_weapon = 0');   // (the weapon up and ready)
    await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 1, 0, 0, 0)');
    await tic(16);
    assert((await one(`SELECT st FROM things WHERE id = ${amb}`)).ST === 'idle', 'an ambush monster out of sight ignores the noise');
  }

  // the flood on the biggest maps
  for (const big of maps.filter((m) => wad.map(m).sectors.length > 700).slice(0, 2)) {
    await loadMap(db, wad, res, big);
    const s0 = (await one(`SELECT sector_id s FROM things WHERE kind = 'player'`)).S;
    const t0 = performance.now();
    await db.exec(`EXECUTE PROCEDURE noise_alert(${s0}, 1000)`);
    const n = (await one('SELECT COUNT(*) n FROM sectors WHERE sound_heard = 1')).N;
    console.log(`(${big}: ${wad.map(big).sectors.length} sectors, flood reached ${n} in ${(performance.now() - t0).toFixed(0)} ms)`);
  }
}

// a monster killed by another thing's attack earlier in the same tic stays dead
// (the monster loop must not write back its cursor's stale copy)
{
  await loadMap(db, wad, res, maps[0]);
  await quiet();
  const pl = await one(`SELECT t.x, t.y FROM things t WHERE t.kind = 'player'`);
  const barrel = await spawn(2035, pl.X + 1000, pl.Y + 1000);    // spawned first: thinks first
  const imp = await spawn(3001, pl.X + 1024, pl.Y + 1000);
  await db.exec(`UPDATE things SET hp = 10, st = 'chase', st_tics = 3 WHERE id = ${imp}`);
  await db.exec(`UPDATE things SET st = 'dying', st_len = 25, st_tics = 16 WHERE id = ${barrel}`);
  await tic(4);
  const st = (await one(`SELECT st, hp FROM things WHERE id = ${imp}`));
  assert(['dying', 'dead'].includes(st.ST), `an imp killed by a barrel exploding earlier in the tic stays dead (${st.ST}, ${st.HP} hp)`);
}

// ── infighting ─────────────────────────────────────────────────────────
{
  /** A map whose start has a heading with open, level floor out to 300 units. */
  let dir = null;
  let pl;
  for (const name of maps.slice(0, 10)) {
  await loadMap(db, wad, res, name);
  await db.exec('UPDATE player SET health = 100000');
  await quiet();
  pl = await one(`SELECT t.id, t.x, t.y, t.z, t.angle FROM things t WHERE t.kind = 'player'`);
  for (let k = 0; k < 16 && dir === null; k++) {
    const a = pl.ANGLE + (k * Math.PI) / 8;
    let ok = true;
    for (const d of [80, 140, 200, 260, 300]) {
      const x = pl.X + Math.cos(a) * d;
      const y = pl.Y + Math.sin(a) * d;
      const r = (await db.query(`EXECUTE BLOCK RETURNS (ok SMALLINT, fz DOUBLE PRECISION, seen SMALLINT) AS
          DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
          BEGIN
            EXECUTE PROCEDURE check_position(-1, ${x}, ${y}, ${pl.Z}, 32, 56, 1) RETURNING_VALUES ok, fz, cz, dz, sec;
            seen = check_sight(${pl.X}, ${pl.Y}, ${pl.Z + 41}, ${x}, ${y}, ${pl.Z + 41});
            SUSPEND;
          END`)).rows[0];
      if (!(r.OK === 1 && r.SEEN === 1 && Math.abs(r.FZ - pl.Z) < 1)) ok = false;
    }
    if (ok) dir = a;
  }
  if (dir !== null) { console.log(`(infighting tests on ${name})`); break; }
  }
  const at = (d) => [pl.X + Math.cos(dir) * d, pl.Y + Math.sin(dir) * d];
  const placeMon = async (type, d, extra = '') => {
    const [x, y] = at(d);
    const id = await spawn(type, x, y);
    await db.exec(`UPDATE things SET st = 'idle', flags = 8, hp = 1000 ${extra} WHERE id = ${id}`);
    return id;
  };
  const fireball = async (owner, fromD, toward) => {
    const [x, y] = at(fromD);
    const a = toward > fromD ? dir : dir + Math.PI;
    const fz = (await one(`SELECT z FROM things WHERE id = ${owner}`)).Z;
    const id = await spawn(9000, x, y, fz + 32, a);
    await db.exec(`UPDATE things SET momx = ${Math.cos(a) * 10}, momy = ${Math.sin(a) * 10}, owner_id = ${owner} WHERE id = ${id}`);
    return id;
  };
  if (dir !== null) {
    // an imp's fireball hits a demon: the demon turns on the imp
    const imp = await placeMon(3001, 260);
    const demon = await placeMon(3002, 160);
    await fireball(imp, 200, 0);
    await tic(8);
    const d1 = await one(`SELECT hp, target_id, threshold, st FROM things WHERE id = ${demon}`);
    assert(d1.HP < 1000 && d1.TARGET_ID === imp && d1.THRESHOLD > 0,
      `an imp's fireball hurts a demon (${1000 - d1.HP}), which turns on the imp (threshold ${d1.THRESHOLD})`);
    const impHp0 = (await one(`SELECT hp FROM things WHERE id = ${imp}`)).HP;
    await db.exec(`UPDATE things SET flags = 0 WHERE id = ${demon}`);
    for (let i = 0; i < 20; i++) await tic(5);
    const impHp1 = (await one(`SELECT hp FROM things WHERE id = ${imp}`)).HP;
    assert(impHp1 < impHp0, `…and goes and bites it (${impHp0 - impHp1} damage)`);

    // the player can't win it back while the grudge lasts…
    await db.exec(`EXECUTE PROCEDURE damage_thing(${demon}, 1, ${pl.ID})`);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${demon}`)).T === imp, 'while its threshold lasts, the player can\'t draw it off');
    // …and when the imp dies, back it comes
    await db.exec(`EXECUTE PROCEDURE damage_thing(${imp}, 100000)`);
    await tic(8);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${demon}`)).T === null, 'its target dead, the demon hunts the player again');
    await db.exec(`DELETE FROM things WHERE id IN (${imp}, ${demon}) OR thing_type IN (9000, 9011)`);

    // same species: the fireball bursts harmlessly
    const i1 = await placeMon(3001, 260);
    const i2 = await placeMon(3001, 160);
    const fb = await fireball(i1, 200, 0);
    await tic(8);
    const i2now = await one(`SELECT hp, target_id FROM things WHERE id = ${i2}`);
    const fbNow = await one(`SELECT st FROM things WHERE id = ${fb}`);
    assert(i2now.HP === 1000 && i2now.TARGET_ID === null && (!fbNow || fbNow.ST === 'dying'),
      'an imp\'s fireball bursts on another imp without hurting it');
    await db.exec(`DELETE FROM things WHERE id IN (${i1}, ${i2}) OR thing_type IN (9000, 9011)`);

    // a zombieman shooting at the player hits an imp in the way, which then goes for the zombieman
    const zombie = await placeMon(3004, 280, `, angle = ${dir + Math.PI}`);
    const blocker = await placeMon(3001, 140);
    let hit = false;
    for (let i = 0; i < 10 && !hit; i++) {
      await db.exec(`UPDATE things SET st = 'attack', st_len = 16, st_tics = 8 WHERE id = ${zombie}`);
      await tic(2);
      hit = (await one(`SELECT hp FROM things WHERE id = ${blocker}`)).HP < 1000;
    }
    const b = await one(`SELECT hp, target_id FROM things WHERE id = ${blocker}`);
    const zb = await one(`SELECT st, hp, target_id FROM things WHERE id = ${zombie}`);
    assert(hit && b.TARGET_ID === zombie, `a zombieman's bullets hit an imp in the line of fire (${1000 - b.HP}), which turns on it (imp → ${b.TARGET_ID}, zombie ${zombie}: ${zb.ST}, ${zb.HP} hp, after ${zb.TARGET_ID})`);
    // and once the grudge wears off, the player can draw it back
    await db.exec(`UPDATE things SET threshold = 0 WHERE id = ${blocker}`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${blocker}, 1, ${pl.ID})`);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${blocker}`)).T === null, 'with its threshold spent, hurting it brings it back to the player');
    await db.exec(`DELETE FROM things WHERE id IN (${zombie}, ${blocker}) OR thing_type IN (9010, 9011)`);

    // arch-viles: always provoked, never provoking
    const vile = await placeMon(64, 280, `, angle = ${dir + Math.PI}`);
    const demon2 = await placeMon(3002, 140);
    const imp2 = await placeMon(3001, 200);
    await db.exec(`UPDATE things SET target_id = ${imp2}, threshold = 80 WHERE id = ${vile}`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${vile}, 5, ${demon2})`);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${vile}`)).T === demon2,
      'an arch-vile hurt by a demon turns on it, even mid-grudge');
    await db.exec(`UPDATE things SET threshold = 80 WHERE id = ${vile}`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${vile}, 5, ${pl.ID})`);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${vile}`)).T === null,
      '…and hurt by the player, it turns on the player, threshold or not');
    await db.exec(`EXECUTE PROCEDURE damage_thing(${imp2}, 5, ${vile})`);
    assert((await one(`SELECT target_id t FROM things WHERE id = ${imp2}`)).T === null, 'an arch-vile\'s damage provokes nobody');
    await db.exec(`DELETE FROM things WHERE id = ${imp2}`);

    // an arch-vile fighting a demon flames the demon, not the player
    await db.exec(`UPDATE things SET target_id = ${demon2}, threshold = 100, st = 'attack', st_len = 80, st_tics = 80 WHERE id = ${vile}`);
    await db.exec(`UPDATE things SET flags = 8, st = 'idle' WHERE id = ${demon2}`);
    await db.exec('UPDATE player SET health = 1000, armor = 0');
    const dhp0 = (await one(`SELECT hp FROM things WHERE id = ${demon2}`)).HP;
    let nearDemon = 0;
    let flameTics = 0;
    let rose = 0;
    let demonRose = 0;
    for (let i = 0; i < 85; i++) {
      await tic();
      const f = await one(`SELECT f.x fx, f.y fy, d.x dx, d.y dy, p.z pz, s.floor_h pf, d.z - ds.floor_h dr
                             FROM things d JOIN sectors ds ON ds.id = d.sector_id
                             CROSS JOIN things p JOIN sectors s ON s.id = p.sector_id
                             LEFT JOIN things f ON f.kind = 'flame' AND f.owner_id = ${vile}
                            WHERE d.id = ${demon2} AND p.kind = 'player'`);
      rose = Math.max(rose, f.PZ - f.PF);
      demonRose = Math.max(demonRose, f.DR);
      if (f.FX != null) {
        flameTics++;
        if (Math.hypot(f.FX - f.DX, f.FY - f.DY) < 30) nearDemon++;
      }
    }
    const dhp1 = (await one(`SELECT hp FROM things WHERE id = ${demon2}`)).HP;
    const php = (await one('SELECT health FROM player')).HEALTH;
    assert(flameTics > 50 && nearDemon / flameTics > 0.75, `the arch-vile's flame dances on the demon (${nearDemon} of ${flameTics} tics)`);
    assert(dhp0 - dhp1 >= 20, `the blast hits the demon (${dhp0 - dhp1} damage)`);
    // (hurt, the demon wakes and comes for the player – an arch-vile provokes nobody – so the
    //  player may get bitten, but must not be blasted into the air)
    assert(rose < 1, `and never blasts the player into the air (health ${php})`);
    // the toss: 1000 / mass 400 = 2.5 units a tic up, gravity brings it back
    assert(demonRose > 3 && demonRose < 6, `the blast tosses the demon ${demonRose.toFixed(1)} units up (momz 2.5)`);
    await tic(10);
    const dl = await one(`SELECT t.z - s.floor_h dr, t.momz FROM things t JOIN sectors s ON s.id = t.sector_id WHERE t.id = ${demon2}`);
    assert(dl.DR === 0 && dl.MOMZ === 0, `…and it lands again (${dl.DR} above the floor, momz ${dl.MOMZ})`);
    await db.exec(`DELETE FROM things WHERE id IN (${vile}, ${demon2}) OR kind IN ('flame', 'fx')`);

    // vertical physics: an imp tossed at momz 10 (an arch-vile's 1000 / mass 100)
    // rises 10 + 9 + … + 1 = 55 units and falls back; a corpse falls too
    const height = async (id) => one(`SELECT t.z - s.floor_h dr, t.momz, t.st FROM things t JOIN sectors s ON s.id = t.sector_id WHERE t.id = ${id}`);
    const tossed = await placeMon(3001, 200);
    await db.exec(`UPDATE things SET momz = 10 WHERE id = ${tossed}`);
    let impRose = 0;
    for (let i = 0; i < 12; i++) { await tic(); impRose = Math.max(impRose, (await height(tossed)).DR); }
    assert(impRose > 50 && impRose <= 56, `an imp tossed at momz 10 flies ${impRose} units up`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${tossed}, 100000)`);
    for (let i = 0; i < 40; i++) await tic();
    const fell = await height(tossed);
    assert(fell.DR === 0 && fell.MOMZ === 0 && fell.ST === 'dead', `killed in mid-air, it falls and lies on the floor (${fell.DR} up, ${fell.ST})`);
    await db.exec(`DELETE FROM things WHERE id = ${tossed}`);

    // a cacodemon flies: no gravity while alive, it drops when it dies
    const caco = await placeMon(3005, 200);
    // (as high as 40 units up as the ceiling allows)
    await db.exec(`UPDATE things t SET z = (SELECT r.floor_z + MINVALUE(40, r.ceil_z - r.floor_z - t.height)
                                              FROM z_range(t.x, t.y, t.radius) r) WHERE t.id = ${caco}`);
    const c0 = await height(caco);
    await tic(16);
    const c1 = await height(caco);
    assert(c0.DR > 24 && c1.DR === c0.DR, `a cacodemon hangs in the air (${c0.DR}, then ${c1.DR} up)`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${caco}, 100000)`);
    for (let i = 0; i < 40; i++) await tic();
    const c2 = await height(caco);
    assert(c2.DR === 0 && c2.ST === 'dead', `…and falls when it dies (${c2.DR} up, ${c2.ST})`);
    await db.exec(`DELETE FROM things WHERE id = ${caco}`);

    // P_Move's MF_FLOAT: a flier blocked only by the height rises or sinks FLOATSPEED
    // (4) where it is, and that counts as a move; MF_INFLOAT (131072) until a real step
    const flier = await placeMon(3005, 200);
    const walker = await placeMon(3001, 260);
    const tryStep = async (id, dz, fl) => {
      const t = await one(`SELECT t.x, t.y, t.z, s.floor_h fh, s.ceil_h ch FROM things t JOIN sectors s ON s.id = t.sector_id WHERE t.id = ${id}`);
      const z = dz === 'low' ? t.FH - 40 : dz === 'high' ? t.CH - 56 + 20 : t.FH;
      for (let d = 0; d < 8; d++) {
        const r = await one(`EXECUTE BLOCK RETURNS (ok SMALLINT, nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION, sec INTEGER, bumped SMALLINT)
          AS BEGIN EXECUTE PROCEDURE p_move(${id}, ${t.X}, ${t.Y}, ${z}, 31, 56, 8, ${fl}, 0, ${d}) RETURNING_VALUES ok, nx, ny, nz, sec, bumped; SUSPEND; END`);
        if (r.OK === 1) return { ...r, X: t.X, Y: t.Y, Z: z };
      }
      return { OK: 0, Z: z };
    };
    const fUp = await tryStep(flier, 'low', 1);
    const inf = (await one(`SELECT flags FROM things WHERE id = ${flier}`)).FLAGS & 131072;
    assert(fUp.OK === 1 && fUp.NX === fUp.X && fUp.NY === fUp.Y && fUp.NZ === fUp.Z + 4 && inf !== 0,
      `a cacodemon below where it fits rises 4 in place (${fUp.Z} → ${fUp.NZ}) and is MF_INFLOAT`);
    const fDown = await tryStep(flier, 'high', 1);
    assert(fDown.OK === 1 && fDown.NZ === fDown.Z - 4, `…and one too high for the ceiling sinks 4 (${fDown.Z} → ${fDown.NZ})`);
    const fLevel = await tryStep(flier, 'level', 1);
    assert(fLevel.OK === 1 && (fLevel.NX !== fLevel.X || fLevel.NY !== fLevel.Y)
        && ((await one(`SELECT flags FROM things WHERE id = ${flier}`)).FLAGS & 131072) === 0,
      'a real step clears MF_INFLOAT');
    assert((await tryStep(walker, 'low', 0)).OK === 0, 'an imp blocked by the height just stays blocked');
    // P_TryMove: MF_FLOAT things ignore a drop-off; walkers don't step over one
    const ledges = (await db.query(`SELECT FIRST 40 (l.x1 + l.x2) / 2e0 mx, (l.y1 + l.y2) / 2e0 my, MAXVALUE(f.floor_h, b.floor_h) top
        FROM linedefs l JOIN sectors f ON f.id = l.front_sector JOIN sectors b ON b.id = l.back_sector
       WHERE ABS(f.floor_h - b.floor_h) > 24 AND l.len2 > 128 * 128 AND BIN_AND(l.flags, 3) = 0
         AND MINVALUE(f.ceil_h, b.ceil_h) - MAXVALUE(f.floor_h, b.floor_h) >= 64 ORDER BY l.id`)).rows;
    let ledgeHit = null;
    for (const c of ledges) {
      const cp = (m) => one(`EXECUTE BLOCK RETURNS (ok SMALLINT) AS DECLARE a DOUBLE PRECISION; DECLARE b DOUBLE PRECISION;
          DECLARE c DOUBLE PRECISION; DECLARE d INTEGER; BEGIN
          EXECUTE PROCEDURE check_position(-1, ${c.MX}, ${c.MY}, ${c.TOP}, 31, 56, ${m}) RETURNING_VALUES ok, a, b, c, d; SUSPEND; END`);
      if ((await cp(0)).OK === 1) { ledgeHit = { walker: (await cp(1)).OK, flier: (await cp(2)).OK }; break; }
    }
    if (ledgeHit) assert(ledgeHit.walker === 0 && ledgeHit.flier === 1, `over a drop-off a walker is blocked (${ledgeHit.walker}), a flier isn't (${ledgeHit.flier})`);
    else console.log('(no clear ledge on this map; skipping the drop-off check)');
    // …and in the chase: heading into a step too high to take, it rises in place, 4 units a move
    const steps = (await db.query(`SELECT FIRST 40 l.x1, l.y1, l.x2, l.y2, f.floor_h ff, b.floor_h bf
        FROM linedefs l JOIN sectors f ON f.id = l.front_sector JOIN sectors b ON b.id = l.back_sector
       WHERE ABS(f.floor_h - b.floor_h) BETWEEN 32 AND 96 AND l.len2 > 128 * 128 AND BIN_AND(l.flags, 3) = 0
         AND (l.x1 = l.x2 OR l.y1 = l.y2)
         AND MINVALUE(f.ceil_h, b.ceil_h) - MAXVALUE(f.floor_h, b.floor_h) >= 96 ORDER BY l.id`)).rows;
    let climbed = null;
    for (const c of steps) {
      // the low side: DOOM's front is on the right of the line (x1,y1)→(x2,y2)
      const len = Math.hypot(c.X2 - c.X1, c.Y2 - c.Y1);
      const rx = (c.Y2 - c.Y1) / len, ry = -(c.X2 - c.X1) / len;   // towards the front
      const s = c.FF < c.BF ? 1 : -1;                               // which side is low
      const lx = (c.X1 + c.X2) / 2 + s * rx * 34, ly = (c.Y1 + c.Y2) / 2 + s * ry * 34;   // (radius 31: the next step reaches it)
      const lowZ = Math.min(c.FF, c.BF);
      const ok = await one(`EXECUTE BLOCK RETURNS (ok SMALLINT) AS DECLARE a DOUBLE PRECISION; DECLARE b DOUBLE PRECISION;
          DECLARE c DOUBLE PRECISION; DECLARE d INTEGER; BEGIN
          EXECUTE PROCEDURE check_position(-1, ${lx}, ${ly}, ${lowZ}, 31, 56, 2) RETURNING_VALUES ok, a, b, c, d; SUSPEND; END`);
      if (ok.OK !== 1) continue;
      // towards the high side: one of the four straight headings
      const hx = -s * rx, hy = -s * ry;
      const md = Math.abs(hx) > 0.5 ? (hx > 0 ? 0 : 4) : (hy > 0 ? 2 : 6);
      const cid = await spawn(3005, lx, ly);
      await db.exec(`UPDATE things SET st = 'chase', st_tics = 1, reaction = 1000, movedir = ${md}, movecount = 20,
                       z = ${lowZ}, flags = 0, hp = 1000 WHERE id = ${cid}`);
      let top = lowZ;
      let moved = 0;
      for (let i = 0; i < 24; i++) {
        await tic();
        const m = await one(`SELECT x, y, z, flags FROM things WHERE id = ${cid}`);
        top = Math.max(top, m.Z);
        if (Math.hypot(m.X - lx, m.Y - ly) > 1) { moved = 1; break; }
      }
      climbed = { rise: top - lowZ, moved };
      await db.exec(`DELETE FROM things WHERE id = ${cid}`);
      break;
    }
    if (climbed) assert(climbed.rise >= 8, `a chasing cacodemon at a ${'step'} it can't take floats up in place (${climbed.rise} units${climbed.moved ? ', then crosses' : ''})`);
    else console.log('(no clear straight step on this map; skipping the chase climb)');
    await db.exec(`DELETE FROM things WHERE id IN (${flier}, ${walker})`);

    // a lost soul's charge: 10 tics facing you, then 20 units a tic until it hits
    await db.exec('UPDATE player SET health = 1000, armor = 0');
    await db.exec(`DELETE FROM sound_events`);
    const soul = await placeMon(3006, 260, `, angle = ${dir + Math.PI}`);
    await db.exec(`UPDATE things SET st = 'attack', st_len = 10, st_tics = 10, reaction = 0, flags = 0 WHERE id = ${soul}`);
    const seen = [];
    let maxStep = 0;
    let prev = await one(`SELECT x, y FROM things WHERE id = ${soul}`);
    let hurt = 0;
    for (let i = 0; i < 30 && !hurt; i++) {
      await tic();
      const s = await one(`SELECT st, x, y FROM things WHERE id = ${soul}`);
      if (seen.at(-1) !== s.ST) seen.push(s.ST);
      maxStep = Math.max(maxStep, Math.hypot(s.X - prev.X, s.Y - prev.Y));
      prev = s;
      hurt = 1000 - (await one('SELECT health FROM player')).HEALTH;
    }
    const after = await one(`SELECT st, momx, momy, momz FROM things WHERE id = ${soul}`);
    const scream = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSSKLATK'`)).N;
    assert(seen.join(' ').startsWith('attack charge') && maxStep > 19 && maxStep < 21,
      `a lost soul winds up, then charges (${seen.join(' → ')}, ${maxStep.toFixed(1)} units a tic)`);
    assert(hurt >= 3 && hurt <= 24 && after.ST !== 'charge' && after.MOMX === 0 && after.MOMY === 0 && scream > 0,
      `…slams into you for ${hurt} and stops (${after.ST})`);
    // hurt in mid-flight, it stops dead
    await db.exec(`UPDATE things SET st = 'charge', momx = ${Math.cos(dir) * -20}, momy = ${Math.sin(dir) * -20}, momz = 0 WHERE id = ${soul}`);
    await db.exec(`EXECUTE PROCEDURE damage_thing(${soul}, 1, ${pl.ID})`);
    const stopped = await one(`SELECT st, momx, momy FROM things WHERE id = ${soul}`);
    assert(stopped.ST !== 'charge' && stopped.MOMX === 0 && stopped.MOMY === 0, `a charging lost soul that gets shot stops (${stopped.ST})`);
    await db.exec(`DELETE FROM things WHERE id = ${soul}`);

    // partial invisibility: the sphere gives 2100 tics, and monsters' aim goes astray
    await db.exec(`DELETE FROM sound_events`);
    const sphere = await spawn(2024, pl.X, pl.Y);
    const got = (await tic()).rows[0];
    const sphereLeft = await one(`SELECT COUNT(*) n FROM things WHERE id = ${sphere}`);
    const pow = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSGETPOW'`)).N;
    assert(got.INVIS_TICS > 2090 && got.INVIS_TICS <= 2100 && sphereLeft.N === 0 && pow > 0,
      `picking up the partial invisibility sphere: ${got.INVIS_TICS} tics of it (DSGETPOW)`);
    // a zombieman 280 units off, 80 volleys seen and 80 unseen
    const shooter = await placeMon(3004, 280, `, angle = ${dir + Math.PI}`);
    const volleys = async () => {
      let hits = 0;
      for (let i = 0; i < 80; i++) {
        await db.exec('UPDATE player SET health = 1000, armor = 0');
        await db.exec(`UPDATE things SET st = 'attack', st_len = 16, st_tics = 8, hp = 1000 WHERE id = ${shooter}`);
        await tic();
        if ((await one('SELECT health FROM player')).HEALTH < 1000) hits++;
      }
      return hits;
    };
    await db.exec('UPDATE player SET invis_tics = 0');
    const seenHits = await volleys();
    await db.exec('UPDATE player SET invis_tics = 2000');
    const unseenHits = await volleys();
    assert(seenHits >= 30 && unseenHits < seenHits / 2,
      `a zombieman hits you ${seenHits}/80 times, partially invisible only ${unseenHits}/80`);
    await db.exec('UPDATE player SET invis_tics = 3');
    const worn = (await tic(5)).rows[0];
    assert(worn.INVIS_TICS === 0, `it wears off (${worn.INVIS_TICS} tics left)`);
    await db.exec(`DELETE FROM things WHERE id = ${shooter} OR thing_type IN (9010, 9011)`);
    await db.exec('UPDATE player SET health = 100');

    // invulnerability: 1050 tics in which nothing but a telefrag hurts
    await db.exec(`DELETE FROM sound_events`);
    await spawn(2022, pl.X, pl.Y);
    const inv = (await tic()).rows[0];
    assert(inv.INVULN_TICS > 1040 && inv.INVULN_TICS <= 1050, `the invulnerability sphere: ${inv.INVULN_TICS} tics of it`);
    await db.exec('UPDATE player SET health = 100, armor = 0, damage_count = 0');
    await db.exec('EXECUTE PROCEDURE damage_player(80)');
    const brute = await placeMon(3002, 40, `, angle = ${dir + Math.PI}`);
    for (let i = 0; i < 40; i++) {
      await db.exec(`UPDATE things SET st = 'attack', st_len = 24, st_tics = 8, hp = 1000 WHERE id = ${brute}`);
      await tic();
    }
    const unhurt = await one('SELECT health, damage_count FROM player');
    assert(unhurt.HEALTH === 100 && unhurt.DAMAGE_COUNT === 0, `…shrugs off a hit for 80 and a demon's bites (health ${unhurt.HEALTH})`);
    await db.exec(`DELETE FROM things WHERE id = ${brute}`);
    await db.exec('EXECUTE PROCEDURE damage_player(10000)');
    assert((await one('SELECT dead FROM player')).DEAD === 1, '…but not a telefrag (10000)');
    await db.exec('UPDATE player SET dead = 0, health = 100, msg_tics = 0, invuln_tics = 3');
    const over = (await tic(5)).rows[0];
    await db.exec('EXECUTE PROCEDURE damage_player(10)');
    assert(over.INVULN_TICS === 0 && (await one('SELECT health FROM player')).HEALTH === 90, 'and once it wears off, damage hurts again');
    await db.exec('UPDATE player SET health = 100, damage_count = 0');

    // ── chase details: P_NewChaseDir, A_Chase, A_Look ──────────────────────
    await quiet();
    await db.exec('UPDATE sectors SET sound_heard = 0');
    await db.exec('UPDATE player SET health = 100000, invis_tics = 0');
    const me = await one(`SELECT t.id, t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`);
    const [ox, oy] = at(140);   // (open for a 32-unit radius: any 8-unit step from here is clear)
    const ncd = (olddir) => one(`EXECUTE BLOCK RETURNS (md SMALLINT, mc INTEGER, moved SMALLINT) AS
        DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE sec INTEGER;
        BEGIN EXECUTE PROCEDURE new_chase_dir(-1, ${ox}, ${oy}, ${me.Z}, 20, 56, 8, 0, 0, ${olddir}, ${me.X}, ${me.Y})
          RETURNING_VALUES md, mc, nx, ny, nz, sec, moved; SUSPEND; END`);
    // vanilla's choice for the way back to the player
    const ddx = me.X - ox;
    const ddy = me.Y - oy;
    const e1 = ddx > 10 ? 0 : ddx < -10 ? 4 : 8;
    const e2 = ddy < -10 ? 6 : ddy > 10 ? 2 : 8;
    const want = e1 !== 8 && e2 !== 8 ? [3, 1, 5, 7][(ddy < 0 ? 2 : 0) + (ddx > 0 ? 1 : 0)] : e1 !== 8 ? e1 : e2;
    const fresh = await ncd(8);
    const away = await ncd((want + 4) % 8);
    assert(fresh.MOVED === 1 && fresh.MD === want && fresh.MC >= 0 && fresh.MC <= 15,
      `P_NewChaseDir heads for the player in 45° steps: heading ${fresh.MD} (vanilla's ${want}), for ${fresh.MC} steps`);
    assert(away.MOVED === 1 && away.MD !== want,
      `…but walking away from it, it doesn't turn straight round while another way is open (heading ${away.MD}, not ${want})`);

    // A_Chase turns towards its heading 45° a step
    const chaser = await placeMon(3001, 140);
    await db.exec(`UPDATE things SET flags = 0, st = 'chase', st_tics = 1, reaction = 99, angle = 0.3, movedir = 2, movecount = 10 WHERE id = ${chaser}`);
    await tic();
    const turned = (await one(`SELECT angle FROM things WHERE id = ${chaser}`)).ANGLE;
    assert(Math.abs(turned - Math.PI / 4) < 1e-9, `A_Chase turns 45° a step towards its heading: 0.3 rad → ${turned.toFixed(4)} (π/4)`);

    // a missile attack waits for MOVECOUNT to run out – except on Nightmare
    const [ax, ay] = at(80);
    const ready = (extra = '') => db.exec(`UPDATE things SET x = ${ax}, y = ${ay}, z = ${me.Z}, sector_id = sector_at(${ax}, ${ay}),
        st = 'chase', st_tics = 1, reaction = 0, movecount = 5, just_attacked = 0, angle = ${dir + Math.PI} WHERE id = ${chaser}`)
      .then(() => extra && db.exec(`UPDATE things SET ${extra} WHERE id = ${chaser}`));
    const stAfter = async () => { await tic(); return (await one(`SELECT st, just_attacked FROM things WHERE id = ${chaser}`)); };
    await ready();
    const waits = await stAfter();
    await db.exec('UPDATE game SET skill = 5');
    await ready();
    const nightmare = await stAfter();
    await db.exec('UPDATE game SET skill = 3');
    assert(waits.ST === 'chase' && nightmare.ST === 'attack',
      `in range with MOVECOUNT 5 an imp keeps walking (${waits.ST}); on Nightmare it attacks at once (${nightmare.ST})`);
    // MF_JUSTATTACKED: the step after an attack only picks a heading
    await ready('movecount = 0, just_attacked = 1');
    const after1 = await stAfter();
    await ready('movecount = 0');
    const after2 = await stAfter();
    assert(nightmare.JUST_ATTACKED === 1 && after1.ST === 'chase' && after1.JUST_ATTACKED === 0 && after2.ST === 'attack',
      `an attack sets MF_JUSTATTACKED; the next step just walks (${after1.ST}), the one after may attack (${after2.ST})`);

    // with its target dead, A_Chase finds nobody and it goes back to standing
    await ready('reaction = 99');
    await db.exec('UPDATE player SET dead = 1');
    const widowed = await stAfter();
    await db.exec('UPDATE player SET dead = 0, health = 100000, msg_tics = 0');
    assert(widowed.ST === 'idle', `the player dead, a chasing monster goes back to its spawn state (${widowed.ST})`);

    // A_Look sees only ahead: not the player behind its back, unless within 64
    const look = async (d, facing) => {
      const [lx, ly] = at(d);
      await db.exec(`UPDATE things SET x = ${lx}, y = ${ly}, z = ${me.Z}, sector_id = sector_at(${lx}, ${ly}),
          st = 'idle', st_tics = 0, flags = 0, angle = ${facing} WHERE id = ${chaser}`);
      await db.exec('UPDATE sectors SET sound_heard = 0');
      for (let i = 0; i < 16; i++) await tic();
      return (await one(`SELECT st FROM things WHERE id = ${chaser}`)).ST;
    };
    const backTurned = await look(260, dir);
    const facing = await look(260, dir + Math.PI);
    const close = await look(50, dir);
    assert(backTurned === 'idle' && facing !== 'idle' && close !== 'idle',
      `A_Look: 260 away with its back to the player it stays ${backTurned}; facing it, it wakes (${facing}); 50 away behind its back, too (${close})`);
    // P_CheckSight asks REJECT first: a sector that REJECT says can't see the player's never
    // wakes by sight, line of sight or not (here a row of all ones, swapped in for the test)
    const [rx, ry] = at(260);
    const rsec = (await one(`SELECT sector_at(${rx}, ${ry}) s FROM rdb$database`)).S;
    const nsec = (await one('SELECT COUNT(*) n FROM sectors')).N;
    const oldRow = (await one(`SELECT bits FROM reject WHERE sector_id = ${rsec}`))?.BITS ?? null;
    await db.exec(`UPDATE OR INSERT INTO reject (sector_id, bits) VALUES (${rsec}, '${'f'.repeat(Math.ceil(nsec / 4))}') MATCHING (sector_id)`);
    const blind = await look(260, dir + Math.PI);
    await db.exec(oldRow === null ? `DELETE FROM reject WHERE sector_id = ${rsec}` : `UPDATE reject SET bits = '${oldRow}' WHERE sector_id = ${rsec}`);
    const sees = await look(260, dir + Math.PI);
    assert(blind === 'idle' && sees !== 'idle', `REJECT: facing the player from a sector REJECT blinds, it stays ${blind}; with the map's own table it wakes (${sees})`);
    await db.exec(`DELETE FROM things WHERE id = ${chaser}`);
    await db.exec('UPDATE player SET health = 100, damage_count = 0');
  } else console.log('(no open run from the player start for the infighting tests)');
}

// ── REJECT: the table in Firebird is the lump, bit for bit ─────────────
{
  const name = (await one('SELECT map_name FROM game')).MAP_NAME.trim();
  const m = wad.map(name);
  const n = m.sectors.length;
  const bit = (i) => (i >> 3 < m.reject.length ? (m.reject[i >> 3] >> (i & 7)) & 1 : 0);
  const pairs = [];
  for (let k = 0; k < 400; k++) pairs.push([(k * 7919) % n, (k * 104729 + 13) % n]);
  const got = (await db.query(`SELECT ${pairs.map(([a, b]) => `rejected(${a}, ${b})`).join(', ')} FROM rdb$database`, [], { rowMode: 'array' })).rows[0];
  const bad = pairs.filter(([a, b], i) => got[i] !== bit(a * n + b)).length;
  const set = pairs.filter(([a, b]) => bit(a * n + b)).length;
  assert(bad === 0 && set > 0 && set < pairs.length, `${name}: rejected(s1, s2) matches the REJECT lump at ${pairs.length} sector pairs (${set} rejected)`);
}

// ── skill levels ────────────────────────────────────────────────────────
{
  // which things spawn: easy, normal and hard flags
  const counts = {};
  for (const skill of [1, 3, 4]) {
    await loadMap(db, wad, res, maps[0], { skill });
    counts[skill] = (await one("SELECT COUNT(*) n FROM things WHERE kind = 'monster'")).N;
  }
  assert(counts[1] <= counts[3] && counts[3] <= counts[4] && counts[1] < counts[4],
    `${maps[0]}: ${counts[1]} monsters on skill 1, ${counts[3]} on 3, ${counts[4]} on 4`);

  const at = async () => one(`SELECT t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`);
  const hurtAndClip = async () => {
    await db.exec('UPDATE player SET health = 100, armor = 0, bullets = 10, max_bullets = 200');
    await db.exec('EXECUTE PROCEDURE damage_player(20)');
    const p = await at();
    await spawn(2007, p.X, p.Y);
    await tic();
    return one('SELECT health, bullets FROM player');
  };
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  const normal = await hurtAndClip();
  await loadMap(db, wad, res, maps[0], { skill: 1 });
  await quiet();
  const baby = await hurtAndClip();
  assert((await one('SELECT skill FROM game')).SKILL === 1 && normal.HEALTH === 80 && normal.BULLETS === 20
    && baby.HEALTH === 90 && baby.BULLETS === 30,
    `skill 1 takes half damage (20 → ${100 - baby.HEALTH}, normal ${100 - normal.HEALTH}) and gets double ammo (a clip: +${baby.BULLETS - 10}, normal +${normal.BULLETS - 10})`);

  // Nightmare
  await loadMap(db, wad, res, maps[0], { skill: 5 });
  await quiet();
  const nm = await hurtAndClip();
  const p = await at();
  await db.exec(`EXECUTE PROCEDURE monster_missile(${(await one("SELECT MIN(id) i FROM things WHERE kind = 'monster'")).I}, 9000,
                 ${p.X}, ${p.Y}, ${p.Z}, 20, 0, ${p.X + 200}, ${p.Y}, ${p.Z})`);
  const ball = await one('SELECT SQRT(momx * momx + momy * momy) v FROM things WHERE thing_type = 9000 ORDER BY id DESC ROWS 1');
  await db.exec(`EXECUTE PROCEDURE cheat('iddqd')`);
  const god = (await one('SELECT god FROM player')).GOD;
  assert(nm.HEALTH === 80 && nm.BULLETS === 30 && Math.abs(ball.V - 20) < 0.01 && god === 0,
    `Nightmare: full damage, double ammo (+${nm.BULLETS - 10}), imp fireballs at ${ball.V.toFixed(0)}, and IDDQD does nothing`);
  // demons run twice as often (the test fireball goes first: it flies east, right through where the demon stands)
  await db.exec('DELETE FROM things WHERE thing_type = 9000');
  const demon = await spawn(3002, p.X + 96, p.Y);
  const steps = [];
  for (let i = 0; i < 6; i++) {
    await db.exec(`UPDATE things SET st = 'chase', st_tics = 1, reaction = 9, hp = 1000 WHERE id = ${demon}`);
    await tic();
    steps.push((await one(`SELECT st_tics FROM things WHERE id = ${demon}`)).ST_TICS);
  }
  assert(steps.every((s) => s >= 1 && s <= 2), `Nightmare demons take a step every 1–2 tics (${steps.join(' ')}), not every 3`);
  await db.exec(`DELETE FROM things WHERE id = ${demon}`);

  // a corpse gets back up at its spawn spot, in teleport fog; a lost soul doesn't
  await db.exec('DELETE FROM sound_events');
  const corpse = await spawn(3001, p.X + 64, p.Y);
  const soul = await spawn(3006, p.X - 64, p.Y);
  await db.exec(`UPDATE things SET st = 'dead', hp = 0, solid = 0, frame = 'M', dead_tic = 0,
                 spawn_x = x, spawn_y = y, spawn_angle = 1.5, x = x + 8 WHERE id IN (${corpse}, ${soul})`);
  let tries = 0;
  while ((await one(`SELECT st FROM things WHERE id = ${corpse}`)).ST === 'dead' && tries++ < 3000) {
    await db.exec('EXECUTE PROCEDURE nightmare_respawn(100000)');
  }
  const up = await one(`SELECT t.st, t.hp, t.solid, t.x, t.angle, t.dead_tic FROM things t WHERE t.id = ${corpse}`);
  const lost = (await one(`SELECT st FROM things WHERE id = ${soul}`)).ST;
  const fog = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9016')).N;
  const tele = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSTELEPT'`)).N;
  assert(up.ST === 'idle' && up.HP === 60 && up.SOLID === 1 && Math.abs(up.X - (p.X + 64)) < 0.01 && Math.abs(up.ANGLE - 1.5) < 1e-9
    && up.DEAD_TIC === null && lost === 'dead' && fog >= 2 && tele > 0,
    `Nightmare: an imp's corpse rises after ${tries} tries (4/256 each), at its spawn spot with full health, in teleport fog; the lost soul stays down`);
  await db.exec(`DELETE FROM things WHERE id IN (${corpse}, ${soul}) OR thing_type = 9016`);
  // a corpse younger than 12 seconds stays put
  const young = await spawn(3001, p.X + 64, p.Y);
  await db.exec(`UPDATE things SET st = 'dead', hp = 0, solid = 0, dead_tic = 99900, spawn_x = x, spawn_y = y WHERE id = ${young}`);
  for (let i = 0; i < 300; i++) await db.exec('EXECUTE PROCEDURE nightmare_respawn(100000)');
  assert((await one(`SELECT st FROM things WHERE id = ${young}`)).ST === 'dead', 'a corpse dead less than 12 seconds stays down');
  await db.exec(`DELETE FROM things WHERE id = ${young}`);
}

// ── the radiation suit and the light amplification goggles ─────────────
const slimeMap = maps.find((m) => wad.map(m).sectors.some((s) => s.special === 5 || s.special === 7));
if (slimeMap) {
  await loadMap(db, wad, res, slimeMap);
  await quiet();
  const sp = await one(`SELECT t.x, t.y FROM things t WHERE t.kind = 'player'`);
  await spawn(2025, sp.X, sp.Y);
  await spawn(2045, sp.X, sp.Y);
  const got = (await tic()).rows[0];
  assert(got.IRON_TICS > 2090 && got.IRON_TICS <= 2100 && got.INFRA_TICS > 4190 && got.INFRA_TICS <= 4200,
    `the radiation suit (${got.IRON_TICS} tics) and the goggles (${got.INFRA_TICS} tics)`);
  // stand in the slime: hurt every 32 tics without the suit, never with it
  const sec = await one(`SELECT FIRST 1 s.id, s.floor_h, s.special FROM sectors s WHERE s.special IN (5, 7)
                          ORDER BY (SELECT COUNT(*) FROM segs g WHERE g.front_sector = s.id) DESC`);
  const at = await inside(sec.ID);
  const soak = async (iron) => {
    await db.exec(`UPDATE player SET health = 100, armor = 0, iron_tics = ${iron}, damage_count = 0`);
    await db.exec(`UPDATE things SET x = ${at.X}, y = ${at.Y}, z = ${sec.FLOOR_H}, momx = 0, momy = 0,
                   sector_id = sector_at(${at.X}, ${at.Y}) WHERE kind = 'player'`);
    await tic(70);
    return 100 - (await one('SELECT health FROM player')).HEALTH;
  };
  const bare = await soak(0);
  const suited = await soak(2000);
  assert(bare > 0 && suited === 0, `sector ${sec.ID} (special ${sec.SPECIAL}): ${bare} damage in 70 tics bare, ${suited} in the suit`);
  await db.exec('UPDATE player SET health = 100, iron_tics = 0, infra_tics = 0');
} else console.log('(no nukage or slime in this WAD)');

// ── active sounds (A_Chase: activesound, P_Random() < 3) ──────────────────
{
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  const p = await one(`SELECT t.x, t.y FROM things t WHERE t.kind = 'player'`);
  const imp = await spawn(3001, p.X + 256, p.Y);
  await db.exec('DELETE FROM sound_events');
  // chasing, but never ready to attack: every chase step ends in A_Chase's last lines
  // (DOOM_TIC forgets sounds older than 70 tics: count after every 50)
  let steps = 0;
  let growls = 0;
  let others = 0;
  let seen = 0;
  for (let k = 0; k < 80; k++) {
    await db.exec(`UPDATE things SET st = 'chase', reaction = 99 WHERE id = ${imp}`);
    const s0 = (await one(`SELECT step FROM things WHERE id = ${imp}`)).STEP;
    await tic(50);
    steps += (await one(`SELECT step FROM things WHERE id = ${imp}`)).STEP - s0;
    const c = await one(`SELECT COALESCE(MAX(id), ${seen}) top,
        COUNT(CASE WHEN sound = 'DSBGACT' AND origin = ${imp} THEN 1 END) mine,
        COUNT(CASE WHEN sound LIKE 'DS%ACT' AND origin <> ${imp} THEN 1 END) theirs
      FROM sound_events WHERE id > ${seen}`);
    growls += c.MINE;
    others += c.THEIRS;
    seen = c.TOP;
  }
  const expect = (steps * 3) / 256;
  assert(steps > 800 && growls >= expect / 3 && growls <= expect * 3 && others === 0,
    `a chasing imp growls (DSBGACT) ${growls} times in ${steps} chase steps (3 in 256 expects ${expect.toFixed(1)}), from where it is`);
  const quietTypes = (await one(`SELECT COUNT(*) n FROM thing_types WHERE kind = 'monster' AND active_snd IS NULL`)).N;
  assert(quietTypes === 0, 'every monster has its activesound');
  await db.exec(`DELETE FROM things WHERE id = ${imp}`);
}

// ── armour types (P_GiveArmor, P_DamageMobj) ────────────────────────────
{
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  const p = await one(`SELECT t.x, t.y FROM things t WHERE t.kind = 'player'`);
  const pick = async (type) => { await spawn(type, p.X, p.Y); await tic(); return one('SELECT health, armor, armor_type FROM player'); };
  const hit = async (dmg) => { await db.exec(`EXECUTE PROCEDURE damage_player(${dmg})`); return one('SELECT health, armor, armor_type FROM player'); };
  await db.exec('UPDATE player SET health = 100, armor = 0, armor_type = 0');
  const green = await pick(2018);
  const g1 = await hit(30);
  assert(green.ARMOR === 100 && green.ARMOR_TYPE === 1 && g1.HEALTH === 80 && g1.ARMOR === 90,
    `green armour: ${green.ARMOR} points, type ${green.ARMOR_TYPE}; a hit for 30 costs 20 health and 10 armour (a third)`);
  const blue = await pick(2019);
  await db.exec('UPDATE player SET health = 100');
  const b1 = await hit(30);
  assert(blue.ARMOR === 200 && blue.ARMOR_TYPE === 2 && b1.HEALTH === 85 && b1.ARMOR === 185,
    `blue armour: ${blue.ARMOR} points, type ${blue.ARMOR_TYPE}; a hit for 30 costs 15 and 15 (half)`);
  // green armour isn't taken over more blue points; a bonus keeps the type
  await db.exec(`DELETE FROM things WHERE thing_type = 2018`);
  await spawn(2018, p.X, p.Y);
  await tic();
  const kept = await one('SELECT armor, armor_type, (SELECT COUNT(*) FROM things WHERE thing_type = 2018) left_ FROM player');
  await db.exec(`DELETE FROM things WHERE thing_type = 2018`);
  const bonus = await pick(2015);
  assert(kept.ARMOR_TYPE === 2 && kept.LEFT_ === 1 && bonus.ARMOR === 186 && bonus.ARMOR_TYPE === 2,
    'green armour stays on the floor while you have more; a bonus adds a point and keeps blue');
  // used up: the type goes, and the next hit isn't absorbed at all
  await db.exec('UPDATE player SET health = 100, armor = 4, armor_type = 2');
  const out = await hit(20);
  const bare = await hit(9);
  assert(out.HEALTH === 84 && out.ARMOR === 0 && out.ARMOR_TYPE === 0 && bare.HEALTH === 75,
    'the last 4 points absorb 4 of 20 and the type goes; the next 9 all hurt');
  // a bonus with no armour gives green's type; the megasphere blue's
  const b0 = await pick(2015);
  await db.exec(`DELETE FROM things WHERE thing_type = 83`);
  const mega = await pick(83);
  assert(b0.ARMOR === 1 && b0.ARMOR_TYPE === 1 && mega.HEALTH === 200 && mega.ARMOR === 200 && mega.ARMOR_TYPE === 2,
    'a bonus on nothing is type 1; the megasphere 200 health, 200 armour, type 2');
  await db.exec('UPDATE player SET health = 100, armor = 0, armor_type = 0');
}

// ── timed doors (10, 14) and E1M8's exit floor (11) ──────────────────────
{
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  // two empty sectors with room for a door: one left open (10), one shut (14)
  // (for 14, one whose lowest neighbouring ceiling leaves room to open, as a door's would)
  const pick = (extra) => one(`SELECT FIRST 1 s.id, s.floor_h, s.ceil_h FROM sectors s
      WHERE s.ceil_h - s.floor_h >= 64 AND s.special = 0 ${extra}
        AND NOT EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM things t WHERE t.sector_id = s.id) ORDER BY s.id`);
  const a = await pick('');
  const b = await pick(`AND s.id <> ${a.ID} AND neighbor_h(s.id, 'min_ceil') - 4 >= s.floor_h + 32`);
  await db.exec(`UPDATE sectors SET special = 10 WHERE id = ${a.ID}`);
  await db.exec(`UPDATE sectors SET special = 14, ceil_h = floor_h WHERE id = ${b.ID}`);
  await db.exec('EXECUTE PROCEDURE spawn_door_specials');
  const mover = (id) => one(`SELECT m.dir, m.wait_left, m.top_h, s.ceil_h, s.floor_h, s.special
      FROM sectors s LEFT JOIN movers m ON m.sector_id = s.id WHERE s.id = ${id}`);
  const ma = await mover(a.ID);
  const mb = await mover(b.ID);
  assert(ma.DIR === 0 && ma.WAIT_LEFT === 30 * 35 && mb.DIR === 2 && mb.WAIT_LEFT === 5 * 60 * 35
      && ma.SPECIAL === 0 && mb.SPECIAL === 0 && mb.TOP_H > mb.FLOOR_H,
    `sector 10: a door waiting ${ma.WAIT_LEFT} tics to close; 14: one waiting ${mb.WAIT_LEFT} to open (to ${mb.TOP_H}); both specials spent`);
  // (thirty seconds and five minutes are long: skip to the last tics of the wait)
  await db.exec(`UPDATE movers SET wait_left = 3 WHERE sector_id IN (${a.ID}, ${b.ID})`);
  await tic(3);
  const held = [await mover(a.ID), await mover(b.ID)];
  await tic(Math.ceil((a.CEIL_H - a.FLOOR_H) / 2) + 2);
  const shut = await mover(a.ID);
  const rising = await mover(b.ID);
  assert(held[0].CEIL_H === a.CEIL_H && held[1].CEIL_H === b.FLOOR_H && shut.CEIL_H === shut.FLOOR_H && shut.DIR === null
      && rising.CEIL_H > rising.FLOOR_H,
    `when the wait is up, the open door closes for good (ceiling ${shut.CEIL_H} = floor) and the shut one starts up (${rising.CEIL_H})`);
  await tic(Math.ceil((mb.TOP_H - mb.FLOOR_H) / 2) + 150 + Math.ceil((mb.TOP_H - mb.FLOOR_H) / 2) + 5);
  const done = await mover(b.ID);
  assert(done.CEIL_H === done.FLOOR_H && done.DIR === null, '…and that one goes on as a normal door: up, a wait, and down again');

  // the hurting floor 4 strobes too, fast, like 2
  await db.exec(`UPDATE sectors SET special = 4, min_light = 0, base_light = 200, light = 200 WHERE id = ${a.ID}`);
  const lights = new Set();
  for (let i = 0; i < 24; i++) { await tic(); lights.add((await one(`SELECT light FROM sectors WHERE id = ${a.ID}`)).LIGHT); }
  await db.exec(`UPDATE sectors SET special = 0 WHERE id = ${a.ID}`);
  assert(lights.has(0) && lights.has(200) && lights.size === 2, `sector 4 strobes between ${[...lights].join(' and ')}, like 2`);

  // E1M8's floor: IDDQD off, 20 damage every 32 tics, and at 10 or less the level ends
  const ps = await one(`SELECT t.sector_id s FROM things t WHERE t.kind = 'player'`);
  await db.exec(`UPDATE sectors SET special = 11 WHERE id = ${ps.S}`);
  await db.exec('UPDATE player SET health = 50, god = 1, invuln_tics = 0, iron_tics = 0');
  await db.exec('UPDATE game SET exit_kind = 0');
  const first = (await tic()).rows[0];
  await tic(31);
  const hurt = await one('SELECT p.health, p.god, g.exit_kind FROM player p CROSS JOIN game g');
  await db.exec('UPDATE player SET health = 25');
  await tic(32);
  const out = await one('SELECT p.health, p.dead, g.exit_kind FROM player p CROSS JOIN game g');
  assert(first.GOD === 0 && hurt.HEALTH === 30 && hurt.EXIT_KIND === 0 && out.HEALTH === 5 && out.EXIT_KIND === 1 && out.DEAD === 0,
    `sector 11: god mode off at once, 50 → ${hurt.HEALTH} health and no exit; at 25 the next hit leaves ${out.HEALTH} and ends the level (exit ${out.EXIT_KIND})`);
  await db.exec(`UPDATE sectors SET special = 0 WHERE id = ${ps.S}`);
  await db.exec('UPDATE game SET exit_kind = 0');
  await db.exec('UPDATE player SET health = 100');
}

// ── the less common linedef specials ────────────────────────────────────
{
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  // a test sector X (empty, with room, neighbours above and below would be
  // nice but aren't needed) tagged 999, and a line elsewhere to carry the special
  const X = await one(`SELECT FIRST 1 s.id, s.floor_h, s.ceil_h, s.floor_flat, s.light FROM sectors s
      WHERE s.ceil_h - s.floor_h >= 96 AND s.special = 0 AND s.tag = 0
        AND NOT EXISTS (SELECT 1 FROM things t WHERE t.sector_id = s.id)
        AND (SELECT COUNT(*) FROM linedefs l WHERE (l.front_sector = s.id OR l.back_sector = s.id) AND l.back_sector IS NOT NULL) >= 2
      ORDER BY s.id`);
  const L = await one(`SELECT FIRST 1 l.id, l.front_sector f FROM linedefs l WHERE l.front_sector <> ${X.ID} AND l.back_sector IS NULL ORDER BY l.id`);
  await db.exec(`UPDATE sectors SET tag = 999 WHERE id = ${X.ID}`);
  const state = () => one(`SELECT s.floor_h, s.ceil_h, s.floor_flat, s.light, s.special, s.base_light, s.min_light,
      m.kind, m.dir, m.speed, m.top_h, m.bottom_h, m.wait_left, m.stay, m.new_flat, m.new_special
      FROM sectors s LEFT JOIN movers m ON m.sector_id = s.id WHERE s.id = ${X.ID}`);
  const reset = async () => {
    await db.exec(`DELETE FROM movers`);
    await db.exec(`UPDATE sectors SET floor_h = ${X.FLOOR_H}, ceil_h = ${X.CEIL_H}, floor_flat = ${X.FLOOR_FLAT},
        light = ${X.LIGHT}, base_light = ${X.LIGHT}, special = 0 WHERE id = ${X.ID}`);
  };
  const fire = async (sp, how = 'walk') => {
    await db.exec(`UPDATE linedefs SET special = ${sp}, tag = 999 WHERE id = ${L.ID}`);
    await db.exec(`EXECUTE PROCEDURE activate_line(${L.ID}, '${how}')`);
    return state();
  };
  const nb = (what) => one(`SELECT neighbor_h(${X.ID}, '${what}') v FROM rdb$database`).then((r) => r.V);
  const until = async (cond, max = 3000) => { for (let i = 0; i < max; i++) { const s = await state(); if (cond(s)) return s; await tic(); } return state(); };

  // lights
  await reset();
  const l255 = await fire(13);
  const l35 = await fire(35);
  const lmax = await fire(12);
  const brightest = await nb('max_light');
  await db.exec(`UPDATE sectors SET light = 255 WHERE id = ${X.ID}`);
  const lmin = await fire(104);
  const darkest = Math.min(255, await nb('min_light'));
  const l138 = await fire(138, 'use');
  assert(l255.LIGHT === 255 && l35.LIGHT === 35 && lmax.LIGHT === brightest && lmin.LIGHT === darkest && l138.LIGHT === 255,
    `lights: 13 → 255, 35 → 35, 12 → the brightest neighbour (${brightest}), 104 → the darkest (${darkest}), switch 138 → 255`);
  await reset();
  await db.exec(`UPDATE sectors SET light = 200 WHERE id = ${X.ID}`);
  const strobe = await fire(17);
  const seen = new Set();
  for (let i = 0; i < 44; i++) { await tic(); seen.add((await state()).LIGHT); }
  assert(strobe.SPECIAL === 3 && strobe.BASE_LIGHT === 200 && seen.has(200) && seen.has(strobe.MIN_LIGHT) && seen.size === 2,
    `17 starts a slow strobe between 200 and ${strobe.MIN_LIGHT} (light type 3)`);

  // a door that closes for thirty seconds
  await reset();
  const c30 = await fire(16);
  const shut = await until((s) => s.CEIL_H === s.FLOOR_H);
  await db.exec(`UPDATE movers SET wait_left = 2 WHERE sector_id = ${X.ID}`);
  const back = await until((s) => s.KIND === null);
  assert(c30.DIR === -1 && c30.STAY === 2 && shut.DIR === 0 && shut.WAIT_LEFT >= 30 * 35 - 1 && back.CEIL_H === X.CEIL_H,
    `16: the door closes, waits thirty seconds (${shut.WAIT_LEFT} tics left), and opens again to ${back.CEIL_H} for good`);

  // perpetual lifts, stopped and started
  await reset();
  const perp = await fire(53);
  const hi = Math.max(X.FLOOR_H, await nb('max_floor'));
  const lo = Math.min(X.FLOOR_H, await nb('min_floor'));
  for (let i = 0; i < 400; i++) await tic();
  const still = await state();
  const stopped = await fire(54);
  const fh0 = stopped.FLOOR_H;
  for (let i = 0; i < 20; i++) await tic();
  const frozen = await state();
  const going = await fire(53);
  assert(perp.KIND === 'lift' && perp.STAY === 2 && perp.SPEED === 1 && perp.TOP_H === hi && perp.BOTTOM_H === lo
      && still.KIND === 'lift' && stopped.KIND === 'lifts' && frozen.FLOOR_H === fh0 && going.KIND === 'lift',
    `53: a perpetual lift between ${lo} and ${hi}, still going 400 tics later; 54 stops it dead, 53 starts it again`);

  // raise and change
  await db.exec('DELETE FROM movers');
  await reset();
  const other = (await one(`SELECT FIRST 1 id FROM flats WHERE id <> ${X.FLOOR_FLAT} AND is_sky = 0 ORDER BY id`)).ID;
  await db.exec(`UPDATE sectors SET floor_flat = ${other} WHERE id = ${L.F}`);
  const r24 = await fire(15, 'use');
  await reset();
  const r32 = await fire(14, 'use');
  await reset();
  await db.exec(`UPDATE sectors SET special = 7 WHERE id = ${X.ID}`);
  const near = await fire(22);
  assert(r24.FLOOR_FLAT === other && r24.TOP_H === X.FLOOR_H + 24 && r24.SPEED === 0.5 && r32.TOP_H === X.FLOOR_H + 32
      && near.FLOOR_FLAT === other && near.SPECIAL === 0,
    'raise and change: the front sector\'s flat at once, then up 24 (15), 32 (14), or to the next floor (22, which also clears the special), at half speed');

  // lower and change
  await reset();
  const low = await nb('min_floor');
  if (low < X.FLOOR_H) {
    const lc = await fire(37);
    const after = await until((s) => s.KIND === null);
    assert(lc.TOP_H === low && lc.NEW_FLAT !== null && after.FLOOR_H === low && after.FLOOR_FLAT === lc.NEW_FLAT,
      `37: down to the lowest floor around (${low}), taking that neighbour's flat when it gets there`);
  } else console.log('(no lower neighbour for lowerAndChange)');

  // floors: by the shortest lower texture, turbo to the next, by 512, and the gun's
  await reset();
  const tex = await fire(30);
  const shortest = (await one(`SELECT MIN(t.h) h FROM linedefs l JOIN sidedefs sd ON sd.id IN (l.front_side, l.back_side)
      JOIN textures t ON t.id = sd.lower_tex WHERE (l.front_sector = ${X.ID} OR l.back_sector = ${X.ID})
        AND l.back_sector IS NOT NULL AND sd.lower_tex > 0`)).H;
  await reset();
  const f512 = await fire(140, 'use');
  await reset();
  const turbo = await fire(131, 'use');
  await reset();
  const gun = await fire(24, 'shoot');
  assert((shortest == null || tex.TOP_H === X.FLOOR_H + shortest) && f512.TOP_H === X.FLOOR_H + 512
      && (turbo.KIND === null || turbo.SPEED === 4) && (gun.KIND === null || gun.TOP_H <= X.CEIL_H),
    `floors: 30 up by the shortest lower texture (${shortest}), 140 by 512, 131 to the next at speed 4, and shooting 24 raises it`);

  // ceilings
  await reset();
  const top = Math.max(X.CEIL_H, await nb('max_ceil'));
  await fire(40);
  const raised = await until((s) => s.KIND === null);
  await reset();
  const lowering = await fire(41, 'use');
  const down = await until((s) => s.KIND === null);
  assert(raised.CEIL_H === top && lowering.STAY === 1 && down.CEIL_H === down.FLOOR_H,
    `ceilings: 40 up to the highest ceiling around (${top}) and stops; 41 down to the floor`);

  // turbo stairs
  await reset();
  const st16 = await fire(100);
  assert(st16.TOP_H === X.FLOOR_H + 16 && st16.SPEED === 4, `100: stairs in steps of 16, four times as fast`);

  // the donut
  await reset();
  const s2 = (await one(`SELECT FIRST 1 IIF(l.front_sector = ${X.ID}, l.back_sector, l.front_sector) s FROM linedefs l
      WHERE (l.front_sector = ${X.ID} OR l.back_sector = ${X.ID}) AND l.back_sector IS NOT NULL ORDER BY l.id`)).S;
  await db.exec(`UPDATE linedefs SET special = 9, tag = 999 WHERE id = ${L.ID}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${L.ID}, 'use')`);
  const ring = await one(`SELECT m.top_h, m.new_flat, m.speed FROM movers m WHERE m.sector_id = ${s2}`);
  const hole = await state();
  assert((ring == null || (ring.SPEED === 0.5 && ring.NEW_FLAT !== null)) && (hole.KIND === null || hole.SPEED === 0.5)
      && (ring == null || hole.KIND === null || ring.TOP_H === hole.TOP_H),
    `9: the donut – the ring and the hole move to the same height at half speed, the ring taking the outer flat`);
  await db.exec(`DELETE FROM movers WHERE sector_id = ${s2}`);

  // a walk line doesn't answer USE, nor a switch a step
  await reset();
  const wrong = await fire(13, 'use');
  const wrong2 = await fire(138, 'walk');
  assert(wrong.LIGHT === X.LIGHT && wrong2.LIGHT === X.LIGHT, 'a walk-over special ignores USE, and a switch ignores walking over it');
  await reset();
  await db.exec(`UPDATE sectors SET tag = 0 WHERE id = ${X.ID}`);
  await db.exec(`UPDATE linedefs SET special = 0, tag = 0 WHERE id = ${L.ID}`);
}

// ── monsters crossing lines, and telefrags ───────────────────────────────
{
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  await db.exec('UPDATE player SET health = 100, god = 0, invuln_tics = 0');
  // a teleporter: a destination (thing 14) in an empty sector tagged 777, and a two-sided line given the special
  const D = await one(`SELECT FIRST 1 s.id FROM sectors s WHERE s.tag = 0 AND s.ceil_h - s.floor_h >= 72
      AND NOT EXISTS (SELECT 1 FROM things t WHERE t.sector_id = s.id) ORDER BY s.id DESC`);
  await db.exec(`UPDATE sectors SET tag = 777 WHERE id = ${D.ID}`);
  const dp = await inside(D.ID);
  await spawn(14, dp.X, dp.Y);
  const T = await one(`SELECT FIRST 1 l.id, l.x1, l.y1, l.dx, l.dy, l.len FROM linedefs l
      WHERE l.back_sector IS NOT NULL AND l.special = 0 AND l.len >= 64
        AND l.front_sector <> ${D.ID} AND l.back_sector <> ${D.ID} ORDER BY l.id`);
  const mx = T.X1 + T.DX / 2;
  const my = T.Y1 + T.DY / 2;
  const nx = T.DY / T.LEN;
  const ny = -T.DX / T.LEN;
  const front = [mx + nx * 4, my + ny * 4];
  const back = [mx - nx * 4, my - ny * 4];
  const special = (sp) => db.exec(`UPDATE linedefs SET special = ${sp}, tag = 777 WHERE id = ${T.ID}`);
  const cross = (id, [ax, ay], [bx, by]) => one(`EXECUTE BLOCK RETURNS (t SMALLINT) AS BEGIN
      EXECUTE PROCEDURE monster_cross(${id}, ${ax}, ${ay}, ${bx}, ${by}) RETURNING_VALUES t; SUSPEND; END`).then((r) => r.T);
  const at = (id) => one(`SELECT x, y, st, hp FROM things WHERE id = ${id}`);
  const place = (id, [x, y]) => db.exec(`UPDATE things SET x = ${x}, y = ${y}, sector_id = sector_at(${x}, ${y}), st = 'chase' WHERE id = ${id}`);

  await special(97);
  const imp = await spawn(3001, ...front);
  await db.exec('DELETE FROM sound_events');
  const fogs0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9016')).N;
  const went = await cross(imp, front, back);
  const there = await at(imp);
  const fogs = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9016')).N - fogs0;
  const zaps = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSTELEPT'`)).N;
  assert(went === 1 && Math.abs(there.X - dp.X) < 1e-6 && Math.abs(there.Y - dp.Y) < 1e-6 && fogs === 2 && zaps === 2,
    `a monster walking over teleporter 97 lands on the destination, with fog and a zap at both ends (${fogs}, ${zaps})`);
  const imp2 = await spawn(3001, ...back);
  const fromBack = await cross(imp2, back, front);
  await place(imp2, front);
  const blocked = await cross(imp2, front, back);
  assert(fromBack === 0 && blocked === 0 && (await at(imp)).ST !== 'dead',
    'crossed from the back it stays put; and with a monster standing on the destination, another can\'t follow (not on MAP30)');

  // the player telefrags whatever is there, and stands still for 18 tics
  const p0 = await one(`SELECT t.id FROM things t WHERE t.kind = 'player'`);
  await db.exec(`UPDATE things SET hp = 1000 WHERE id = ${imp}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${T.ID}, 'walk')`);
  const fragged = await at(imp);
  const me = await one(`SELECT x, y, reaction FROM things WHERE id = ${p0.ID}`);
  await db.query('SELECT * FROM doom_tic(1, 1, 0, 0.3, 0, 0, 0, 1)');
  const still = await one(`SELECT x, y, angle, reaction FROM things WHERE id = ${p0.ID}`);
  assert(['dying', 'dead'].includes(fragged.ST) && Math.abs(me.X - dp.X) < 1e-6 && me.REACTION === 18
      && still.X === me.X && still.Y === me.Y && still.REACTION === 17,
    `the player's teleport telefrags the monster on the destination (${fragged.ST}, from 1000 hp) and holds still for 18 tics`);

  // 125 is the monsters' own (and a W1: spent once used)
  await special(125);
  await db.exec(`UPDATE things SET x = ${back[0]}, y = ${back[1]}, sector_id = sector_at(${back[0]}, ${back[1]}), reaction = 0 WHERE id = ${p0.ID}`);
  await db.exec(`EXECUTE PROCEDURE activate_line(${T.ID}, 'walk')`);
  const pStay = await one(`SELECT x FROM things WHERE id = ${p0.ID}`);
  await db.exec(`DELETE FROM things WHERE id IN (${imp})`);
  await place(imp2, front);
  const m125 = await cross(imp2, front, back);
  const spent = (await one(`SELECT special FROM linedefs WHERE id = ${T.ID}`)).SPECIAL;
  // (a double sent as text can come back a bit off: compare with a tolerance)
  assert(Math.abs(pStay.X - back[0]) < 1e-9 && m125 === 1 && spent === 0, 'teleporter 125 ignores the player, takes a monster, and is spent');

  // a monster walking over a door the player would open (2) does nothing; over lift 10 it starts it
  const lift = await one(`SELECT FIRST 1 s.id FROM sectors s WHERE s.tag = 0 AND s.id <> ${D.ID}
      AND neighbor_h(s.id, 'min_floor') < s.floor_h ORDER BY s.id`);
  if (lift) {
    await db.exec(`UPDATE sectors SET tag = 778 WHERE id = ${lift.ID}`);
    await db.exec(`UPDATE linedefs SET special = 2, tag = 778 WHERE id = ${T.ID}`);
    await place(imp2, front);
    await cross(imp2, front, back);
    const no = (await one(`SELECT COUNT(*) n FROM movers WHERE sector_id = ${lift.ID}`)).N;
    await db.exec(`UPDATE linedefs SET special = 10 WHERE id = ${T.ID}`);
    await cross(imp2, front, back);
    const yes = await one(`SELECT kind FROM movers WHERE sector_id = ${lift.ID}`);
    assert(no === 0 && yes?.KIND === 'lift', 'walking over line 2 a monster opens nothing; over lift 10 it sets the lift off');
    await db.exec(`DELETE FROM movers WHERE sector_id = ${lift.ID}`);
    await db.exec(`UPDATE sectors SET tag = 0 WHERE id = ${lift.ID}`);
  }
  await db.exec(`UPDATE linedefs SET special = 0, tag = 0 WHERE id = ${T.ID}`);

  // bumping into a closed door (1) opens it; it never closes one, and leaves secret doors alone
  const door = await one(`SELECT FIRST 1 l.id, l.x1, l.y1, l.dx, l.dy, l.len, l.back_sector b, l.flags FROM linedefs l
      JOIN sectors s ON s.id = l.back_sector WHERE l.special = 1 AND s.ceil_h <= s.floor_h AND l.len >= 48 ORDER BY l.id`);
  if (door) {
    const dmx = door.X1 + door.DX / 2;
    const dmy = door.Y1 + door.DY / 2;
    const ux = door.DY / door.LEN;
    const uy = -door.DX / door.LEN;
    const sx = dmx + ux * 24;
    const sy = dmy + uy * 24;
    // the eight-way heading most nearly into the door
    const hd = ((Math.round(Math.atan2(-uy, -ux) / (Math.PI / 4)) % 8) + 8) % 8;
    await place(imp2, [sx, sy]);
    const bump = () => one(`EXECUTE BLOCK RETURNS (ok SMALLINT, b SMALLINT) AS
        DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE sec INTEGER;
        BEGIN EXECUTE PROCEDURE p_move(${imp2}, ${sx}, ${sy}, (SELECT floor_h FROM sectors WHERE id = sector_at(${sx}, ${sy})), 20, 56, 8, 0, 0, ${hd})
          RETURNING_VALUES ok, nx, ny, nz, sec, b; SUSPEND; END`);
    const first = await bump();
    const opening = await one(`SELECT dir FROM movers WHERE sector_id = ${door.B}`);
    await bump();
    const again = await one(`SELECT dir FROM movers WHERE sector_id = ${door.B}`);
    await db.exec(`DELETE FROM movers WHERE sector_id = ${door.B}`);
    await db.exec(`UPDATE sectors SET ceil_h = floor_h WHERE id = ${door.B}`);
    await db.exec(`UPDATE linedefs SET flags = BIN_OR(flags, 32) WHERE id = ${door.ID}`);
    const secret = await bump();
    const none = (await one(`SELECT COUNT(*) n FROM movers WHERE sector_id = ${door.B}`)).N;
    await db.exec(`UPDATE linedefs SET flags = ${door.FLAGS} WHERE id = ${door.ID}`);
    assert(first.OK === 1 && first.B === 1 && opening?.DIR === 1 && again?.DIR === 1 && secret.B === 0 && none === 0,
      'a monster bumping a closed door (1) opens it and waits; bumping again doesn\'t close it; a secret door stays shut');
  } else console.log('(no closed door 1 on this map)');
  await db.exec(`UPDATE sectors SET tag = 0 WHERE id = ${D.ID}`);
  await db.exec(`DELETE FROM things WHERE thing_type = 14 AND x = ${dp.X} AND y = ${dp.Y}`);
  await db.exec(`DELETE FROM things WHERE id = ${imp2}`);
}

// ── a scrolling wall (48) in the renderer ───────────────────────────────
{
  const { Renderer } = await import('../src/renderer.js');
  await loadMap(db, wad, res, maps[0], { skill: 3 });
  await quiet();
  const arr = { rowMode: 'array' };
  const hud = (await tic()).rows[0];
  const walls = (await db.query('SELECT * FROM frame_walls', [], arr)).rows;
  const map = { skyTex: 0 };
  map.lines = new Map((await db.query('SELECT id, front_side, back_side, flags, light_delta FROM linedefs', [], arr)).rows
    .map((r) => [r[0], { fs: r[1], bs: r[2], flags: r[3], lightDelta: r[4], scroll: false }]));
  map.sides = new Map((await db.query('SELECT id, xoff, yoff, upper_tex, lower_tex, mid_tex, sector_id FROM sidedefs', [], arr)).rows
    .map((r) => [r[0], { xoff: r[1], yoff: r[2], upper: r[3], lower: r[4], mid: r[5], sector: r[6] }]));
  map.sectors = new Map((await db.query('SELECT * FROM frame_sectors', [], arr)).rows
    .map((r) => [r[0], { floor: r[1], ceil: r[2], floorFlat: r[3], ceilFlat: r[4], light: r[5], sky: r[6] === 1 }]));
  // the solid wall (one-sided, textured) that fills most of the view
  const count = new Map();
  for (const w of walls) {
    const ln = map.lines.get(w[3]);
    if (!w[4] && ln.bs == null && map.sides.get(ln.fs).mid > 0) count.set(w[3], (count.get(w[3]) ?? 0) + 1);
  }
  const lineId = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const line = map.lines.get(lineId);
  const side = map.sides.get(line.fs);
  const x0 = side.xoff;
  const r = new Renderer(wad, res);
  const frame = (scroll, extra) => {
    line.scroll = scroll;
    side.xoff = x0 + extra;
    r.drawView({ x: hud.PX, y: hud.PY, z: hud.VIEW_Z, angle: hud.PANGLE, tic: 37, palette: 0, fixedColormap: null }, walls, [], map);
    return Buffer.from(r.fb).toString('base64');
  };
  const scrolled = frame(true, 0);
  const byHand = frame(false, 37);
  const plain = frame(false, 0);
  assert(scrolled === byHand && scrolled !== plain,
    `line 48: at tic 37 its front side is drawn 37 units along (line ${lineId}, ${count.get(lineId)} columns), exactly as if its offset were 37 more`);
}

// ── the computer area map ───────────────────────────────────────────────
{
  const sp = await one(`SELECT t.x, t.y FROM things t WHERE t.kind = 'player'`);
  await db.exec('DELETE FROM sound_events');
  await spawn(2026, sp.X, sp.Y);
  const got = (await tic()).rows[0];
  const pow = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSGETPOW'`)).N;
  assert(got.ALLMAP === 1 && pow > 0, `the computer area map: allmap ${got.ALLMAP}`);
  const second = await spawn(2026, sp.X, sp.Y);
  await tic();
  assert((await one(`SELECT COUNT(*) n FROM things WHERE id = ${second}`)).N === 1, '…and a second one stays where it lies (P_GivePower)');
  await loadMap(db, wad, res, maps[0]);
  assert((await tic()).rows[0].ALLMAP === 0, '…and the next level starts without it');

  // AM_drawWalls: seen lines in their colours, unseen ones grey with the map, else hidden
  const { automapColor, AM_COLORS } = await import('../src/automap.js');
  const room = { floor: 0, ceil: 128 };
  const step = { floor: 24, ceil: 128 };
  const cases = [
    [automapColor({ flags: 1, special: 0 }, room, null, true, false), AM_COLORS.wall, 'a seen wall is red'],
    [automapColor({ flags: 4, special: 0 }, room, step, true, false), AM_COLORS.floor, 'a seen step is brown'],
    [automapColor({ flags: 4, special: 0 }, room, room, true, false), null, 'a seen flat opening is left out'],
    [automapColor({ flags: 36, special: 0 }, room, step, true, false), AM_COLORS.wall, 'a secret line passes for a wall'],
    [automapColor({ flags: 4, special: 39 }, room, room, true, false), AM_COLORS.teleport, 'a teleporter line is dark red'],
    [automapColor({ flags: 1, special: 0 }, room, null, false, false), null, 'an unseen wall is hidden'],
    [automapColor({ flags: 1, special: 0 }, room, null, false, true), AM_COLORS.unseen, '…grey with the computer map'],
    [automapColor({ flags: 4, special: 0 }, room, room, false, true), AM_COLORS.unseen, '…openings too'],
    [automapColor({ flags: 129, special: 0 }, room, null, true, true), null, 'ML_DONTDRAW never shows'],
    [automapColor({ flags: 257, special: 0 }, room, null, false, false), AM_COLORS.wall, 'ML_MAPPED shows unseen'],
    // IDDT
    [automapColor({ flags: 1, special: 0 }, room, null, false, false, 1), AM_COLORS.wall, 'IDDT shows unseen walls in colour'],
    [automapColor({ flags: 4, special: 0 }, room, step, false, false, 1), AM_COLORS.floor, '…and unseen steps'],
    [automapColor({ flags: 4, special: 0 }, room, room, false, false, 1), AM_COLORS.twoSided, '…and flat openings, in grey'],
    [automapColor({ flags: 129, special: 0 }, room, null, false, false, 2), AM_COLORS.wall, '…and even ML_DONTDRAW lines'],
  ];
  const { makeCheatReader, makeParamCheatReader, clevMap, idmusMap } = await import('../src/cheats.js');
  const reader = makeCheatReader('iddt');
  const fired = [...'xidxiddtwidd', 'Shift', ...'T'].map((k) => reader(k));
  cases.push([fired.indexOf(true), 7, 'the cheat reader fires on the t of "iddt"'],
    [fired.filter(Boolean).length, 2, '…and again on "idd" + Shift + "T" (case-blind, modifiers ignored)']);
  const bad = cases.filter(([got, want]) => got !== want).map(([, , what]) => what);
  assert(bad.length === 0, `automap colours (${cases.length} cases${bad.length ? `; wrong: ${bad.join(', ')}` : ''})`);

  // IDCLEV: the code, then two digits; DOOM I reads episode + map, DOOM II the map number
  const clev = makeParamCheatReader('idclev', 2);
  const clevGot = [...'xxidclev', 'Shift', ...'13'].map((k) => clev(k)).filter(Boolean);
  const d1 = ['E1M1', 'E1M2', 'E1M3', 'E2M1'];
  const d2 = ['MAP01', 'MAP07', 'MAP30'];
  const clevCases = [
    [clevGot.join(), '13', 'IDCLEV collects the two digits after the code'],
    [clevMap('13', d1), 'E1M3', 'DOOM I: 13 is E1M3'],
    [clevMap('07', d2), 'MAP07', 'DOOM II: 07 is MAP07'],
    [clevMap('19', d1), null, 'a map the WAD lacks is ignored'],
    [clevMap('4x', d1), null, 'so is anything but two digits'],
    // IDMUS: vanilla's range rules ("IMPOSSIBLE SELECTION" past them)
    [idmusMap('13', false), 'E1M3', 'IDMUS 13 on DOOM I: E1M3\'s song'],
    [idmusMap('45', false), 'E4M5', '…as far as the 32nd song, E4M5'],
    [idmusMap('46', false), null, '…but no further'],
    [idmusMap('10', false), null, '…and no map 0'],
    [idmusMap('35', true), 'MAP35', 'IDMUS 35 on DOOM II: the 35th song'],
    [idmusMap('36', true), null, '…but not a 36th'],
  ];
  // DOOM II's secret levels, against this WAD: IDCLEV 31/32 reach MAP31/MAP32, and IDMUS
  // 31–35 play EVIL, ULTIMA and the three non-level songs
  if (maps.includes('MAP31')) {
    const { musicLumpFor } = await import('../src/audio.js');
    const song = (d) => { const l = musicLumpFor(idmusMap(d, true)); return l && wad.lump(l) ? l : null; };
    clevCases.push(
      [clevMap('31', maps), 'MAP31', 'IDCLEV 31: MAP31, the first secret level'],
      [clevMap('32', maps), 'MAP32', 'IDCLEV 32: MAP32, the second'],
      [clevMap('33', maps), null, 'IDCLEV 33: no such map'],
      [song('31'), 'D_EVIL', 'IDMUS 31: D_EVIL'],
      [song('32'), 'D_ULTIMA', 'IDMUS 32: D_ULTIMA'],
      [song('33'), 'D_READ_M', 'IDMUS 33: D_READ_M (the story screens)'],
      [song('34'), 'D_DM2TTL', 'IDMUS 34: D_DM2TTL (the title)'],
      [song('35'), 'D_DM2INT', 'IDMUS 35: D_DM2INT (the intermission)'],
    );
  }
  const clevBad = clevCases.filter(([g, w]) => g !== w).map(([, , what]) => what);
  assert(clevBad.length === 0, `IDCLEV parsing (${clevCases.length} cases${clevBad.length ? `; wrong: ${clevBad.join(', ')}` : ''})`);
}

// ── which map comes next (G_DoCompleted) ─────────────────────────────────
{
  const { nextMap } = await import('../src/progress.js');
  const d1 = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M8', 'E1M9', 'E2M1', 'E2M5', 'E2M6', 'E2M9'];
  const d2 = Array.from({ length: 32 }, (_, i) => `MAP${String(i + 1).padStart(2, '0')}`);
  const cases = [
    [nextMap('E1M1', false, d1), 'E1M2', 'E1M1 → E1M2'],
    [nextMap('E1M3', true, d1), 'E1M9', 'E1M3, secret exit → E1M9'],
    [nextMap('E1M9', false, d1), 'E1M4', 'E1M9 → E1M4, after the secret exit\'s map'],
    [nextMap('E1M8', false, d1), 'E2M1', 'E1M8 → the next episode'],
    [nextMap('E2M9', false, d1), 'E2M6', 'E2M9 → E2M6'],
    [nextMap('MAP01', false, d2), 'MAP02', 'MAP01 → MAP02'],
    [nextMap('MAP15', false, d2), 'MAP16', 'MAP15, normal exit → MAP16'],
    [nextMap('MAP15', true, d2), 'MAP31', 'MAP15, secret exit → MAP31'],
    [nextMap('MAP31', true, d2), 'MAP32', 'MAP31, secret exit → MAP32'],
    [nextMap('MAP31', false, d2), 'MAP16', 'MAP31, normal exit → back to MAP16'],
    [nextMap('MAP32', false, d2), 'MAP16', 'MAP32 → back to MAP16'],
    [nextMap('MAP07', true, d2), 'MAP08', 'a secret exit elsewhere is a plain one'],
    [nextMap('MAP30', false, d2), 'MAP01', 'MAP30 ends the game: back to MAP01'],
    [nextMap('MAP15', true, d2.slice(0, 30)), 'MAP01', 'no MAP31 in the WAD: the first map'],
  ];
  const bad = cases.filter(([g, w]) => g !== w).map(([g, , what]) => `${what} (got ${g})`);
  assert(bad.length === 0, `map order (${cases.length} cases${bad.length ? `; wrong: ${bad.join(', ')}` : ''})`);

  // in this WAD: MAP15's and MAP31's secret exit lines really do raise the secret exit
  for (const [m, to] of [['MAP15', 'MAP31'], ['MAP31', 'MAP32']]) {
    if (!maps.includes(m)) continue;
    await loadMap(db, wad, res, m);
    const l = await one(`SELECT FIRST 1 l.id FROM linedefs l WHERE l.special IN (51, 124) ORDER BY l.id`);
    if (!l) { assert(false, `${m} has a secret exit line`); continue; }
    await db.exec(`EXECUTE PROCEDURE activate_line(${l.ID}, ${(await one(`SELECT special FROM linedefs WHERE id = ${l.ID}`)).SPECIAL === 124 ? "'walk'" : "'use'"})`);
    const kind = (await one('SELECT exit_kind FROM game')).EXIT_KIND;
    assert(kind === 2 && nextMap(m, kind === 2, maps) === to, `${m}: its secret exit (line ${l.ID}) leads to ${nextMap(m, kind === 2, maps)}`);
  }
}

// ── IDCLIP: through a wall and out the other side ───────────────────────
{
  await loadMap(db, wad, res, maps[0]);
  await quiet();
  // a long one-sided wall with room in front of it
  const walls = (await db.query(`SELECT l.id, l.x1, l.y1, l.dx, l.dy, l.len FROM linedefs l
                                  WHERE l.back_sector IS NULL AND l.len > 160 ORDER BY l.len DESC`)).rows;
  let spot = null;
  for (const l of walls.slice(0, 40)) {
    const nx = l.DY / l.LEN;         // the front side is on the right of v1 → v2
    const ny = -l.DX / l.LEN;
    const x = l.X1 + l.DX / 2 + nx * 40;
    const y = l.Y1 + l.DY / 2 + ny * 40;
    const ok = (await db.query(`EXECUTE BLOCK RETURNS (ok SMALLINT) AS
        DECLARE fz DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
        BEGIN
          EXECUTE PROCEDURE check_position(-1, ${x}, ${y}, (SELECT floor_h FROM sectors WHERE id = sector_at(${x}, ${y})), 16, 56, 0)
            RETURNING_VALUES ok, fz, cz, dz, sec;
          SUSPEND;
        END`)).rows[0].OK;
    if (ok === 1) { spot = { l, x, y, ang: Math.atan2(-ny, -nx) }; break; }
  }
  if (spot) {
    const side = async () => {
      const p = await one(`SELECT x, y FROM things WHERE kind = 'player'`);
      return Math.sign(spot.l.DX * (p.Y - spot.l.Y1) - spot.l.DY * (p.X - spot.l.X1));
    };
    const walkAtWall = async () => {
      await db.exec(`UPDATE things SET x = ${spot.x}, y = ${spot.y}, momx = 0, momy = 0, angle = ${spot.ang},
                     z = (SELECT floor_h FROM sectors WHERE id = sector_at(${spot.x}, ${spot.y})),
                     sector_id = sector_at(${spot.x}, ${spot.y}) WHERE kind = 'player'`);
      const before = await side();
      for (let i = 0; i < 25; i++) await db.query('SELECT * FROM doom_tic(1, 1, 0, 0, 0, 0, 0, 0)');
      return before !== (await side());
    };
    const blocked = await walkAtWall();
    await db.exec(`EXECUTE PROCEDURE cheat('idclip')`);
    const on = (await tic()).rows[0];
    const through = await walkAtWall();
    await db.exec(`EXECUTE PROCEDURE cheat('idclip')`);
    const off = (await tic()).rows[0];
    const blockedAgain = await walkAtWall();
    assert(!blocked && on.MSG === 'No Clipping Mode ON' && through && off.MSG === 'No Clipping Mode OFF' && !blockedAgain,
      `IDCLIP: line ${spot.l.ID} stops you (${!blocked}), with no clipping you walk through it (${through}), and then it stops you again (${!blockedAgain})`);
  } else console.log('(no wall to walk through)');
}

await db.close();
console.log(failures ? `${failures} failure(s)` : 'physics ok');
process.exit(failures ? 1 : 0);
