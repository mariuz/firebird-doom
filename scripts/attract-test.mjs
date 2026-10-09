// attract-test.mjs – the title loop's demos (public/demos/, from
// `npm run attract`) still play out as recorded: each is replayed from its
// seed and the game's checksum at the end compared with the one in the file.
// A change to the simulation that alters what happens fails here, and the
// demos want recording again – like the README's pictures and
// docs/screenshots.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { demoProblem, attractDemoFile, ATTRACT_DEMOS } from '../src/demo.js';
import { TitleLoop } from '../src/menu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

for (const label of ['freedoom1.wad', 'freedoom2.wad']) {
  const file = path.join(root, 'public/wads', label);
  if (!fs.existsSync(file)) { console.log(`(no ${label})`); continue; }
  const db = new FirebirdBrowser(`memory://attract-test-${label}`, { transport: new DirectTransport() });
  await createSchema(db, sql);
  const wad = new Wad(fs.readFileSync(file));
  const res = await loadResources(db, wad);
  const doom2 = label.includes('2');
  // as many demos as the title loop asks for (D_DoAdvanceDemo: three, four on DOOM II)
  const wanted = new TitleLoop(doom2, !doom2).pages.filter((p) => p[0].startsWith('DEMO')).length;
  const n = ATTRACT_DEMOS[label];
  assert(n === wanted, `${label}: ${n} demos for the title loop's ${wanted} demo slots`);
  for (let i = 1; i <= n; i++) {
    const name = attractDemoFile(label, i);
    const p = path.join(root, 'public/demos', name);
    if (!fs.existsSync(p)) { assert(false, `${name} is there (npm run attract)`); continue; }
    const demo = JSON.parse(fs.readFileSync(p, 'utf8'));
    const problem = demoProblem(demo);
    const key = `${label}|${wad.mapNames().length}`;
    assert(!problem && demo.wad === key && wad.mapNames().includes(demo.map) && typeof demo.checksum === 'string' && fs.statSync(p).size < 200000,
      `${name}: a demo of ${demo.map} for ${key} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)${problem ? `: ${problem}` : ''}`);
    if (problem) continue;
    await loadMap(db, wad, res, demo.map, { skill: demo.skill, newGame: true, seed: demo.seed });
    let hud = null;
    let tics = 0;
    for (const c of demo.calls) {
      hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', c)).rows[0];
      tics += c[0];
      if (hud.EXIT_KIND) break;
    }
    const csum = (await db.query('SELECT csum FROM net_checksum')).rows[0].CSUM;
    assert(csum === demo.checksum && !hud.EXIT_KIND && !hud.DEAD && hud.KILLS > 0,
      `${name} replays as recorded: ${tics} tics, ${hud.KILLS} kills, alive at the end (checksum ${csum}${csum === demo.checksum ? '' : ` ≠ ${demo.checksum}: record them again with npm run attract`})`);
  }
  await db.close();
}

console.log(failures ? `${failures} failure(s)` : 'attract ok');
process.exit(failures ? 1 : 0);
