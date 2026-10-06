// music.js – DOOM music from the WAD: MUS or MIDI lumps, played through a
// small FM synthesiser that uses the WAD's own GENMIDI instrument bank, the
// OPL2 patches DOOM's Adlib/Sound Blaster driver loaded.
//
// Each OPL voice is two operators: a modulator and a carrier. Here they are
// two Web Audio oscillators, the modulator wired into the carrier's frequency
// (FM) or straight to the output (additive), each with an OPL-style
// attack/decay/sustain/release envelope and one of the four OPL2 waveforms
// (built as PeriodicWaves, with the operator's self-feedback baked in).

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

// ── GENMIDI: 175 OPL2 instruments (128 melodic + 47 percussion) ──────────
export function parseGenmidi(d) {
  const ins = [];
  for (let i = 0; i < 175; i++) {
    const o = 8 + i * 36;
    if (o + 36 > d.length) break;
    const voice = (v) => {
      const b = o + 4 + v * 16;
      const op = (k) => ({ char: d[k], attack: d[k + 1], sustain: d[k + 2], wave: d[k + 3] & 3, level: d[k + 5] & 63 });
      return { mod: op(b), feedback: d[b + 6], car: op(b + 7), offset: (d[b + 14] | (d[b + 15] << 8)) << 16 >> 16 };
    };
    const flags = d[o] | (d[o + 1] << 8);
    ins.push({ fixed: flags & 1, double: flags & 4, fine: d[o + 2], note: d[o + 3], voices: [voice(0), voice(1)] });
  }
  return ins;
}

// ── the synthesiser ────────────────────────────────────────────────────
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// OPL2 envelope timings in seconds by rate 0..15 (0 = never)
const ATTACK = [Infinity, 2.826, 1.413, 0.707, 0.353, 0.177, 0.088, 0.044, 0.022, 0.011, 0.0055, 0.0028, 0.0014, 0.0007, 0.00035, 0];
const DECAY = [Infinity, 39.28, 19.64, 9.82, 4.91, 2.455, 1.228, 0.614, 0.307, 0.153, 0.077, 0.038, 0.019, 0.0096, 0.0048, 0.0024];
const db = (x) => 10 ** (x / 20);

export class OplSynth {
  constructor(ctx, out, bank) {
    this.ctx = ctx;
    this.out = out;
    this.bank = bank;
    this.waves = new Map();
    this.voices = [];
    this.timer = null;
    this.resetChannels();
  }

  resetChannels() {
    this.ch = Array.from({ length: 16 }, () => ({ prog: 0, vol: 100, expr: 127, pan: 64, bend: 0 }));
  }

