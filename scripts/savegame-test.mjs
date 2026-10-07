// savegame-test.mjs – save, play on, load: the game comes back exactly as it was.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { captureGame, restoreGame, saveStore, mantissaExponent, SAVE_VERSION } from '../src/savegame.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://savegame', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const map = wad.mapNames()[0];

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const tic = (fwd = 0, turn = 0, fire = 0, use = 0) => db.query(`SELECT * FROM doom_tic(1, ${fwd}, 0, ${turn}, ${fire}, ${use}, 0, 0)`).then((r) => r.rows[0]);
const one = async (q) => (await db.query(q)).rows[0];

// play a while on skill 4: walk, turn, shoot, push at walls; kill a monster outright; open a door
await loadMap(db, wad, res, map, { skill: 4 });
await db.exec('UPDATE player SET health = 1000');
for (let i = 0; i < 70; i++) await tic(1, i % 20 < 10 ? 0.05 : -0.05, i % 7 === 0 ? 1 : 0, i % 15 === 0 ? 1 : 0);
const victim = await one("SELECT FIRST 1 id FROM things WHERE kind = 'monster' AND st <> 'dead' ORDER BY id");
await db.exec(`EXECUTE PROCEDURE damage_thing(${victim.ID}, 100000)`);
const door = await one('SELECT FIRST 1 id FROM linedefs WHERE special = 1 ORDER BY id');
if (door) await db.exec(`EXECUTE PROCEDURE activate_line(${door.ID}, 'use')`);
for (let i = 0; i < 20; i++) await tic(0, 0.1);
await db.exec("UPDATE sidedefs SET mid_tex = upper_tex WHERE id = (SELECT MIN(id) FROM sidedefs)");   // (a texture change, as a switch makes)

// save – through JSON, as IndexedDB would store it
const saved = JSON.parse(JSON.stringify(await captureGame(db, { seen: [1, 2, 3], didSecret: [] })));
const before = JSON.stringify(await captureGame(db));
const counts = Object.fromEntries(Object.entries(saved.tables).map(([t, v]) => [t, v.rows.length]));
assert(saved.version === SAVE_VERSION && saved.map === map && saved.skill === 4 && counts.things > 10 && counts.player === 1,
  `a save of ${map} on skill 4: ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ')} (${(JSON.stringify(saved).length / 1024).toFixed(0)} KB)`);

// play on: things move, monsters die, the clock runs
for (let i = 0; i < 60; i++) await tic(1, 0.07, i % 5 === 0 ? 1 : 0);
await db.exec("UPDATE things SET st = 'dead' WHERE kind = 'monster'");
const changed = JSON.stringify(await captureGame(db)) !== before;

// load: the map afresh, then the save written back
await loadMap(db, wad, res, saved.map, { skill: saved.skill });
await restoreGame(db, saved);
const after = await captureGame(db);
const same = JSON.stringify({ ...after, extra: undefined }) === JSON.stringify({ ...JSON.parse(before), extra: undefined });
let diff = '';
if (!same) {
  const b = JSON.parse(before);
  for (const t of Object.keys(b.tables)) {
    if (JSON.stringify(b.tables[t]) === JSON.stringify(after.tables[t])) continue;
    diff += ` ${t}`;
    // the first row and column that differ, to say why
    const { cols, rows } = b.tables[t];
    if (rows.length !== after.tables[t].rows.length) { diff += ` (${rows.length} rows saved, ${after.tables[t].rows.length} back)`; continue; }
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].findIndex((v, j) => JSON.stringify(v) !== JSON.stringify(after.tables[t].rows[i][j]));
      if (k >= 0) { diff += ` (row id ${rows[i][0]}, ${cols[k]}: ${JSON.stringify(rows[i][k])} saved, ${JSON.stringify(after.tables[t].rows[i][k])} back)`; break; }
    }
  }
  if (b.seq !== after.seq) diff += ` seq ${b.seq}/${after.seq}`;
}
assert(changed && same, `playing on changed things; loading brings back every row exactly${diff ? ` (differs:${diff})` : ''}`);

// the game runs on from there, and new things don't collide with restored ones
const maxId = (await one('SELECT MAX(id) m FROM things')).M;
const fresh = (await db.query(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
    EXECUTE PROCEDURE spawn_thing(2011, 0, 0, NULL, 0) RETURNING_VALUES id; SUSPEND; END`)).rows[0].ID;
let ran = 0;
try { for (let i = 0; i < 35; i++) { await tic(1, 0.05, 1); ran++; } } catch (err) { console.log(err.message); }
const p = await one('SELECT p.health, t.x, t.y FROM player p JOIN things t ON t.id = p.thing_id');
assert(fresh > maxId && ran === 35 && p.HEALTH > 0, `after loading, a new thing gets id ${fresh} (> ${maxId}) and the game plays on (${ran} tics)`);

// fractions go back as m × 2^e: that rebuilds every double exactly
{
  const values = [216.47363339883418, Math.PI, -Math.E, 0.1, -1e-300, 5e-324, 1.7976931348623157e308, 2 ** -60];
  for (let i = 0; i < 10000; i++) values.push((Math.random() - 0.5) * 10 ** Math.floor(Math.random() * 12 - 4));
  const wrong = values.filter((v) => { const [m, e] = mantissaExponent(v); return m * 2 ** e !== v || !Number.isSafeInteger(m); });
  assert(wrong.length === 0, `m × 2^e rebuilds ${values.length} doubles exactly, subnormals and extremes included${wrong.length ? ` (wrong: ${wrong.slice(0, 3)})` : ''}`);
}

// a save from before armour types (no ARMOR_TYPE column) gets one from its points
{
  const old = JSON.parse(JSON.stringify(saved));
  const pl = old.tables.player;
  const k = pl.cols.indexOf('armor_type');
  const a = pl.cols.indexOf('armor');
  const types = [];
  for (const points of [150, 60]) {
    pl.rows[0][a] = points;
    const cols = pl.cols.filter((_, i) => i !== k);
    const rows = pl.rows.map((r) => r.filter((_, i) => i !== k));
    await loadMap(db, wad, res, old.map, { skill: old.skill });
    await restoreGame(db, { ...old, tables: { ...old.tables, player: { cols, rows } } });
    types.push((await db.query('SELECT armor_type t FROM player')).rows[0].T);
  }
  assert(k >= 0 && types.join() === '2,1', `an older save without armour types: 150 points load as blue (${types[0]}), 60 as green (${types[1]})`);
}

// a save from another version is refused
let refused = false;
try { await restoreGame(db, { ...saved, version: 99 }); } catch { refused = true; }
assert(refused, 'a save from another version is refused');

// the store (memory here, IndexedDB in the page)
const store = saveStore();
await store.put('freedoom1.wad|36|0', { name: 'TEST', save: saved });
const back = await store.get('freedoom1.wad|36|0');
assert(back?.name === 'TEST' && (await store.get('nothing')) === null, 'the save store keeps and returns slots');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'savegame ok');
process.exit(failures ? 1 : 0);
