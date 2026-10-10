// mouse.js – the mouse's half of G_BuildTiccmd (g_game.c). DOOM's mouse
// buttons, by its own numbering: 1 fires (mousebfire), 2 strafes while held
// (mousebstrafe: the mouse's X, and the turn keys, move you sideways), 3
// moves forward (mousebforward). A double click on button 2 or 3 is use. The
// mouse's Y moves you forward and back (mousey), as it did in DOOM; that's an
// option here, off unless chosen, as most players had it (the "novert" hacks).

export const FORWARDMOVE = [25, 50];        // forwardmove[speed]: walking, running
export const MAXPLMOVE = FORWARDMOVE[1];    // the most a ticcmd moves, either way
// angleturn -= mousex * 0x8: radians per unit of mousex
export const MOUSEX_RAD = (8 * 2 * Math.PI) / 65536;
// DOOM's buttons (0 fire, 1 strafe, 2 forward) from the browser's (0 left, 1 middle, 2 right)
export const DOOM_BUTTON = { 0: 0, 2: 1, 1: 2 };

/**
 * mousex (and mousey) per pixel: the page's rate since before this module,
 * 0.0035 rad a pixel at sensitivity 5, so turning feels the same as before.
 */
export const mouseRate = (sensitivity) => (0.0035 * ((sensitivity + 1) / 6)) / MOUSEX_RAD;

/** a double click's clock: dclickstate, dclicktime, dclicks */
class DoubleClick {
  constructor() { this.state = false; this.time = 0; this.clicks = 0; }

  /** TICS tics with the button DOWN (or not): true on the second click */
  tick(down, tics) {
    if (down !== this.state && this.time > 1) {
      this.state = down;
      if (down) this.clicks++;
      if (this.clicks === 2) {
        this.clicks = 0;
        return true;
      }
      this.time = 0;
    } else {
      this.time += tics;
      if (this.time > 20) {
        this.clicks = 0;
        this.state = false;
      }
    }
    return false;
  }
}

export class MouseInput {
  constructor() {
    this.x = 0;                              // mousex, since the last ticcmd
    this.y = 0;                              // mousey (up, away from you, is +)
    this.held = [false, false, false];       // mousebuttons[], by DOOM's numbering
    this.clicked = [false, false, false];    // pressed since the last ticcmd (a click shorter than a frame still counts)
    this.dclickForward = new DoubleClick();
    this.dclickStrafe = new DoubleClick();
  }

  /** a mousemove of DX, DY pixels (the browser's: Y grows downwards) */
  move(dx, dy, sensitivity = 5) {
    const k = mouseRate(sensitivity);
    this.x += dx * k;
    this.y -= dy * k;
  }

  /** a browser button (MouseEvent.button) down or up */
  button(domButton, down) {
    const b = DOOM_BUTTON[domButton];
    if (b === undefined) return;
    this.held[b] = down;
    if (down) this.clicked[b] = true;
  }

  release() { this.held.fill(false); }

  /**
   * G_BuildTiccmd's mouse terms for TICS tics (RUN: the speed key):
   * { forward, side } in DOOM's move units, turn in radians (+ is left),
   * fire, use and strafe (button 2 held: the turn keys strafe too).
   * MOUSEY: the mouse's Y moves you.
   */
  take(tics, { run = 0, mousey = false } = {}) {
    const down = (b) => this.held[b] || this.clicked[b];
    const strafe = down(1);
    let forward = 0;
    let side = 0;
    let turn = 0;
    if (down(2)) forward += FORWARDMOVE[run ? 1 : 0];
    // (the double clicks: button 3's, then button 2's)
    let use = this.dclickForward.tick(down(2), tics);
    use = this.dclickStrafe.tick(strafe, tics) || use;
    if (mousey) forward += this.y;
    if (strafe) side += this.x * 2;
    else turn -= this.x * MOUSEX_RAD;
    const fire = down(0);
    this.x = 0;
    this.y = 0;
    this.clicked.fill(false);
    return { forward, side, turn, fire, use, strafe };
  }
}

/**
 * The ticcmd's movement from DOOM's units: forward and side are fractions of
 * the speed's forwardmove, with RUN saying which. Beyond walking speed
 * without the speed key (the mouse can push you up to MAXPLMOVE, as in DOOM)
 * the command is put as running, which moves you the same.
 */
export function moveCommand(forwardUnits, sideUnits, run) {
  const clamp = (v) => Math.max(-MAXPLMOVE, Math.min(MAXPLMOVE, v));
  const f = clamp(forwardUnits);
  const s = clamp(sideUnits);
  const r = run || Math.abs(f) > FORWARDMOVE[0] || Math.abs(s) > FORWARDMOVE[0] ? 1 : 0;
  return { fwd: f / FORWARDMOVE[r], side: s / FORWARDMOVE[r], run: r };
}
