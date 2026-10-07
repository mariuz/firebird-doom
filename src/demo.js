// demo.js – recording and playing back a level (g_game.c's G_RecordDemo /
// G_DoPlayDemo, in this port's own format).
//
// The simulation is deterministic: every chance goes through P_RANDOM, seeded
// in GAME.RNG, and a map always loads with the same thing ids. So a demo is
// just where it starts (WAD, map, skill, seed) and every DOOM_TIC call the
// page made: [tics, fwd, side, turn, fire, use, weapon, run]. Playing it makes
// the same calls from the same start, and the same game unfolds.
//
// DOOM's own .lmp demos can't be played: they need DOOM's exact simulation
// (fixed point, its random table consumed in the same order), and this one is
// a re-implementation in SQL that is faithful but not bit-identical.

export const DEMO_VERSION = 1;

export class DemoRecorder {
  /** @param start { wad, map, skill, seed } */
  constructor(start) {
    this.demo = { version: DEMO_VERSION, ...start, date: new Date().toISOString(), calls: [] };
  }

  /** one DOOM_TIC call's arguments, exactly as made (JSON keeps doubles exact) */
  push(args) { this.demo.calls.push(args.slice()); }

  get tics() { return this.demo.calls.reduce((n, c) => n + c[0], 0); }
}

export class DemoPlayer {
  constructor(demo) {
    const problem = demoProblem(demo);
    if (problem) throw new Error(problem);
    this.demo = demo;
    this.index = 0;
  }

  /** the next call's arguments, or null when the demo is over */
  next() { return this.index < this.demo.calls.length ? this.demo.calls[this.index++] : null; }

  get done() { return this.index >= this.demo.calls.length; }
}

/** why a demo can't be played, or null */
export function demoProblem(demo) {
  if (!demo || typeof demo !== 'object') return 'not a demo';
  if (demo.version !== DEMO_VERSION) return `a version ${demo.version} demo; this game plays version ${DEMO_VERSION}`;
  if (!demo.map || !Number.isInteger(demo.skill) || !Number.isInteger(demo.seed) || !Array.isArray(demo.calls)) return 'a damaged demo';
  if (!demo.calls.every((c) => Array.isArray(c) && c.length === 8)) return 'a damaged demo';
  return null;
}
