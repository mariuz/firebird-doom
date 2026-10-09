// audio.js – sound effects and music from the WAD.
//
// The simulation decides *what* is heard: PSQL procedures insert rows into
// SOUND_EVENTS (S_StartSound). The browser reads the new rows each frame and
// plays them: DMX sound lumps (DS*) through Web Audio, on DOOM's 8 channels
// with its priorities, attenuated and panned by where the listener is and
// following their sources as they move (channels.js). Music is a D_* lump
// (music.js reads MUS and MIDI) played by DOOM's DMX driver on an emulated
// OPL2 chip (dmx.js, opl.js), in an AudioWorklet (opl-worklet.js) – or, with
// the Synth setting, an OPL3 in stereo, as DMX's -opl3 option drove it.

import { parseSong } from './music.js';
import { DmxPlayer, parseGenmidiRaw } from './dmx.js';
import { OPL_RATE } from './opl.js';
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
    this.opl3 = false;
  }

  /** The Synth setting: an OPL3 (stereo, 18 voices) or the OPL2; the song starts over on the new chip. */
  setOpl3(on) {
    if (this.opl3 === !!on) return;
    this.opl3 = !!on;
    if (this.currentMusic && this.musicPlaying) this.playMusic(this.currentMusic, true);
  }

  setWad(wad) {
    this.wad = wad;
    this.buffers.clear();
    this.bankSent = null;      // which WAD's GENMIDI the worklet has
    this.stopMusic();
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
    if (music === 0) this.stopMusic();
    else if (this.currentMusic && !this.musicPlaying) this.playMusic(this.currentMusic, true);
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
      this.stopMusic();
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
   * Debugging aid: render the first seconds of a song (no Web Audio needed) and
   * report its level, e.g. doom.audio.renderLevel('D_E1M1', 8) in the console.
   */
  renderLevel(lumpName, seconds = 8) {
    const song = parseSong(this.wad.data(this.wad.lump(lumpName)));
    const p = new DmxPlayer(parseGenmidiRaw(this.wad.data(this.wad.lump('GENMIDI'))), song, { loop: false, opl3: this.opl3 });
    let sum = 0;
    let peak = 0;
    const n = Math.round(OPL_RATE * seconds);
    for (let i = 0; i < n; i++) {
      const v = p.sample();
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    return { rms: Math.sqrt(sum / n), peak, voices: p.dmx.voices.filter((v) => v.channel).length };
  }

  /** The worklet that plays the music, loaded once per audio context. */
  musicNode() {
    if (!this.oplReady) {
      this.oplReady = this.ctx.audioWorklet.addModule(new URL('./opl-worklet.js', location.href)).then(() => {
        this.opl = new AudioWorkletNode(this.ctx, 'doom-opl', { numberOfInputs: 0, outputChannelCount: [2] });
        this.opl.connect(this.musicGain);
        return this.opl;
      });
    }
    return this.oplReady;
  }

  stopMusic() {
    this.musicPlaying = false;
    this.opl?.port.postMessage({ type: 'stop' });
  }

  playMusic(lumpName, force = false) {
    if (!force && lumpName === this.currentMusic && this.musicPlaying) return;
    this.currentMusic = lumpName;
    if (!this.enabled) return;
    if (!this.ctx || this.ctx.state !== 'running') {
      this.pendingMusic = lumpName;
      return;
    }
    this.stopMusic();
    if (!lumpName || this.musicVolume === 0 || !this.wad) return;
    const lump = this.wad.lump(lumpName);
    const genmidi = this.wad.lump('GENMIDI');
    if (!lump || !genmidi) return;
    let song;
    try {
      song = parseSong(this.wad.data(lump));
    } catch (err) {
      console.warn(`[firebird-doom] could not read ${lumpName}:`, err);
      return;
    }
    if (!song) return;
    this.musicPlaying = true;
    const wad = this.wad;
    this.musicNode().then((node) => {
      // (still the song wanted? a newer playMusic or a stop may have come first)
      if (this.currentMusic !== lumpName || !this.musicPlaying || this.wad !== wad) return;
      if (this.bankSent !== wad) {
        node.port.postMessage({ type: 'bank', data: wad.data(genmidi).slice() });
        this.bankSent = wad;
      }
      node.port.postMessage({ type: 'play', song, opl3: this.opl3 });
    }).catch((err) => {
      this.musicPlaying = false;
      console.warn('[firebird-doom] no music (the AudioWorklet failed to load):', err);
    });
  }
}
