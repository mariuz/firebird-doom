// specials-test.mjs – hanging decorations, Commander Keen, the Icon of Sin
// and the boss-death specials, in the real engine.
//
//   node scripts/specials-test.mjs                       (Phase 1: hangers, E1M8/E2M8)
//   WAD=public/wads/freedoom2.wad node scripts/specials-test.mjs   (adds Keen, MAP07, MAP30)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://specials', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const maps = wad.mapNames();

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const tics = async (n) => { for (let i = 0; i < n; i += 4) await db.query('SELECT * FROM doom_tic(4, 0, 0, 0, 0, 0, 0, 0)'); };
const one = async (q) => (await db.query(q)).rows[0];
// keep the player out of trouble while we watch
const godMode = () => db.exec(`UPDATE player SET health = 100000`);

// ── hanging decorations ────────────────────────────────────────────────
const hangMap = maps.find((m) => wad.map(m).things.some((t) => [49, 50, 51, 52, 53, 59, 60, 61, 62, 63, 73, 74, 75, 76, 77, 78].includes(t.type)));
await loadMap(db, wad, res, hangMap);
const h = await one(`SELECT COUNT(*) n, SUM(IIF(ABS(t.z + t.height - s.ceil_h) < 0.01, 1, 0)) at_ceiling
                       FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                       JOIN sectors s ON s.id = t.sector_id WHERE tt.hang = 1`);
assert(h.N > 0 && h.N === h.AT_CEILING, `${hangMap}: all ${h.N} hanging things hang from the ceiling`);

// ── boss deaths ────────────────────────────────────────────────────────
async function bossTest(map, ttype, expect) {
  if (!maps.includes(map) || !wad.map(map).things.some((t) => t.type === ttype)) return;
  await loadMap(db, wad, res, map);
  await godMode();
  const n = (await one(`SELECT COUNT(*) n FROM things WHERE thing_type = ${ttype}`)).N;
  const tag = ttype === 68 ? 667 : 666;
  const tagged = (await one(`SELECT COUNT(*) n FROM sectors WHERE tag = ${tag}`)).N;
  if (n === 0 || (expect !== 'exit' && tagged === 0)) {
    // e.g. multiplayer-only arachnotrons, or a map without the tagged sector
    console.log(`(${map}: ${n} of type ${ttype} in single player, ${tagged} sectors tagged ${tag}; nothing to trigger)`);
    return;
  }
  await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
      FOR SELECT id FROM things WHERE thing_type = ${ttype} INTO id DO EXECUTE PROCEDURE damage_thing(id, 100000); END`);
  await tics(80);
  const g = await one(`SELECT g.exit_kind, (SELECT COUNT(*) FROM movers) movers FROM game g`);
  if (expect === 'exit') assert(g.EXIT_KIND === 1, `${map}: killing all ${n} of type ${ttype} ends the level`);
  else assert(g.MOVERS > 0, `${map}: killing all ${n} of type ${ttype} moves the tagged sectors (${g.MOVERS})`);
}
await bossTest('E1M8', 3003, 'floor');
await bossTest('E2M8', 16, 'exit');
await bossTest('E3M8', 7, 'exit');
await bossTest('E4M8', 7, 'floor');
await bossTest('MAP07', 67, 'floor');
await bossTest('MAP07', 68, 'floor');

// ── Commander Keen ─────────────────────────────────────────────────────
const keenMap = maps.find((m) => wad.map(m).things.some((t) => t.type === 72) && wad.map(m).sectors.some((s) => s.tag === 666));
if (keenMap && wad.lump('KEENA0')) {
  await loadMap(db, wad, res, keenMap);
  await godMode();
  const k = await one(`SELECT COUNT(*) n, MIN(t.z + t.height - s.ceil_h) gap FROM things t JOIN sectors s ON s.id = t.sector_id WHERE t.kind = 'keen'`);
  assert(k.N > 0 && Math.abs(k.GAP) < 0.01, `${keenMap}: ${k.N} Keens hanging from the ceiling`);
  const door = await one(`SELECT FIRST 1 id, ceil_h FROM sectors WHERE tag = 666`);
  await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
      FOR SELECT id FROM things WHERE kind = 'keen' INTO id DO EXECUTE PROCEDURE damage_thing(id, 1000); END`);
  await tics(140);
  const after = await one(`SELECT ceil_h FROM sectors WHERE id = ${door.ID}`);
  const kills = await one(`SELECT kills FROM player`);
  assert(after.CEIL_H > door.CEIL_H, `${keenMap}: the last Keen opens the 666 door (ceiling ${door.CEIL_H} → ${after.CEIL_H})`);
  assert(kills.KILLS >= k.N, `${keenMap}: Keens count as kills (${kills.KILLS})`);
} else console.log('(no Commander Keen in this WAD)');

