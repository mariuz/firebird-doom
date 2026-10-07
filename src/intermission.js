// intermission.js – the screen between levels (wi_stuff.c, single player).
//
// "<level> Finished", then kills, items and secrets count up as percentages,
// two points a tic with a pistol shot every four tics and a barrel explosion
// as each settles; then the time and par count up three seconds a tic
// (WI_updateStats). Fire or use jumps to the final numbers; once they're all
// there, another press moves on. DOOM I then shows the episode map: a splat
// on every level done, a blinking "you are here" on the next, and "Entering
// <level>" (WI_updateShowNextLoc). DOOM II just says "Entering" for a moment.
// DOOM I's episode maps also come alive (WI_updateAnimatedBack): little
// animations cycle on episodes 1 and 3, and on episode 2 the part of the map
// you're heading for lights up.
// The counting is IntermissionState, kept apart from the drawing for tests.

const TICRATE = 35;
const SP_STATSX = 50;
const SP_STATSY = 50;
const SP_TIMEX = 16;
const SP_TIMEY = 168;
const SHOWNEXTLOCDELAY = 4;   // seconds

// par times in seconds: pars[episode][map] (DOOM I) and cpars[map - 1] (DOOM II)
const PARS = [
  [0, 30, 75, 120, 90, 165, 180, 180, 30, 165],
  [0, 90, 90, 90, 120, 90, 360, 240, 30, 170],
  [0, 90, 45, 90, 150, 90, 90, 165, 30, 135],
];
const CPARS = [30, 90, 120, 120, 90, 150, 120, 120, 270, 90, 210, 150, 150, 150, 210, 150, 420, 150, 210, 150,
  240, 150, 180, 150, 150, 300, 330, 420, 300, 180, 120, 30];

// where each level sits on DOOM I's episode maps (lnodes)
const LNODES = [
  [[185, 164], [148, 143], [69, 122], [209, 102], [116, 89], [166, 55], [71, 56], [135, 29], [71, 24]],
  [[254, 25], [97, 50], [188, 64], [128, 78], [214, 92], [133, 130], [208, 136], [148, 140], [235, 158]],
  [[156, 168], [48, 154], [174, 95], [265, 75], [130, 48], [279, 23], [198, 48], [140, 25], [281, 136]],
];

// wi_stuff.c's anim_t tables, per episode: [period, frames, x, y, level]. A
// level animation (episode 2) only plays when `level` is the map you're
// entering (wbs->next); the others always cycle.
const T3 = Math.floor(TICRATE / 3);
const T4 = Math.floor(TICRATE / 4);
const BACK_ANIMS = [
  [[T3, 3, 224, 104], [T3, 3, 184, 160], [T3, 3, 112, 136], [T3, 3, 72, 112], [T3, 3, 88, 96],
    [T3, 3, 64, 48], [T3, 3, 192, 40], [T3, 3, 136, 16], [T3, 3, 80, 16], [T3, 3, 64, 24]],
  [[T3, 1, 128, 136, 1], [T3, 1, 128, 136, 2], [T3, 1, 128, 136, 3], [T3, 1, 128, 136, 4], [T3, 1, 128, 136, 5],
    [T3, 1, 128, 136, 6], [T3, 1, 128, 136, 7], [T3, 3, 192, 144, 8], [T3, 1, 128, 136, 8]],
  [[T3, 3, 104, 168], [T3, 3, 40, 136], [T3, 3, 160, 96], [T3, 3, 104, 80], [T3, 3, 120, 32], [T4, 3, 40, 0]],
];

/** WI_initAnimatedBack / WI_updateAnimatedBack / WI_drawAnimatedBack for one episode map. */
export class BackAnims {
  /**
   * @param episode 0–2 (anything else has none)
   * @param next    the map being entered, 0-based (wbs->next)
   * @param random  [0, 1) – where in its period each always-on animation starts
   */
  constructor(episode, next, random = Math.random) {
    this.episode = episode;
    this.next = next;
    this.random = random;
    this.list = (BACK_ANIMS[episode] ?? []).map(([period, frames, x, y, level], j) => ({ j, period, frames, x, y, level }));
    this.reset(0);
  }

