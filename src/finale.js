// finale.js – DOOM's text screens and endings (f_finale.c).
//
// After MAP06, MAP11 and MAP20 (G_WorldDone) the story so far types itself
// out over a tiled flat (F_TextWrite) to D_READ_M, as it does when MAP15's or
// MAP31's secret exit leads to a secret level; once 50 tics have passed, fire
// or use moves on to the next map (F_Ticker). After MAP30 the text is
// followed by the cast call (F_StartCast) to D_EVIL: each monster in turn walks on the
// BOSSBACK backdrop under its name, attacks every twelve frames, and dies
// when you press a key (F_CastResponder); after its last death frame the next
// one comes on (F_CastTicker). The cast ends with the player and starts over,
// as in DOOM. DOOM I's episodes end differently: after E?M8 the episode's
// text plays to D_VICTOR and can't be skipped; TEXTWAIT tics after the last
// character the art screen follows (F_Drawer): CREDIT (or HELP2) after E1,
// VICTORY2 after E2, the bunny scroll after E3 (F_BunnyScroll, to D_BUNNY),
// ENDPIC after E4. DOOM ends the game there; we let fire or use carry on
// into the next episode.
// The words come from the WAD's DEHACKED lump (Freedoom ships its
// own); the state machine is kept apart from the drawing so it can be tested.

const TEXTSPEED = 3;     // tics per character
const SKIP_AFTER = 50;   // F_Ticker: no skipping before this
const WALK_TICS = 4;     // a cast member's see-state frames
const ATTACK_TICS = 8;   // …its attack frames
const DEATH_TICS = 5;    // …its death frames
const LAST_TICS = 15;    // F_CastTicker: a state lasting forever holds 15 tics
const TEXTWAIT = 250;    // DOOM I: tics after the text before the art screen
const ART_HOLD = 35;     // …and how long the art stays before a key moves on

// F_StartFinale for DOOM II: which text, over which flat, after which map
// (secret: only when it was left by the secret exit, into MAP31 or MAP32)
const SCREENS = {
  MAP06: { text: 'C1TEXT', flat: 'SLIME16' },
  MAP11: { text: 'C2TEXT', flat: 'RROCK14' },
  MAP20: { text: 'C3TEXT', flat: 'RROCK07' },
  MAP30: { text: 'C4TEXT', flat: 'RROCK17', cast: true },
  MAP15: { text: 'C5TEXT', flat: 'RROCK13', secret: true },
  MAP31: { text: 'C6TEXT', flat: 'RROCK19', secret: true },
  // DOOM I: the end of each episode, and the art that follows its text
  E1M8: { text: 'E1TEXT', flat: 'FLOOR4_8', music: 'D_VICTOR', art: 'credit' },
  E2M8: { text: 'E2TEXT', flat: 'SFLR6_1', music: 'D_VICTOR', art: 'VICTORY2' },
  E3M8: { text: 'E3TEXT', flat: 'MFLR8_4', music: 'D_VICTOR', art: 'bunny' },
  E4M8: { text: 'E4TEXT', flat: 'MFLR8_3', music: 'D_VICTOR', art: 'ENDPIC' },
};

/**
 * F_BunnyScroll at tic `count` of the art screen: PFUB2 slides off to the
 * left revealing PFUB1 (`scrolled` pixels of PFUB2 gone), then "THE END"
 * stamps in a letter at a time (END0…END6), each with a pistol shot.
 */
export function bunnyFrame(count) {
  const scrolled = Math.max(0, Math.min(320, 320 - Math.floor((count - 230) / 2)));
  if (count < 1130) return { scrolled, end: null, stage: -1 };
  if (count < 1180) return { scrolled, end: 'END0', stage: 0 };
  const stage = Math.min(6, Math.floor((count - 1180) / 5));
  return { scrolled, end: `END${stage}`, stage };
}

