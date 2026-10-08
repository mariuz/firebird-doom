// wad.js – a small, dependency-free reader for DOOM WAD files.
//
// Only the parsing lives here. Every piece of *game* data (maps, thing
// placements, texture dimensions, sprite frames) is handed to Firebird by
// loader.js; the pixels themselves (palette, colormaps, patches, flats) stay
// in JavaScript because the browser has to blit them anyway.

const td = new TextDecoder('ascii');

function name8(bytes, off) {
  let end = off;
  while (end < off + 8 && bytes[end] !== 0) end++;
  return td.decode(bytes.subarray(off, end)).toUpperCase();
}

/**
 * One WAD, or an IWAD with PWADs on top: new Wad(iwad, ...pwads). Like
 * W_AddFile, every file's lumps go into one directory in load order, and a
 * name finds the last of them – so a PWAD replaces maps, graphics, sounds,
 * music and texture lists by name. Flats and sprites between their markers
 * are gathered from every file (later ones replacing earlier ones by name),
 * as Chocolate Doom's -merge and Boom do; vanilla needed the PWAD merged in
 * with DeuTex for those.
 */
export class Wad {
  constructor(buffer, ...more) {
    this.files = [];
    this.lumps = [];
    for (const b of [buffer, ...more]) {
      const buf = b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const bytes = new Uint8Array(buf);
      const view = new DataView(buf);
      const magic = td.decode(bytes.subarray(0, 4));
      if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error(`not a WAD file (magic ${JSON.stringify(magic)})`);
      const file = this.files.length;
      this.files.push({ buf, bytes, view, magic });
      const n = view.getInt32(4, true);
      const dir = view.getInt32(8, true);
      for (let i = 0; i < n; i++) {
        const o = dir + i * 16;
        this.lumps.push({
          index: this.lumps.length,
          file,
          pos: view.getInt32(o, true),
          size: view.getInt32(o + 4, true),
          name: name8(bytes, o + 8),
        });
      }
    }
    // (the first file's buffers, for code that reads the WAD file itself)
    ({ buf: this.buf, bytes: this.bytes, view: this.view } = this.files[0]);
    this._byName = new Map();
    for (const l of this.lumps) this._byName.set(l.name, l); // last one wins, like DOOM
  }

  lump(name) { return this._byName.get(name.toUpperCase()); }
  /** Every lump of this name, in load order (each file's DEHACKED, say). */
  lumpsNamed(name) { return this.lumps.filter((l) => l.name === name.toUpperCase()); }
  data(lump) { return this.files[lump.file ?? 0].bytes.subarray(lump.pos, lump.pos + lump.size); }
  dv(lump) { return new DataView(this.files[lump.file ?? 0].buf, lump.pos, lump.size); }
  /** Every DEHACKED lump's text, in load order (the IWAD's, then each PWAD's). */
  dehacked() {
    if (!this.lump('DEHACKED')) return '';   // (none – or hidden, as the id-layout tests do)
    return this.lumpsNamed('DEHACKED').map((l) => new TextDecoder('latin1').decode(this.data(l))).join('\n');
  }

  /** Lumps between two markers, e.g. F_START/F_END, also accepting FF_ variants. */
  between(start, end) {
    const out = [];
    let inside = false;
    for (const l of this.lumps) {
      if (l.name === start || l.name === start[0] + start) { inside = true; continue; }
      if (l.name === end || l.name === end[0] + end) { inside = false; continue; }
      if (inside && l.size > 0) out.push(l);
    }
    return out;
  }

  mapNames() {
    // (a PWAD's map replaces the IWAD's of that name: listed once, where it first appeared)
    return [...new Set(this.lumps
      .filter((l) => /^(E\dM\d|MAP\d\d)$/.test(l.name))
      .filter((l) => this.lumps[l.index + 1]?.name === 'THINGS')
      .map((l) => l.name))];
  }

  /** The maps the PWADs bring (none for a single WAD). */
  pwadMapNames() {
    return [...new Set(this.lumps
      .filter((l) => l.file > 0 && /^(E\dM\d|MAP\d\d)$/.test(l.name))
      .filter((l) => this.lumps[l.index + 1]?.name === 'THINGS')
      .map((l) => l.name))];
  }

  // ── graphics ───────────────────────────────────────────────────────────

