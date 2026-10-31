// test-all.mjs – the whole pre-commit set (CLAUDE.md), side by side.
//
//   npm run test:all              as many at once as there are cores
//   JOBS=2 npm run test:all       or that many
//   npm run test:all -- music pwad    only the tests whose names contain these
//   npm run test:all -- --part=sql    all but the two browser tests (or --part=browser, --part=coop)
//
// Every SQL test opens its own in-memory database and the browser tests serve on
// free ports, so they don't step on each other. The site is built once, first,
// and the two browser tests serve that build (NO_BUILD=1) instead of each writing
// dist/ again. The longest tests start first. Each one's output goes to
// test-logs/<name>.log; a failure prints its end here, and the exit code is 1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F2 = 'public/wads/freedoom2.wad';
const npm = (script, env = {}, ...args) => ({ cmd: ['npm', 'run', '-s', script, ...(args.length ? ['--', ...args] : [])], env });

// [name, command, about how long it took with the others beside it here, in seconds]:
// they start in this order, the longest first, so the short ones fill in at the end
const both = (t, sec) => [[t, npm(`test:${t}`), sec], [`${t} (Phase 2)`, npm(`test:${t}`, { WAD: F2 }), sec]];
const TESTS = [
  ['coop', npm('test:coop', { NO_BUILD: '1' }), 460],
  ['browser', npm('test:browser', { NO_BUILD: '1' }), 500],
  ...both('physics', 60),
  ['attract', npm('test:attract'), 57],
  ...both('demo', 50),
  ...both('netgame', 39),
  ...both('savegame', 25),
  ['visual', npm('test:visual'), 26],
  ...both('specials', 20),
  ['renderers', npm('test:renderers', {}, 'E1M1', 'E1M2', 'E1M3'), 20],
  ['smoke', npm('test'), 10],
  ['pwad', npm('test:pwad'), 10],
  ['dehacked', npm('test:dehacked'), 9],
  ['lmp', npm('test:lmp'), 390],
  ...both('weapons', 6),
  ['relay', npm('test:relay'), 3],
  ...both('states', 5),
  ...['music', 'statusbar', 'light', 'sound', 'intermission', 'automap', 'finale', 'menu'].map((t) => [t, npm(`test:${t}`), 5]),
];

// --part=sql|browser|coop: one share of the set (CI runs the three on runners of their own,
// side by side: on a 4-core runner the browser tests are the slow ones, and slower still
// beside the rest). Other arguments pick tests whose names contain them.
const args = process.argv.slice(2);
const part = args.find((a) => a.startsWith('--part='))?.slice(7);
const only = args.filter((a) => !a.startsWith('--'));
const PAGES = ['browser', 'coop'];
if (part && !['sql', ...PAGES].includes(part)) throw new Error(`--part=${part}: sql, browser or coop`);
const chosen = TESTS.filter(([name]) => (!part || (part === 'sql' ? !PAGES.includes(name) : name === part))
  && (!only.length || only.some((o) => name.includes(o))));
if (!chosen.length) { console.log(`no test matches ${args.join(' ')}`); process.exit(1); }
const jobs = Math.max(1, Number(process.env.JOBS) || os.availableParallelism?.() || os.cpus().length);
const logs = path.join(root, 'test-logs');
fs.mkdirSync(logs, { recursive: true });
const ci = !!process.env.GITHUB_ACTIONS;
const secs = (ms) => `${(ms / 1000).toFixed(0)} s`;

/** one command, its output to LOG; resolves to { ok, ms } */
function run(name, { cmd, env }) {
  const log = path.join(logs, `${name.replace(/[^\w-]+/g, '-').replace(/-$/, '')}.log`);
  const out = fs.createWriteStream(log);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: root, env: { ...process.env, TEST_ALL: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code) => out.end(() => resolve({ ok: code === 0, ms: Date.now() - t0, log })));
  });
}

function report(name, r) {
  if (r.ok) { console.log(`PASS ${name} (${secs(r.ms)})`); return; }
  const tail = fs.readFileSync(r.log, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
  console.log(`FAIL ${name} (${secs(r.ms)}): ${path.relative(root, r.log)}`);
  console.log(ci ? `::group::${name}\n${tail}\n::endgroup::` : tail.replace(/^/gm, '   | '));
}

const start = Date.now();
const failed = [];
// the build first: the browser tests serve it
if (chosen.some(([n]) => n === 'coop' || n === 'browser')) {
  const b = await run('build', npm('build'));
  report('build', b);
  if (!b.ok) process.exit(1);
}
const queue = [...chosen];
let cpu = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [name, command] = next;
    const r = await run(name, command);
    cpu += r.ms;
    report(name, r);
    if (!r.ok) failed.push(name);
  }
}));
console.log(`${chosen.length - failed.length} of ${chosen.length} passed in ${secs(Date.now() - start)}, ${jobs} at a time `
  + `(${secs(cpu)} of tests one after another)${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