// castorder[], by thing type; the player is "type" 0
const CAST = [
  [3004, 'CC_ZOMBIE', 'Zombieman'], [9, 'CC_SHOTGUN', 'Shotgun guy'], [65, 'CC_HEAVY', 'Heavy weapon dude'],
  [3001, 'CC_IMP', 'Imp'], [3002, 'CC_DEMON', 'Demon'], [3006, 'CC_LOST', 'Lost soul'],
  [3005, 'CC_CACO', 'Cacodemon'], [69, 'CC_HELL', 'Hell knight'], [3003, 'CC_BARON', 'Baron of hell'],
  [68, 'CC_ARACH', 'Arachnotron'], [71, 'CC_PAIN', 'Pain elemental'], [66, 'CC_REVEN', 'Revenant'],
  [67, 'CC_MANCU', 'Mancubus'], [64, 'CC_ARCH', 'Arch-vile'], [7, 'CC_SPIDER', 'Spider mastermind'],
  [16, 'CC_CYBER', 'Cyberdemon'], [0, 'CC_HERO', 'Our hero'],
];
const PLAYER = { sprite: 'PLAY', walk: 'ABCD', attack: 'EF', death: 'HIJKLMN', seeSnd: null, atkSnd: 'DSDSHTGN', deathSnd: 'DSPLDETH' };

/**
 * The front view (rotation 0 or 1) of a sprite frame among the WAD's lump
 * names: in the first half of a name (SKELA1) or, mirrored, in the second
 * (SKELA1D1 also holds frame D, flipped). → { name, flip } or null
 */
export function frontLump(names, sprite, frame) {
  let flipped = null;
  for (const n of names) {
    if (!n.startsWith(sprite)) continue;
    if (n[4] === frame && (n[5] === '0' || n[5] === '1')) return { name: n, flip: false };
    if (n.length === 8 && n[6] === frame && (n[7] === '0' || n[7] === '1')) flipped ??= { name: n, flip: true };
  }
  return flipped;
}

/** A BEX [STRINGS] section → Map of KEY → text (\n escapes, \-continued lines). */
export function parseDehStrings(text) {
  const out = new Map();
  const at = text.search(/^\[STRINGS\]/m);
  if (at < 0) return out;
  const lines = text.slice(at).split(/\r?\n/).slice(1);
  for (let i = 0; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) break;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s?(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2];
    while (value.endsWith('\\') && i + 1 < lines.length) value = value.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    out.set(m[1].toUpperCase(), value.replace(/\\n/g, '\n'));
  }
  return out;
}

/** The finale's clock and choices, with nothing drawn. */
export class FinaleState {
  /**
   * @param text   the story text (C4TEXT)
   * @param cast   [{ name, sprite, walk, attack, melee, death, seeSnd, atkSnd, deathSnd }]
   * @param sound  called with a sound lump name to play
   * @param castAfter the cast call follows the text (MAP30); otherwise the
   *                  text ends the screen (stage 'done': on to the next map)
   * @param artAfter  DOOM I: the text can't be skipped, and the art screen
   *                  follows it on its own (stage 'art'), then a key ends it
   */
  constructor(text, cast, sound = () => {}, castAfter = true, artAfter = false) {
    this.text = text;
    this.cast = cast;
    this.sound = sound;
    this.castAfter = castAfter && !artAfter;
    this.artAfter = artAfter;
    // no text to show (id's WADs keep it in the executable): DOOM I's art, or
    // DOOM II's cast call, at once
    this.stage = artAfter && !text ? 'art' : 'text';
    this.count = 0;
    if (this.castAfter && !text) this.startCast();
  }

  /** How much of the text is showing. */
  get shown() { return Math.max(0, Math.floor((this.count - 10) / TEXTSPEED)); }

