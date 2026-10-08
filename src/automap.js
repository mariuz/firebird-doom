// automap.js – am_map.c's AM_drawWalls: which colour, if any, a line gets.
//
// A line shows once you've seen it (ML_MAPPED: the renderer drew part of it,
// or the map pre-marked it with flag 256). Lines you haven't seen show in
// grey only with the computer area map (pw_allmap). ML_DONTDRAW (128) lines
// never show, and ML_SECRET (32) ones pass for plain walls.
//
// IDDT (am_cheating 1 or 2) shows every line, ML_DONTDRAW ones included,
// with flat two-sided openings in grey; level 2 also draws the things.

// palette indices, as am_map.c defines them
export const AM_COLORS = {
  wall: 176,        // WALLCOLORS (REDS): one-sided, or secret
  teleport: 184,    // WALLCOLORS + WALLRANGE/2: a teleporter line (39)
  floor: 64,        // FDWALLCOLORS (BROWNS): a floor height change
  ceil: 231,        // CDWALLCOLORS (YELLOWS): a ceiling height change
  unseen: 99,       // GRAYS + 3: not seen yet, shown by the computer map
  twoSided: 96,     // TSWALLCOLORS (GRAYS): a flat opening, only with IDDT
  thing: 112,       // THINGCOLORS (GREENS): things, with IDDT twice
  player: 209,      // YOURCOLORS (WHITE): your arrow
};

const ML_SECRET = 32;
const ML_DONTDRAW = 128;
const ML_MAPPED = 256;

/**
 * @param line   { flags, special }
 * @param front  front sector { floor, ceil }
 * @param back   back sector or null (one-sided)
 * @param seen   the renderer has drawn this line
 * @param allmap the player carries the computer area map
 * @param cheating IDDT level: 0 off, 1 all lines, 2 all lines and things
 * @returns a palette index, or null to leave the line out
 */
export function automapColor(line, front, back, seen, allmap, cheating = 0) {
  if (cheating || seen || line.flags & ML_MAPPED) {
    if (line.flags & ML_DONTDRAW && !cheating) return null;
    if (!back) return AM_COLORS.wall;
    if (line.special === 39) return AM_COLORS.teleport;
    if (line.flags & ML_SECRET) return AM_COLORS.wall;   // (SECRETWALLCOLORS is WALLCOLORS)
    if (front.floor !== back.floor) return AM_COLORS.floor;
    if (front.ceil !== back.ceil) return AM_COLORS.ceil;
    return cheating ? AM_COLORS.twoSided : null;
  }
  if (line.flags & ML_DONTDRAW) return null;
  return allmap ? AM_COLORS.unseen : null;
}


// ── AM_Responder / AM_Ticker / AM_changeWindowScale: where the map looks ──
const F_W = 320;                 // the automap's window: the screen above the status bar
const F_H = 168;
const PLAYERRADIUS = 16;
const M_ZOOMIN = 1.02;           // per tic, while = is held (M_ZOOMOUT is its inverse)
const F_PANINC = 4;              // pixels a tic, while an arrow is held (follow mode off)
const NUMMARKS = 10;             // AM_NUMMARKPOINTS
export const GRID_COLOR = 104;   // GRIDCOLORS: GRAYS + GRAYSRANGE/2
export const MAPBLOCKUNITS = 128;

/** Freedoom's wording for the automap's messages (BSD-3-Clause), for WADs whose DEHACKED has none. */
export const AM_STRINGS = {
  AMSTR_FOLLOWON: 'Map following player.', AMSTR_FOLLOWOFF: 'Map no longer following player.',
  AMSTR_GRIDON: 'Map grid on.', AMSTR_GRIDOFF: 'Map grid off.',
  AMSTR_MARKEDSPOT: 'Added map bookmark.', AMSTR_MARKSCLEARED: 'All map bookmarks cleared.',
};

/**
 * The automap's window over the level: its centre and scale (pixels per map
 * unit), follow mode, the grid, the marks. Nothing is drawn here.
 */
