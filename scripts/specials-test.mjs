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

await db.close();
console.log(failures ? `${failures} failure(s)` : 'specials ok');
process.exit(failures ? 1 : 0);
