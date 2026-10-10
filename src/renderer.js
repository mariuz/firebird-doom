// renderer.js – turn Firebird's frame rows into pixels.
//
// Firebird decides *what* is visible: which wall slice lands in which screen
// column, at what depth, through which clip window (FRAME_WALLS), and which
// sprite frame faces the camera at what screen rectangle (FRAME_SPRITES).
// This file only does what a GPU would: texture lookups and colormap
// lighting. Like DOOM, it works in palette indices: the view and the 320×200
// screen hold one byte per pixel, already lit through COLORMAP, and the
// palette (PLAYPAL, with its pain/pickup/radiation tints) is applied when the
// screen is presented (present.js).

import { paletteTables } from './present.js';

// DOOM's animated flats and wall textures (p_spec.c animdefs), 8 tics/frame.
const ANIMS = [
  ['NUKAGE1', 'NUKAGE3'], ['FWATER1', 'FWATER4'], ['SWATER1', 'SWATER4'], ['LAVA1', 'LAVA4'],
  ['BLOOD1', 'BLOOD3'], ['RROCK05', 'RROCK08'], ['SLIME01', 'SLIME04'], ['SLIME05', 'SLIME08'],
  ['SLIME09', 'SLIME12'],
  ['BLODGR1', 'BLODGR4'], ['SLADRIP1', 'SLADRIP3'], ['BLODRIP1', 'BLODRIP4'], ['FIREWALA', 'FIREWALL'],
  ['GSTFONT1', 'GSTFONT3'], ['FIRELAVA', 'FIRELAV3'], ['FIREMAG1', 'FIREMAG3'], ['FIREBLU1', 'FIREBLU2'],
  ['ROCKRED1', 'ROCKRED3'], ['BFALL1', 'BFALL4'], ['SFALL1', 'SFALL4'], ['WFALL1', 'WFALL4'], ['DBRAIN1', 'DBRAIN4'],
];

function buildAnim(names) {
  // names: array index = id-1 → name. Returns id → [ids of the cycle] for animated ones.
  const idOf = new Map(names.map((n, i) => [n, i + 1]));
  const cycles = new Map();
  for (const [a, b] of ANIMS) {
    const ia = idOf.get(a);
    const ib = idOf.get(b);
    if (!ia || !ib || ib < ia) continue;
    const cyc = [];
    for (let i = ia; i <= ib; i++) cyc.push(i);
    for (const id of cyc) cycles.set(id, cyc);
  }
  return cycles;
}

/**
 * This frame's visplanes. A plane is one (height, flat, light) surface with
 * at most one span per column; marking a column that is already taken
 * starts a new plane with the same key, which is what R_CheckPlane does.
 */
class Visplanes {
  constructor(w) {
    this.w = w;
    this.byKey = new Map();
    this.list = [];
  }

  mark(key, info, x, top, bottom) {
    let group = this.byKey.get(key);
    if (!group) this.byKey.set(key, (group = []));
    let p = group.find((q) => q.top[x] === 0x7fff);
    if (!p) {
      p = { ...info, top: new Int16Array(this.w).fill(0x7fff), bottom: new Int16Array(this.w).fill(-1), minx: x, maxx: x };
      group.push(p);
      this.list.push(p);
    }
    p.top[x] = top;
    p.bottom[x] = bottom;
    if (x < p.minx) p.minx = x;
    if (x > p.maxx) p.maxx = x;
  }
}

// r_draw.c's fuzzoffset[]: one row up (-1) or down (+1), 50 pixels long
const FUZZ_OFFSETS = [
  1, -1, 1, -1, 1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, -1, -1, -1, 1, -1, -1, 1,
  1, 1, 1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1, -1, 1, 1, -1, 1,
];
const FUZZ_MAP = 6 * 256;   // COLORMAP 6: what fuzz darkens through

/**
 * R_InitTranslationTables: players 2, 3 and 4 wear player 1's green ramp
 * (palette 0x70–0x7F) as indigo (0x60), brown (0x40) and red (0x20).
 */
export const TRANSLATIONS = [0x60, 0x40, 0x20].map((base) => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i >= 0x70 && i <= 0x7f ? base + (i & 0xf) : i;
  return t;
});

