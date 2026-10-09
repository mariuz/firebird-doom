// music.js – DOOM's music lumps, MUS or MIDI, read into one list of events.
// They're played by the DMX driver on an emulated OPL2 (dmx.js, opl.js), with
// the WAD's GENMIDI instrument bank.

// ── song parsing ───────────────────────────────────────────────────────
// Both formats become one list: { t (seconds), type, ch, a, b }.
//   on: a=note b=velocity · off: a=note · prog: a=program
//   cc: a=controller b=value · bend: a=semitones

function readVar(d, p) {
  let v = 0;
  let b;
  do {
    b = d[p.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return v;
}

export function parseMidi(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12) || 96;
  const raw = [];
  let pos = 14;
  for (let tr = 0; tr < ntrks && pos + 8 <= d.length; tr++) {
    const len = dv.getUint32(pos + 4);
    const p = { i: pos + 8 };
    const end = pos + 8 + len;
    let tick = 0;
    let status = 0;
    let seq = 0;
    while (p.i < end) {
      tick += readVar(d, p);
      let s = d[p.i];
      if (s & 0x80) p.i++;
      else s = status;
      if (s === 0xff) {
        const type = d[p.i++];
        const l = readVar(d, p);
        if (type === 0x51) raw.push({ tick, seq: seq++, tempo: (d[p.i] << 16) | (d[p.i + 1] << 8) | d[p.i + 2] });
        if (type === 0x2f) break;
        p.i += l;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) {
        p.i += readVar(d, p);
        continue;
      }
      status = s;
      const ch = s & 15;
      const hi = s >> 4;
      const a = d[p.i++];
      const b = hi === 0xc || hi === 0xd ? 0 : d[p.i++];
      let ev = null;
      if (hi === 0x9 && b > 0) ev = { type: 'on', ch, a, b };
      else if (hi === 0x8 || hi === 0x9) ev = { type: 'off', ch, a };
      else if (hi === 0xb) ev = { type: 'cc', ch, a, b };
      else if (hi === 0xc) ev = { type: 'prog', ch, a };
      else if (hi === 0xe) ev = { type: 'bend', ch, a: (((b << 7) | a) - 8192) / 4096 };
      if (ev) raw.push({ tick, seq: seq++ + tr * 1e7, ...ev });
    }
    pos = end;
  }
  raw.sort((x, y) => x.tick - y.tick || x.seq - y.seq);
  let tempo = 500000;
  let lastTick = 0;
  let t = 0;
  const events = [];
  for (const e of raw) {
    t += ((e.tick - lastTick) * tempo) / division / 1e6;
    lastTick = e.tick;
    if (e.tempo) tempo = e.tempo;
    else events.push({ t, type: e.type, ch: e.ch, a: e.a, b: e.b });
  }
  return { events, duration: t };
}

export function parseMus(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const start = dv.getUint16(6, true);
  const p = { i: start };
  const vol = new Array(16).fill(100);
  const map = (c) => (c === 15 ? 9 : c >= 9 ? c + 1 : c);
  const CC = [null, 0, 1, 7, 10, 11, 91, 93, 64, 67];
  const events = [];
  let t = 0;
  while (p.i < d.length) {
    const desc = d[p.i++];
    const type = (desc >> 4) & 7;
    const ch = map(desc & 15);
    if (type === 0) events.push({ t, type: 'off', ch, a: d[p.i++] & 127 });
    else if (type === 1) {
      const n = d[p.i++];
      if (n & 0x80) vol[ch] = d[p.i++] & 127;
      events.push({ t, type: 'on', ch, a: n & 127, b: vol[ch] });
    } else if (type === 2) events.push({ t, type: 'bend', ch, a: (d[p.i++] - 128) / 64 });
    else if (type === 3) {
      const c = d[p.i++];
      if (c === 10 || c === 11) events.push({ t, type: 'cc', ch, a: 123, b: 0 });
      else if (c === 14) events.push({ t, type: 'cc', ch, a: 121, b: 0 });
    } else if (type === 4) {
      const c = d[p.i++];
      const v = d[p.i++] & 127;
      if (c === 0) events.push({ t, type: 'prog', ch, a: v });
      else if (CC[c] != null) events.push({ t, type: 'cc', ch, a: CC[c], b: v });
    } else if (type === 6) break;
    else if (type === 5 || type === 7) p.i++;
    if (desc & 0x80) t += readVar(d, p) / 140;
  }
  return { events, duration: t };
}

export function parseSong(d) {
  const magic = String.fromCharCode(d[0], d[1], d[2], d[3]);
  if (magic === 'MThd') return parseMidi(d);
  if (magic === 'MUS\x1a') return parseMus(d);
  return null;
}
