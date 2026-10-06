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
  } else console.log('(no open run from the player start for the infighting tests)');
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
