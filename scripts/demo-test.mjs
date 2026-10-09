// demo-test.mjs – the simulation is deterministic: the same seed and the same
// inputs, from a fresh load, give the very same game, row for row. That's
// what makes demos (and repeatable bugs) possible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { captureGame } from '../src/savegame.js';
import { DemoPlayer, DemoRecorder, demoProblem } from '../src/demo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://demo', { transport: new DirectTransport() });
await createSchema(db, sql);
const wadPath = process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad');
const wad = new Wad(fs.readFileSync(wadPath));
const res = await loadResources(db, wad);
const map = wad.mapNames()[0];

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// the inputs: a fixed but busy pattern – walking, turning, strafing, firing, using
let s = 7;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const inputs = [];
for (let i = 0; i < 260; i++) {
  inputs.push([1 + Math.floor(rnd() * 3), rnd() < 0.7 ? 1 : 0, rnd() < 0.2 ? (rnd() < 0.5 ? 1 : -1) : 0,
    (rnd() - 0.5) * 0.3, rnd() < 0.3 ? 1 : 0, rnd() < 0.05 ? 1 : 0, 0, rnd() < 0.3 ? 1 : 0]);
}

/** a fresh load, the seed, the calls; then everything that changes, as JSON */
async function play(seed, calls) {
  await loadMap(db, wad, res, map, { skill: 4 });
  await db.exec(`UPDATE game SET rng = ${seed} WHERE id = 1`);
  await db.exec('UPDATE player SET health = 100000 WHERE id = 1');   // (a long demo shouldn't end in death)
  for (const c of calls) await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', c);
  const snap = await captureGame(db);
  return JSON.stringify(snap.tables);
}

// record, through JSON as a saved demo would be
const rec = new DemoRecorder({ wad: path.basename(wadPath), map, skill: 4, seed: 12345 });
for (const c of inputs) rec.push(c);
const demo = JSON.parse(JSON.stringify(rec.demo));
const a = await play(demo.seed, inputs);
const player = new DemoPlayer(demo);
const replayed = [];
for (let c = player.next(); c; c = player.next()) replayed.push(c);
const b = await play(demo.seed, replayed);
const tics = rec.tics;
const killed = JSON.parse(a).things.rows.length;
assert(a === b && player.done, `${map}: ${demo.calls.length} recorded calls (${tics} tics) replay into the same game, every row (${(a.length / 1024).toFixed(0)} KB compared)`);

// the same again, several times, with other maps loaded in between: their rows
// reuse the tables' pages, so the map's rows lie in a different physical order.
// Anything that depends on that order (an unordered cursor, a set-based UPDATE
// drawing P_RANDOM) shows up as drift here.
const others = wad.mapNames().slice(1, 4);
let drift = 0;
for (let k = 0; k < 4; k++) {
  if (k) await loadMap(db, wad, res, others[(k - 1) % others.length], { skill: 3 });
  if ((await play(demo.seed, inputs)) !== a) drift++;
}
assert(drift === 0, `four more runs, other maps loaded in between, land on the same game (${drift} drifted)`);

// another seed, another game
const d = await play(999, inputs);
assert(d !== a, 'a different seed plays out differently');

// P_RANDOM itself: repeatable, in [0, 1), and spread out
await db.exec('UPDATE game SET rng = 42 WHERE id = 1');
const draw = async (n) => (await db.query(`EXECUTE BLOCK RETURNS (v DOUBLE PRECISION) AS DECLARE i INTEGER = 0;
  BEGIN WHILE (i < ${n}) DO BEGIN v = p_random(); SUSPEND; i = i + 1; END END`)).rows.map((r) => r.V);
const r1 = await draw(2000);
await db.exec('UPDATE game SET rng = 42 WHERE id = 1');
const r2 = await draw(2000);
const mean = r1.reduce((x, y) => x + y, 0) / r1.length;
const buckets = Array(8).fill(0);
for (const v of r1) buckets[Math.floor(v * 8)]++;
assert(JSON.stringify(r1) === JSON.stringify(r2) && r1.every((v) => v >= 0 && v < 1) && Math.abs(mean - 0.5) < 0.03
  && buckets.every((n) => n > 180 && n < 320),
  `P_RANDOM: the same seed, the same 2000 numbers, all in [0, 1), mean ${mean.toFixed(3)}, eighths ${buckets.join('/')}`);

