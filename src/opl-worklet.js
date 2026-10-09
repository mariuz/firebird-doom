// opl-worklet.js – the music, played on the audio thread: DMX driving the
// emulated OPL2 (dmx.js, opl.js) at the chip's 49716 Hz, resampled to the
// output rate. The page posts it the GENMIDI bank and the songs.
//   { type: 'bank', data: Uint8Array }  { type: 'play', song }  { type: 'stop' }
import { DmxPlayer, parseGenmidiRaw } from './dmx.js';
import { OPL_RATE } from './opl.js';

class OplProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bank = null;
    this.player = null;
    this.pos = 0;      // where the output is between the last two chip samples
    this.a = 0;
    this.b = 0;
    this.port.onmessage = ({ data: m }) => {
      if (m.type === 'bank') this.bank = parseGenmidiRaw(m.data);
      else if (m.type === 'play' && this.bank) this.player = new DmxPlayer(this.bank, m.song, { loop: m.loop !== false });
      else if (m.type === 'stop') this.player = null;
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    if (!this.player) {
      for (const c of out) c.fill(0);
      return true;
    }
    const step = OPL_RATE / sampleRate;
    for (let i = 0; i < ch0.length; i++) {
      this.pos += step;
      while (this.pos >= 1) {
        this.a = this.b;
        this.b = this.player.sample();
        this.pos -= 1;
      }
      ch0[i] = this.a + (this.b - this.a) * this.pos;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('doom-opl', OplProcessor);
