// renderer.js – turn Firebird's frame rows into pixels.
//
// Firebird decides *what* is visible: which wall slice lands in which screen
// column, at what depth, through which clip window (FRAME_WALLS), and which
// sprite frame faces the camera at what screen rectangle (FRAME_SPRITES).
// This file only does what a GPU would: texture lookups, colormap lighting,
// and writing RGBA into a canvas.

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
export class Renderer {
  constructor(canvas, wad, res) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.wad = wad;
    this.res = res;
    this.textures = new Map();
    this.flats = new Map();
    this.pictures = new Map();
    this.texAnim = buildAnim(res.texDefs.map((d) => d.name));
    this.flatAnim = buildAnim(res.flats.map((l) => l.name));

    // RGBA for every (palette, colormap, index): 14 × 34 × 256 entries.
    const pal = wad.data(wad.lump('PLAYPAL'));
    const cmap = wad.colormap();
    const npal = Math.min(14, Math.floor(pal.length / 768));
    this.lut = new Uint32Array(npal * 34 * 256);
    for (let p = 0; p < npal; p++) {
      for (let c = 0; c < 34; c++) {
        for (let i = 0; i < 256; i++) {
          const ci = cmap[c * 256 + i];
          const o = p * 768 + ci * 3;
          this.lut[(p * 34 + c) * 256 + i] = 0xff000000 | (pal[o + 2] << 16) | (pal[o + 1] << 8) | pal[o];
        }
      }
    }
    // …and back: which palette index is this framebuffer colour? (fuzz
    // darkens what's already on screen through COLORMAP 6)
    this.unlut = [];
    for (let p = 0; p < npal; p++) {
      const m = new Map();
      for (let i = 0; i < 256; i++) {
        const o = p * 768 + i * 3;
        const rgba = (0xff000000 | (pal[o + 2] << 16) | (pal[o + 1] << 8) | pal[o]) >>> 0;
        if (!m.has(rgba)) m.set(rgba, i);
      }
      this.unlut.push(m);
    }
    this.fuzzPos = 0;
    this.setSize(320, 168);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = 320;
    this.canvas.height = 200;
    this.view = new ImageData(w, h);
    this.fb = new Uint32Array(this.view.data.buffer);
    this.screen = new ImageData(320, 200);
    this.sfb = new Uint32Array(this.screen.data.buffer);
    this.proj = w / 2; // 90° horizontal field of view
    this.spanStart = new Int32Array(h);
    this.projy = 160; // vertical scale of a 320-wide screen, whatever the detail
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
   *   view:    { x, y, z, angle, tic, palette }
   *   walls:   FRAME_WALLS rows [col, depth, u, line, backView, openTop, openBot, clipTop, clipBot,
   *                               fsec, cTop, cBot, fTop, fBot]  (the last four: visplane rows)
   *   sprites: FRAME_SPRITES rows [id, depth, lump, flip, x1, x2, y1, y2, light, fuzz]
   *   map:     { lines: Map, sides: Map, sectors: Map, skyTex }
   */
  drawView(view, walls, sprites, map) {
    const { w, h, fb, proj, projy } = this;
    // R_SetupFrame: a fixed colormap (32, INVERSECOLORMAP, while invulnerable)
    // replaces the light levels – except on the sky, as in vanilla
    this.fixedCm = view.fixedColormap ?? null;
    const hh = h / 2;
    const hw = w / 2;
    const vz = view.z;
    const palBase = view.palette * 34 * 256;
    const tic = view.tic;
    const sky = this.texture(map.skyTex);
    fb.fill(0xff000000);

    const masked = [];
    const planes = new Visplanes(w);
    // Per-column index into `walls` so sprites can find what is in front of them.
    const colStart = new Int32Array(w + 1).fill(-1);

    for (let i = 0; i < walls.length; i++) {
      const [col, depth, u, lineId, backView, openTop, openBot, clipTop, clipBot, , cTop, cBot, fTop, fBot] = walls[i];
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
      const tu = u + S.xoff;
      if (!bs) {
        const tex = this.texture(this.anim(S.mid, this.texAnim, tic));
        if (tex) {
          const top = L.flags & 16 ? fs.floor + tex.h : fs.ceil;
          this.wallColumn(col, cEnd, fStart, tex, tu, top + S.yoff, depth, scale, vz, light, palBase);
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
            this.wallColumn(col, cEnd, end, tex, tu, top + S.yoff, depth, scale, vz, light, palBase);
          }
        }
        if (bs.floor > fs.floor && S.lower) {
          const tex = this.texture(this.anim(S.lower, this.texAnim, tic));
          if (tex) {
            const top = L.flags & 16 ? fs.ceil : bs.floor;
            const start = Math.max(cEnd, Math.min(fStart, Math.ceil(ybf)));
            this.wallColumn(col, start, fStart, tex, tu, top + S.yoff, depth, scale, vz, light, palBase);
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
            this.skyColumn(x, p.top[x], p.bottom[x] + 1, view.angle - Math.atan((x + 0.5 - hw) / proj), sky, palBase);
          }
        }
      } else {
        const flat = this.flat(this.anim(p.flat, this.flatAnim, tic));
        if (flat) this.makeSpans(p, flat, view, palBase);
      }
    }