// ── R_InitLightTables / R_ExecuteSetViewSize, in DOOM's integer arithmetic ──
// 16 light levels (LIGHTSEGSHIFT 4), 32 colormaps; each level's brightest
// colormap is startmap = (15 - level) * 4, and distance takes it darker.
const LIGHTLEVELS = 16;
const NUMCOLORMAPS = 32;
const MAXLIGHTSCALE = 48;
const MAXLIGHTZ = 128;
const clampMap = (level) => Math.max(0, Math.min(NUMCOLORMAPS - 1, level));
const startMap = (lightnum) => ((LIGHTLEVELS - 1 - lightnum) * 2 * NUMCOLORMAPS) / LIGHTLEVELS;

/** A sector light level (0–255) plus extralight → the light number, 0–15. */
export function lightNum(light, extralight = 0) {
  return Math.max(0, Math.min(LIGHTLEVELS - 1, (light >> 4) + extralight));
}

/**
 * FRAME_WALLS' five values a slice [col, depth, u, line, backView], in order
 * down each column (front to back), made whole again:
 * [col, depth, u, line, backView, openTop, openBot, clipTop, clipBot].
 * The opening is RENDER_SLICES': none (h, 0) for a one-sided line or a closed
 * two-sided one, else the screen y of the lower ceiling and the higher floor
 * (with the sky hack: two sky ceilings count as one). The clip window is
 * RENDER_WALLS': what the openings in front of it leave open. MAP gives the
 * lines, sides and this frame's sectors; VZ is the view's height.
 */
export function expandWalls(rows, map, vz, h, projy) {
  if (rows.length && rows[0].length > 5) return rows;   // (already whole)
  const hh = h / 2;
  const out = new Array(rows.length);
  let col = -1;
  let clipTop = 0;
  let clipBot = 1e9;
  for (let i = 0; i < rows.length; i++) {
    const [c, depth, u, lineId, backView] = rows[i];
    if (c !== col) {
      col = c;
      clipTop = 0;
      clipBot = 1e9;
    }
    const L = map.lines.get(lineId);
    const fs = map.sectors.get(map.sides.get(backView ? L.bs : L.fs).sector);
    const bs = L.bs == null ? null : map.sectors.get(map.sides.get(backView ? L.fs : L.bs).sector);
    let openTop = h;
    let openBot = 0;
    if (bs) {
      const bc = fs.sky && bs.sky ? fs.ceil : bs.ceil;
      if (!(bc <= bs.floor || bc <= fs.floor || bs.floor >= fs.ceil)) {
        const s = projy / depth;
        openTop = hh - (Math.min(fs.ceil, bc) - vz) * s;
        openBot = hh - (Math.max(fs.floor, bs.floor) - vz) * s;
      }
    }
    out[i] = [c, depth, u, lineId, backView, openTop, openBot, clipTop, clipBot];
    clipTop = Math.max(clipTop, openTop);
    clipBot = Math.min(clipBot, openBot);
  }
  return out;
}

/**
 * R_StoreWallRange's markceiling / markfloor, as RENDER_WALLS works them out:
 * the rows [cTop, cBot) of the front sector's ceiling and [fTop, fBot) of its
 * floor, between the clip window's rows [yTop, yBot) and the wall. YFC and YFF
 * are the screen y of the front sector's ceiling and floor at the slice's
 * scale (h/2 − (height − viewz) × projy / depth).
 */
export function visplaneMarks(yTop, yBot, yfc, yff) {
  return [yTop, Math.min(yBot, Math.max(yTop, Math.ceil(yfc))), Math.max(yTop, Math.min(yBot, Math.ceil(yff))), yBot];
}

/** scalelight[lightnum][index]: walls and sprites, by their projected scale (index = scale >> 12).
 *  R_ExecuteSetViewSize builds it for the view's width on the screen (viewwidth << detailshift). */
export function scaleLight(lightnum, index, scaledWidth = 320) {
  // level = startmap - j*SCREENWIDTH/(viewwidth<<detailshift)/DISTMAP
  const j = Math.max(0, Math.min(MAXLIGHTSCALE - 1, index));
  return clampMap(startMap(lightnum) - Math.trunc(Math.trunc((j * 320) / scaledWidth) / 2));
}