  reset(bcnt) {
    for (const a of this.list) {
      a.ctr = -1;
      a.nexttic = a.level == null ? bcnt + 1 + Math.floor(this.random() * a.period) : bcnt + 1;
    }
  }

  /** statCount: the stats are still counting (one of episode 2's waits for them) */
  update(bcnt, statCount) {
    this.list.forEach((a, i) => {
      if (bcnt !== a.nexttic) return;
      if (a.level == null) {
        if (++a.ctr >= a.frames) a.ctr = 0;
        a.nexttic = bcnt + a.period;
      } else if (!(statCount && i === 7) && this.next === a.level) {
        // "gawd-awful hack for level anims": light up, then hold the last frame
        a.ctr++;
        if (a.ctr === a.frames) a.ctr--;
        a.nexttic = bcnt + a.period;
      }
    });
  }

  /** what to draw: [{ lump, x, y }] – WIAeaaff, episode 2's ninth borrowing the fifth's pictures */
  get frames() {
    const two = (n) => String(n).padStart(2, '0');
    return this.list.filter((a) => a.ctr >= 0).map((a) => ({
      lump: `WIA${this.episode}${two(this.episode === 1 && a.j === 8 ? 4 : a.j)}${two(a.ctr)}`, x: a.x, y: a.y,
    }));
  }
}

/** E1M3 → { doom2: false, episode: 0, map: 2 }; MAP07 → { doom2: true, map: 6 } (0-based, like wbs) */
export function levelOf(name) {
  const ep = /^E(\d)M(\d)$/.exec(name);
  if (ep) return { doom2: false, episode: Number(ep[1]) - 1, map: Number(ep[2]) - 1 };
  return { doom2: true, episode: 0, map: Number(name.slice(3)) - 1 };
}

/** The par time for a level in seconds, or null where DOOM shows none (episode 4, MAP33+). */
export function parTime(name) {
  const l = levelOf(name);
  if (l.doom2) return CPARS[l.map] ?? null;
  return PARS[l.episode]?.[l.map + 1] ?? null;
}

/** WI_updateStats and friends: what the intermission shows, tic by tic. */
export class IntermissionState {
  /**
   * @param stats { kills, totalKills, items, totalItems, secrets, totalSecrets, time (tics), par (seconds | null) }
   * @param doom2 DOOM II skips the episode map
   * @param sound called with a sound lump name
   */
  constructor(stats, doom2, sound = () => {}) {
    this.doom2 = doom2;
    this.sound = sound;
    const pct = (n, total) => Math.floor((n * 100) / Math.max(1, total));   // (wbs->max* = 1 if 0)
    this.final = {
      kills: pct(stats.kills, stats.totalKills),
      items: pct(stats.items, stats.totalItems),
      secret: pct(stats.secrets, stats.totalSecrets),
      time: Math.floor(stats.time / TICRATE),
      par: stats.par,
    };
    this.cnt = { kills: -1, items: -1, secret: -1, time: -1, par: -1 };
    this.stage = 'stats';
    this.sp = 1;            // sp_state: odd = pause, 2/4/6 = counting, 8 = time, 10 = all there
    this.pause = TICRATE;
    this.bcnt = 0;
    this.pointer = true;
  }

  /** One tic. accelerate: fire or use was just pressed (WI_checkForAccelerate). */
  tick(accelerate = false) {
    this.bcnt++;
    if (this.stage === 'stats') this.updateStats(accelerate);
    else if (this.stage === 'next') {
      // WI_updateShowNextLoc
      if (!--this.timer || accelerate) this.noState();
      else this.pointer = (this.timer & 31) < 20;
    } else if (this.stage === 'nostate') {
      if (!--this.timer) this.stage = 'done';
    }
  }

