// sight-bench.mjs – P_CheckSight two ways: SIGHT_BSP (DOOM's walk of the BSP, P_CrossBSPNode)
// against SIGHT_FX (the lines in the blocks the sight line passes, the same tests on each). Every
// pair of monsters and players REJECT lets through, on each map: do they agree, and how long each
// takes. Exits 1 if any pair differs.
//   node scripts/sight-bench.mjs [MAP,MAP…] [PAIRS]      (WAD= picks the WAD; PAIRS caps a map's)
// With no maps (npm run test:sight) it runs the maps where the walk's quirks first showed – a sight
// line along a wall's end, a looker on a horizontal node's y – 1500 pairs each; every map of both
// WADs, all 168,824 pairs, agreed when SIGHT_FX went in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((k) => [k, fs.readFileSync(path.join(root, `sql/${k}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://sightbench', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const phase2 = wad.mapNames().includes('MAP01');
const [maps = phase2 ? 'MAP01,MAP03,MAP10' : 'E1M4,E1M6,E1M7,E2M1', cap = '1500'] = process.argv.slice(2);
let all = 0;
let differ = 0;
let tBsp = 0;
let tLines = 0;
for (const map of maps.split(',')) {
  await loadMap(db, wad, res, map, { skill: 4, seed: 0 });
  const { rows: [r] } = await db.query(`EXECUTE BLOCK RETURNS (n INTEGER, seen INTEGER, bad INTEGER, ms_bsp DOUBLE PRECISION, ms_lines DOUBLE PRECISION, first_bad VARCHAR(40)) AS
    DECLARE a INTEGER; DECLARE b INTEGER; DECLARE s1 SMALLINT; DECLARE s2 SMALLINT; DECLARE t0 TIMESTAMP;
    BEGIN
      n = 0; seen = 0; bad = 0; ms_bsp = 0; ms_lines = 0;
      FOR SELECT FIRST ${cap} p.id, q.id FROM things p JOIN things q ON q.id <> p.id
           WHERE p.kind IN ('monster', 'player') AND q.kind IN ('monster', 'player')
             AND rejected(p.sector_id, q.sector_id) = 0
           ORDER BY p.id, q.id INTO a, b
      DO BEGIN
        t0 = CAST('NOW' AS TIMESTAMP);
        s1 = sight_bsp(a, b);
        ms_bsp = ms_bsp + DATEDIFF(MILLISECOND FROM t0 TO CAST('NOW' AS TIMESTAMP));
        t0 = CAST('NOW' AS TIMESTAMP);
        s2 = sight_fx(a, b);
        ms_lines = ms_lines + DATEDIFF(MILLISECOND FROM t0 TO CAST('NOW' AS TIMESTAMP));
        n = n + 1;
        seen = seen + s1;
        IF (s1 <> s2) THEN BEGIN bad = bad + 1; IF (first_bad IS NULL) THEN first_bad = a || ' ' || b || ': ' || s1 || ' vs ' || s2; END
      END
      SUSPEND;
    END`);
  console.log(`${map}: ${r.N} pairs (${r.SEEN} in sight), ${r.BAD} differ${r.FIRST_BAD ? ` (${r.FIRST_BAD})` : ''}; BSP ${(r.MS_BSP * 1000 / r.N).toFixed(0)} µs a check, lines ${(r.MS_LINES * 1000 / r.N).toFixed(0)} µs`);
  all += r.N; differ += r.BAD; tBsp += r.MS_BSP; tLines += r.MS_LINES;
}
console.log(`all: ${all} pairs, ${differ} differ; BSP ${(tBsp * 1000 / all).toFixed(0)} µs, lines ${(tLines * 1000 / all).toFixed(0)} µs a check`);
await db.close();
process.exit(differ ? 1 : 0);