export class AutomapView {
  /** AM_LevelInit: bounds { minX, maxX, minY, maxY } of the level, origin [x, y] of its BLOCKMAP. */
  constructor(bounds, origin = [bounds.minX, bounds.minY]) {
    this.bounds = bounds;
    this.origin = origin;
    // AM_findMinMaxBoundaries: the whole level fits at the smallest scale;
    // the largest shows a player twice the window's height
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    this.minScale = Math.min(F_W / w, F_H / h);
    this.maxScale = F_H / (2 * PLAYERRADIUS);
    this.scale = this.minScale / 0.7;
    if (this.scale > this.maxScale) this.scale = this.minScale;
    this.x = (bounds.minX + bounds.maxX) / 2;   // the window's centre, in map units
    this.y = (bounds.minY + bounds.maxY) / 2;
    this.follow = true;
    this.grid = false;
    this.marks = [];                            // markpoints, [x, y] each (up to ten, the oldest replaced)
    this.markNum = 0;
    this.big = null;                            // AM_saveScaleAndLoc while the whole level is shown
  }

  /** Map → screen. */
  toScreen(x, y) { return [F_W / 2 + (x - this.x) * this.scale, F_H / 2 - (y - this.y) * this.scale]; }

  /**
   * AM_Ticker, `tics` times: zoom while = or - is held, pan while an arrow is
   * (follow mode off), or stay on the player.
   * @param held { zoomIn, zoomOut, left, right, up, down }
   */
  tick(tics, held, player) {
    for (let i = 0; i < tics; i++) {
      if (held.zoomIn !== held.zoomOut) {
        this.scale *= held.zoomIn ? M_ZOOMIN : 1 / M_ZOOMIN;
        this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale));   // AM_changeWindowScale's clamps
        this.big = null;
      }
      if (this.follow) {
        this.x = player.x;
        this.y = player.y;
      } else {
        // AM_changeWindowLoc: F_PANINC pixels, kept within the level
        const step = F_PANINC / this.scale;
        this.x += ((held.right ? 1 : 0) - (held.left ? 1 : 0)) * step;
        this.y += ((held.up ? 1 : 0) - (held.down ? 1 : 0)) * step;
        this.x = Math.min(this.bounds.maxX, Math.max(this.bounds.minX, this.x));
        this.y = Math.min(this.bounds.maxY, Math.max(this.bounds.minY, this.y));
      }
    }
  }

  /** F: follow mode on or off; the message to show. */
  toggleFollow() { this.follow = !this.follow; return this.follow ? 'AMSTR_FOLLOWON' : 'AMSTR_FOLLOWOFF'; }

  /** G: the grid. */
  toggleGrid() { this.grid = !this.grid; return this.grid ? 'AMSTR_GRIDON' : 'AMSTR_GRIDOFF'; }

  /** 0 (AM_BIGZOOMKEY): the whole level, centred; again, back to where it was. */
  toggleBig() {
    if (this.big) {
      ({ x: this.x, y: this.y, scale: this.scale } = this.big);
      this.big = null;
    } else {
      this.big = { x: this.x, y: this.y, scale: this.scale };
      this.scale = this.minScale;
      this.x = (this.bounds.minX + this.bounds.maxX) / 2;
      this.y = (this.bounds.minY + this.bounds.maxY) / 2;
      this.follow = false;
    }
  }

  /** M: a mark at the window's centre (AM_addMark); the oldest goes after ten. */
  addMark() {
    this.marks[this.markNum] = [this.x, this.y];
    this.markNum = (this.markNum + 1) % NUMMARKS;
    return 'AMSTR_MARKEDSPOT';
  }

  /** C: no marks (AM_clearMarks). */
  clearMarks() {
    this.marks = [];
    this.markNum = 0;
    return 'AMSTR_MARKSCLEARED';
  }

  /** AM_drawGrid: the BLOCKMAP's lines across the window, as [x1, y1, x2, y2] in map units. */
  gridLines() {
    const halfW = F_W / 2 / this.scale;
    const halfH = F_H / 2 / this.scale;
    const out = [];
    const [ox, oy] = this.origin;
    for (let x = ox + Math.ceil((this.x - halfW - ox) / MAPBLOCKUNITS) * MAPBLOCKUNITS; x <= this.x + halfW; x += MAPBLOCKUNITS) {
      out.push([x, this.y - halfH, x, this.y + halfH]);
    }
    for (let y = oy + Math.ceil((this.y - halfH - oy) / MAPBLOCKUNITS) * MAPBLOCKUNITS; y <= this.y + halfH; y += MAPBLOCKUNITS) {
      out.push([this.x - halfW, y, this.x + halfW, y]);
    }
    return out;
  }
}