/**
 * R_ExecuteSetViewSize: the 3D view for screen size BLOCKS (3–11) and the
 * detail. 11 is the whole 320×200 screen with no status bar, 10 the full
 * width above it; below that the view is blocks × 32 wide and
 * (blocks × 168 / 10) & ~7 tall, centred over the status bar, with a border.
 * w is in columns (half of scaledW in low detail).
 */
export function viewGeometry(blocks = 10, detail = 'high') {
  const b = Math.max(3, Math.min(11, Math.trunc(blocks)));
  const scaledW = b === 11 ? 320 : b * 32;
  const h = b === 11 ? 200 : Math.trunc((b * 168) / 10) & ~7;
  return {
    blocks: b, scaledW, h, w: scaledW >> (detail === 'low' ? 1 : 0),
    x: (320 - scaledW) >> 1, y: scaledW === 320 ? 0 : (168 - h) >> 1,
  };
}

// zlight[lightnum][j]: scale = FixedDiv(160 << 16, (j + 1) << 20) >> 12, level = startmap - scale/DISTMAP
const ZLIGHT = Array.from({ length: LIGHTLEVELS }, (_, i) => Array.from({ length: MAXLIGHTZ }, (__, j) => {
  const scale = Math.trunc(Math.trunc((160 * 65536 * 65536) / ((j + 1) * 1048576)) / 4096);
  return clampMap(startMap(i) - Math.trunc(scale / 2));
}));

/** zlight[lightnum][index]: flats, by distance (index = distance >> 20, i.e. distance / 16). */
export function zLight(lightnum, index) {
  return ZLIGHT[lightnum][Math.max(0, Math.min(MAXLIGHTZ - 1, index))];
}

export class Renderer {
  constructor(wad, res) {
    this.wad = wad;
    this.res = res;
    this.textures = new Map();
    this.flats = new Map();
    this.pictures = new Map();
    this.texAnim = buildAnim(res.texDefs.map((d) => d.name));
    this.flatAnim = buildAnim(res.flats.map((l) => l.name));
    // COLORMAP: 34 rows of 256 – light levels 0–31, 32 the invulnerability greys
    this.cmap = wad.colormap();
    this.playpal = wad.data(wad.lump('PLAYPAL'));
    this.palettes = paletteTables(this.playpal);   // (as the WAD has them: toRGBA, the tests' pictures)
    this.gamma = 0;                                 // the presenter's gamma level (F11)
    this.presenter = null;
    this.fuzzPos = 0;
    this.screen = new Uint8Array(320 * 200);
    this.setSize(320, 168);
    this.back = null;        // R_FillBackScreen's picture, and what it was made for
    this.backKey = '';
  }

  /** Where present() sends the screen; it gets this WAD's palettes, at the gamma level. */
  attach(presenter) {
    this.presenter = presenter;
    presenter?.setPalettes(paletteTables(this.playpal, this.gamma));
  }

  /** I_SetPalette with usegamma: the presenter's palettes through gamma table LEVEL (0–4). */
  setGamma(level) {
    this.gamma = Math.max(0, Math.min(4, level | 0));
    this.attach(this.presenter);
  }

  /** The view: W columns by H rows, SCALEDW pixels wide on the screen at (X, Y). */
  setSize(w, h, { scaledW = 320, x = 0, y = 0 } = {}) {
    this.w = w;
    this.h = h;
    this.scaledW = scaledW;
    this.winX = x;
    this.winY = y;
    this.fb = new Uint8Array(w * h);
    this.sfb = this.screen;
    this.proj = w / 2; // 90° horizontal field of view
    this.spanStart = new Int32Array(h);
    // yslope's (viewwidth << detailshift) / 2: the vertical scale follows the
    // view's width on the screen, whatever the detail
    this.projy = scaledW / 2;
  }

  texture(id) {
    let t = this.textures.get(id);
    if (!t) {
      const def = this.res.texDefs[id - 1];
      if (!def) return null;
      t = this.wad.composeTexture(def);
      this.textures.set(id, t);
    }
    return t;
  }

  flat(id) {
    let f = this.flats.get(id);
    if (!f) {
      const l = this.res.flats[id - 1];
      if (!l) return null;
      f = this.wad.data(l);
      this.flats.set(id, f);
    }
    return f;
  }

  picture(lump) {
    let p = this.pictures.get(lump);
    if (!p) {
      p = this.wad.picture(this.wad.lumps[lump]);
      this.pictures.set(lump, p);
    }
    return p;
  }

