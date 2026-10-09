// demo.js – recording and playing back a level (g_game.c's G_RecordDemo /
// G_DoPlayDemo, in this port's own format).
//
// The simulation is deterministic: every chance goes through P_RANDOM, seeded
// in GAME.RNG, and a map always loads with the same thing ids. So a demo is
// just where it starts (WAD, map, skill, seed) and every DOOM_TIC call the
// page made: [tics, fwd, side, turn, fire, use, weapon, run]. Playing it makes
// the same calls from the same start, and the same game unfolds.
//
// Like DOOM's, a demo goes on from level to level (version 2). Between the
// calls come the screens' frames and the level starts:
//   ['wi', tics, buttons]          an intermission frame (WI_Ticker's input)
//   ['fin', tics, held, pressed]   a text screen's frame (F_Responder, F_Ticker)
//   ['map', name, seed, newGame]   a level starting: the next one, or the same
//                                  one again after a death (with a new seed)
// Playing checks the game takes the same turns; if not, it stops, out of step.
//
// DOOM's own .lmp demos can't be played: they need DOOM's exact simulation
// (fixed point, its random table consumed in the same order), and this one is
// a re-implementation in SQL that is faithful but not bit-identical.

export const DEMO_VERSION = 2;

export class DemoRecorder {
  /** @param start { wad, map, skill, seed } */
  constructor(start) {
    this.demo = { version: DEMO_VERSION, ...start, date: new Date().toISOString(), calls: [] };
  }

  /** one DOOM_TIC call's arguments, exactly as made (JSON keeps doubles exact), or a screen's frame */
  push(args) { this.demo.calls.push(args.slice()); }

  /** the game tics recorded (screens' frames and level starts aside) */
  get tics() { return this.demo.calls.reduce((n, c) => n + (typeof c[0] === 'number' ? c[0] : 0), 0); }

  /** the levels it covers, in order */
  get levels() { return [this.demo.map, ...this.demo.calls.filter((c) => c[0] === 'map').map((c) => c[1])]; }
}

export class DemoPlayer {
  constructor(demo) {
    const problem = demoProblem(demo);
    if (problem) throw new Error(problem);
    this.demo = demo;
    this.index = 0;
  }

  /** the next entry, or null when the demo is over */
  next() { return this.index < this.demo.calls.length ? this.demo.calls[this.index++] : null; }

  /** the next entry if it's of KIND ('tic' for a DOOM_TIC call, else 'wi', 'fin', 'map'), else null (out of step) */
  take(kind) {
    const c = this.demo.calls[this.index];
    if (!c || (kind === 'tic' ? typeof c[0] !== 'number' : c[0] !== kind)) return null;
    this.index++;
    return c;
  }

  get done() { return this.index >= this.demo.calls.length; }
}

/** why a demo can't be played, or null */
export function demoProblem(demo) {
  if (!demo || typeof demo !== 'object') return 'not a demo';
  if (demo.version !== 1 && demo.version !== DEMO_VERSION) return `a version ${demo.version} demo; this game plays versions 1 and ${DEMO_VERSION}`;
  if (!demo.map || !Number.isInteger(demo.skill) || !Number.isInteger(demo.seed) || !Array.isArray(demo.calls)) return 'a damaged demo';
  const ok = (c) => Array.isArray(c) && (
    (c.length === 8 && c.every((v) => typeof v === 'number'))
    || (c[0] === 'wi' && c.length === 3) || (c[0] === 'fin' && c.length === 4)
    || (c[0] === 'map' && c.length === 4 && typeof c[1] === 'string'));
  if (!demo.calls.every(ok)) return 'a damaged demo';
  return null;
}