  /** An OPL2 waveform with operator self-feedback, as a PeriodicWave. */
  wave(w, fb) {
    const key = w * 8 + fb;
    let pw = this.waves.get(key);
    if (pw) return pw;
    const N = 512;
    const shape = (ph) => {
      const s = Math.sin(ph);
      if (w === 1) return s > 0 ? s : 0;
      if (w === 2) return Math.abs(s);
      if (w === 3) return ((ph % Math.PI) + Math.PI) % Math.PI < Math.PI / 2 ? Math.abs(s) : 0;
      return s;
    };
    const k = fb ? (Math.PI * 2 ** (fb - 1)) / 16 : 0;
    const y = new Float32Array(N);
    let prev = 0;
    let prev2 = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < N; n++) {
        const v = shape((2 * Math.PI * n) / N + (k * (prev + prev2)) / 2);
        prev2 = prev;
        prev = v;
        y[n] = v;
      }
    }
    const H = 48;
    const re = new Float32Array(H + 1);
    const im = new Float32Array(H + 1);
    for (let h = 1; h <= H; h++) {
      let c = 0;
      let s = 0;
      for (let n = 0; n < N; n++) {
        const ph = (2 * Math.PI * h * n) / N;
        c += y[n] * Math.cos(ph);
        s += y[n] * Math.sin(ph);
      }
      re[h] = (2 * c) / N;
      im[h] = (2 * s) / N;
    }
    pw = this.ctx.createPeriodicWave(re, im);
    this.waves.set(key, pw);
    return pw;
  }

  /** ADSR on a gain param, OPL style. Returns the release duration. */
  envelope(param, op, peak, t) {
    const a = ATTACK[op.attack >> 4];
    const d = DECAY[op.attack & 15];
    const slDb = (op.sustain >> 4) * 3;
    const r = DECAY[op.sustain & 15];
    const sus = Math.max(peak * db(-slDb), 1e-4);
    param.setValueAtTime(0, t);
    if (!Number.isFinite(a)) return 0.05;
    const ta = t + Math.max(a, 0.001);
    param.linearRampToValueAtTime(peak, ta);
    const td = ta + (Number.isFinite(d) ? Math.max(d * (slDb / 96), 0.001) : 1e4);
    if (slDb > 0) param.exponentialRampToValueAtTime(sus, td);
    if (!(op.char & 0x20) && Number.isFinite(r)) {
      // not a sustaining envelope: keep decaying at the release rate
      param.exponentialRampToValueAtTime(1e-4, td + Math.max(r * ((96 - slDb) / 96), 0.01));
    }
    return Number.isFinite(r) ? Math.min(Math.max(r * 0.35, 0.02), 3) : 3;
  }

  noteOn(t, chn, note, vel) {
    const c = this.ch[chn];
    let ins;
    let key = note;
    if (chn === 9) {
      if (note < 35 || note > 81) return;
      ins = this.bank[128 + note - 35];
    } else ins = this.bank[c.prog];
    if (!ins) return;
    if (ins.fixed) key = ins.note;
    const amp = 0.11 * (vel / 127) * (c.vol / 127) * (c.expr / 127);
    const nodes = [];
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = (c.pan - 64) / 64;
    pan.connect(this.out);
    let release = 0.05;
    const vcount = ins.double ? 2 : 1;
    for (let v = 0; v < vcount; v++) {
      const vo = ins.voices[v];
      const detune = v === 1 ? (ins.fine - 128) / 64 : 0;
      const f = 440 * 2 ** ((key + vo.offset - 69 + c.bend + detune) / 12);
      if (f < 8 || f > 12000) continue;
      const additive = vo.feedback & 1;
      const fb = (vo.feedback >> 1) & 7;
      const mod = this.ctx.createOscillator();
      const car = this.ctx.createOscillator();
      mod.setPeriodicWave(this.wave(vo.mod.wave, fb));
      car.setPeriodicWave(this.wave(vo.car.wave, 0));
      const fm = f * MULT[vo.mod.char & 15];
      mod.frequency.value = fm;
      car.frequency.value = f * MULT[vo.car.char & 15];
      const modEnv = this.ctx.createGain();
      const carEnv = this.ctx.createGain();
      mod.connect(modEnv);
      car.connect(carEnv);
      carEnv.connect(pan);
      const carPeak = amp * db(-0.75 * vo.car.level);
      if (additive) {
        modEnv.connect(pan);
        release = Math.max(release, this.envelope(modEnv.gain, vo.mod, amp * db(-0.75 * vo.mod.level), t));
      } else {
        // FM: the modulator's output swings the carrier's frequency
        modEnv.connect(car.frequency);
        release = Math.max(release, this.envelope(modEnv.gain, vo.mod, fm * 5 * db(-0.75 * vo.mod.level), t));
      }
      release = Math.max(release, this.envelope(carEnv.gain, vo.car, carPeak, t));
      mod.start(t);
      car.start(t);
      nodes.push({ mod, car, modEnv, carEnv });
    }
    if (!nodes.length) return;
    const voice = { chn, note, nodes, release, pan, start: t };
    this.voices.push(voice);
    // OPL2 has 9 channels; DOOM ran 9 (or 18 on OPL3) voices. Steal the oldest.
    while (this.voices.length > 24) this.stopVoice(this.voices.shift(), t, 0.02);
  }

  stopVoice(v, t, rel = v.release) {
    for (const n of v.nodes) {
      for (const g of [n.modEnv.gain, n.carEnv.gain]) {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, rel / 4);
      }
      n.mod.stop(t + rel + 0.05);
      n.car.stop(t + rel + 0.05);
    }
    setTimeout(() => v.pan.disconnect(), (t - this.ctx.currentTime + rel + 0.2) * 1000);
  }

  noteOff(t, chn, note) {
    const i = this.voices.findIndex((v) => v.chn === chn && v.note === note);
    if (i >= 0) this.stopVoice(this.voices.splice(i, 1)[0], t);
  }

  allOff(t) {
    for (const v of this.voices) this.stopVoice(v, t, 0.05);
    this.voices = [];
  }

  dispatch(e, t) {
    const c = this.ch[e.ch];
    if (e.type === 'on') this.noteOn(t, e.ch, e.a, e.b);
    else if (e.type === 'off') this.noteOff(t, e.ch, e.a);
    else if (e.type === 'prog') c.prog = e.a;
    else if (e.type === 'bend') c.bend = e.a;
    else if (e.type === 'cc') {
      if (e.a === 7) c.vol = e.b;
      else if (e.a === 11) c.expr = e.b;
      else if (e.a === 10) c.pan = e.b;
      else if (e.a === 121) Object.assign(c, { vol: 100, expr: 127, pan: 64, bend: 0 });
      else if (e.a === 120 || e.a === 123) {
        for (const v of this.voices.filter((x) => x.chn === e.ch)) this.noteOff(t, v.chn, v.note);
      }
    }
  }

  /** Play a parsed song, looping, scheduling a little ahead of the clock. */
  play(song) {
    this.stop();
    if (!song || !song.events.length) return;
    this.song = song;
    this.idx = 0;
    this.t0 = this.ctx.currentTime + 0.1;
    this.resetChannels();
    this.timer = setInterval(() => this.pump(), 40);
    this.pump();
  }

  pump() {
    const horizon = this.ctx.currentTime + 0.3;
    const { events, duration } = this.song;
    for (;;) {
      if (this.idx >= events.length) {
        this.allOff(this.t0 + duration);
        this.t0 += Math.max(duration, 1) + 0.25;
        this.idx = 0;
        this.resetChannels();
      }
      const e = events[this.idx];
      const t = this.t0 + e.t;
      if (t > horizon) break;
      this.dispatch(e, Math.max(t, this.ctx.currentTime));
      this.idx++;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.allOff(this.ctx.currentTime);
  }
}