    // Masked middles and sprites, far to near, clipped by the walls in front.
    const items = masked.map((m) => ({ ...m, kind: 0 }));
    for (const s of sprites) items.push({ kind: 1, depth: s[1], lump: s[2], flip: s[3], x1: s[4], x2: s[5], y1: s[6], y2: s[7], light: s[8], fuzz: s[9] });
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) {
      if (it.kind === 0) {
        this.wallColumn(it.col, it.y0, it.y1, it.tex, it.tu, it.top, it.depth, it.scale, vz, it.light, palBase, true);
      } else {
        this.spriteDraw(it, walls, colStart, palBase);
      }
    }
  }

  lightIndex(light, depth) {
    // fixedcolormap (invulnerability) overrides all lighting
    if (this.fixedCm != null) return this.fixedCm;
    // R_ScaleFromGlobalAngle → scalelight: startmap - scale/DISTMAP
    const start = (15 - Math.min(15, Math.max(0, light >> 4))) * 4;
    return Math.max(0, Math.min(31, start - Math.min(24, Math.floor(1280 / depth))));
  }

  wallColumn(col, y0, y1, tex, u, top, depth, scale, vz, light, palBase, masked = false) {
    if (y0 >= y1) return;
    const { fb, w, h } = this;
    const hh = h / 2;
    const cm = palBase + this.lightIndex(light, depth) * 256;
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
      fb[y * w + col] = this.lut[cm + tex.pix[colOff + ty]];
    }
  }

  /**
   * R_MakeSpans: sweep the plane's columns left to right. Rows whose span
   * ends at this column are drawn; rows that begin here are remembered.
   */
  makeSpans(p, flat, view, palBase) {
    const { top, bottom, minx, maxx } = p;
    const start = this.spanStart;
    const T = (x) => (x < minx || x > maxx ? 0x7fff : top[x]);
    const B = (x) => (x < minx || x > maxx ? -1 : bottom[x]);
    for (let x = minx; x <= maxx + 1; x++) {
      let t1 = T(x - 1);
      let b1 = B(x - 1);
      let t2 = T(x);
      let b2 = B(x);
      while (t1 < t2 && t1 <= b1) { this.mapPlane(p, flat, t1, start[t1], x - 1, view, palBase); t1++; }
      while (b1 > b2 && b1 >= t1) { this.mapPlane(p, flat, b1, start[b1], x - 1, view, palBase); b1--; }
      while (t2 < t1 && t2 <= b2) { start[t2] = x; t2++; }
      while (b2 > b1 && b2 >= t2) { start[b2] = x; b2--; }
    }
  }

  /**
   * R_MapPlane: one horizontal span. Every pixel of a row of a flat plane is
   * at the same distance, so distance and light are computed once per span
   * and the texture coordinates just step along the row.
   */
  mapPlane(p, flat, y, x1, x2, view, palBase) {
    const { fb, w, h, proj, projy } = this;
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
    const start = (15 - Math.min(15, Math.max(0, p.light >> 4))) * 4;
    const cm = palBase + (this.fixedCm ?? Math.max(0, Math.min(31, start - Math.floor(1280 / (dist + 16))))) * 256;
    const lut = this.lut;
    let o = y * w + x1;
    for (let x = x1; x <= x2; x++) {
      fb[o++] = lut[cm + flat[((Math.floor(-wy) & 63) << 6) | (Math.floor(wx) & 63)]];
      wx += sx;
      wy += sy;
    }
  }

  skyColumn(col, y0, y1, angle, sky, palBase) {
    if (!sky || y0 >= y1) return;
    const { fb, w, h } = this;
    let tx = Math.floor((angle * 1024) / (2 * Math.PI)) % sky.w;
    if (tx < 0) tx += sky.w;
    const off = tx * sky.h;
    // R_DrawSky: texturemid 100 at the view's centre line, one texel per row
    for (let y = y0; y < y1; y++) {
      let ty = Math.floor(100 + y + 0.5 - h / 2) % sky.h;
      if (ty < 0) ty += sky.h;
      fb[y * w + col] = this.lut[palBase + sky.pix[off + ty]];
    }
  }

  spriteDraw(s, walls, colStart, palBase) {
    const pic = this.picture(s.lump);
    const { fb, w, h } = this;
    // R_DrawFuzzColumn: a shadow's pixels aren't its own – each one takes the
    // pixel just above or below it (FUZZTABLE) and darkens it (COLORMAP 6)
    const fuzz = s.fuzz === 1;
    const unlut = this.unlut[palBase / (34 * 256)];
    const dark = palBase + 6 * 256;
    const cm = palBase + (s.light >= 255 ? (this.fixedCm ?? 0) : this.lightIndex(s.light, s.depth)) * 256;
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
          const sy = Math.min(h - 1, Math.max(0, y + FUZZ_OFFSETS[this.fuzzPos]));
          this.fuzzPos = (this.fuzzPos + 1) % FUZZ_OFFSETS.length;
          fb[y * w + x] = this.lut[dark + (unlut.get(fb[sy * w + x]) ?? 0)];
        } else fb[y * w + x] = this.lut[cm + pic.pix[off + py]];
      }
    }
  }

  /** Draw a patch onto the 320×200 screen buffer (status bar, weapon, text). */
  patch(pic, x, y, palBase = 0, cmap = 0, scaleW = 1) {
    if (!pic) return;
    const { sfb } = this;
    const x0 = x - pic.left;
    const y0 = y - pic.top;
    const base = palBase + cmap * 256;
    for (let px = 0; px < pic.w; px++) {
      const sx = x0 + px;
      if (sx < 0 || sx >= 320) continue;
      const off = px * pic.h;
      for (let py = 0; py < pic.h; py++) {
        const sy = y0 + py;
        if (sy < 0 || sy >= 200 || !pic.alpha[off + py]) continue;
        sfb[sy * 320 + sx] = this.lut[base + pic.pix[off + py]];
      }
    }
  }

  /** A patch drawn as fuzz (R_DrawFuzzColumn) over the 3D view: the weapon while invisible. */
  patchFuzz(pic, x, y, palBase = 0) {
    if (!pic) return;
    const { sfb } = this;
    const x0 = x - pic.left;
    const y0 = y - pic.top;
    const unlut = this.unlut[palBase / (34 * 256)];
    const dark = palBase + 6 * 256;
    for (let px = 0; px < pic.w; px++) {
      const sx = x0 + px;
      if (sx < 0 || sx >= 320) continue;
      const off = px * pic.h;
      for (let py = 0; py < pic.h; py++) {
        const sy = y0 + py;
        if (sy < 0 || sy >= 168 || !pic.alpha[off + py]) continue;
        const fy = Math.min(167, Math.max(0, sy + FUZZ_OFFSETS[this.fuzzPos]));
        this.fuzzPos = (this.fuzzPos + 1) % FUZZ_OFFSETS.length;
        sfb[sy * 320 + sx] = this.lut[dark + (unlut.get(sfb[fy * 320 + sx]) ?? 0)];
      }
    }
  }

  /** Scale the 3D view into the top of the 320×200 screen (low detail doubles pixels). */
  composeView() {
    const { w, h, fb, sfb } = this;
    const sx = w / 320;
    for (let y = 0; y < Math.min(h, 168); y++) {
      const row = y * w;
      for (let x = 0; x < 320; x++) sfb[y * 320 + x] = fb[row + Math.floor(x * sx)];
    }
  }

  present() {
    this.ctx.putImageData(this.screen, 0, 0);
  }
}