  pictureByName(name) {
    const l = this.wad.lump(name);
    return l ? this.picture(l.index) : null;
  }

  anim(id, cycles, tic) {
    const c = cycles.get(id);
    if (!c) return id;
    return c[(c.indexOf(id) + Math.floor(tic / 8)) % c.length];
  }

  /**
   * Draw one frame.
   *   view:    { x, y, z, angle, tic, fixedColormap }
   *   walls:   FRAME_WALLS rows [col, depth, u, line, backView]: the opening, the clip window
   *            and the visplane rows are worked out here (expandWalls, visplaneMarks), as
   *            RENDER_SLICES and RENDER_WALLS have them
   *   sprites: FRAME_SPRITES rows [id, depth, lump, flip, x1, x2, y1, y2, light, fuzz, tr]
   *   map:     { lines: Map, sides: Map, sectors: Map, skyTex }
   */
  drawView(view, frameWalls, sprites, map) {
    const { w, h, fb, proj, projy } = this;
    const walls = expandWalls(frameWalls, map, view.z, h, projy);
    // R_SetupFrame: a fixed colormap (32, INVERSECOLORMAP, while invulnerable)
    // replaces the light levels – except on the sky, as in vanilla
    this.fixedCm = view.fixedColormap ?? null;
    // P_PlayerThink's extralight: the muzzle flash (A_Light1/A_Light2) brightens everything a step or two
    this.extralight = view.extralight ?? 0;
    const hh = h / 2;
    const hw = w / 2;
    const vz = view.z;
    const tic = view.tic;
    const sky = this.texture(map.skyTex);
    fb.fill(0);

    const masked = [];
    const planes = new Visplanes(w);
    // Per-column index into `walls` so sprites can find what is in front of them.
    const colStart = new Int32Array(w + 1).fill(-1);

    for (let i = 0; i < walls.length; i++) {
      const [col, depth, u, lineId, backView, openTop, openBot, clipTop, clipBot] = walls[i];
      if (colStart[col] < 0) colStart[col] = i;
      const L = map.lines.get(lineId);
      const S = map.sides.get(backView ? L.bs : L.fs);
      const B = L.bs == null ? null : map.sides.get(backView ? L.fs : L.bs);
      const fs = map.sectors.get(S.sector);
      const bs = B ? map.sectors.get(B.sector) : null;
      const scale = projy / depth;
      const yTop = Math.max(0, Math.ceil(clipTop));
      const yBot = Math.min(h, Math.ceil(clipBot));
      if (yTop >= yBot) continue;
      const yfc = hh - (fs.ceil - vz) * scale;
      const yff = hh - (fs.floor - vz) * scale;
      const [cTop, cBot, fTop, fBot] = visplaneMarks(yTop, yBot, yfc, yff);

      // R_FindPlane / R_CheckPlane: Firebird told us which rows of this column
      // the front sector's ceiling and floor fill; file them under a visplane.
      // All sky shares one plane, as in DOOM.
      if (cBot > cTop) {
        if (fs.sky) planes.mark('sky', { sky: true }, col, cTop, cBot - 1);
        else planes.mark(`c${fs.ceil}|${fs.ceilFlat}|${fs.light}`, { height: fs.ceil, flat: fs.ceilFlat, light: fs.light, floor: false }, col, cTop, cBot - 1);
      }
      if (fBot > fTop) {
        planes.mark(`f${fs.floor}|${fs.floorFlat}|${fs.light}`, { height: fs.floor, flat: fs.floorFlat, light: fs.light, floor: true }, col, fTop, fBot - 1);
      }
      const cEnd = cBot; // the wall starts where the ceiling ends…
      const fStart = fTop; // …and ends where the floor starts

      const light = fs.light + L.lightDelta;
      // P_UpdateSpecials: line 48's front side scrolls a unit a tic (textureoffset += FRACUNIT)
      const tu = u + S.xoff + (L.scroll && !backView ? tic : 0);
      if (!bs) {
        const tex = this.texture(this.anim(S.mid, this.texAnim, tic));
        if (tex) {
          const top = L.flags & 16 ? fs.floor + tex.h : fs.ceil;
          this.wallColumn(col, cEnd, fStart, tex, tu, top + S.yoff, depth, scale, vz, light);
        }
      } else {
        const bc = fs.sky && bs.sky ? fs.ceil : bs.ceil;
        const ybc = hh - (bc - vz) * scale;
        const ybf = hh - (bs.floor - vz) * scale;
        if (bc < fs.ceil && S.upper) {
          const tex = this.texture(this.anim(S.upper, this.texAnim, tic));
          if (tex) {
            const top = L.flags & 8 ? fs.ceil : bc + tex.h;
            const end = Math.min(fStart, Math.max(cEnd, Math.ceil(ybc)));
            this.wallColumn(col, cEnd, end, tex, tu, top + S.yoff, depth, scale, vz, light);
          }
        }
        if (bs.floor > fs.floor && S.lower) {
          const tex = this.texture(this.anim(S.lower, this.texAnim, tic));
          if (tex) {
            const top = L.flags & 16 ? fs.ceil : bs.floor;
            const start = Math.max(cEnd, Math.min(fStart, Math.ceil(ybf)));
            this.wallColumn(col, start, fStart, tex, tu, top + S.yoff, depth, scale, vz, light);
          }
        }
        if (S.mid) {
          const tex = this.texture(S.mid);
          if (tex) {
            const top = L.flags & 16 ? Math.max(fs.floor, bs.floor) + tex.h : Math.min(fs.ceil, bc);
            masked.push({
              depth, col, tex, tu, top: top + S.yoff, light, scale,
              y0: Math.max(yTop, Math.ceil(Math.max(yfc, ybc))),
              y1: Math.min(yBot, Math.ceil(Math.min(yff, ybf))),
            });
          }
        }
      }
    }
    colStart[w] = walls.length;

    // R_DrawPlanes: each visplane becomes horizontal spans.
    this.visplaneCount = planes.list.length;
    for (const p of planes.list) {
      if (p.sky) {
        for (let x = p.minx; x <= p.maxx; x++) {
          if (p.top[x] <= p.bottom[x]) {
            this.skyColumn(x, p.top[x], p.bottom[x] + 1, view.angle - Math.atan((x + 0.5 - hw) / proj), sky);
          }
        }
      } else {
        const flat = this.flat(this.anim(p.flat, this.flatAnim, tic));
        if (flat) this.makeSpans(p, flat, view);
      }
    }

    // Masked middles and sprites, far to near, clipped by the walls in front.
    const items = masked.map((m) => ({ ...m, kind: 0 }));
    for (const s of sprites) items.push({ kind: 1, depth: s[1], lump: s[2], flip: s[3], x1: s[4], x2: s[5], y1: s[6], y2: s[7], light: s[8], fuzz: s[9], tr: s[10] });
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) {
      if (it.kind === 0) {
        this.wallColumn(it.col, it.y0, it.y1, it.tex, it.tu, it.top, it.depth, it.scale, vz, it.light, true);
      } else {
        this.spriteDraw(it, walls, colStart);
      }
    }
  }

  /** A wall's (or masked middle's) colormap: scalelight[light][rw_scale >> LIGHTSCALESHIFT]. */
  lightIndex(light, depth) {
    // fixedcolormap (invulnerability, the goggles) overrides all lighting
    if (this.fixedCm != null) return this.fixedCm;
    // R_RenderSegLoop: rw_scale is projection / distance, and projection is
    // half the view's columns – so in low detail it halves while scalelight
    // doesn't, and walls come out darker at a distance (vanilla's quirk, kept)
    return scaleLight(lightNum(light, this.extralight), Math.floor((this.proj * 16) / depth), this.scaledW ?? 320);
  }

  /** A sprite's: R_ProjectSprite shifts by LIGHTSCALESHIFT - detailshift, so detail doesn't change it. */
  spriteLightIndex(light, depth) {
    if (this.fixedCm != null) return this.fixedCm;
    const sw = this.scaledW ?? 320;
    return scaleLight(lightNum(light, this.extralight), Math.floor((sw * 8) / depth), sw);
  }

  wallColumn(col, y0, y1, tex, u, top, depth, scale, vz, light, masked = false) {
    if (y0 >= y1) return;
    const { fb, w, h, cmap } = this;
    const hh = h / 2;
    const cm = this.lightIndex(light, depth) * 256;
    let tx = Math.floor(u) % tex.w;
    if (tx < 0) tx += tex.w;
    const colOff = tx * tex.h;
    const inv = 1 / scale;
    for (let y = y0; y < y1; y++) {
      const z = vz + (hh - (y + 0.5)) * inv;
      let ty = Math.floor(top - z);
      if (masked) {
        if (ty < 0 || ty >= tex.h || !tex.alpha[colOff + ty]) continue;
      } else {
        ty %= tex.h;
        if (ty < 0) ty += tex.h;
      }
      fb[y * w + col] = cmap[cm + tex.pix[colOff + ty]];
    }
  }

  /**
   * R_MakeSpans: sweep the plane's columns left to right. Rows whose span
   * ends at this column are drawn; rows that begin here are remembered.
   */
  makeSpans(p, flat, view) {
    const { top, bottom, minx, maxx } = p;
    const start = this.spanStart;
    const T = (x) => (x < minx || x > maxx ? 0x7fff : top[x]);
    const B = (x) => (x < minx || x > maxx ? -1 : bottom[x]);
    for (let x = minx; x <= maxx + 1; x++) {
      let t1 = T(x - 1);
      let b1 = B(x - 1);
      let t2 = T(x);
      let b2 = B(x);
      while (t1 < t2 && t1 <= b1) { this.mapPlane(p, flat, t1, start[t1], x - 1, view); t1++; }
      while (b1 > b2 && b1 >= t1) { this.mapPlane(p, flat, b1, start[b1], x - 1, view); b1--; }
      while (t2 < t1 && t2 <= b2) { start[t2] = x; t2++; }
      while (b2 > b1 && b2 >= t2) { start[b2] = x; b2--; }
    }
  }

  /**
   * R_MapPlane: one horizontal span. Every pixel of a row of a flat plane is
   * at the same distance, so distance and light are computed once per span
   * and the texture coordinates just step along the row.
   */
  mapPlane(p, flat, y, x1, x2, view) {
    const { fb, w, h, proj, projy, cmap } = this;
    const hh = h / 2;
    const dy = p.floor ? y + 0.5 - hh : hh - y - 0.5;
    const height = p.floor ? view.z - p.height : p.height - view.z;
    if (dy <= 0 || height <= 0) return;
    const dist = (height * projy) / dy;
    const ca = Math.cos(view.angle);
    const sa = Math.sin(view.angle);
    const k = (x1 + 0.5 - w / 2) / proj;
    let wx = view.x + dist * (ca + k * sa);
    let wy = view.y + dist * (sa - k * ca);
    const sx = (dist * sa) / proj;
    const sy = (-dist * ca) / proj;
    // R_MapPlane: zlight[light][distance >> LIGHTZSHIFT]
    const cm = (this.fixedCm ?? zLight(lightNum(p.light, this.extralight), Math.floor(dist / 16))) * 256;
    let o = y * w + x1;
    for (let x = x1; x <= x2; x++) {
      fb[o++] = cmap[cm + flat[((Math.floor(-wy) & 63) << 6) | (Math.floor(wx) & 63)]];
      wx += sx;
      wy += sy;
    }
  }

  skyColumn(col, y0, y1, angle, sky) {
    if (!sky || y0 >= y1) return;
    const { fb, w, h, cmap } = this;
    let tx = Math.floor((angle * 1024) / (2 * Math.PI)) % sky.w;
    if (tx < 0) tx += sky.w;
    const off = tx * sky.h;
    // R_DrawSky: texturemid 100 at the view's centre line, one texel per row,
    // always COLORMAP 0 (full bright, untouched by invulnerability)
    for (let y = y0; y < y1; y++) {
      let ty = Math.floor(100 + y + 0.5 - h / 2) % sky.h;
      if (ty < 0) ty += sky.h;
      fb[y * w + col] = cmap[sky.pix[off + ty]];
    }
  }

  spriteDraw(s, walls, colStart) {
    const pic = this.picture(s.lump);
    const { fb, w, h, cmap } = this;
    // R_DrawFuzzColumn: a shadow's pixels aren't its own – each one takes the
    // pixel just above or below it (FUZZTABLE) and darkens it (COLORMAP 6)
    const fuzz = s.fuzz === 1;
    const tr = s.tr ? TRANSLATIONS[s.tr - 1] : null;   // (R_DrawTranslatedColumn: another player's colours)
    const cm = (s.light >= 255 ? (this.fixedCm ?? 0) : this.spriteLightIndex(s.light, s.depth)) * 256;
    const xa = Math.max(0, Math.ceil(s.x1 - 0.5));
    const xb = Math.min(w - 1, Math.ceil(s.x2 - 0.5) - 1);
    const sx = pic.w / (s.x2 - s.x1);
    const sy = pic.h / (s.y2 - s.y1);
    for (let x = xa; x <= xb; x++) {
      // the clip window left by every wall slice nearer than the sprite
      let top = 0;
      let bot = h;
      for (let i = colStart[x]; i >= 0 && i < walls.length && walls[i][0] === x; i++) {
        const r = walls[i];
        if (r[1] >= s.depth) break;
        top = Math.max(top, r[5], r[7]);
        bot = Math.min(bot, r[6], r[8]);
      }
      let px = Math.floor((x + 0.5 - s.x1) * sx);
      if (px < 0 || px >= pic.w) continue;
      if (s.flip) px = pic.w - 1 - px;
      const y0 = Math.max(Math.ceil(top), Math.ceil(s.y1 - 0.5), 0);
      const y1 = Math.min(Math.ceil(bot), Math.ceil(s.y2 - 0.5), h);
      const off = px * pic.h;
      for (let y = y0; y < y1; y++) {
        const py = Math.floor((y + 0.5 - s.y1) * sy);
        if (py < 0 || py >= pic.h || !pic.alpha[off + py]) continue;
        if (fuzz) {
          const fy = Math.min(h - 1, Math.max(0, y + FUZZ_OFFSETS[this.fuzzPos]));
          this.fuzzPos = (this.fuzzPos + 1) % FUZZ_OFFSETS.length;
          fb[y * w + x] = cmap[FUZZ_MAP + fb[fy * w + x]];
        } else fb[y * w + x] = cmap[cm + (tr ? tr[pic.pix[off + py]] : pic.pix[off + py])];
      }
    }
  }

  /** Draw a patch onto the 320×200 screen (status bar, weapon, text), through colormap `light`. */
  patch(pic, x, y, light = 0) {
    if (!pic) return;
    const { sfb, cmap } = this;
    const x0 = x - pic.left;
    const y0 = y - pic.top;
    const base = light * 256;
    for (let px = 0; px < pic.w; px++) {
      const sx = x0 + px;
      if (sx < 0 || sx >= 320) continue;
      const off = px * pic.h;
      for (let py = 0; py < pic.h; py++) {
        const sy = y0 + py;
        if (sy < 0 || sy >= 200 || !pic.alpha[off + py]) continue;
        sfb[sy * 320 + sx] = cmap[base + pic.pix[off + py]];
      }
    }
  }

  /**
   * R_DrawPSprite: a weapon sprite at (SX, SY) in DOOM's 320×200 weapon
   * space, placed against the view's centre (BASEYCENTER 100 is the centre of
   * a full screen, so above the status bar it sits 16 pixels higher), scaled
   * by pspritescale (the view's width / 320) and clipped to the view. LIGHT
   * is a colormap row, or 'fuzz' (R_DrawFuzzColumn: partial invisibility).
   */
  psprite(pic, sx, sy, light = 0) {
    if (!pic) return;
    const { sfb, cmap, scaledW, h, winX, winY } = this;
    const s = scaledW / 320;
    const left = winX + scaledW / 2 + (sx - 160 - pic.left) * s;
    const top = winY + h / 2 - (100 - (sy - pic.top)) * s;
    const x0 = Math.max(winX, Math.ceil(left));
    const x1 = Math.min(winX + scaledW, Math.ceil(left + pic.w * s));
    const y0 = Math.max(winY, Math.ceil(top));
    const y1 = Math.min(winY + h, Math.ceil(top + pic.h * s));
    const fuzz = light === 'fuzz';
    const base = fuzz ? 0 : light * 256;
    for (let x = x0; x < x1; x++) {
      const px = Math.min(pic.w - 1, Math.floor((x - left) / s));
      const off = px * pic.h;
      for (let y = y0; y < y1; y++) {
        const py = Math.min(pic.h - 1, Math.floor((y - top) / s));
        if (!pic.alpha[off + py]) continue;
        if (fuzz) {
          const fy = Math.min(winY + h - 1, Math.max(winY, y + FUZZ_OFFSETS[this.fuzzPos]));
          this.fuzzPos = (this.fuzzPos + 1) % FUZZ_OFFSETS.length;
          sfb[y * 320 + x] = cmap[FUZZ_MAP + sfb[fy * 320 + x]];
        } else sfb[y * 320 + x] = cmap[base + pic.pix[off + py]];
      }
    }
  }

  /**
   * R_FillBackScreen + R_DrawViewBorder: around a view narrower than the
   * screen, the flat FLAT tiled over everything above the status bar, and the
   * BRDR_* patches bevelling the view's edge. Made once per size, then copied.
   */
  drawBorder(flat) {
    const { scaledW, h, winX, winY, sfb } = this;
    if (scaledW >= 320) return;
    const key = `${flat}|${scaledW}|${h}`;
    if (this.backKey !== key) {
      const lump = this.wad.lump(flat);
      const data = lump ? this.wad.data(lump) : null;
      for (let y = 0; y < 168; y++) {
        for (let x = 0; x < 320; x++) sfb[y * 320 + x] = data ? data[((y & 63) << 6) + (x & 63)] : 0;
      }
      const p = (n) => this.pictureByName(n);
      for (let x = 0; x < scaledW; x += 8) {
        this.patch(p('BRDR_T'), winX + x, winY - 8);
        this.patch(p('BRDR_B'), winX + x, winY + h);
      }
      for (let y = 0; y < h; y += 8) {
        this.patch(p('BRDR_L'), winX - 8, winY + y);
        this.patch(p('BRDR_R'), winX + scaledW, winY + y);
      }
      this.patch(p('BRDR_TL'), winX - 8, winY - 8);
      this.patch(p('BRDR_TR'), winX + scaledW, winY - 8);
      this.patch(p('BRDR_BL'), winX - 8, winY + h);
      this.patch(p('BRDR_BR'), winX + scaledW, winY + h);
      this.back = sfb.slice(0, 320 * 168);
      this.backKey = key;
      return;
    }
    sfb.set(this.back);
  }

  /** Put the 3D view into its window on the 320×200 screen (low detail doubles pixels). */
  composeView() {
    const { w, h, fb, sfb, scaledW, winX, winY } = this;
    const sx = w / scaledW;
    for (let y = 0; y < Math.min(h, 200 - winY); y++) {
      const row = y * w;
      const out = (winY + y) * 320 + winX;
      for (let x = 0; x < scaledW; x++) sfb[out + x] = fb[row + Math.floor(x * sx)];
    }
  }

  /** Darken the view area through a COLORMAP row (the automap's backdrop). */
  dim(level) {
    const { sfb, cmap } = this;
    const base = level * 256;
    for (let i = 0; i < 320 * 168; i++) sfb[i] = cmap[base + sfb[i]];
  }

  /** A line in palette colour `color` across the view area (AM_drawMline), clipped to it. */
  line(x0, y0, x1, y1, color) {
    const { sfb } = this;
    // Liang–Barsky against 0..319 × 0..167, then a DDA
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    for (const [p, q] of [[-dx, x0], [dx, 319 - x0], [-dy, y0], [dy, 167 - y0]]) {
      if (p === 0) { if (q < 0) return; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return; if (r > t0) t0 = r; } else { if (r < t0) return; if (r < t1) t1 = r; }
    }
    const ax = x0 + t0 * dx;
    const ay = y0 + t0 * dy;
    const bx = x0 + t1 * dx;
    const by = y0 + t1 * dy;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const y = Math.round(ay + ((by - ay) * i) / n);
      if (x >= 0 && x < 320 && y >= 0 && y < 168) sfb[y * 320 + x] = color;
    }
  }

  /** I_SetPalette + I_FinishUpdate: the presenter turns the screen into colours. */
  present(palette = 0) {
    this.presenter?.present(this.sfb, palette);
  }

  /** The screen as RGBA words through one palette (screenshots, tests). */
  toRGBA(palette = 0) {
    const { words, npal } = this.palettes;
    const base = Math.min(palette, npal - 1) * 256;
    const out = new Uint32Array(320 * 200);
    for (let i = 0; i < out.length; i++) out[i] = words[base + this.sfb[i]];
    return out;
  }
}