// ── the Icon of Sin ────────────────────────────────────────────────────
const iconMap = maps.find((m) => wad.map(m).things.some((t) => t.type === 88) && wad.map(m).things.some((t) => t.type === 89));
if (iconMap && wad.lump('BBRNA0')) {
  await loadMap(db, wad, res, iconMap);
  await godMode();
  const before = (await one(`SELECT COUNT(*) n FROM things WHERE kind = 'monster'`)).N;
  await tics(140);
  const cubes = (await one(`SELECT COUNT(*) n FROM things WHERE kind = 'cube'`)).N;
  const spit = (await one(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSBOSPIT'`)).N;
  assert(cubes > 0 && spit > 0, `${iconMap}: the shooter spits a cube (${cubes} in flight)`);
  await tics(500);
  const after = (await one(`SELECT COUNT(*) n FROM things WHERE kind = 'monster'`)).N;
  assert(after > before, `${iconMap}: cubes land and turn into monsters (${before} → ${after})`);
  const brain = await one(`SELECT id FROM things WHERE kind = 'brain'`);
  await db.exec(`EXECUTE PROCEDURE damage_thing(${brain.ID}, 1000)`);
  await tics(60);
  const fx = (await one(`SELECT COUNT(*) n FROM things WHERE thing_type = 9013`)).N;
  assert(fx > 0, `${iconMap}: the brain dies in a storm of explosions (${fx} on screen)`);
  await tics(60);
  assert((await one('SELECT exit_kind FROM game')).EXIT_KIND === 1, `${iconMap}: killing the brain ends the game`);
} else console.log('(no Icon of Sin in this WAD)');

// ── revenant tracers and the mancubus's three volleys ──────────────────
if (wad.lump('FATTA1') || wad.lump('FATTA1D1') || wad.spriteFrames().some((f) => f.sprite === 'FATT')) {
  let p;
  /** An open spot at distance d from the player that can see it. */
  async function openSpot(d) {
    for (let k = 0; k < 32; k++) {
      const a = (k * Math.PI) / 16;
      const x = p.X + Math.cos(a) * d;
      const y = p.Y + Math.sin(a) * d;
      const r = (await db.query(`EXECUTE BLOCK RETURNS (ok SMALLINT, fz DOUBLE PRECISION, seen SMALLINT) AS
          DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
          BEGIN
            EXECUTE PROCEDURE check_position(-1, ${x}, ${y}, (SELECT floor_h FROM sectors WHERE id = sector_at(${x}, ${y})), 48, 64, 1)
              RETURNING_VALUES ok, fz, cz, dz, sec;
            seen = check_sight(${x}, ${y}, fz + 40, ${p.X}, ${p.Y}, ${p.Z} + 40);
            SUSPEND;
          END`)).rows[0];
      if (r.OK === 1 && r.SEEN === 1 && Math.abs(r.FZ - p.Z) < 24) return { x, y, z: r.FZ, a };
    }
    return null;
  }
  // find a map whose start has room: a spot 400 units out for a mancubus
  let s2 = null;
  for (const name of maps.slice(0, 12)) {
    await loadMap(db, wad, res, name);
    await godMode();
    await db.exec(`UPDATE things SET hp = 1000000, st = 'dead' WHERE kind = 'monster'`); // keep the room quiet
    p = await one(`SELECT t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`);
    if ((s2 = await openSpot(400))) { console.log(`(volley and tracer tests on ${name})`); break; }
  }
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // a revenant missile launched 60° off target turns 16.875° per update, then hits
  if (s2) {
    const fire = async (off) => {
      const bearing = Math.atan2(p.Y - s2.y, p.X - s2.x);
      const heading = bearing + off;
      await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
          EXECUTE PROCEDURE spawn_thing(9006, ${s2.x}, ${s2.y}, ${s2.z + 32}, ${heading}) RETURNING_VALUES id;
          UPDATE things SET momx = ${Math.cos(heading) * 10}, momy = ${Math.sin(heading) * 10} WHERE id = :id;
        END`);
    };
    const err = (m) => Math.abs(norm(Math.atan2(p.Y - m.Y, p.X - m.X) - m.ANGLE));
    await fire(Math.PI / 3);
    const turns = [];
    let last = null;
    for (let i = 0; i < 9; i++) {
      await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 0, 0, 0, 0)');
      const m = await one(`SELECT x, y, angle FROM things WHERE thing_type = 9006 AND st = 'fly'`);
      if (!m) break;
      if (last !== null && Math.abs(m.ANGLE - last) > 1e-6) turns.push(Math.abs(norm(m.ANGLE - last)) * 180 / Math.PI);
      last = m.ANGLE;
    }
    assert(turns.length >= 1 && turns.every((d) => Math.abs(d - 16.875) < 0.01),
      `revenant missile turns TRACEANGLE per update (${turns.map((d) => d.toFixed(3)).join('°, ')}°)`);
    await db.exec("DELETE FROM things WHERE thing_type IN (9006, 9010)");
    const hp0 = (await one('SELECT health FROM player')).HEALTH;
    await fire(Math.PI / 6);
    for (let i = 0; i < 60; i++) await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 0, 0, 0, 0)');
    const hp1 = (await one('SELECT health FROM player')).HEALTH;
    assert(hp1 < hp0, `a revenant missile 30° off still finds the player (${hp0 - hp1} damage)`);
  } else console.log('(no open spot for the revenant test)');

  // a mancubus attack: three volleys, six fireballs, DOOM's spread
  if (s2) {
    await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
        EXECUTE PROCEDURE spawn_thing(67, ${s2.x}, ${s2.y}, ${s2.z}, 0) RETURNING_VALUES id;
        UPDATE things SET st = 'attack', st_len = 80, st_tics = 80, reaction = 0 WHERE id = :id;
      END`);
    const aim = Math.atan2(p.Y - s2.y, p.X - s2.x);
    const seen = new Map();
    for (let i = 0; i < 82; i++) {
      await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 0, 0, 0, 0)');
      for (const m of (await db.query(`SELECT id, angle FROM things WHERE thing_type = 9007`)).rows) {
        if (!seen.has(m.ID)) seen.set(m.ID, Math.round((norm(m.ANGLE - aim) * 180) / Math.PI * 10) / 10);
      }
    }
    const offsets = [...seen.values()].sort((a, b) => a - b);
    const want = [-22.5, -5.6, 0, 0, 5.6, 11.3];
    assert(offsets.length === 6 && offsets.every((o, i) => Math.abs(o - want[i]) < 0.3),
      `mancubus fires 3 volleys of 2 (offsets ${offsets.join(', ')}°; DOOM: ${want.join(', ')}°)`);
  } else console.log('(no open spot for the mancubus test)');
}

await db.close();
console.log(failures ? `${failures} failure(s)` : 'specials ok');
process.exit(failures ? 1 : 0);
