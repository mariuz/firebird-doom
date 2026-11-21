// sql-profile.mjs – where a tic's time goes inside the engine (the WASM build has no profiler):
// a copy of game.sql with the main calls timed (CAST('NOW' AS TIMESTAMP), 0.1 ms steps, summed
// over many calls), TICS tics of each map played with the player walking, turning and firing,
// god mode on. Times are inclusive (a part that calls another counts both), and the clock reads
// add a little to each.
//   node scripts/sql-profile.mjs [MAP,MAP…] [TICS]      (WAD= picks the WAD)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let game = fs.readFileSync(path.join(root, 'sql/game.sql'), 'utf8');
// (each timed statement: [the procedure it's in, the statement, its key – a string or an SQL expression])
const TIMED = [
  ['doom_tic', 'EXECUTE PROCEDURE player_think(1, fwd, side, turn / tics, fire, use_key, IIF(i = 0, weapon_sel, 0), run, tic);', "'P_PlayerThink'"],
  ['doom_tic', 'EXECUTE PROCEDURE world_tic(tic);', "'world_tic'"],
  ['world_tic', "EXECUTE PROCEDURE think_all(tic, 'TLM');", "'the thinkers (think_all)'"],
  ['world_tic', 'EXECUTE PROCEDURE lights_count(tic);', "'lights_count'"],
  ['thing_think', 'IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE player_body(pid, tic);', "'  the player''s body (P_XYMovement, P_ZMovement)'"],
  ['thing_think', "ELSE IF (k IN ('missile', 'cube')) THEN EXECUTE PROCEDURE missile_step(tid, tic);", "'  missiles'' flight'"],
  ['thing_think', 'ELSE IF (moving = 1 OR (skull = 1 AND stt IS NOT NULL)) THEN EXECUTE PROCEDURE xy_movement_mobj(tid);', "'  things sliding (xy_movement_mobj)'"],
  ['thing_think', 'EXECUTE PROCEDURE z_step(tid, tic);', "'  z_step'"],
  ['thing_think', 'IF (nxt IS NOT NULL) THEN EXECUTE PROCEDURE set_state(tid, nxt, tic) RETURNING_VALUES alive;', "'  the next state (set_state and its action)'"],
  ['set_state', 'IF (act IS NOT NULL) THEN EXECUTE PROCEDURE state_action(tid, act, tic);', "'    ' || act"],
];
const ADD = `CREATE OR ALTER PROCEDURE prof_add (k VARCHAR(60), t0 TIMESTAMP)
AS
DECLARE ms DOUBLE PRECISION;
BEGIN
  ms = DATEDIFF(MILLISECOND FROM t0 TO CAST('NOW' AS TIMESTAMP));
  UPDATE OR INSERT INTO prof (k, ms, n) VALUES (:k, COALESCE((SELECT p.ms FROM prof p WHERE p.k = :k), 0) + :ms,
    COALESCE((SELECT p.n FROM prof p WHERE p.k = :k), 0) + 1) MATCHING (k);
END^
`;
for (const [proc, stmt, key] of TIMED) {
  const start = game.lastIndexOf(`CREATE OR ALTER PROCEDURE ${proc} (`);
  if (start < 0) throw new Error(`no procedure ${proc}`);
  const end = game.indexOf('\nEND^', start);
  const at = game.indexOf(stmt, start);
  if (at < 0 || at > end) throw new Error(`no "${stmt.slice(0, 50)}" in ${proc}`);
  // (an IF's or ELSE IF's statement: wrapped as a block; the clock read is the block's first)
  const m = /^((?:ELSE )?IF \(.*?\) THEN )(.*)$/.exec(stmt);
  const timed = m ? `${m[1]}BEGIN prof_t0 = CAST('NOW' AS TIMESTAMP); ${m[2]} EXECUTE PROCEDURE prof_add(${key}, prof_t0); END`
    : `prof_t0 = CAST('NOW' AS TIMESTAMP); ${stmt} EXECUTE PROCEDURE prof_add(${key}, prof_t0);`;
  game = game.slice(0, at) + timed + game.slice(at + stmt.length);
  const as = game.indexOf('\nAS\n', start) + 4;
  if (!game.slice(as, as + 400).includes('DECLARE prof_t0')) game = game.slice(0, as) + 'DECLARE prof_t0 TIMESTAMP;\n' + game.slice(as);
}
game = game.replace('SET TERM ^ ;', `SET TERM ^ ;\n${ADD}`);
const sql = { schema: fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8') + '\nCREATE TABLE prof (k VARCHAR(60) NOT NULL PRIMARY KEY, ms DOUBLE PRECISION, n INTEGER);\n',
  game, render: fs.readFileSync(path.join(root, 'sql/render.sql'), 'utf8') };
const db = new FirebirdBrowser('memory://sqlprof', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const [maps = wad.mapNames().slice(0, 3).join(','), tics = '300'] = process.argv.slice(2);
let total = 0;
let count = 0;
for (const map of maps.split(',')) {
  await loadMap(db, wad, res, map, { skill: 3, seed: 0 });
  await db.exec('UPDATE player SET god = 1');
  const t0 = performance.now();
  await db.query(`EXECUTE BLOCK AS DECLARE i INTEGER = 0; DECLARE t INTEGER; BEGIN WHILE (i < ${tics}) DO BEGIN
    FOR SELECT tic FROM doom_tic(1, IIF(MOD(:i, 60) < 45, 2, 0), 0, IIF(MOD(:i, 60) >= 45, 0.1, 0), IIF(MOD(:i, 10) = 0, 1, 0), IIF(MOD(:i, 30) = 0, 1, 0), 0, 1) INTO t DO t = t;
    i = i + 1; END END`);
  total += performance.now() - t0;
  count += Number(tics);
}
console.log(`${maps}: ${count} tics, ${(total / count).toFixed(2)} ms a tic (timed)`);
for (const r of (await db.query('SELECT k, ms, n FROM prof ORDER BY ms DESC')).rows) {
  console.log(`${r.K.padEnd(52)} ${(r.MS / count).toFixed(2).padStart(6)} ms a tic   ${String(r.N).padStart(7)} calls  ${(r.MS * 1000 / r.N).toFixed(0).padStart(5)} µs each`);
}
await db.close();
