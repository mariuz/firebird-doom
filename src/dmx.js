// dmx.js – DOOM's music driver for the OPL2 (DMX), driving opl.js: song
// events in, register writes out. It follows the reconstruction of DMX in
// Chocolate Doom's i_oplmusic.c (the Doom 1.9 behaviour):
//   - 9 voices, each an OPL channel; a free list, taken from the front and
//     given back at the end; with none free, the voice to take is a second
//     voice of a two-voice instrument, else the one on the highest MIDI channel
//   - GENMIDI's instruments loaded operator by operator; the carrier's level
//     (and, in additive mode, the modulator's) set from the note's and the
//     channel's volume through DMX's volume table
//   - two-voice instruments: the second voice detuned by the fine tuning field
//   - the percussion channel plays instruments 128–174 by key (35–81), at
//     their fixed note
//   - pitch from DMX's frequency table, in 1/32 semitone steps, which pitch
//     bend moves (±2 semitones)
// Panning is OPL3-only and DOOM's driver ran the OPL2 in mono, so it's ignored.

import { Opl, OPL_RATE } from './opl.js';

const VOICES = 9;
const MOD_OFF = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];   // each channel's modulator
const GENMIDI_FIXED = 0x0001;
const GENMIDI_2VOICE = 0x0004;

// DMX's volume curve: a MIDI volume (0–127) → loudness (0–127)
export const VOLUME_MAP = [
  0, 1, 3, 5, 6, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23,
  25, 26, 27, 29, 30, 32, 33, 34, 36, 37, 39, 41, 43, 45, 47, 49,
  50, 52, 54, 55, 57, 59, 60, 61, 63, 64, 66, 67, 68, 69, 71, 72,
  73, 74, 75, 76, 77, 79, 80, 81, 82, 83, 84, 84, 85, 86, 87, 88,
  89, 90, 91, 92, 92, 93, 94, 95, 96, 96, 97, 98, 99, 99, 100, 101,
  101, 102, 103, 103, 104, 105, 105, 106, 107, 107, 108, 109, 109, 110, 110, 111,
  112, 112, 113, 113, 114, 114, 115, 115, 116, 117, 117, 118, 118, 119, 119, 120,
  120, 121, 121, 122, 122, 123, 123, 123, 124, 124, 125, 125, 126, 126, 127, 127,
];

// DMX's frequency table: F-numbers in 1/32 semitone steps. Index 64 + 32 × note
// is MIDI note `note` an octave up (16.35 Hz at index 64, as the driver had it);
// entries 0–283 are octave (block) 0, and 284–667 the octave that repeats with
// the block number on top. Computed here, the F-number for each step rounded
// (within a step of DMX's own table: a few cents at most).
export const FREQ_CURVE = Array.from({ length: 668 }, (_, i) =>
  Math.min(1023, Math.round((16.351597831287414 * 2 ** ((i - 64) / 384) * 2 ** 20) / OPL_RATE)));

/** GENMIDI, kept as the bytes DMX wrote: 175 instruments of 2 voices of 2 operators. */
export function parseGenmidiRaw(d) {
  const ins = [];
  for (let i = 0; i < 175; i++) {
    const o = 8 + i * 36;
    if (o + 36 > d.length) break;
    const op = (k) => ({ tremolo: d[k], attack: d[k + 1], sustain: d[k + 2], waveform: d[k + 3], scale: d[k + 4] & 0xc0, level: d[k + 5] & 0x3f });
    const voice = (v) => {
      const b = o + 4 + v * 16;
      return { mod: op(b), feedback: d[b + 6], car: op(b + 7), offset: ((d[b + 14] | (d[b + 15] << 8)) << 16) >> 16 };
    };
    ins.push({ flags: d[o] | (d[o + 1] << 8), fine: d[o + 2], fixedNote: d[o + 3], voices: [voice(0), voice(1)] });
  }
  return ins;
}

export class Dmx {
  /** @param bank parseGenmidiRaw(GENMIDI) · @param opl an Opl (or anything with write(reg, val)) */
  constructor(bank, opl = new Opl()) {
    this.bank = bank;
    this.opl = opl;
    this.voices = Array.from({ length: VOICES }, (_, i) => ({ index: i, channel: null, key: 0, note: 0, instr: null, instrVoice: 0, noteVolume: 0, freq: 0, carVolume: 0, modVolume: 0 }));
    this.free = [...this.voices];
    this.reset();
  }

