// think-bench.mjs – the thinkers' list on its own: how long RUN_THINKERS' query takes to find who
// has something to do this tic, timed inside the engine (a WHILE loop in an EXECUTE BLOCK), on
// each map after TICS tics of the player walking and firing.
//   node scripts/think-bench.mjs [MAP,MAP…] [TICS] [RUNS]      (WAD= picks the WAD)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((k) => [k, fs.readFileSync(path.join(root, `sql/${k}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://thinkbench', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const [maps = wad.mapNames().slice(0, 3).join(','), tics = '300', runs = '300'] = process.argv.slice(2);
for (const map of maps.split(',')) {
  await loadMap(db, wad, res, map, { skill: 3, seed: 0 });
  await db.exec('UPDATE player SET god = 1');
  await db.query(`EXECUTE BLOCK AS DECLARE i INTEGER = 0; DECLARE t INTEGER; BEGIN WHILE (i < ${tics}) DO BEGIN
    FOR SELECT tic FROM doom_tic(1, IIF(MOD(:i, 60) < 45, 2, 0), 0, IIF(MOD(:i, 60) >= 45, 0.1, 0), IIF(MOD(:i, 10) = 0, 1, 0), IIF(MOD(:i, 30) = 0, 1, 0), 0, 1) INTO t DO t = t;
    i = i + 1; END END`);
  const { rows: [g] } = await db.query('SELECT g.tic, (SELECT COUNT(*) FROM things) n FROM game g WHERE g.id = 1');
  // (the list as RUN_THINKERS reads it: THINKER_LIST, every kind, the whole range)
  const { rows: [r] } = await db.query(`EXECUTE BLOCK RETURNS (ms DOUBLE PRECISION, n INTEGER) AS
    DECLARE i INTEGER = 0; DECLARE t0 TIMESTAMP; DECLARE k BIGINT; DECLARE tic INTEGER = ${g.TIC + 1};
    BEGIN
      t0 = CAST('NOW' AS TIMESTAMP);
      WHILE (i < ${runs}) DO BEGIN
        n = 0;
        FOR SELECT q.k FROM thinker_list(:tic, -1, 2 * GEN_ID(thing_seq, 0) + 1, 'TLM', 0) q INTO k DO n = n + 1;
        i = i + 1;
      END
      ms = DATEDIFF(MILLISECOND FROM t0 TO CAST('NOW' AS TIMESTAMP)) / ${runs}e0;
      SUSPEND;
    END`);
  console.log(`${map}: ${g.N} things, ${r.N} thinkers due, the list ${(r.MS * 1000).toFixed(0)} µs`);
}
await db.close();
