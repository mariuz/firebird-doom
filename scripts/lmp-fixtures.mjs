// lmp-fixtures.mjs – .lmp demos on Freedoom's maps and vanilla's trace of each, for
// test:lmp (npm run lmp-fixtures). Writes scripts/fixtures/lmp/NAME.lmp and NAME.trace.
//
// The demos are ours: scripted input, or the attract demos' (public/demos) turned into
// ticcmds. Each trace is the oracle's (scripts/oracle: Chocolate Doom 3.1.0 built headless,
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
  const d = JSON.parse(fs.readFileSync(path.join(root, 'public/demos', file), 'utf8'));
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

/** scripted: walk, turn, run and strafe, fire, use – each step [tics, forwardmove, sidemove, angleturn, buttons] */
function scripted(episode, map, steps) {
  const tics = [];
  for (const [n, fwd, side, turn, buttons] of steps) for (let k = 0; k < n; k++) tics.push([[fwd, side, turn, k === 0 ? buttons : buttons & ~BT_USE]]);
  return { skill: 3, episode, map, players: [true, false, false, false], tics };
}

const DEMOS = [
  // standing still: only the world moves (the monsters, the randoms, the lights)
  ['e1m1-idle', 'freedoom1.wad', scripted(1, 1, [[350, 0, 0, 0, 0]])],
  ['e1m1-walk', 'freedoom1.wad', scripted(1, 1, [
    [35, 25, 0, 0, 0], [10, 25, 0, -640, 0], [35, 50, 10, 0, 0], [20, 0, 0, 1280, 0],
    [15, 0, -25, 0, BT_ATTACK], [30, -25, 0, -320, 0], [10, 0, 0, 0, BT_USE], [60, 50, 0, 0, BT_ATTACK],
  ])],
  ['e1m1-attract', 'freedoom1.wad', fromAttract('freedoom1-demo1.json', 700)],
  ['map01-attract', 'freedoom2.wad', fromAttract('freedoom2-demo1.json', 700)],
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-home-'));
for (const [name, wadFile, demo] of DEMOS) {
  const lmp = path.join(out, `${name}.lmp`);
  const trace = path.join(out, `${name}.trace`);
  fs.writeFileSync(lmp, writeLmp(demo));
  fs.rmSync(trace, { force: true });
  try {
    execFileSync(oracle, ['-iwad', path.join(root, 'public/wads', wadFile), '-timedemo', lmp, '-nodraw', '-nosound', '-nomusic'],
      { env: { ...process.env, HOME: home, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', ORACLE_TRACE: trace }, stdio: 'pipe', timeout: 120000 });
  } catch { /* (-timedemo ends with I_Error's report and a non-zero exit) */ }
  const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').length : 0;
  console.log(`scripts/fixtures/lmp/${name}.lmp: ${demo.tics.length} tics; vanilla's trace ${lines} lines`);
}
fs.rmSync(home, { recursive: true, force: true });