  updateStats(accelerate) {
    const f = this.final;
    const c = this.cnt;
    if (accelerate && this.sp !== 10) {
      Object.assign(c, { kills: f.kills, items: f.items, secret: f.secret, time: f.time, par: f.par ?? -1 });
      this.sound('DSBAREXP');
      this.sp = 10;
      return;
    }
    const count = (key, next) => {
      c[key] += 2;                       // (from -1: 1, 3, 5…)
      if (!(this.bcnt & 3)) this.sound('DSPISTOL');
      if (c[key] >= f[key]) {
        c[key] = f[key];
        this.sound('DSBAREXP');
        this.sp = next;
      }
    };
    if (this.sp === 2) count('kills', 3);
    else if (this.sp === 4) count('items', 5);
    else if (this.sp === 6) count('secret', 7);
    else if (this.sp === 8) {
      if (!(this.bcnt & 3)) this.sound('DSPISTOL');
      c.time = Math.min(f.time, c.time + 3);
      c.par = f.par == null ? -1 : Math.min(f.par, c.par + 3);
      if (c.time >= f.time && (f.par == null || c.par >= f.par)) {
        this.sound('DSBAREXP');
        this.sp = 9;
      }
    } else if (this.sp === 10) {
      if (accelerate) {
        this.sound('DSSGCOCK');
        if (this.doom2) this.noState();
        else this.showNextLoc();
      }
    } else if (this.sp & 1) {
      if (!--this.pause) {
        this.sp++;
        this.pause = TICRATE;
      }
    }
  }

  showNextLoc() {
    this.stage = 'next';
    this.timer = SHOWNEXTLOCDELAY * TICRATE;
  }

  noState() {
    this.stage = 'nostate';
    this.pointer = true;
    this.timer = 10;
  }

  get done() { return this.stage === 'done'; }
}

/** The intermission on screen. */
export class Intermission {
  /**
   * @param from   the level just finished (E1M3, MAP07…)
   * @param to     the level next
   * @param stats  as IntermissionState takes, without par
   * @param didSecret DOOM I: this episode's secret level has been done
   */
  constructor(renderer, audio, wad, from, to, stats, didSecret = false) {
    this.renderer = renderer;
    this.wad = wad;
    this.from = levelOf(from);
    this.to = levelOf(to);
    this.didSecret = didSecret;
    this.state = new IntermissionState({ ...stats, par: parTime(from) }, this.from.doom2,
      (snd) => audio.playEvents([[0, snd, 0, null, null]], { x: 0, y: 0, angle: 0 }));
    // the episode map's animations (none on DOOM II or episode 4)
    this.anims = new BackAnims(this.from.doom2 ? -1 : this.from.episode, this.to.map);
    audio.playMusic(this.from.doom2 ? 'D_DM2INT' : 'D_INTER');
  }

  tick(accelerate) {
    const was = this.state.stage;
    this.state.tick(accelerate);
    // WI_initShowNextLoc starts the animations over
    if (was === 'stats' && this.state.stage === 'next') this.anims.reset(this.state.bcnt);
    this.anims.update(this.state.bcnt, this.state.stage === 'stats');
  }

  get done() { return this.state.done; }

  pic(name) { return this.renderer.pictureByName(name); }

  /** a level's name patch: WILVem (DOOM I) or CWILVnn (DOOM II) */
  levelName(l) {
    return l.doom2 ? this.pic(`CWILV${String(l.map).padStart(2, '0')}`) : this.pic(`WILV${l.episode}${l.map}`);
  }

  draw() {
    const r = this.renderer;
    // WI_slamBackground: the episode map (DOOM I, episodes 1–3), else INTERPIC
    const bg = !this.from.doom2 && this.from.episode < 3 ? `WIMAP${this.from.episode}` : 'INTERPIC';
    r.patch(this.pic(bg), 0, 0);
    for (const f of this.anims.frames) r.patch(this.pic(f.lump), f.x, f.y);   // WI_drawAnimatedBack
    if (this.state.stage === 'stats') this.drawStats();
    else this.drawNextLoc();
    r.present();
  }

  centred(pic, y) {
    if (pic) this.renderer.patch(pic, Math.floor((320 - pic.w) / 2), y);
  }

