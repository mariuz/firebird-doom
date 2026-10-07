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