  /** OPL_InitRegisters, and the channels back to their defaults. */
  reset() {
    const w = (r, v) => this.opl.write(r, v);
    for (let r = 0x40; r <= 0x55; r++) w(r, 0x3f);          // every operator silent
    for (let r = 0x20; r <= 0xf5; r++) if (r < 0x40 || r >= 0x60) w(r, 0);
    for (let c = 0; c < 9; c++) { w(0xa0 + c, 0); w(0xb0 + c, 0); w(0xc0 + c, 0); }
    w(0x01, 0x20);                                          // waveform select on
    w(0x08, 0x40);                                          // keyboard split: F-number bit 8
    w(0xbd, 0);
    this.channels = Array.from({ length: 16 }, () => ({ instr: this.bank[0], volume: 100, bend: 0 }));
    for (const v of this.voices) { v.channel = null; v.freq = 0; }
    this.free = [...this.voices];
  }

  write(r, v) { this.opl.write(r, v); }

  // ── voices ──
  getFreeVoice() { return this.free.shift() ?? null; }

  releaseVoice(v) {
    v.channel = null;
    this.free.push(v);
  }

  keyOff(v) { this.write(0xb0 + v.index, v.freq >> 8); }

  /** ReplaceExistingVoice: a second voice if there is one, else the one on the highest channel. */
  replaceExistingVoice() {
    let pick = null;
    for (const v of this.voices) {
      if (!v.channel) continue;
      if (!pick || v.instrVoice !== 0 || v.channel.num >= pick.channel.num) pick = v;
    }
    if (!pick) return;
    this.keyOff(pick);
    this.releaseVoice(pick);
  }

  /** LoadOperatorData */
  loadOperator(reg, op, maxLevel) {
    const level = op.scale | (maxLevel ? 0x3f : op.level);
    this.write(0x40 + reg, level);
    this.write(0x20 + reg, op.tremolo);
    this.write(0x60 + reg, op.attack);
    this.write(0x80 + reg, op.sustain);
    this.write(0xe0 + reg, op.waveform);
    return level;
  }

  /** SetVoiceInstrument: the carrier first, both at their quietest until the volume is set. */
  setInstrument(v, instr, instrVoice) {
    v.instr = instr;
    v.instrVoice = instrVoice;
    const d = instr.voices[instrVoice];
    const modulating = (d.feedback & 1) === 0;
    const off = MOD_OFF[v.index];
    v.carVolume = this.loadOperator(off + 3, d.car, true);
    v.modVolume = this.loadOperator(off, d.mod, !modulating);
    this.write(0xc0 + v.index, d.feedback);
  }

  /** SetVoiceVolume */
  setVolume(v, volume) {
    v.noteVolume = volume;
    const d = v.instr.voices[v.instrVoice];
    const midiVolume = 2 * (VOLUME_MAP[v.channel.volume] + 1);
    const full = (VOLUME_MAP[volume] * midiVolume) >> 9;
    const car = 0x3f - full;
    if (car !== (v.carVolume & 0x3f)) {
      v.carVolume = car | (v.carVolume & 0xc0);
      this.write(0x40 + MOD_OFF[v.index] + 3, v.carVolume);
      // additive: the modulator is heard too, and gets the same volume (no louder than its own level)
      if ((d.feedback & 1) && d.mod.level !== 0x3f) {
        let mod = Math.max(d.mod.level, car);
        mod |= v.modVolume & 0xc0;
        if (mod !== v.modVolume) {
          v.modVolume = mod;
          this.write(0x40 + MOD_OFF[v.index], mod | d.mod.scale);
        }
      }
    }
  }

  /** FrequencyForVoice */
  frequency(v) {
    const d = v.instr.voices[v.instrVoice];
    let note = v.note;
    if (!(v.instr.flags & GENMIDI_FIXED)) note += d.offset;
    while (note < 0) note += 12;
    while (note > 95) note -= 12;
    let i = 64 + 32 * note + v.channel.bend;
    if (v.instrVoice !== 0) i += (v.instr.fine >> 1) - 64;
    if (i < 0) i = 0;
    if (i < 284) return FREQ_CURVE[i];
    const sub = (i - 284) % 384;
    const octave = Math.min(7, Math.floor((i - 284) / 384));
    return FREQ_CURVE[sub + 284] | (octave << 10);
  }

