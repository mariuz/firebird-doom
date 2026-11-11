// lmp-mobjs.mjs – a fixture's thinkers, one by one, against vanilla's at the leveltimes given
// (dump.c's ORACLE_MOBJS, made here from the oracle): where the first thing parts from vanilla.
//   node scripts/lmp-mobjs.mjs map01-mancubus 100,105,108
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { parseLmp, portCmd } from '../src/lmp.js';
import { startDemo, exitPwad, EXIT_PWADS, parseMobjs, portThinkers, compareThinkers } from './lmp-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [name, ticList] = process.argv.slice(2);
const dir = path.join(root, 'scripts/fixtures/lmp');
const iwadFile = path.join(root, 'public/wads', name.startsWith('map') ? 'freedoom2.wad' : 'freedoom1.wad');
const iwad = new Wad(fs.readFileSync(iwadFile));
const pw = EXIT_PWADS[name];
const pwadBytes = pw ? exitPwad(iwad, pw[1], pw[2], pw[3], [], pw[4]) : null;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-home-'));
const mobjsPath = path.join(home, `${name}.mobjs`);
const args = ['-iwad', iwadFile];
if (pwadBytes) { fs.writeFileSync(path.join(home, 'p.wad'), pwadBytes); args.push('-file', path.join(home, 'p.wad')); }
try {
  execFileSync(process.env.ORACLE ?? path.join(root, 'oracle-build/build/src/chocolate-doom'),
    [...args, '-timedemo', path.join(dir, `${name}.lmp`), '-nodraw', '-nosound', '-nomusic'],
    { env: { ...process.env, HOME: home, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', ORACLE_TRACE: path.join(home, 't'), ORACLE_MOBJS: mobjsPath, ORACLE_MOBJS_TICS: ticList }, stdio: 'pipe', timeout: 120000 });
} catch { /* (-timedemo ends with I_Error) */ }
const van = parseMobjs(fs.readFileSync(mobjsPath, 'utf8'));
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://lmp-mobjs', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = pwadBytes ? new Wad(iwad.files[0].bytes, pwadBytes) : iwad;
const res = await loadResources(db, wad);
const demo = parseLmp(fs.readFileSync(path.join(dir, `${name}.lmp`)));
await startDemo(db, wad, res, demo, loadMap);
let done = 0;
for (const t of [...van.keys()].sort((a, b) => a - b)) {
  for (; done < t; done++) {
    const [fwd, side, turn, fire, use, weapon, run] = portCmd(demo.tics[done][0]);
    await db.query('SELECT * FROM doom_tic(1, ?, ?, ?, ?, ?, ?, ?)', [fwd, side, turn, fire, use, weapon, run]);
  }
  const c = compareThinkers(van.get(t), await portThinkers(db));
  console.log(`tic ${t}: ${c.count[1]} thinkers in vanilla, ${c.count[0]} here${c.order ? `; the order parts at ${c.order.at}: port ${c.order.port}, vanilla ${c.order.vanilla}` : ''}`);
  for (const [f, l] of Object.entries(c.fields)) for (const d of l.slice(0, 4)) console.log(`  ${f} #${d[0]} ${d[3]}: port ${d[1]}, vanilla ${d[2]}`);
}
await db.close();
fs.rmSync(home, { recursive: true, force: true });
