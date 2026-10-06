// automap.js – am_map.c's AM_drawWalls: which colour, if any, a line gets.
//
// A line shows once you've seen it (ML_MAPPED: the renderer drew part of it,
// or the map pre-marked it with flag 256). Lines you haven't seen show in
// grey only with the computer area map (pw_allmap). ML_DONTDRAW (128) lines
// never show, and ML_SECRET (32) ones pass for plain walls.
//
// IDDT (am_cheating 1 or 2) shows every line, ML_DONTDRAW ones included,
// with flat two-sided openings in grey; level 2 also draws the things.

export const AM_COLORS = {
  wall: '#fc0000',      // WALLCOLORS: one-sided, or secret
  teleport: '#a40000',  // WALLCOLORS + WALLRANGE/2: a teleporter line (39)
  floor: '#bc7844',     // FDWALLCOLORS: a floor height change
  ceil: '#fcfc00',      // CDWALLCOLORS: a ceiling height change
  unseen: '#8b8b8b',    // GRAYS + 3: not seen yet, shown by the computer map
  twoSided: '#6f6f6f',  // TSWALLCOLORS: a flat opening, only with IDDT
  thing: '#74fc6c',     // THINGCOLORS: things, with IDDT twice
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
 * @returns a CSS colour, or null to leave the line out
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

/** cht_CheckCheat for IDDT: feed it each key typed on the automap; true once "iddt" is spelt. */
export function makeCheatReader(code = 'iddt') {
  let typed = '';
  return (key) => {
    if (key.length !== 1) return false;
    typed = (typed + key.toLowerCase()).slice(-code.length);
    if (typed !== code) return false;
    typed = '';
    return true;
  };
}
