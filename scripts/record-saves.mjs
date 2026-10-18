// record-saves.mjs – saves as earlier versions of the game wrote them, for
// savegame-test to load with today's code (npm run save-fixtures).
//
// Every commit since saving began (278ea84) that changed the schema or the
// save code is checked out into a temporary git worktree, given this
// checkout's node_modules and WADs, and made to play E1M1 a while and save,
// with its own loader, simulation and captureGame. One fixture is kept per
// distinct save shape (which tables, which columns), named by the first
// commit that wrote it, gzipped into scripts/fixtures/saves/. Today's shape
// is recorded too, so the next schema change has a fixture to be held to.
//
//   npm run save-fixtures            (keeps fixtures already there; --force rewrites them)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'scripts/fixtures/saves');
const FIRST = '278ea84';   // "Save and load: six IndexedDB slots per WAD"
const force = process.argv.includes('--force');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// the play, run inside each worktree against that version's own code
const CAPTURE = `
import fs from 'node:fs';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { captureGame } from '../src/savegame.js';
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync('sql/' + n + '.sql', 'utf8')]));
const db = new FirebirdBrowser('memory://fixture', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync('public/wads/freedoom1.wad'));
const res = await loadResources(db, wad);
await loadMap(db, wad, res, 'E1M1', { skill: 4 });
await db.query('UPDATE game SET rng = 4321 WHERE id = 1').catch(() => {});   // (no P_RANDOM state before demos)
await db.exec('UPDATE player SET health = 1000');
const tic = (fwd, turn, fire, use) => db.query('SELECT * FROM doom_tic(1, ' + fwd + ', 0, ' + turn + ', ' + fire + ', ' + use + ', 0, 0)');
for (let i = 0; i < 70; i++) await tic(1, i % 20 < 10 ? 0.05 : -0.05, i % 7 === 0 ? 1 : 0, i % 15 === 0 ? 1 : 0);
const victim = (await db.query("SELECT FIRST 1 id FROM things WHERE kind = 'monster' AND st <> 'dead' ORDER BY id")).rows[0];
if (victim) await db.exec('EXECUTE PROCEDURE damage_thing(' + victim.ID + ', 100000)');
const door = (await db.query('SELECT FIRST 1 id FROM linedefs WHERE special = 1 ORDER BY id')).rows[0];
if (door) await db.exec("EXECUTE PROCEDURE activate_line(" + door.ID + ", 'use')");
for (let i = 0; i < 20; i++) await tic(0, 0.1, 0, 0);
process.stdout.write(JSON.stringify(await captureGame(db, { seen: [1, 2, 3], didSecret: [] })));
process.exit(0);
`;

const shapeOf = (save) => Object.entries(save.tables).map(([t, v]) => `${t}(${[...v.cols].sort().join(',')})`).sort().join(' ');

const commits = git('log', '--reverse', '--format=%h', `${FIRST}^..HEAD`, '--', 'sql/schema.sql', 'src/savegame.js').split('\n');
const head = git('rev-parse', '--short', 'HEAD');
if (!commits.includes(head)) commits.push(head);
fs.mkdirSync(outDir, { recursive: true });
const have = new Map(fs.readdirSync(outDir).filter((f) => f.endsWith('.json.gz'))
  .map((f) => [shapeOf(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(outDir, f))))), f]));
const seen = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saves-'));
for (const commit of commits) {
  const dir = path.join(tmp, commit);
  git('worktree', 'add', '--detach', dir, commit);
  try {
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'public/wads'), { recursive: true });
    fs.copyFileSync(path.join(root, 'public/wads/freedoom1.wad'), path.join(dir, 'public/wads/freedoom1.wad'));
    fs.writeFileSync(path.join(dir, 'scripts/_capture.mjs'), CAPTURE);
    let save;
    try {
      save = JSON.parse(execFileSync(process.execPath, ['scripts/_capture.mjs'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 }));
    } catch (err) {
      console.log(`${commit}: could not play and save (${String(err.message).split('\n')[0]})`);
      continue;
    }
    const shape = shapeOf(save);
    if (seen.has(shape)) { console.log(`${commit}: the same shape as an earlier one`); continue; }
    seen.add(shape);
    const subject = git('log', '-1', '--format=%s', commit);
    const date = git('log', '-1', '--format=%cs', commit);
    const name = `${date}-${commit}.json.gz`;
    if (have.has(shape) && !force) { console.log(`${commit}: kept (${have.get(shape)})`); continue; }
    save.fixture = { commit, date, subject };
    fs.writeFileSync(path.join(outDir, name), zlib.gzipSync(JSON.stringify(save), { level: 9 }));
    console.log(`${commit}: ${name} (${(fs.statSync(path.join(outDir, name)).size / 1024).toFixed(0)} KB) – ${subject}`);
  } finally {
    git('worktree', 'remove', '--force', dir);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
