// audio.js – sound effects and music from the WAD.
//
// The simulation decides *what* is heard: PSQL procedures insert rows into
// SOUND_EVENTS (S_StartSound). The browser reads the new rows each frame and
// plays them: DMX sound lumps (DS*) through Web Audio, on DOOM's 8 channels
// with its priorities, attenuated and panned by where the listener is and
// following their sources as they move (channels.js). Music is a D_* lump
// played by music.js.

import { parseSong, parseGenmidi, OplSynth } from './music.js';
import { Channels, adjust } from './channels.js';

// DOOM II's music lumps: MAP01..MAP30, the secret levels (MAP31 EVIL, MAP32
// ULTIMA), then the three that aren't level music but that IDMUS 33–35 reach
// all the same – the story screens, the title and the intermission
const D2_MUSIC = ['RUNNIN', 'STALKS', 'COUNTD', 'BETWEE', 'DOOM', 'THE_DA', 'SHAWN', 'DDTBLU', 'IN_CIT', 'DEAD',
  'STLKS2', 'THEDA2', 'DOOM2', 'DDTBL2', 'RUNNI2', 'DEAD2', 'STLKS3', 'ROMERO', 'SHAWN2', 'MESSAG', 'COUNT2',
  'DDTBL3', 'AMPIE', 'THEDA3', 'ADRIAN', 'MESSG2', 'ROMER2', 'TENSE', 'SHAWN3', 'OPENIN', 'EVIL', 'ULTIMA',
  'READ_M', 'DM2TTL', 'DM2INT'];

export function musicLumpFor(mapName) {
  if (/^E\dM\d$/.test(mapName)) return `D_${mapName}`;
  const n = Number(mapName.slice(3));
  return D2_MUSIC[n - 1] ? `D_${D2_MUSIC[n - 1]}` : null;
}

export class DoomAudio {
  constructor() {
    this.ctx = null;
    this.wad = null;
    this.buffers = new Map();
    // s_sound.c's channels; a handle is { src, gain, pan }
    this.channels = new Channels((h) => {
      try { h.src?.stop(); } catch { /* already ended */ }
    });
    this.sfxVolume = 0.7;
    this.musicVolume = 0.5;
    this.pendingMusic = null;
    this.currentMusic = null;
    this.enabled = true;
  }

  setWad(wad) {
    this.wad = wad;
    this.buffers.clear();
    this.bank = null;
    if (this.synth) this.synth.stop();
    this.synth = null;
  }