// thing ids start over on every load
await loadMap(db, wad, res, map, { skill: 3 });
const first = (await db.query('SELECT MIN(id) a, MAX(id) b FROM things')).rows[0];
await loadMap(db, wad, res, map, { skill: 3 });
const again = (await db.query('SELECT MIN(id) a, MAX(id) b FROM things')).rows[0];
assert(first.A === again.A && first.B === again.B, `every load numbers the things the same (${first.A}–${first.B})`);

// a demo goes on from level to level: the exit, then the next map with the
// random state and the inventory carried over, plays out the same every time
{
  const name = wad.mapNames()[0];
  const next = wad.mapNames()[1];
  /** the player before the first exit switch (11) facing it, as the start both runs share */
  async function atExit() {
    const l = (await db.query(`SELECT FIRST 1 l.x1, l.y1, l.x2, l.y2 FROM linedefs l WHERE l.special = 11 ORDER BY l.id`)).rows[0];
    const len = Math.hypot(l.X2 - l.X1, l.Y2 - l.Y1);
    const nx = (l.Y2 - l.Y1) / len;
    const ny = -(l.X2 - l.X1) / len;           // the front: right of x1,y1 → x2,y2
    const px = (l.X1 + l.X2) / 2 + nx * 24;
    const py = (l.Y1 + l.Y2) / 2 + ny * 24;
    await db.exec(`UPDATE things SET x = ${px}, y = ${py}, angle = ${Math.atan2(-ny, -nx)}, sector_id = sector_at(${px}, ${py}),
                     z = (SELECT s.floor_h FROM sectors s WHERE s.id = sector_at(${px}, ${py})) WHERE kind = 'player'`);
  }
  const level2 = inputs.slice(0, 120);
  async function session(seed) {
    await loadMap(db, wad, res, name, { skill: 4 });
    await db.exec(`UPDATE game SET rng = ${seed} WHERE id = 1`);
    await db.exec('UPDATE player SET health = 100000 WHERE id = 1');
    await atExit();
    let exitKind = 0;
    for (let i = 0; i < 10 && !exitKind; i++) {
      exitKind = (await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 0, ?, 0, 0)', [i % 2])).rows[0].EXIT_KIND;
    }
    const rng = (await db.query('SELECT rng FROM game')).rows[0].RNG;
    await loadMap(db, wad, res, next, { skill: 4, newGame: false });
    await db.exec('UPDATE game SET exit_kind = 0 WHERE id = 1');
    const carried = (await db.query('SELECT rng FROM game')).rows[0].RNG;
    for (const c of level2) await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', c);
    return { exitKind, rng, carried, snap: JSON.stringify((await captureGame(db)).tables) };
  }
  const one = await session(4242);
  const two = await session(4242);
  assert(one.exitKind === 1 && one.carried === one.rng && one.snap === two.snap,
    `${name} → ${next}: the exit switch ends the level; the next one starts with the random state carried (${one.carried}) and plays out the same twice`);

  // the recording's own bookkeeping: the screens' frames and level starts between the calls
  const r = new DemoRecorder({ wad: 'x.wad|36', map: name, skill: 4, seed: 4242 });
  r.push([2, 1, 0, 0, 0, 0, 0, 0]);
  r.push(['wi', 3, 0]);
  r.push(['wi', 2, 1]);
  r.push(['map', next, null, 0]);
  r.push([1, 0, 0, 0, 1, 0, 0, 0]);
  r.push(['fin', 4, 0, 1]);
  r.push(['map', next, 777, 1]);
  const d2 = JSON.parse(JSON.stringify(r.demo));
  const p = new DemoPlayer(d2);
  const order = [p.take('tic') && 'tic', p.take('tic') ?? 'stop', p.take('wi') && 'wi', p.take('wi') && 'wi', p.take('map')?.[1]];
  assert(r.tics === 3 && r.levels.join() === `${name},${next},${next}` && order.join() === `tic,stop,wi,wi,${next}` && demoProblem(d2) === null,
    `a version 2 demo: ${r.tics} game tics between the screens' frames, levels ${r.levels.join(' → ')}; playing takes each kind in turn and notices one out of step`);
}

// a damaged or foreign demo is refused, with a reason
assert(demoProblem({ ...demo, version: 9 })?.includes('version') && demoProblem({ ...demo, calls: [[1, 2]] }) && demoProblem(null)
  && demoProblem({ ...demo, calls: [['map', 5, 0, 0]] }) && demoProblem(demo) === null && demoProblem({ ...demo, version: 1 }) === null,
  'a damaged or foreign demo is refused with a reason; version 1 demos (one level) still play');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'demo ok');
process.exit(failures ? 1 : 0);
