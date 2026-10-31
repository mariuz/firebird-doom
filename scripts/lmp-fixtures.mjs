// lmp-fixtures.mjs – .lmp demos on Freedoom's maps and vanilla's trace of each, for
// test:lmp (npm run lmp-fixtures). Writes scripts/fixtures/lmp/NAME.lmp and NAME.trace.
//
// The demos are ours: scripted input, or the attract demos' (public/demos) turned into
// ticcmds. `npm run lmp-fixtures -- NAME …` makes only those. For some, NAME.mobjs too: every
// thinker in the list's order at a few leveltimes (dump.c's ORACLE_MOBJS), for the things one by one. Each trace is the oracle's (scripts/oracle: Chocolate Doom 3.1.0 built headless,
// npm run oracle first): one line of the game's state per tic, as vanilla plays the demo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeLmp, BT_ATTACK, BT_USE } from '../src/lmp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scripts/fixtures/lmp');
const oracle = process.env.ORACLE ?? path.join(root, 'oracle-build/build/src/chocolate-doom');
if (!fs.existsSync(oracle)) {
  console.log(`no oracle at ${oracle}: npm run oracle first`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const clamp = (v) => Math.max(-127, Math.min(127, Math.round(v)));
/** an attract demo's DOOM_TIC calls ([tics, fwd, side, turn, fire, use, weapon, run]) as ticcmds */
function fromAttract(file, limit) {
  return fromCalls(JSON.parse(fs.readFileSync(path.join(root, 'public/demos', file), 'utf8')), limit);
}

/** a recording's DOOM_TIC calls (the attract demos' JSON shape) as ticcmds */
function fromCalls(d, limit) {
  const tics = [];
  for (const c of d.calls) {
    if (typeof c[0] !== 'number') continue;
    const [n, fwd, side, turn, fire, use, weapon, run] = c;
    const mult = run ? 50 : 25;
    const buttons = (fire ? BT_ATTACK : 0) | (use ? BT_USE : 0) | (weapon ? 4 | (((weapon === 1 ? 0 : weapon - 1) & 7) << 3) : 0);
    for (let k = 0; k < n && tics.length < limit; k++) {
      tics.push([[clamp(fwd * mult), clamp(side * mult), Math.round((turn * 65536) / (2 * Math.PI)), k === 0 ? buttons : buttons & ~4]]);
    }
  }
  const m = /^(?:E(\d)M(\d)|MAP(\d\d))$/.exec(d.map);
  return { skill: d.skill, episode: m[1] ? Number(m[1]) : 1, map: Number(m[2] ?? m[3]), players: [true, false, false, false], tics };
}

/**
 * the attract demos' scripted player (record-attract.mjs's Bot), run in the port for TICS on
 * MAP from SEED, as ticcmds: longer walks than the title loop's, through doors and onto lifts.
 * (What it does is decided in the port; vanilla plays the same ticcmds.)
 */
async function fromBot(wadFile, map, tics, seed) {
  const { FirebirdBrowser, DirectTransport } = await import('firebird-wasm/browser');
  const { Wad } = await import('../src/wad.js');
  const { createSchema, loadResources } = await import('../src/loader.js');
  const { record } = await import('./record-attract.mjs');
  const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
  const db = new FirebirdBrowser(`memory://bot-${map}`, { transport: new DirectTransport({ threads: false }) });
  await createSchema(db, sql);
  const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads', wadFile)));
  const res = await loadResources(db, wad);
  const { demo } = await record(db, wad, res, wadFile, map, tics, seed);
  await db.close();
  return fromCalls(demo, tics);
}

/** scripted: walk, turn, run and strafe, fire, use – each step [tics, forwardmove, sidemove, angleturn, buttons] */
function scripted(episode, map, steps) {
  const tics = [];
  for (const [n, fwd, side, turn, buttons] of steps) for (let k = 0; k < n; k++) tics.push([[fwd, side, turn, k === 0 ? buttons : buttons & ~BT_USE]]);
  return { skill: 3, episode, map, players: [true, false, false, false], tics };
}

const DEMOS = [
  // standing still: only the world moves (the monsters, the randoms, the lights)
  ['e1m1-idle', 'freedoom1.wad', scripted(1, 1, [[350, 0, 0, 0, 0]]), '0,1,175,350'],
  ['e1m1-walk', 'freedoom1.wad', scripted(1, 1, [
    [35, 25, 0, 0, 0], [10, 25, 0, -640, 0], [35, 50, 10, 0, 0], [20, 0, 0, 1280, 0],
    [15, 0, -25, 0, BT_ATTACK], [30, -25, 0, -320, 0], [10, 0, 0, 0, BT_USE], [60, 50, 0, 0, BT_ATTACK],
  ])],
  // standing still, a shot at once: the puffs and the woken monsters, before anything else moves
  ['e1m1-shoot', 'freedoom1.wad', scripted(1, 1, [[30, 0, 0, 0, 0], [12, 0, 0, 0, BT_ATTACK], [60, 0, 0, 0, 0]]), '34,35,36,48,49,102'],
  // into the zombiemen's sight, and then still: they wake, chase and fire, and nothing's shot back
  ['e1m1-wake', 'freedoom1.wad', scripted(1, 1, [[35, 25, 0, 0, 0], [10, 25, 0, -640, 0], [35, 50, 10, 0, 0], [150, 0, 0, 0, 0]]), '55,60,80,100,140,200,230'],
  // a turn to the barrel in sight of E1M2's start and the pistol until it bursts: P_RadiusAttack, the barrel's death
  ['e1m2-barrel', 'freedoom1.wad', scripted(1, 2, [[1, 0, 0, 10122, 0], [10, 0, 0, 0, 0], [60, 0, 0, 0, BT_ATTACK], [90, 0, 0, 0, 0]])],
  ['e1m1-attract', 'freedoom1.wad', fromAttract('freedoom1-demo1.json', 700)],
  ['map01-attract', 'freedoom2.wad', fromAttract('freedoom2-demo1.json', 700)],
  // longer walks by the attract demos' scripted player: doors, lifts, floors (phase L6)
  ['e1m1-bot', 'freedoom1.wad', () => fromBot('freedoom1.wad', 'E1M1', 2100, 1001)],
  ['e1m2-bot', 'freedoom1.wad', () => fromBot('freedoom1.wad', 'E1M2', 2100, 1002)],
  ['e1m3-bot', 'freedoom1.wad', () => fromBot('freedoom1.wad', 'E1M3', 2100, 1003)],
  ['map01-bot', 'freedoom2.wad', () => fromBot('freedoom2.wad', 'MAP01', 2100, 2001)],
  ['map02-bot', 'freedoom2.wad', () => fromBot('freedoom2.wad', 'MAP02', 2100, 2002)],
  ['e1m4-bot', 'freedoom1.wad', () => fromBot('freedoom1.wad', 'E1M4', 2100, 1004)],
  ['e1m5-bot', 'freedoom1.wad', () => fromBot('freedoom1.wad', 'E1M5', 2100, 1005)],
  ['map03-bot', 'freedoom2.wad', () => fromBot('freedoom2.wad', 'MAP03', 2100, 2003)],
  ['map04-bot', 'freedoom2.wad', () => fromBot('freedoom2.wad', 'MAP04', 2100, 2004)],
  ['map05-bot', 'freedoom2.wad', () => fromBot('freedoom2.wad', 'MAP05', 2100, 2005)],
  ['e1m2-attract', 'freedoom1.wad', fromAttract('freedoom1-demo2.json', 700)],
  ['e1m3-attract', 'freedoom1.wad', fromAttract('freedoom1-demo3.json', 700)],
  ['map02-attract', 'freedoom2.wad', fromAttract('freedoom2-demo2.json', 700)],
  ['map03-attract', 'freedoom2.wad', fromAttract('freedoom2-demo3.json', 700)],
  ['map04-attract', 'freedoom2.wad', fromAttract('freedoom2-demo4.json', 700)],
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-home-'));
// (names on the command line: only those)
const only = process.argv.slice(2);
for (const [name, wadFile, make, mobjTics] of DEMOS.filter(([n]) => !only.length || only.includes(n))) {
  const demo = typeof make === 'function' ? await make() : make;
  const lmp = path.join(out, `${name}.lmp`);
  const trace = path.join(out, `${name}.trace`);
  // (and for some, every thinker at those leveltimes: NAME.mobjs, ORACLE_MOBJS)
  const mobjs = path.join(out, `${name}.mobjs`);
  fs.writeFileSync(lmp, writeLmp(demo));
  fs.rmSync(trace, { force: true });
  try {
    execFileSync(oracle, ['-iwad', path.join(root, 'public/wads', wadFile), '-timedemo', lmp, '-nodraw', '-nosound', '-nomusic'],
      { env: { ...process.env, HOME: home, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', ORACLE_TRACE: trace,
        ...(mobjTics ? { ORACLE_MOBJS: mobjs, ORACLE_MOBJS_TICS: mobjTics } : {}) }, stdio: 'pipe', timeout: 120000 });
  } catch { /* (-timedemo ends with I_Error's report and a non-zero exit) */ }
  const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').length : 0;
  console.log(`scripts/fixtures/lmp/${name}.lmp: ${demo.tics.length} tics; vanilla's trace ${lines} lines`);
}
fs.rmSync(home, { recursive: true, force: true });
