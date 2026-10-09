// wipe.js – the screen melt between screens (f_wipe.c's wipe_Melt).
//
// When D_Display sees the game state change (a level, the intermission, an
// ending, the title) – and on every level load, which G_DoLoadLevel forces –
// it keeps the old screen (wipe_StartScreen), draws the new one
// (wipe_EndScreen), and melts: the old screen slides down in columns two
// pixels wide, each starting a little after its neighbour, uncovering the
// new one. Everything here is in palette indices, like the screen.

const W = 320;
const H = 200;
const COLS = W / 2;   // the melt moves pairs of pixels

export class Melt {
  /**
   * @param start  the old screen (320×200 palette indices)
   * @param end    the new screen
   * @param random () → 0..1, for M_Random (the menu's generator, not the game's)
   */
  constructor(start, end, random = Math.random) {
    this.start = start.slice();
    this.end = end.slice();
    this.done = false;
    // wipe_initMelt: the first column starts up to 15 tics late, each next one
    // a tic before, with or after its neighbour, never early, never 16 late
    const m = () => Math.floor(random() * 256);
    this.y = new Int32Array(COLS);
    this.y[0] = -(m() % 16);
    for (let i = 1; i < COLS; i++) {
      const r = (m() % 3) - 1;
      let y = this.y[i - 1] + r;
      if (y > 0) y = 0;
      else if (y === -16) y = -15;
      this.y[i] = y;
    }
  }

  /** wipe_doMelt: TICS tics of it. Waiting columns count down; moving ones drop
   *  1, 2, 3… pixels a tic for the first 16, then 8. Returns true when done. */
  tick(tics = 1) {
    for (let t = 0; t < tics && !this.done; t++) {
      let done = true;
      for (let i = 0; i < COLS; i++) {
        const y = this.y[i];
        if (y < 0) {
          this.y[i] = y + 1;
          done = false;
        } else if (y < H) {
          let dy = y < 16 ? y + 1 : 8;
          if (y + dy >= H) dy = H - y;
          this.y[i] = y + dy;
          done = false;
        }
      }
      this.done = done;
    }
    return this.done;
  }

  /** The screen now: above each column's edge the new screen, below it the old one, moved down. */
  draw(out) {
    for (let i = 0; i < COLS; i++) {
      const off = Math.max(0, this.y[i]);
      for (let x = i * 2; x < i * 2 + 2; x++) {
        for (let y = 0; y < H; y++) {
          out[y * W + x] = y < off ? this.end[y * W + x] : this.start[(y - off) * W + x];
        }
      }
    }
    return out;
  }
}