  drawStats() {
    const r = this.renderer;
    const s = this.state;
    // WI_drawLF: "<level>" over "Finished"
    const name = this.levelName(this.from);
    this.centred(name, 2);
    this.centred(this.pic('WIF'), 2 + Math.floor(((name?.h ?? 0) * 5) / 4));
    const lh = Math.floor((3 * (this.pic('WINUM0')?.h ?? 12)) / 2);
    r.patch(this.pic('WIOSTK'), SP_STATSX, SP_STATSY);
    this.percent(320 - SP_STATSX, SP_STATSY, s.cnt.kills);
    r.patch(this.pic('WIOSTI'), SP_STATSX, SP_STATSY + lh);
    this.percent(320 - SP_STATSX, SP_STATSY + lh, s.cnt.items);
    r.patch(this.pic('WISCRT2'), SP_STATSX, SP_STATSY + 2 * lh);
    this.percent(320 - SP_STATSX, SP_STATSY + 2 * lh, s.cnt.secret);
    r.patch(this.pic('WITIME'), SP_TIMEX, SP_TIMEY);
    this.time(160 - SP_TIMEX, SP_TIMEY, s.cnt.time);
    if (s.final.par != null) {
      r.patch(this.pic('WIPAR'), 160 + SP_TIMEX, SP_TIMEY);
      this.time(320 - SP_TIMEX, SP_TIMEY, s.cnt.par);
    }
  }

  drawNextLoc() {
    const r = this.renderer;
    const { from, to } = this;
    if (!from.doom2 && from.episode < 3) {
      // splats on the levels done, "you are here" blinking on the next
      const last = from.map === 8 ? to.map - 1 : from.map;
      for (let i = 0; i <= last; i++) this.onNode(i, ['WISPLAT']);
      if (this.didSecret) this.onNode(8, ['WISPLAT']);
      if (this.state.pointer && to.episode === from.episode) this.onNode(to.map, ['WIURH0', 'WIURH1']);
    }
    // WI_drawEL: "Entering" over "<level>" (not after MAP30: the ending comes next)
    if (!from.doom2 || from.map !== 29) {
      const entering = this.pic('WIENTER');
      this.centred(entering, 2);
      this.centred(this.levelName(to), 2 + Math.floor(((this.levelName(to)?.h ?? 0) * 5) / 4));
    }
  }

  /** WI_drawOnLnode: the first of the pictures that fits on screen at that level's spot. */
  onNode(n, names) {
    const [x, y] = LNODES[this.from.episode][n];
    for (const name of names) {
      const p = this.pic(name);
      if (!p) continue;
      const left = x - p.left;
      const top = y - p.top;
      if (left >= 0 && left + p.w < 320 && top >= 0 && top + p.h < 200) {
        this.renderer.patch(p, x, y);
        return;
      }
    }
  }

  /** WI_drawNum: right-aligned at x; returns the new left edge. */
  num(x, y, n, digits) {
    const font = this.pic('WINUM0');
    if (!font) return x;
    let d = digits;
    if (d < 0) d = n === 0 ? 1 : String(n).length;
    let v = n;
    let cx = x;
    while (d--) {
      cx -= font.w;
      this.renderer.patch(this.pic(`WINUM${v % 10}`), cx, y);
      v = Math.floor(v / 10);
    }
    return cx;
  }

  /** WI_drawPercent: the % sign at x, the number just left of it. */
  percent(x, y, p) {
    if (p < 0) return;
    this.renderer.patch(this.pic('WIPCNT'), x, y);
    this.num(x, y, p, -1);
  }

  /** WI_drawTime: m:ss right-aligned at x, "sucks" past an hour. */
  time(x, y, t) {
    if (t < 0) return;
    const colon = this.pic('WICOLON');
    if (t <= 61 * 59) {
      let div = 1;
      let cx = x;
      do {
        const n = Math.floor(t / div) % 60;
        cx = this.num(cx, y, n, 2) - (colon?.w ?? 0);
        div *= 60;
        if (div === 60 || Math.floor(t / div)) this.renderer.patch(colon, cx, y);
      } while (Math.floor(t / div));
    } else {
      const sucks = this.pic('WISUCKS');
      if (sucks) this.renderer.patch(sucks, x - sucks.w, y);
    }
  }
}
