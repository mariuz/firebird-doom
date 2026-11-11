// lmp-one.mjs – one or more of the .lmp fixtures against vanilla's traces, the first tic each
// field differs (test:lmp's sync loop for those alone, with no baseline):
//   node scripts/lmp-one.mjs map01-revenant map01-pain …
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { parseLmp } from '../src/lmp.js';
import { FIELDS, parseTrace, playAgainst, startDemo, restartDemo, nextDemoMap, exitPwad, EXIT_PWADS } from './lmp-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'scripts/fixtures/lmp');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://lmp-one', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
for (const name of process.argv.slice(2)) {
  const demo = parseLmp(fs.readFileSync(path.join(dir, `${name}.lmp`)));
  const trace = parseTrace(fs.readFileSync(path.join(dir, `${name}.trace`), 'utf8'));
  const iwad = new Wad(fs.readFileSync(path.join(root, 'public/wads', name.startsWith('map') ? 'freedoom2.wad' : 'freedoom1.wad')));
  const pw = EXIT_PWADS[name];
  const wad = pw ? new Wad(iwad.files[0].bytes, exitPwad(iwad, pw[1], pw[2], pw[3], [], pw[4])) : iwad;
  const res = await loadResources(db, wad);
  await startDemo(db, wad, res, demo, loadMap);
  const r = await playAgainst(db, demo, trace, { restart: () => restartDemo(db, wad, res, demo, loadMap),
    worldDone: (secret) => nextDemoMap(db, wad, res, demo, loadMap, secret) });
  const off = FIELDS.filter((f) => r.first[f]);
  console.log(`${name}: ${r.tics} tics, the player in step for ${r.synced}; `
    + (off.length ? off.map((f) => `${f}@${r.first[f].tic} (port ${r.first[f].port}, vanilla ${r.first[f].vanilla})`).join('; ') : 'every column in step'));
}
await db.close();