  /** Browsers only allow audio after a user gesture: call from input handlers. */
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createDynamicsCompressor();
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.sfxGain.connect(this.master);
      this.musicGain.connect(this.master);
      this.setVolumes(this.sfxVolume, this.musicVolume);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.pendingMusic) {
      const m = this.pendingMusic;
      this.pendingMusic = null;
      this.playMusic(m);
    }
  }

  setVolumes(sfx, music) {
    this.sfxVolume = sfx;
    this.musicVolume = music;
    if (!this.ctx) return;
    this.sfxGain.gain.value = sfx;
    this.musicGain.gain.value = music;
    if (music === 0 && this.synth) this.synth.stop();
    else if (music > 0 && this.currentMusic && !this.synth?.timer) this.playMusic(this.currentMusic, true);
  }

  suspend(on) {
    if (!this.ctx) return;
    if (on || !this.enabled) this.ctx.suspend();
    else this.ctx.resume();
  }

  /** The Audio setting: off stops the music and silences everything. */
  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      if (this.synth) this.synth.stop();
      this.channels.slots.forEach((_, i) => this.channels.free(i));
      if (this.ctx) this.ctx.suspend();
    } else {
      this.unlock();
      // resuming is asynchronous: restart the music once the clock runs again
      if (this.ctx) this.ctx.resume().then(() => this.playMusic(this.currentMusic, true));
    }
  }

  /** A DMX sound lump: format 3, sample rate, sample count, 8-bit unsigned PCM. */
  buffer(name) {
    if (this.buffers.has(name)) return this.buffers.get(name);
    let buf = null;
    const lump = this.wad?.lump(name);
    if (lump && lump.size > 8) {
      const d = this.wad.data(lump);
      const dv = this.wad.dv(lump);
      if (dv.getUint16(0, true) === 3) {
        const rate = dv.getUint16(2, true);
        const n = Math.min(dv.getUint32(4, true), lump.size - 8);
        // DMX pads each sample with 16 bytes at both ends
        const pcm = n > 32 ? d.subarray(8 + 16, 8 + n - 16) : d.subarray(8, 8 + n);
        if (pcm.length) {
          buf = this.ctx.createBuffer(1, pcm.length, Math.max(3000, rate));
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] - 128) / 128;
        }
      }
    }
    this.buffers.set(name, buf);
    return buf;
  }

  /**
   * Play SOUND_EVENTS rows [id, sound, origin, x, y] heard from `listener`
   * ({ x, y, angle, bossMap }): S_StartSound for each.
   */
  playEvents(rows, listener) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running' || this.sfxVolume === 0) return;
    for (const [, sound, origin, x, y] of rows.slice(-16)) {
      const buf = this.buffer(sound);
      if (!buf) continue;
      const h = {};
      if (this.channels.start(sound, origin, x, y, listener, h) < 0) continue;
      h.src = this.ctx.createBufferSource();
      h.src.buffer = buf;
      h.gain = this.ctx.createGain();
      h.pan = this.ctx.createStereoPanner();
      h.src.connect(h.gain).connect(h.pan).connect(this.sfxGain);
      h.src.onended = () => {
        this.channels.ended(h);
        h.pan.disconnect();
      };
      const a = adjust(x, y, listener);
      h.gain.gain.value = a.vol;
      h.pan.pan.value = a.pan;
      h.src.start();
    }
  }

  /** S_UpdateSounds: POSITIONS (Map thing id → [x, y]) for the things sounding now. */
  update(listener, positions) {
    if (!this.ctx) return;
    this.channels.update(listener, positions, (h, vol, pan) => {
      if (!h.gain) return;
      h.gain.gain.value = vol;
      h.pan.pan.value = pan;
    });
  }

  /**
   * Debugging aid: render the first seconds of a song offline and report its
   * level, e.g. await doom.audio.renderLevel('D_E1M1', 8) in the console.
   */
  async renderLevel(lumpName, seconds = 8) {
    const lump = this.wad.lump(lumpName);
    const song = parseSong(this.wad.data(lump));
    const ctx = new OfflineAudioContext(2, 44100 * seconds, 44100);
    const synth = new OplSynth(ctx, ctx.destination, parseGenmidi(this.wad.data(this.wad.lump('GENMIDI'))));
    for (const e of song.events) if (e.t < seconds) synth.dispatch(e, e.t);
    const out = (await ctx.startRendering()).getChannelData(0);
    let sum = 0;
    let peak = 0;
    for (const v of out) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    return { rms: Math.sqrt(sum / out.length), peak, voices: synth.voices.length };
  }

  playMusic(lumpName, force = false) {
    if (!force && lumpName === this.currentMusic && this.synth?.timer) return;
    this.currentMusic = lumpName;
    if (!this.enabled) return;
    if (!this.ctx || this.ctx.state !== 'running') {
      this.pendingMusic = lumpName;
      return;
    }
    if (this.synth) this.synth.stop();
    if (!lumpName || this.musicVolume === 0 || !this.wad) return;
    const lump = this.wad.lump(lumpName);
    const genmidi = this.wad.lump('GENMIDI');
    if (!lump || !genmidi) return;
    if (!this.bank) this.bank = parseGenmidi(this.wad.data(genmidi));
    if (!this.synth) this.synth = new OplSynth(this.ctx, this.musicGain, this.bank);
    try {
      this.synth.play(parseSong(this.wad.data(lump)));
    } catch (err) {
      console.warn(`[firebird-doom] could not play ${lumpName}:`, err);
    }
  }
}