  palette() {
    const d = this.data(this.lump('PLAYPAL'));
    return d.subarray(0, 768);
  }

  /** 34 colormaps × 256 palette indices. */
  colormap() { return this.data(this.lump('COLORMAP')); }

  /** Parse a picture (patch / sprite) into column-major indices + alpha. */
  picture(lump) {
    const dv = this.dv(lump);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const left = dv.getInt16(4, true);
    const top = dv.getInt16(6, true);
    const pix = new Uint8Array(w * h);
    const alpha = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      let p = dv.getUint32(8 + x * 4, true);
      let lastTop = -1;
      for (;;) {
        let delta = dv.getUint8(p);
        if (delta === 0xff) break;
        // "tall patch" convention: a delta <= previous means relative offset
        if (delta <= lastTop) delta += lastTop;
        lastTop = delta;
        const len = dv.getUint8(p + 1);
        for (let i = 0; i < len; i++) {
          const y = delta + i;
          if (y < h) {
            pix[x * h + y] = dv.getUint8(p + 3 + i);
            alpha[x * h + y] = 1;
          }
        }
        p += len + 4;
      }
    }
    return { w, h, left, top, pix, alpha };
  }

  /** Composite wall textures from TEXTURE1/TEXTURE2 + PNAMES (metadata only). */
  textureDefs() {
    const pn = this.dv(this.lump('PNAMES'));
    const pnBytes = this.data(this.lump('PNAMES'));
    const pnames = [];
    const np = pn.getInt32(0, true);
    for (let i = 0; i < np; i++) pnames.push(name8(pnBytes, 4 + i * 8));
    const defs = [];
    for (const tname of ['TEXTURE1', 'TEXTURE2']) {
      const l = this.lump(tname);
      if (!l) continue;
      const dv = this.dv(l);
      const bytes = this.data(l);
      const n = dv.getInt32(0, true);
      for (let i = 0; i < n; i++) {
        const o = dv.getInt32(4 + i * 4, true);
        const def = {
          name: name8(bytes, o),
          w: dv.getInt16(o + 12, true),
          h: dv.getInt16(o + 14, true),
          patches: [],
        };
        const pc = dv.getInt16(o + 20, true);
        for (let p = 0; p < pc; p++) {
          const po = o + 22 + p * 10;
          def.patches.push({
            x: dv.getInt16(po, true),
            y: dv.getInt16(po + 2, true),
            name: pnames[dv.getInt16(po + 4, true)],
          });
        }
        defs.push(def);
      }
    }
    return defs;
  }

  /** Build a texture's pixels (column-major, with alpha for masked mids). */
  composeTexture(def) {
    const { w, h } = def;
    const pix = new Uint8Array(w * h);
    const alpha = new Uint8Array(w * h);
    for (const p of def.patches) {
      const lump = this.lump(p.name);
      if (!lump) continue;
      const pic = this.picture(lump);
      for (let x = 0; x < pic.w; x++) {
        const tx = p.x + x;
        if (tx < 0 || tx >= w) continue;
        for (let y = 0; y < pic.h; y++) {
          const ty = p.y + y;
          if (ty < 0 || ty >= h || !pic.alpha[x * pic.h + y]) continue;
          pix[tx * h + ty] = pic.pix[x * pic.h + y];
          alpha[tx * h + ty] = 1;
        }
      }
    }
    return { w, h, pix, alpha };
  }

  flatLumps() { return this.between('F_START', 'F_END'); }
  spriteLumps() { return this.between('S_START', 'S_END'); }

  /**
   * Sprite frames: "POSSA2A8" → [{sprite POSS, frame A, rot 2, flip 0},
   *                               {sprite POSS, frame A, rot 8, flip 1}].
   */
  spriteFrames() {
    const out = [];
    for (const l of this.spriteLumps()) {
      if (l.name.length < 6) continue;
      const dv = this.dv(l);
      const meta = {
        lump: l.index,
        w: dv.getUint16(0, true),
        h: dv.getUint16(2, true),
        left: dv.getInt16(4, true),
        top: dv.getInt16(6, true),
      };
      const sprite = l.name.slice(0, 4);
      out.push({ sprite, frame: l.name[4], rot: +l.name[5], flip: 0, ...meta });
      if (l.name.length >= 8) out.push({ sprite, frame: l.name[6], rot: +l.name[7], flip: 1, ...meta });
    }
    return out;
  }

  // ── maps ───────────────────────────────────────────────────────────────

  /** The map's BLOCKMAP origin (bmaporgx, bmaporgy), or null if it has none. */
  blockmapOrigin(name) {
    const marker = this.lump(name);
    if (!marker) return null;
    for (let i = marker.index + 1; i < marker.index + 12 && i < this.lumps.length; i++) {
      const l = this.lumps[i];
      if (l.name === 'BLOCKMAP' && l.size >= 4) { const dv = this.dv(l); return [dv.getInt16(0, true), dv.getInt16(2, true)]; }
    }
    return null;
  }

  map(name) {
    const marker = this.lump(name);
    if (!marker) throw new Error(`map ${name} not in WAD`);
    const parts = {};
    for (let i = marker.index + 1; i < marker.index + 12 && i < this.lumps.length; i++) {
      const l = this.lumps[i];
      if (!['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP', 'BEHAVIOR'].includes(l.name)) break;
      parts[l.name] = l;
    }
    if (parts.BEHAVIOR) throw new Error('Hexen-format maps are not supported');
    const rec = (lname, size, fn) => {
      const l = parts[lname];
      const out = [];
      if (!l) return out;
      const dv = this.dv(l);
      const bytes = this.data(l);
      for (let o = 0, i = 0; o + size <= l.size; o += size, i++) out.push(fn(dv, o, i, bytes));
      return out;
    };
    const s16 = (dv, o) => dv.getInt16(o, true);
    const u16 = (dv, o) => dv.getUint16(o, true);
    if (parts.NODES && parts.NODES.size >= 4 && /^[XZ]NOD/.test(td.decode(this.data(parts.NODES).subarray(0, 4)))) {
      throw new Error('maps with ZDoom extended nodes are not supported');
    }
    return {
      name,
      vertexes: rec('VERTEXES', 4, (dv, o, i) => ({ id: i, x: s16(dv, o), y: s16(dv, o + 2) })),
      linedefs: rec('LINEDEFS', 14, (dv, o, i) => ({
        id: i, v1: u16(dv, o), v2: u16(dv, o + 2), flags: u16(dv, o + 4),
        special: u16(dv, o + 6), tag: u16(dv, o + 8),
        right: s16(dv, o + 10), left: s16(dv, o + 12),
      })),
      sidedefs: rec('SIDEDEFS', 30, (dv, o, i, b) => ({
        id: i, xoff: s16(dv, o), yoff: s16(dv, o + 2),
        upper: name8(b, o + 4), lower: name8(b, o + 12), middle: name8(b, o + 20),
        sector: u16(dv, o + 28),
      })),
      sectors: rec('SECTORS', 26, (dv, o, i, b) => ({
        id: i, floor: s16(dv, o), ceil: s16(dv, o + 2),
        floorTex: name8(b, o + 4), ceilTex: name8(b, o + 12),
        light: s16(dv, o + 20), special: u16(dv, o + 22), tag: u16(dv, o + 24),
      })),
      segs: rec('SEGS', 12, (dv, o, i) => ({
        id: i, v1: u16(dv, o), v2: u16(dv, o + 2), linedef: u16(dv, o + 6), side: s16(dv, o + 8), offset: s16(dv, o + 10),
      })),
      ssectors: rec('SSECTORS', 4, (dv, o, i) => ({ id: i, count: u16(dv, o), first: u16(dv, o + 2) })),
      nodes: rec('NODES', 28, (dv, o, i) => ({
        id: i, x: s16(dv, o), y: s16(dv, o + 2), dx: s16(dv, o + 4), dy: s16(dv, o + 6),
        // child bounding boxes: top, bottom, left, right (BOXTOP..BOXRIGHT)
        rbox: [s16(dv, o + 8), s16(dv, o + 10), s16(dv, o + 12), s16(dv, o + 14)],
        lbox: [s16(dv, o + 16), s16(dv, o + 18), s16(dv, o + 20), s16(dv, o + 22)],
        right: u16(dv, o + 24), left: u16(dv, o + 26),
      })),
      things: rec('THINGS', 10, (dv, o, i) => ({
        id: i, x: s16(dv, o), y: s16(dv, o + 2), angle: s16(dv, o + 4), type: u16(dv, o + 6), flags: u16(dv, o + 8),
      })),
    };
  }
}
