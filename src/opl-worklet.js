// opl-worklet.js – the music, played on the audio thread: DMX driving the
// emulated OPL2 or OPL3 (dmx.js, opl.js) at the chip's 49716 Hz, resampled to
// the output rate, in stereo (the same on both sides from an OPL2). The page
// posts it the GENMIDI bank and the songs.
//   { type: 'bank', data: Uint8Array }  { type: 'play', song, opl3 }  { type: 'stop' }
import { DmxPlayer, parseGenmidiRaw } from './dmx.js';
import { OPL_RATE } from './opl.js';

class OplProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bank = null;
    this.player = null;
    this.pos = 0;      // where the output is between the last two chip samples
    this.al = 0; this.bl = 0;   // left: the last two chip samples
    this.ar = 0; this.br = 0;   // right
    this.port.onmessage = ({ data: m }) => {
      if (m.type === 'bank') this.bank = parseGenmidiRaw(m.data);
      else if (m.type === 'play' && this.bank) this.player = new DmxPlayer(this.bank, m.song, { loop: m.loop !== false, opl3: !!m.opl3 });
      else if (m.type === 'stop') this.player = null;
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    if (!this.player) {
      for (const c of out) c.fill(0);
      return true;
    }
    const step = OPL_RATE / sampleRate;
    const chip = this.player.opl;
    for (let i = 0; i < L.length; i++) {
      this.pos += step;
      while (this.pos >= 1) {
        this.al = this.bl;
        this.ar = this.br;
        this.player.sample();
        this.bl = chip.left / 32768;
        this.br = chip.right / 32768;
        this.pos -= 1;
      }
      L[i] = this.al + (this.bl - this.al) * this.pos;
      R[i] = this.ar + (this.br - this.ar) * this.pos;
    }
    for (let c = 2; c < out.length; c++) out[c].set(L);
    return true;
  }
}

registerProcessor('doom-opl', OplProcessor);
