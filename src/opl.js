// opl.js – a Yamaha YM3812 (OPL2), the FM chip on the AdLib and Sound Blaster
// cards DOOM's music was written for, emulated one sample at a time at the
// chip's own rate (49716 Hz: its 14.318 MHz clock / 288).
//
// Written from how the chip works (as documented by the YM3812 manual and the
// reverse-engineering behind today's emulators), not ported from one:
//   - 9 channels of 2 operators, a modulator and a carrier: FM (the modulator
//     bends the carrier's phase) or AM (both heard), the modulator feeding
//     back on itself
//   - each operator is a phase counter, a quarter-sine table in the log domain
//     plus an envelope attenuation, and an exponent table back to linear –
//     the chip never multiplies
//   - 4 waveforms (sine, half sine, absolute sine, quarter "pulse")
//   - envelopes: attack, decay to the sustain level, sustain (held or not),
//     release; rates scaled by pitch (KSR); the counter-driven increments
//   - total level, key scale level, tremolo and vibrato
// Rhythm mode and the timers aren't emulated: DOOM's driver uses neither.

export const OPL_RATE = 49716;

// ── tables ──────────────────────────────────────────────────────────────
// −log2(sin) of a quarter wave in 1/256 steps, and 2^(−x/256) back again
const LOGSIN = new Uint16Array(256);
const EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256);
  EXP[i] = Math.round(2 ** (-i / 256) * 4084);
}
// the frequency multiplier, doubled (½, 1, 2, … 10, 10, 12, 12, 15, 15)
const MULT2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
// key scale level: attenuation by the top 4 bits of the F-number
const KSL = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];     // register values 0–3: none, 3, 1.5, 6 dB per octave
// envelope increments: 8-step patterns per rate (low two bits), the counter picks the step
const EG_INC = [
  0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,   // rates 1–12
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2,   // rate 13
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4,   // rate 14
  4, 4, 4, 4, 4, 4, 4, 4,                                                                         // rate 15
  0, 0, 0, 0, 0, 0, 0, 0,                                                                         // rate 0: never
];
const ROW_NEVER = 13;
// a register offset (0x00–0x15) → operator slot, and each channel's two slots
const SLOT_OF = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];
const CH_MOD = [0, 1, 2, 6, 7, 8, 12, 13, 14];

const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

class Slot {
  constructor(ch) {
    this.ch = ch;
    this.am = 0; this.vib = 0; this.egt = 0; this.ksr = 0; this.mult = 0;
    this.ksl = 0; this.tl = 0; this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.wave = 0;
    this.phase = 0;           // 19 bits a cycle
    this.env = 511;           // attenuation, 0.1875 dB steps: 0 loud, 511 silent
    this.state = RELEASE;
    this.key = 0;
    this.out = 0;             // this sample's and the last one's output (feedback)
    this.prev = 0;
  }
}

export class Opl {
  constructor() {
    this.regs = new Uint8Array(256);
    this.slots = Array.from({ length: 18 }, (_, i) => new Slot(Math.floor(i / 6) * 3 + (i % 3)));
    this.fnum = new Uint16Array(9);
    this.block = new Uint8Array(9);
    this.fb = new Uint8Array(9);
    this.cnt = new Uint8Array(9);
    this.wse = 0;             // 0x01 bit 5: waveforms other than the sine allowed
    this.nts = 0;             // 0x08 bit 6: the keyboard split uses F-number bit 8, not 9
    this.dam = 0;             // 0xBD: deep tremolo (4.8 dB, else 1 dB), deep vibrato (14 cents, else 7)
    this.dvb = 0;
    this.egCnt = 0;           // the envelope counter
    this.timer = 0;           // the LFO counter (tremolo, vibrato)
    this.tremPos = 0;
  }

  /** A write to register REG (0x00–0xFF). */
  write(reg, val) {
    reg &= 0xff;
    val &= 0xff;
    this.regs[reg] = val;
    const hi = reg & 0xe0;
    if (reg === 0x01) { this.wse = (val >> 5) & 1; return; }
    if (reg === 0x08) { this.nts = (val >> 6) & 1; return; }
    if (reg === 0xbd) { this.dam = (val >> 7) & 1; this.dvb = (val >> 6) & 1; return; }
    if (hi >= 0x20 && hi <= 0x80 || hi === 0xe0) {
      const s = SLOT_OF[reg & 0x1f];
      if (s === undefined || s < 0) return;
      const o = this.slots[s];
      if (hi === 0x20) {
        o.am = val >> 7; o.vib = (val >> 6) & 1; o.egt = (val >> 5) & 1; o.ksr = (val >> 4) & 1; o.mult = val & 15;
      } else if (hi === 0x40) { o.ksl = val >> 6; o.tl = val & 63; }
      else if (hi === 0x60) { o.ar = val >> 4; o.dr = val & 15; }
      else if (hi === 0x80) { o.sl = (val >> 4) === 15 ? 31 : val >> 4; o.rr = val & 15; }
      else if (hi === 0xe0) o.wave = val & 3;
      return;
    }
    const c = reg & 0x0f;
    if (c > 8) return;
    if (hi === 0xa0 && reg < 0xb0) this.fnum[c] = (this.fnum[c] & 0x300) | val;
    else if (hi === 0xa0) {
      // 0xB0: key on, block, F-number high bits
      this.fnum[c] = (this.fnum[c] & 0xff) | ((val & 3) << 8);
      this.block[c] = (val >> 2) & 7;
      const on = (val >> 5) & 1;
      for (const s of [CH_MOD[c], CH_MOD[c] + 3]) this.keyOn(this.slots[s], on);
    } else if (hi === 0xc0) { this.fb[c] = (val >> 1) & 7; this.cnt[c] = val & 1; }
  }

