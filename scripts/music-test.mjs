// music-test.mjs – the music without a sound card: the emulated OPL2 (opl.js)
// against the chip's documented behaviour, DOOM's DMX driver (dmx.js) against
// Chocolate Doom's reconstruction of it, and real songs from both WADs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opl, OPL_RATE } from '../src/opl.js';
import { Dmx, DmxPlayer, parseGenmidiRaw, FREQ_CURVE, VOLUME_MAP } from '../src/dmx.js';
import { Wad } from '../src/wad.js';
import { parseSong } from '../src/music.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── the chip ─────────────────────────────────────────────────────────────
/** Channel 0 with a silent modulator and the carrier set up by REGS (offset → value). */
function tone({ fnum = 580, block = 4, car = {}, mod = {}, fb = 0, cnt = 0, wse = 1, bd = 0 } = {}) {
  const o = new Opl();
  o.write(0x01, wse ? 0x20 : 0);
  o.write(0xbd, bd);
  const op = (base, r) => {
    o.write(0x20 + base, r.c20 ?? 0x21);
    o.write(0x40 + base, r.c40 ?? 0);
    o.write(0x60 + base, r.c60 ?? 0xf0);
    o.write(0x80 + base, r.c80 ?? 0x0f);
    o.write(0xe0 + base, r.ce0 ?? 0);
  };
  op(0, { c40: 0x3f, ...mod });
  op(3, car);
  o.write(0xc0, (fb << 1) | cnt);
  o.write(0xa0, fnum & 0xff);
  o.write(0xb0, 0x20 | (block << 2) | (fnum >> 8));
  return o;
}
const render = (o, seconds) => o.generate(new Float32Array(Math.round(OPL_RATE * seconds)));
const crossings = (b) => { let n = 0; for (let i = 1; i < b.length; i++) if (b[i - 1] < 0 && b[i] >= 0) n++; return n; };
const peak = (b, from = 0, to = b.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(b[i])); return p; };

{
  const a = render(tone(), 1);
  const a2 = render(tone({ car: { c20: 0x22 } }), 1);          // MULT 2
  const a3 = render(tone({ block: 5 }), 1);                    // an octave up
  const hz = 580 * 2 ** 4 * OPL_RATE / 2 ** 20;
  assert(Math.abs(crossings(a) - hz) <= 2 && Math.abs(crossings(a2) - 2 * hz) <= 2 && Math.abs(crossings(a3) - 2 * hz) <= 2,
    `pitch: F-number 580, block 4 is ${hz.toFixed(1)} Hz (${crossings(a)} cycles a second); ×2 with MULT 2 (${crossings(a2)}) and with block 5 (${crossings(a3)})`);
  const full = peak(a);
  const quarter = peak(render(tone({ car: { c40: 16 } }), 0.2));   // TL 16 × 0.75 dB = 12 dB
  assert(full > 4000 && full <= 4095 && Math.abs(quarter / full - 0.251) < 0.02,
    `level: full scale ${full}; total level 16 (12 dB) gives ${(quarter / full).toFixed(3)} of it`);
  const ksl = peak(render(tone({ block: 7, car: { c40: 0xc0 } }), 0.2)) / peak(render(tone({ block: 7 }), 0.2));
  assert(ksl < 0.2, `key scale level 3 (6 dB an octave) quietens a high note (${(20 * Math.log10(ksl)).toFixed(1)} dB at block 7)`);
}

{
  // envelopes: the fastest attack is immediate, a slow one takes time; release; a percussive sound decays held
  const fast = render(tone(), 0.05);
  const slow = render(tone({ car: { c60: 0x40 } }), 1);
  const ms = (t) => Math.round(OPL_RATE * t / 1000);
  assert(peak(fast, 0, ms(2)) > 4000 && peak(slow, 0, ms(20)) < 1000 && peak(slow, ms(800), ms(1000)) > 3500,
    `attack: rate 15 is at full level within 2 ms; rate 4 is still at ${peak(slow, 0, ms(20))} after 20 ms and at full by a second`);
  const o = tone({ car: { c80: 0x08 } });                          // release rate 8
  render(o, 0.05);
  o.write(0xb0, (4 << 2) | (580 >> 8));
  const rel = render(o, 1);
  assert(peak(rel, 0, ms(20)) > 2000 && peak(rel, ms(900), ms(1000)) < 50, `release: after key off it fades out (${peak(rel, 0, ms(20))} → ${peak(rel, ms(900), ms(1000))})`);
  const perc = render(tone({ car: { c20: 0x01, c60: 0xf6, c80: 0x06 } }), 1.5);     // EGT off: decay, then release, key held
  const held = render(tone({ car: { c20: 0x21, c60: 0xf6, c80: 0x56 } }), 1.5);     // EGT on: holds at the sustain level (−15 dB)
  assert(peak(perc, ms(1400), ms(1500)) < 100 && Math.abs(peak(held, ms(1400), ms(1500)) / 4084 - 0.178) < 0.03,
    `sustain: held (EGT) it stays at sustain level 5 (${(peak(held, ms(1400), ms(1500)) / 4084).toFixed(3)} of full); percussive it fades with the key held`);
}

