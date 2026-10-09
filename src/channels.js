// channels.js – s_sound.c's sound channels, without the audio: which sounds
// play, on which of the 8 channels, how loud and where.
//
// S_StartSoundAtVolume: a sound out of earshot isn't started; otherwise the
// origin's previous sound stops (S_StopSound), then S_getChannel takes a free
// channel, or the first one playing a sound whose priority number is no
// lower (a lower number matters more), or none – and the new sound is lost.
// S_UpdateSounds: every tic each channel follows its origin's position, and
// stops once it's out of earshot. S_AdjustSoundParams: P_AproxDistance, full
// volume within 200 units, nothing beyond 1200 (on map 8 – E?M8, MAP08 – a
// sound never fades below 15 of 127), separation 128 − 96·sin.

export const NUM_CHANNELS = 8;      // snd_channels' default
const CLOSE_DIST = 200;             // S_CLOSE_DIST
const CLIP_DIST = 1200;             // S_CLIPPING_DIST
const ATTENUATOR = CLIP_DIST - CLOSE_DIST;
const STEREO_SWING = 96;            // S_STEREO_SWING
const NORM_SEP = 128;

// sounds.c's S_sfx priorities (lower matters more); anything else gets 64
export const SFX_PRIORITY = {
  pistol: 64, shotgn: 64, sgcock: 64, dshtgn: 64, dbopn: 64, dbcls: 64, dbload: 64, plasma: 64, bfg: 64,
  sawup: 64, sawidl: 118, sawful: 64, sawhit: 64, rlaunc: 64, rxplod: 70, firsht: 70, firxpl: 70,
  pstart: 100, pstop: 100, doropn: 100, dorcls: 100, stnmov: 119, swtchn: 78, swtchx: 78,
  plpain: 96, dmpain: 96, popain: 96, vipain: 96, mnpain: 96, pepain: 96, slop: 78, itemup: 78,
  wpnup: 78, oof: 96, telept: 32, posit1: 98, posit2: 98, posit3: 98, bgsit1: 98, bgsit2: 98,
  sgtsit: 98, cacsit: 98, brssit: 94, cybsit: 92, spisit: 90, bspsit: 90, kntsit: 98, vilsit: 98,
  mansit: 98, pesit: 98, sklatk: 70, sgtatk: 70, skepch: 70, vilatk: 70, claw: 70, skeswg: 70,
  pldeth: 32, pdiehi: 32, podth1: 70, podth2: 70, podth3: 70, bgdth1: 70, bgdth2: 70, sgtdth: 70,
  cacdth: 70, skldth: 70, brsdth: 32, cybdth: 32, spidth: 32, bspdth: 32, vildth: 32, kntdth: 32,
  pedth: 32, skedth: 32, posact: 120, bgact: 120, dmact: 120, bspact: 100, bspwlk: 100, vilact: 100,
  noway: 78, barexp: 60, punch: 64, hoof: 70, metal: 70, chgun: 64, tink: 60, bdopn: 100, bdcls: 100,
  itmbk: 100, flame: 32, flamst: 32, getpow: 60, bospit: 70, boscub: 70, bossit: 70, bospn: 70,
  bosdth: 70, manatk: 70, mandth: 70, sssit: 70, ssdth: 70, keenpn: 70, keendt: 70, skeact: 70,
  skesit: 70, skeatk: 70, radio: 60,
};
export const priorityOf = (lump) => SFX_PRIORITY[String(lump).replace(/^DS/i, '').toLowerCase()] ?? 64;

/** P_AproxDistance */
export const aproxDistance = (dx, dy) => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return ax + ay - Math.min(ax, ay) / 2;
};

/**
 * S_AdjustSoundParams: a sound at (x, y) heard from listener { x, y, angle,
 * bossMap }. Returns { vol: 0–1, pan: −0.75…0.75 } or null when out of earshot.
 * x/y null: the listener's own sound, full volume in the middle.
 */
export function adjust(x, y, listener) {
  if (x == null || y == null) return { vol: 1, pan: 0 };
  const dx = x - listener.x;
  const dy = y - listener.y;
  let dist = aproxDistance(dx, dy);
  if (!listener.bossMap && dist > CLIP_DIST) return null;
  let vol;
  if (dist < CLOSE_DIST) vol = 127;
  else if (listener.bossMap) {
    dist = Math.min(dist, CLIP_DIST);
    vol = 15 + Math.trunc(((127 - 15) * (CLIP_DIST - dist)) / ATTENUATOR);
  } else vol = Math.trunc((127 * (CLIP_DIST - dist)) / ATTENUATOR);
  // (on top of the listener: no separation)
  const sep = dx === 0 && dy === 0 ? NORM_SEP : NORM_SEP - STEREO_SWING * Math.sin(Math.atan2(dy, dx) - listener.angle);
  if (vol <= 0) return null;
  return { vol: vol / 127, pan: (sep - NORM_SEP) / NORM_SEP };
}

export class Channels {
  /** @param stop (handle) → stop that playing sound */
  constructor(stop = () => {}, n = NUM_CHANNELS) {
    this.slots = Array(n).fill(null);   // { sound, origin, priority, x, y, handle }
    this.stop = stop;
  }

  /** S_StartSoundAtVolume: the slot it plays on, or -1 (out of earshot, or no channel to take). */
  start(sound, origin, x, y, listener, handle) {
    if (!adjust(x, y, listener)) return -1;
    this.stopOrigin(origin);                       // "kill old sound"
    const priority = priorityOf(sound);
    let c = this.slots.indexOf(null);              // S_getChannel: a free one…
    if (c < 0) c = this.slots.findIndex((s) => s.priority >= priority);   // …or a less important one
    if (c < 0) return -1;                          // "No lower priority. Sorry, Charlie."
    if (this.slots[c]) this.free(c);
    this.slots[c] = { sound, origin, priority, x, y, handle };
    return c;
  }

  /** S_StopSound */
  stopOrigin(origin) {
    this.slots.forEach((s, i) => { if (s && s.origin === origin) this.free(i); });
  }

  free(i) {
    const s = this.slots[i];
    this.slots[i] = null;
    if (s) this.stop(s.handle);
  }

  /** A sound came to its end by itself. */
  ended(handle) {
    const i = this.slots.findIndex((s) => s && s.handle === handle);
    if (i >= 0) this.slots[i] = null;
  }

  /** The thing origins playing now (what update needs the positions of). */
  thingOrigins() {
    return [...new Set(this.slots.filter((s) => s && typeof s.origin === 'number' && s.origin > 0).map((s) => s.origin))];
  }

  /**
   * S_UpdateSounds: things move their sounds along (POSITIONS: Map id → [x, y]);
   * a thing that's gone took its sound with it (P_RemoveMobj's S_StopSound);
   * out of earshot, a channel stops. Calls set(handle, vol, pan) for the rest.
   */
  update(listener, positions, set = () => {}) {
    this.slots.forEach((s, i) => {
      if (!s) return;
      if (typeof s.origin === 'number' && s.origin > 0) {
        const p = positions.get(s.origin);
        if (!p) { this.free(i); return; }
        [s.x, s.y] = p;
      }
      const a = adjust(s.x, s.y, listener);
      if (!a) { this.free(i); return; }
      set(s.handle, a.vol, a.pan);
    });
  }
}