  /** One tic. buttons: fire or use is held (F_Ticker skips the text on those). */
  tick(buttons = false) {
    this.count++;
    if (this.stage === 'done') return;
    if (this.artAfter) {
      // F_Ticker, DOOM I: no skipping the text; TEXTWAIT after it, the art
      if (this.stage === 'text' && this.count > 10 + this.text.length * TEXTSPEED + TEXTWAIT) {
        this.stage = 'art';
        this.count = 0;
      } else if (this.stage === 'art' && buttons && this.count > ART_HOLD) this.stage = 'done';
      return;
    }
    if (this.stage === 'text') {
      if (buttons && this.count > SKIP_AFTER) {
        if (this.castAfter) this.startCast();
        else this.stage = 'done';         // gameaction = ga_worlddone
      }
      return;
    }
    if (--this.tics > 0) return;
    if (this.mode === 'death') {
      if (this.frame < this.member.death.length - 1) { this.frame++; this.tics = this.frame === this.member.death.length - 1 ? LAST_TICS : DEATH_TICS; return; }
      this.next();
      return;
    }
    this.frame++;
    this.frames++;
    const seq = this.sequence();
    if (this.mode !== 'see' && (this.frame >= seq.length || this.frames >= 24)) this.see();
    else if (this.mode === 'see' && this.frames >= 12) this.attack();
    else this.frame %= seq.length;
    this.tics = this.mode === 'see' ? WALK_TICS : ATTACK_TICS;
  }

  /** F_CastResponder: any key kills the one on stage (once). */
  press() {
    if (this.stage !== 'cast' || this.mode === 'death') return;
    this.mode = 'death';
    this.frame = 0;
    this.tics = this.member.death.length === 1 ? LAST_TICS : DEATH_TICS;
    if (this.member.deathSnd) this.sound(this.member.deathSnd);
  }

  startCast() {
    this.stage = 'cast';
    this.castnum = -1;
    this.melee = false;
    this.next();
  }

  get member() { return this.cast[this.castnum]; }

  /** the sprite lump frame showing now: { sprite, frame } */
  get pose() {
    const seq = this.mode === 'death' ? this.member.death : this.sequence();
    return { sprite: this.member.sprite, frame: seq[Math.min(this.frame, seq.length - 1)] };
  }

  sequence() {
    if (this.mode === 'see') return this.member.walk;
    return this.mode === 'melee' ? this.member.melee : this.member.attack;
  }

  next() {
    this.castnum = (this.castnum + 1) % this.cast.length;
    if (this.member.seeSnd) this.sound(this.member.seeSnd);
    this.see();
    this.frame = 0;
    this.tics = WALK_TICS;
  }

  see() {
    this.mode = 'see';
    this.frame = 0;
    this.frames = 0;
  }

  attack() {
    // castonmelee: those with both alternate; those with one use it
    const m = this.member;
    this.mode = (this.melee && m.melee) || !m.attack ? 'melee' : 'attack';
    this.melee = !this.melee;
    this.frame = 0;
    this.frames = 0;
    if (m.atkSnd) this.sound(m.atkSnd);
  }
}

/** Build the cast from THING_TYPES and the WAD's strings. */
export function buildCast(thingTypes, strings) {
  const byType = new Map(thingTypes.map((t) => [t.type, t]));
  return CAST.map(([type, key, fallback]) => {
    const name = strings.get(key) ?? fallback;
    if (type === 0) return { name, ...PLAYER, melee: null };
    const t = byType.get(type);
    return {
      name, sprite: t.sprite, walk: t.walk, attack: t.attack ?? null, melee: t.meleeFr ?? null,
      death: t.death, seeSnd: t.seeSnd ?? null, atkSnd: t.atkSnd ?? null, deathSnd: t.deathSnd ?? null,
    };
  });
}

/** The finale on screen: FinaleState plus F_TextWrite and F_CastDrawer. */
/** The WAD's DEHACKED strings (Freedoom ships its own text). */
function wadStrings(wad) {
  const deh = wad.lump('DEHACKED');
  return deh ? parseDehStrings(new TextDecoder('latin1').decode(wad.data(deh))) : new Map();
}

// DOOM II's story text for WADs that have none (id's doom2.wad keeps C1TEXT–
// C6TEXT in the executable): Freedoom Phase 2's, BSD-licensed, which the build
// extracts into wads/freedoom-strings.json and the page hands to us.
const FALLBACK_KEYS = ['C1TEXT', 'C2TEXT', 'C3TEXT', 'C4TEXT', 'C5TEXT', 'C6TEXT'];
let fallbackStrings = new Map();