{
  // waveforms, and the waveform select enable
  const neg = (b) => b.some((v) => v < 0);
  const zeros = (b) => b.filter((v) => v === 0).length / b.length;
  const w1 = render(tone({ car: { ce0: 1 } }), 0.2);
  const w2 = render(tone({ car: { ce0: 2 } }), 0.2);
  const w3 = render(tone({ car: { ce0: 3 } }), 0.2);
  const off = render(tone({ car: { ce0: 3 }, wse: 0 }), 0.2);
  assert(!neg(w1) && zeros(w1) > 0.45 && !neg(w2) && zeros(w2) < 0.05 && !neg(w3) && zeros(w3) > 0.45 && neg(off),
    'waveforms: half sine (silent half the time), absolute sine, quarter pulses; without waveform select it is a sine');
}

{
  // feedback and FM bring harmonics (more zero crossings than the fundamental)
  const am = (fb) => crossings(render(tone({ mod: { c40: 0 }, cnt: 1, fb, car: { c40: 0x3f } }), 1));
  const plain = am(0);
  const fed = am(7);
  const fm = crossings(render(tone({ mod: { c40: 0 } }), 1));
  assert(fed > plain * 1.5 && fm > plain * 1.5, `feedback 7 (${fed} crossings) and FM (${fm}) add harmonics to the ${plain} Hz tone`);
  // tremolo: the level wobbles; vibrato: the period does
  const trem = render(tone({ car: { c20: 0xa1 }, bd: 0x80 }), 2);
  const windows = Array.from({ length: 180 }, (_, i) => peak(trem, i * 500, (i + 1) * 500));
  const ratio = Math.min(...windows) / Math.max(...windows);
  const vib = render(tone({ car: { c20: 0x61 }, bd: 0x40, block: 6 }), 1);
  const periods = [];
  for (let i = 1, last = 0; i < vib.length; i++) if (vib[i - 1] < 0 && vib[i] >= 0) { if (last) periods.push(i - last); last = i; }
  assert(Math.abs(20 * Math.log10(ratio) + 4.875) < 0.5 && Math.max(...periods) - Math.min(...periods) >= 1,
    `tremolo (deep): ${(20 * Math.log10(ratio)).toFixed(1)} dB of wobble (26 steps of 0.1875 dB = 4.875 expected); vibrato varies the period (${Math.min(...periods)}–${Math.max(...periods)} samples)`);
}