  /** UpdateVoiceFrequency: a new frequency, written with the key on. */
  updateFrequency(v) {
    const f = this.frequency(v);
    if (f === v.freq) return;
    this.write(0xa0 + v.index, f & 0xff);
    this.write(0xb0 + v.index, (f >> 8) | 0x20);
    v.freq = f;
  }

  voiceKeyOn(channel, instr, instrVoice, note, key, volume) {
    const v = this.getFreeVoice();
    if (!v) return;
    v.channel = channel;
    v.key = key;
    v.note = instr.flags & GENMIDI_FIXED ? instr.fixedNote : note;
    this.setInstrument(v, instr, instrVoice);
    this.setVolume(v, volume);
    v.freq = 0;
    this.updateFrequency(v);
  }

  // ── events ──
  noteOn(ch, key, volume) {
    if (volume <= 0) { this.noteOff(ch, key); return; }
    const channel = this.channels[ch];
    channel.num = ch;
    let instr;
    let note = key;
    if (ch === 9) {
      if (key < 35 || key > 81) return;
      instr = this.bank[128 + key - 35];
      note = 60;
    } else instr = channel.instr;
    if (!instr) return;
    if (!this.free.length) this.replaceExistingVoice();
    this.voiceKeyOn(channel, instr, 0, note, key, volume);
    if (instr.flags & GENMIDI_2VOICE) this.voiceKeyOn(channel, instr, 1, note, key, volume);
  }

  noteOff(ch, key) {
    const channel = this.channels[ch];
    for (const v of this.voices) {
      if (v.channel === channel && v.key === key) {
        this.keyOff(v);
        this.releaseVoice(v);
      }
    }
  }

  allNotesOff(ch) {
    const channel = this.channels[ch];
    for (const v of this.voices) {
      if (v.channel === channel) { this.keyOff(v); this.releaseVoice(v); }
    }
  }

  /** A song event { type, ch, a, b } (music.js's): on, off, prog, cc, bend (a in semitones). */
  event(e) {
    const channel = this.channels[e.ch];
    if (!channel) return;
    channel.num = e.ch;
    if (e.type === 'on') this.noteOn(e.ch, e.a, e.b);
    else if (e.type === 'off') this.noteOff(e.ch, e.a);
    else if (e.type === 'prog') channel.instr = this.bank[e.a & 127] ?? channel.instr;
    else if (e.type === 'bend') {
      // the MIDI bend's top 7 bits − 64: 1/32 semitone steps, ±2 semitones
      channel.bend = Math.max(-64, Math.min(63, Math.round(e.a * 32)));
      for (const v of this.voices) if (v.channel === channel) this.updateFrequency(v);
    } else if (e.type === 'cc') {
      if (e.a === 7) {
        channel.volume = Math.max(0, Math.min(127, e.b));
        for (const v of this.voices) if (v.channel === channel) this.setVolume(v, v.noteVolume);
      } else if (e.a === 120 || e.a === 123) this.allNotesOff(e.ch);
      else if (e.a === 121) channel.bend = 0;
    }
  }

  /** Everything off (the song's end, a new song). */
  silence() {
    for (const v of this.voices) if (v.channel) { this.keyOff(v); this.releaseVoice(v); }
  }
}

/**
 * A song, sequenced and rendered at the chip's rate: SONG is music.js's
 * { events: [{ t (s), type, ch, a, b }], duration }, looped.
 */
export class DmxPlayer {
  constructor(bank, song, { loop = true } = {}) {
    this.opl = new Opl();
    this.dmx = new Dmx(bank, this.opl);
    this.song = song;
    this.loop = loop;
    this.idx = 0;
    this.n = 0;                // chip samples played this time round
    this.ended = false;
  }

  /** The next chip sample (−1…1), playing the events that fall on it first. */
  sample() {
    const ev = this.song?.events;
    if (ev && !this.ended) {
      while (this.idx < ev.length && ev[this.idx].t * OPL_RATE <= this.n) this.dmx.event(ev[this.idx++]);
      if (this.idx >= ev.length && this.n >= this.song.duration * OPL_RATE) {
        this.dmx.silence();
        if (this.loop) {
          // (a quarter second's rest before it comes round again)
          this.idx = 0;
          this.n = -Math.round(OPL_RATE / 4);
          this.dmx.reset();
        } else this.ended = true;
      }
    }
    this.n++;
    return this.opl.sample() / 32768;
  }
}