/** Use these when a WAD lacks DOOM II's story text: { source, strings: { C1TEXT: … } } */
export function setFallbackStrings(data) {
  fallbackStrings = new Map(Object.entries(data?.strings ?? {}).filter(([k]) => FALLBACK_KEYS.includes(k)));
  fallbackStrings.source = data?.source ?? null;
}

/** What the build writes as the fallback: Freedoom Phase 2's C1TEXT–C6TEXT. */
export function freedoomStrings(wad) {
  const s = wadStrings(wad);
  return {
    source: 'Freedoom Phase 2 (BSD-3-Clause, see FREEDOOM-COPYING.txt)',
    strings: Object.fromEntries(FALLBACK_KEYS.filter((k) => s.get(k)).map((k) => [k, s.get(k)])),
  };
}

/**
 * A screen's words: the WAD's own, else (DOOM II's screens only) the fallback.
 * DOOM I's endings don't borrow: without words they go straight to their art.
 */
function screenText(wad, screen) {
  const own = wadStrings(wad).get(screen.text);
  if (own) return { text: own, borrowed: false };
  const spare = screen.art ? null : fallbackStrings.get(screen.text);
  return spare ? { text: spare, borrowed: true } : { text: '', borrowed: false };
}

export class Finale {
  constructor(renderer, audio, wad, thingTypes, mapName = 'MAP30', secret = false) {
    this.renderer = renderer;
    this.audio = audio;
    this.wad = wad;
    this.from = mapName;    // the map it follows…
    this.secret = secret;   // …and how it was left: where the game goes next
    const screen = SCREENS[mapName];
    const strings = wadStrings(wad);
    const { text, borrowed } = screenText(wad, screen);
    this.borrowed = borrowed;   // the words are Freedoom's, the WAD had none
    this.state = new FinaleState(text, buildCast(thingTypes, strings),
      (snd) => audio.playEvents([[0, snd, 0, null, null]], { x: 0, y: 0, angle: 0 }), !!screen.cast, !!screen.art);
    this.flat = wad.lump(screen.flat) ? wad.data(wad.lump(screen.flat)) : null;
    // F_Drawer's art: for episode 1, CREDIT on a four-episode ("retail") WAD, else HELP2
    this.art = screen.art === 'credit' ? (wad.lump('E4M1') ? 'CREDIT' : 'HELP2') : screen.art ?? null;
    this.lastEnd = -1;
    this.names = wad.lumps.map((l) => l.name);
    this.fronts = new Map();
    // straight to the bunny or the cast (no text first): their own music from the start
    audio.playMusic(this.state.stage === 'art' && this.art === 'bunny' ? 'D_BUNNY'
      : this.state.stage === 'cast' ? 'D_EVIL' : screen.music ?? 'D_READ_M');
  }

  /**
   * Is there a screen after this map? DOOM II's MAP06/11/20/30, MAP15/31
   * left by the secret exit, and DOOM I's E?M8, when the WAD has the flat, and the words (the
   * text screens) or the backdrop (MAP30's cast call, which plays even
   * without text).
   */
  static available(wad, mapName, secret = false) {
    const screen = SCREENS[mapName];
    if (!screen || (screen.secret && !secret)) return false;
    if (screen.cast) return !!wad.lump('BOSSBACK');
    const words = !!wad.lump(screen.flat) && !!screenText(wad, screen).text;
    // DOOM I's endings show their art even without the words (id's doom.wad)
    if (screen.art) return words || Finale.hasArt(wad, screen.art);
    return words;
  }

  /** the art screen's pictures are in the WAD */
  static hasArt(wad, art) {
    if (art === 'credit') return !!(wad.lump('CREDIT') || wad.lump('HELP2'));
    if (art === 'bunny') return !!(wad.lump('PFUB1') && wad.lump('PFUB2'));
    return !!wad.lump(art);
  }

  /** The text screen is over: on to the next map. */
  get done() { return this.state.stage === 'done'; }