// ── the driver ───────────────────────────────────────────────────────────
const wad1 = new Wad(fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad')));
const bank = parseGenmidiRaw(wad1.data(wad1.lump('GENMIDI')));
assert(bank.length === 175 && bank.every((i) => i.voices.length === 2), `GENMIDI: ${bank.length} instruments of two voices`);
{
  const writes = [];
  const chip = new Opl();
  const spy = { write: (r, v) => { writes.push([r, v]); chip.write(r, v); }, sample: () => chip.sample() };
  const d = new Dmx(bank, spy);
  const reg = (r) => chip.regs[r];
  // one note: instrument 0, key 69 at volume 127 on a channel at 127
  d.event({ type: 'cc', ch: 0, a: 7, b: 127 });
  d.event({ type: 'prog', ch: 0, a: 0 });
  writes.length = 0;
  d.event({ type: 'on', ch: 0, a: 69, b: 127 });
  const f = (reg(0xb0) & 3) << 8 | reg(0xa0);
  const block = (reg(0xb0) >> 2) & 7;
  const hz = f * 2 ** block * OPL_RATE / 2 ** 20;
  const note = 69 + bank[0].voices[0].offset;
  const want = 440 * 2 ** ((note + 12 - 69) / 12);
  assert((reg(0xb0) & 0x20) && Math.abs(1200 * Math.log2(hz / want)) < 10 && (reg(0x43) & 0x3f) === 0,
    `note on: voice 0 keyed at ${hz.toFixed(1)} Hz (key 69 with the instrument's offset ${bank[0].voices[0].offset}, an octave up as DMX's table has it: ${want.toFixed(1)}), carrier at full volume`);
  const firstWrite = writes[0]?.[0];
  assert(firstWrite === 0x43, `the carrier's registers are written before the modulator's, as DMX does (first write 0x${firstWrite?.toString(16)})`);
  // volume: DMX's table, note × channel
  d.event({ type: 'cc', ch: 0, a: 7, b: 100 });
  const tl = reg(0x43) & 0x3f;
  const expect = 0x3f - ((VOLUME_MAP[127] * 2 * (VOLUME_MAP[100] + 1)) >> 9);
  assert(tl === expect, `channel volume 100: the carrier's level becomes ${tl} (0x3f − (${VOLUME_MAP[127]} × 2 × (${VOLUME_MAP[100]} + 1)) >> 9 = ${expect})`);
  // pitch bend: +2 semitones is 64 steps of the table
  const before = d.voices[0].freq;
  d.event({ type: 'bend', ch: 0, a: 63 / 32 });
  const bent = d.voices[0].freq;
  const ratio = ((bent & 1023) * 2 ** (bent >> 10)) / ((before & 1023) * 2 ** (before >> 10));
  assert(Math.abs(1200 * Math.log2(ratio) - 196.9) < 8, `pitch bend to the top moves it ${(1200 * Math.log2(ratio)).toFixed(0)} cents (63/32 of a semitone each way)`);
  d.event({ type: 'off', ch: 0, a: 69 });
  assert(!(reg(0xb0) & 0x20) && d.free.length === 9, 'note off: the key bit cleared, the voice back on the free list');
  // ten notes on nine voices: the tenth takes the voice of the highest channel
  for (let c = 0; c < 9; c++) d.event({ type: 'on', ch: c === 9 ? 10 : c, a: 60, b: 100 });
  const ninth = d.voices.find((v) => v.channel?.num === 8);
  d.event({ type: 'on', ch: 3, a: 64, b: 100 });
  assert(d.voices.every((v) => v.channel) && !d.voices.some((v) => v.channel?.num === 8) && ninth.channel?.num === 3,
    'nine voices; a tenth note takes the voice playing the highest channel (8)');
  for (let c = 0; c < 16; c++) d.event({ type: 'cc', ch: c, a: 123, b: 0 });
  // percussion: key 36 is instrument 129, at its fixed note
  d.event({ type: 'on', ch: 9, a: 36, b: 100 });
  const pv = d.voices.find((v) => v.channel?.num === 9);
  assert(pv?.instr === bank[129] && pv.note === bank[129].fixedNote, `percussion key 36: GENMIDI instrument 129 at its fixed note ${bank[129].fixedNote}`);
  d.event({ type: 'off', ch: 9, a: 36 });
  // a two-voice instrument takes two voices, the second detuned by its fine tuning
  const two = bank.findIndex((i, k) => k < 128 && (i.flags & 4) && i.fine !== 128);
  if (two >= 0) {
    d.event({ type: 'prog', ch: 1, a: two });
    d.event({ type: 'on', ch: 1, a: 60, b: 100 });
    const vs = d.voices.filter((v) => v.channel?.num === 1);
    assert(vs.length === 2 && vs[0].freq !== vs[1].freq, `two-voice instrument ${two}: two voices, the second detuned (fine tuning ${bank[two].fine})`);
  }
  assert(FREQ_CURVE.length === 668 && FREQ_CURVE.every((v) => v > 0 && v < 1024) && FREQ_CURVE[0] === 0x133,
    `DMX's frequency table, computed: 668 F-numbers, starting 0x${FREQ_CURVE[0].toString(16)} as DMX's does`);
}

// ── songs ────────────────────────────────────────────────────────────────
const wad2Path = path.join(root, 'public/wads/freedoom2.wad');
for (const [w, name] of [[wad1, 'D_E1M1'], [wad1, 'D_INTER'], ...(fs.existsSync(wad2Path) ? [[new Wad(fs.readFileSync(wad2Path)), 'D_RUNNIN']] : [])]) {
  const song = parseSong(w.data(w.lump(name)));
  const p = new DmxPlayer(parseGenmidiRaw(w.data(w.lump('GENMIDI'))), song, { loop: false });
  const n = OPL_RATE * 6;
  let sum = 0;
  let pk = 0;
  let bad = 0;
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    const v = p.sample();
    if (!Number.isFinite(v)) bad++;
    sum += v * v;
    pk = Math.max(pk, Math.abs(v));
  }
  const ms = performance.now() - t;
  const rms = Math.sqrt(sum / n);
  assert(bad === 0 && rms > 0.01 && pk < 1 && ms < 6000 / 4,
    `${name}: 6 s rendered in ${ms.toFixed(0)} ms (needs under real time: ${(6000 / ms).toFixed(0)}× faster), level ${rms.toFixed(3)} rms, peak ${pk.toFixed(2)}`);
}

console.log(failures ? `${failures} failure(s)` : 'music ok');
process.exit(failures ? 1 : 0);