  keyOn(o, on) {
    if (on && !o.key) {
      o.phase = 0;
      o.state = ATTACK;
    } else if (!on && o.key) o.state = RELEASE;
    o.key = on;
  }

  /** The envelope's rate for RATE (0–15) at this slot's pitch: 0–63. */
  rate(o, rate) {
    if (!rate) return 0;
    const c = o.ch;
    const ks = (this.block[c] << 1) | ((this.fnum[c] >> (this.nts ? 8 : 9)) & 1);
    return Math.min(63, rate * 4 + (o.ksr ? ks : ks >> 2));
  }

  /** One step of a slot's envelope (the envelope counter has already moved on). */
  envelope(o) {
    let r;
    if (o.state === ATTACK) r = this.rate(o, o.ar);
    else if (o.state === DECAY) r = this.rate(o, o.dr);
    else if (o.state === SUSTAIN) { if (o.egt) return; r = this.rate(o, o.rr); }
    else r = this.rate(o, o.rr);
    if (o.state === ATTACK && r >= 60) {     // the fastest attacks are immediate
      o.env = 0;
      o.state = DECAY;
      return;
    }
    let row;
    let shift = 0;
    if (r < 4) row = ROW_NEVER;
    else if (r < 52) { row = r & 3; shift = 12 - (r >> 2); }
    else if (r < 60) row = 4 + (r - 52);
    else row = 12;
    if (shift && (this.egCnt & ((1 << shift) - 1))) return;
    const inc = EG_INC[row * 8 + ((this.egCnt >> shift) & 7)];
    if (!inc) return;
    if (o.state === ATTACK) {
      o.env += (~o.env * inc) >> 3;
      if (o.env <= 0) { o.env = 0; o.state = DECAY; }
    } else {
      o.env = Math.min(511, o.env + inc);
      if (o.state === DECAY && o.env >= o.sl << 4) o.state = SUSTAIN;
    }
  }

  /** One operator's output for this sample: MOD added to its phase. */
  operator(o, mod, trem) {
    const c = o.ch;
    // vibrato: the F-number nudged by its own top bits, eight steps a cycle
    let f = this.fnum[c];
    if (o.vib) {
      const vp = (this.timer >> 10) & 7;
      let range = (f >> 7) & 7;
      if (!(vp & 3)) range = 0;
      else if (vp & 1) range >>= 1;
      range >>= this.dvb ? 0 : 1;
      f += vp & 4 ? -range : range;
    }
    o.phase = (o.phase + ((((f << this.block[c]) >> 1) * MULT2[o.mult]) >> 1)) & 0x7ffff;
    const p = ((o.phase >> 9) + mod) & 1023;
    // the attenuation: envelope, total level, key scale, tremolo
    let ksl = (KSL[this.fnum[c] >> 6] << 2) - ((8 - this.block[c]) << 5);
    ksl = ksl < 0 ? 0 : ksl >> KSL_SHIFT[o.ksl];
    const att = Math.min(511, o.env + (o.tl << 2) + ksl + (o.am ? trem : 0));
    // the waveform, from the quarter sine
    const w = this.wse ? o.wave : 0;
    let q = p & 255;
    if (p & 256) q = 255 - q;
    let neg = (p & 512) !== 0;
    if (w === 1 && neg) return 0;
    if (w === 2) neg = false;
    if (w === 3) {
      if (p & 256) return 0;
      q = p & 255;
      neg = false;
    }
    const l = LOGSIN[q] + (att << 3);
    const e = l >> 8;
    if (e > 12) return 0;
    const v = EXP[l & 255] >> e;
    return neg ? -v : v;
  }

  /** The next sample, a signed 16-bit value. */
  sample() {
    this.timer = (this.timer + 1) & 0xffff;
    if ((this.timer & 63) === 0) this.tremPos = (this.tremPos + 1) % 210;
    const trem = (this.tremPos < 105 ? this.tremPos : 210 - this.tremPos) >> (this.dam ? 2 : 4);
    this.egCnt++;
    let acc = 0;
    for (let c = 0; c < 9; c++) {
      const m = this.slots[CH_MOD[c]];
      const k = this.slots[CH_MOD[c] + 3];
      this.envelope(m);
      this.envelope(k);
      if (m.env >= 511 && k.env >= 511 && m.state === RELEASE && k.state === RELEASE) {
        m.prev = m.out = 0;
        continue;
      }
      const fb = this.fb[c] ? (m.out + m.prev) >> (9 - this.fb[c]) : 0;
      m.prev = m.out;
      m.out = this.operator(m, fb, trem);
      if (this.cnt[c]) acc += m.out + this.operator(k, 0, trem);
      else acc += this.operator(k, m.out, trem);
    }
    return acc > 32767 ? 32767 : acc < -32768 ? -32768 : acc;
  }

  /** N samples into OUT (an Int16Array or Float32Array, scaled by SCALE). */
  generate(out, n = out.length, scale = 1) {
    for (let i = 0; i < n; i++) out[i] = this.sample() * scale;
    return out;
  }
}