  tick(buttons) {
    const was = this.state.stage;
    this.state.tick(buttons);
    if (was === 'text' && this.state.stage === 'cast') this.audio.playMusic('D_EVIL');
    if (this.art === 'bunny' && this.state.stage === 'art') {
      if (was === 'text') this.audio.playMusic('D_BUNNY');
      // each new letter of THE END comes with a pistol shot
      const { stage } = bunnyFrame(this.state.count);
      if (stage > this.lastEnd) {
        if (stage > 0) this.state.sound('DSPISTOL');
        this.lastEnd = stage;
      }
    }
  }

  press() { this.state.press(); }

  draw() {
    const r = this.renderer;
    if (this.state.stage === 'art' && this.art === 'bunny') {
      this.bunny(this.state.count);
    } else if (this.state.stage === 'art') {
      r.patch(r.pictureByName(this.art), 0, 0);
    } else if (this.state.stage !== 'cast') {
      // F_TextWrite: the flat tiled over the whole screen, the text typed onto it
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 320; x++) r.sfb[y * 320 + x] = this.flat[((y & 63) << 6) | (x & 63)];
      }
      this.write(this.state.text.slice(0, this.state.shown), 10, 10);
    } else {
      // F_CastDrawer: the backdrop, the name, the monster at (160, 170)
      r.patch(r.pictureByName('BOSSBACK'), 0, 0);
      const name = this.state.member.name.toUpperCase();
      this.write(name, 160 - this.width(name) / 2, 180);
      const { sprite, frame } = this.state.pose;
      const key = sprite + frame;
      if (!this.fronts.has(key)) this.fronts.set(key, frontLump(this.names, sprite, frame));
      const front = this.fronts.get(key);
      if (front) this.sprite(r.pictureByName(front.name), 160, 170, front.flip);
    }
    r.present();
  }

  /** F_BunnyScroll: two full-screen pictures side by side, scrolling, then THE END. */
  bunny(count) {
    const r = this.renderer;
    const { scrolled, end } = bunnyFrame(count);
    const p1 = r.pictureByName('PFUB2');
    const p2 = r.pictureByName('PFUB1');
    for (let x = 0; x < 320; x++) {
      const src = x + scrolled;
      const pic = src < 320 ? p1 : p2;
      const col = (src < 320 ? src : src - 320) * pic.h;
      for (let y = 0; y < Math.min(200, pic.h); y++) {
        if (pic.alpha[col + y]) r.sfb[y * 320 + x] = pic.pix[col + y];
      }
    }
    if (end) r.patch(r.pictureByName(end), (320 - 13 * 8) / 2, (200 - 8 * 8) / 2);
  }

  /** V_DrawPatch / V_DrawPatchFlipped: same origin, the columns mirrored when flipped. */
  sprite(pic, x, y, flip) {
    if (!pic) return;
    const r = this.renderer;
    const x0 = x - pic.left;
    const y0 = y - pic.top;
    for (let px = 0; px < pic.w; px++) {
      const sx = x0 + px;
      if (sx < 0 || sx >= 320) continue;
      const off = (flip ? pic.w - 1 - px : px) * pic.h;
      for (let py = 0; py < pic.h; py++) {
        const sy = y0 + py;
        if (sy < 0 || sy >= 200 || !pic.alpha[off + py]) continue;
        r.sfb[sy * 320 + sx] = pic.pix[off + py];
      }
    }
  }

  glyph(ch) {
    const c = ch.toUpperCase().charCodeAt(0);
    return c >= 33 && c <= 95 ? this.renderer.pictureByName(`STCFN${String(c).padStart(3, '0')}`) : null;
  }

  width(s) { return [...s].reduce((w, ch) => w + (this.glyph(ch)?.w ?? 4), 0); }

  write(s, x, y) {
    let cx = x;
    let cy = y;
    for (const ch of s) {
      if (ch === '\n') { cx = 10; cy += 11; continue; }
      const pic = this.glyph(ch);
      if (!pic) { cx += 4; continue; }
      if (cx + pic.w > 320) break;
      this.renderer.patch(pic, cx, cy);
      cx += pic.w;
    }
  }
}
