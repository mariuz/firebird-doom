// menu.js – the title screen and the menus (d_main.c's page loop, m_menu.c).
//
// The game opens on the title loop: TITLEPIC with the title music, then the
// credits page, round and round (DOOM plays demos in between; there are none
// here). A key opens the main menu; Esc opens it during play, and the game
// waits behind it. New Game → episode (DOOM I) → skill, Nightmare asking to
// be sure; Options (end game, messages, detail, mouse sensitivity, sound
// volume); Read This! (DOOM I); Quit, which here goes back to the title.
// Load and Save: six slots in DOOM's bordered boxes; saving asks for a
// description (typed in, as M_SaveSelect does). F6 quicksaves and F9 quickloads
// (M_QuickSave, M_QuickLoad): the first F6 picks the slot. Everything is drawn with the WAD's
// own M_* graphics and HU font; the words in messages are Freedoom's where
// its DEHACKED has them (NIGHTMARE, QUITMSG…), else our own, never id's.

const LINEHEIGHT = 16;
const SKULLXOFF = -32;
const SAVESTRINGSIZE = 24;   // descriptions hold 23 characters
const SLOTS = 6;

/** The menus as m_menu.c lays them out: x, y, title patches, items. */
function menus(doom2, episodes) {
  const item = (lump, act, extra = {}) => ({ lump, act, ...extra });
  const empty = { lump: null, act: null };
  const main = {
    name: 'main', x: 97, y: 64, titles: [['M_DOOM', 94, 2]],
    items: [item('M_NGAME', 'newgame'), item('M_OPTION', 'options'), item('M_LOADG', 'load'), item('M_SAVEG', 'save'),
      ...(doom2 ? [] : [item('M_RDTHIS', 'readthis')]), item('M_QUITG', 'quit')],
  };
  const episode = {
    name: 'episode', x: 48, y: 63, titles: [['M_EPISOD', 54, 38]], prev: 'main',
    items: ['M_EPI1', 'M_EPI2', 'M_EPI3', 'M_EPI4'].slice(0, episodes).map((l, i) => item(l, 'episode', { episode: i + 1 })),
  };
  const skill = {
    name: 'skill', x: 48, y: 63, titles: [['M_NEWG', 96, 14], ['M_SKILL', 54, 38]], prev: doom2 ? 'main' : 'episode', lastOn: 2,
    items: ['M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE'].map((l, i) => item(l, 'skill', { skill: i + 1 })),
  };
  const options = {
    name: 'options', x: 60, y: 37, titles: [['M_OPTTTL', 108, 15]], prev: 'main',
    items: [item('M_ENDGAM', 'endgame'), item('M_MESSG', 'messages', { toggle: true }), item('M_DETAIL', 'detail', { toggle: true }),
      item('M_SCRNSZ', 'screensize', { slider: true }), empty, item('M_MSENS', 'mouse', { slider: true }), empty, item('M_SVOL', 'sound')],
  };
  const sound = {
    name: 'sound', x: 80, y: 64, titles: [['M_SVOL', 60, 38]], prev: 'options',
    items: [item('M_SFXVOL', 'sfx', { slider: true }), empty, item('M_MUSVOL', 'music', { slider: true }), empty],
  };
  const slots = (act) => Array.from({ length: SLOTS }, (_, i) => item('slot', act, { slot: i }));
  const load = { name: 'load', x: 80, y: 54, titles: [['M_LOADG', 72, 28]], prev: 'main', items: slots('loadslot') };
  const save = { name: 'save', x: 80, y: 54, titles: [['M_SAVEG', 72, 28]], prev: 'main', items: slots('saveslot') };
  return { main, episode, skill, options, sound, load, save };
}

export class Menu {
  /**
   * @param o.doom2     DOOM II (no episodes, no Read This!)
   * @param o.episodes  how many episodes the WAD has (DOOM I)
   * @param o.retail    four episodes: Read This! ends on CREDIT, not HELP2
   * @param o.strings   the WAD's DEHACKED strings (Map)
   * @param o.sound     (lump) → play a menu sound
   * @param o.actions   { newGame(episode, skill), endGame(), quit(), save(slot, name), load(slot),
   *                      slots (six descriptions or null), canSave, get/set: messages, detail,
   *                      mouse (0–9), sfx and music (0–15) }
   */
  constructor({ doom2 = false, episodes = 1, retail = false, strings = new Map(), sound = () => {}, actions = {} } = {}) {
    this.doom2 = doom2;
    this.retail = retail;
    this.strings = strings;
    this.sound = sound;
    this.actions = actions;
    this.defs = menus(doom2, episodes);
    for (const m of Object.values(this.defs)) m.lastOn = m.lastOn ?? 0;
    this.active = false;
    this.current = this.defs.main;
    this.on = 0;
    this.message = null;     // { text, yesno, onYes }
    this.editing = null;     // typing a save's description: { slot, text, old }
    this.quickSaveSlot = -1; // quickSaveSlot: -1 none yet, -2 the save menu is picking it
    this.page = null;        // Read This!: the full-screen page showing
    this.chosenEpisode = 1;
    this.skullTics = 8;
    this.whichSkull = 0;
  }

  /** M_StartControlPanel */
  open(silent = false) {
    if (this.active) return;
    this.active = true;
    this.go('main');
    if (!silent) this.sound('DSSWTCHN');
  }

  /** M_ClearMenus */
  close(silent = false) {
    if (!this.active) return;
    this.active = false;
    this.message = null;
    this.page = null;
    this.editing = null;
    if (!silent) this.sound('DSSWTCHX');
  }

  go(name) {
    this.current.lastOn = this.on;
    this.current = this.defs[name];
    this.on = this.current.lastOn;
  }

  /** M_StartMessage: a box of text; yes/no ones wait for Y. It brings the menu
   *  up if it wasn't (messageLastMenuActive), and puts it back down after. */
  say(text, yesno = false, onYes = null) {
    this.message = { text, yesno, onYes, wasActive: this.active };
    this.active = true;
  }

  /** A WAD string with its %s filled in, or our own words. */
  text(name, fallback, arg = '') {
    const s = this.strings.get(name);
    return s ? s.replace('%s', arg) : fallback;
  }

  /** M_QuickSave (F6): in a game only; the first time it opens Save Game to pick
   *  the slot, after that it asks before writing over that slot's save. */
  quickSave() {
    if (this.active) return;
    this.sound('DSSWTCHN');
    if (!this.actions.canSave) { this.sound('DSOOF'); return; }
    if (this.quickSaveSlot < 0) {
      this.open(true);
      this.go('save');
      this.quickSaveSlot = -2;
      return;
    }
    const slot = this.quickSaveSlot;
    const name = this.actions.slots?.[slot]?.name ?? '';
    this.say(this.text('QSPROMPT', `Quicksave over the game\n\n'${name}'?\n\n(press y or n)`, name), true, () => {
      this.actions.save?.(slot, name);
      this.sound('DSSWTCHX');
    });
  }

  /** M_QuickLoad (F9): asks before loading the quicksave slot, if there is one. */
  quickLoad() {
    if (this.active) return;
    this.sound('DSSWTCHN');
    if (this.quickSaveSlot < 0) {
      this.say(this.text('QSAVESPOT', 'No quicksave slot yet:\nF6 picks one.\n\n(press a key)'));
      return;
    }
    const slot = this.quickSaveSlot;
    const name = this.actions.slots?.[slot]?.name ?? '';
    this.say(this.text('QLPROMPT', `Quickload the game\n\n'${name}'?\n\n(press y or n)`, name), true, () => {
      if (this.actions.slots?.[slot]) this.actions.load?.(slot);
    });
  }

  get item() { return this.current.items[this.on]; }

  /** one tic: the skull blinks every 8 */
  tick() {
    if (--this.skullTics <= 0) {
      this.whichSkull ^= 1;
      this.skullTics = 8;
    }
  }

  /** M_Responder. key: KeyboardEvent.key. Returns true when it took the key. */
  key(key) {
    if (!this.active) return false;
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (this.message) {
      const { yesno, onYes, wasActive } = this.message;
      if (yesno && k !== 'y' && k !== 'n' && k !== 'Escape') return true;
      this.message = null;
      if (!wasActive) this.active = false;
      this.sound('DSSWTCHX');
      if (yesno && k === 'y') onYes?.();
      return true;
    }
    if (this.editing) {
      // M_Responder's savegame string entry
      const ed = this.editing;
      if (k === 'Escape') { ed.text = ed.old; this.editing = null; }
      else if (k === 'Backspace') ed.text = ed.text.slice(0, -1);
      else if (k === 'Enter') {
        if (ed.text) {
          // M_DoSave: a save picked by the first F6 becomes the quicksave slot
          if (this.quickSaveSlot === -2) this.quickSaveSlot = ed.slot;
          this.close(true);
          this.actions.save?.(ed.slot, ed.text);
        }
      } else if (key.length === 1) {
        const ch = key.toUpperCase();
        const c = ch.charCodeAt(0);
        if (c >= 32 && c <= 95 && ed.text.length < SAVESTRINGSIZE - 1) ed.text += ch;
      }
      return true;
    }
    if (this.page) {
      // Read This!: HELP1, then HELP2 (or CREDIT on a four-episode WAD), then back
      if (k === 'Escape' || k === 'Backspace') this.page = null;
      else this.page = this.page === 'HELP1' ? (this.retail ? 'CREDIT' : 'HELP2') : null;
      this.sound('DSPISTOL');
      return true;
    }
    const items = this.current.items;
    const step = (d) => {
      do this.on = (this.on + d + items.length) % items.length; while (!items[this.on].act);
      this.sound('DSPSTOP');
    };
    if (k === 'ArrowDown') step(1);
    else if (k === 'ArrowUp') step(-1);
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const it = this.item;
      if (it.slider || it.toggle) {
        this.change(it, k === 'ArrowRight' ? 1 : -1);
        this.sound('DSSTNMOV');
      }
    } else if (k === 'Enter') {
      const it = this.item;
      if (it.slider) {
        this.change(it, 1);
        this.sound('DSSTNMOV');
      } else {
        this.current.lastOn = this.on;
        this.sound('DSPISTOL');
        this.choose(it);
      }
    } else if (k === 'Escape') {
      this.current.lastOn = this.on;
      this.close();
    } else if (k === 'Backspace') {
      if (this.current.prev) {
        this.go(this.current.prev);
        this.sound('DSSWTCHN');
      }
    }
    return true;
  }

  change(it, dir) {
    const a = this.actions;
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    if (it.act === 'messages') a.messages = !a.messages;
    else if (it.act === 'detail') a.detail = a.detail === 'high' ? 'low' : 'high';
    else if (it.act === 'mouse') a.mouse = clamp(a.mouse + dir, 9);
    else if (it.act === 'screensize') a.screenSize = clamp(a.screenSize + dir, 8);   // M_SizeDisplay
    else if (it.act === 'sfx') a.sfx = clamp(a.sfx + dir, 15);
    else if (it.act === 'music') a.music = clamp(a.music + dir, 15);
  }

  choose(it) {
    const a = this.actions;
    switch (it.act) {
      case 'newgame': this.go(this.doom2 ? 'skill' : 'episode'); break;
      case 'episode': this.chosenEpisode = it.episode; this.go('skill'); break;
      case 'skill':
        if (it.skill === 5) {
          this.say(this.strings.get('NIGHTMARE') ?? 'Nightmare: fast monsters that come back.\n\n(press y to confirm)', true,
            () => this.startGame(5));
        } else this.startGame(it.skill);
        break;
      case 'options': this.go('options'); break;
      case 'sound': this.go('sound'); break;
      case 'messages': case 'detail': this.change(it, 1); break;
      case 'endgame':
        this.say('End this game and go back to the title?\n\n(press y or n)', true, () => { this.close(true); a.endGame?.(); });
        break;
      case 'load': this.go('load'); break;
      case 'save':
        if (this.actions.canSave) this.go('save');
        else this.say('You can only save\nduring a game.\n\n(press a key)');
        break;
      case 'loadslot':
        // (an empty slot can't be chosen)
        if (this.actions.slots?.[it.slot]) { this.close(true); this.actions.load?.(it.slot); }
        break;
      case 'saveslot': {
        const old = this.actions.slots?.[it.slot]?.name ?? '';
        this.editing = { slot: it.slot, text: old, old };
        break;
      }
      case 'readthis': this.page = 'HELP1'; break;
      case 'quit': this.say(this.quitMessage(), true, () => { this.close(true); a.quit?.(); }); break;
      default: break;
    }
  }

  startGame(skill) {
    this.close(true);
    this.actions.newGame?.(this.doom2 ? 1 : this.chosenEpisode, skill);
  }

  /** M_QuitDOOM: one of the WAD's quit messages, with a "press y" if it hasn't one */
  quitMessage() {
    const pool = ['QUITMSG', 'QUITMSG1', 'QUITMSG2', 'QUITMSG3', 'QUITMSG4', 'QUITMSG5', 'QUITMSG6', 'QUITMSG7']
      .map((k) => this.strings.get(k)).filter(Boolean);
    const msg = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 'Quit to the title?';
    return /press y/i.test(msg) ? msg : `${msg}\n\n(press y to quit)`;
  }

  /** M_Drawer: over whatever is on the screen already */
  draw(r) {
    const pic = (n) => r.pictureByName(n);
    if (this.page) { r.patch(pic(this.page), 0, 0); return; }
    if (this.message) { this.drawMessage(r, this.message.text); return; }
    const m = this.current;
    for (const [lump, x, y] of m.titles) r.patch(pic(lump), x, y);
    if (m.name === 'load' || m.name === 'save') {
      // M_DrawLoad / M_DrawSave: each slot's border and its description
      m.items.forEach((it, i) => {
        const y = m.y + i * LINEHEIGHT;
        this.border(r, m.x, y);
        const ed = this.editing?.slot === i ? this.editing : null;
        const text = ed ? ed.text : this.actions.slots?.[i]?.name ?? 'empty slot';
        const end = this.write(r, text, m.x, y);
        if (ed) this.write(r, '_', end, y);
      });
    } else m.items.forEach((it, i) => { if (it.lump) r.patch(pic(it.lump), m.x, m.y + i * LINEHEIGHT); });
    const a = this.actions;
    if (m.name === 'options') {
      r.patch(pic(a.messages ? 'M_MSGON' : 'M_MSGOFF'), m.x + 120, m.y + LINEHEIGHT * 1);
      r.patch(pic(a.detail === 'high' ? 'M_GDHIGH' : 'M_GDLOW'), m.x + 175, m.y + LINEHEIGHT * 2);
      this.thermo(r, m.x, m.y + LINEHEIGHT * 4, 9, a.screenSize ?? 7);
      this.thermo(r, m.x, m.y + LINEHEIGHT * 6, 10, a.mouse);
    } else if (m.name === 'sound') {
      this.thermo(r, m.x, m.y + LINEHEIGHT * 1, 16, a.sfx);
      this.thermo(r, m.x, m.y + LINEHEIGHT * 3, 16, a.music);
    }
    r.patch(pic(this.whichSkull ? 'M_SKULL2' : 'M_SKULL1'), m.x + SKULLXOFF, m.y - 5 + this.on * LINEHEIGHT);
  }

  /** M_DrawSaveLoadBorder */
  border(r, x, y) {
    let xx = x;
    r.patch(r.pictureByName('M_LSLEFT'), xx - 8, y + 7);
    for (let i = 0; i < SAVESTRINGSIZE; i++, xx += 8) r.patch(r.pictureByName('M_LSCNTR'), xx, y + 7);
    r.patch(r.pictureByName('M_LSRGHT'), xx, y + 7);
  }

  /** M_WriteText: the HU font, upper case; returns where the text ends */
  write(r, text, x, y) {
    let cx = x;
    for (const ch of text) {
      const c = ch.toUpperCase().charCodeAt(0);
      const g = c >= 33 && c <= 95 ? r.pictureByName(`STCFN${String(c).padStart(3, '0')}`) : null;
      if (g) r.patch(g, cx, y);
      cx += g?.w ?? 4;
    }
    return cx;
  }

  /** M_DrawThermo */
  thermo(r, x, y, width, dot) {
    let xx = x;
    r.patch(r.pictureByName('M_THERML'), xx, y);
    xx += 8;
    for (let i = 0; i < width; i++, xx += 8) r.patch(r.pictureByName('M_THERMM'), xx, y);
    r.patch(r.pictureByName('M_THERMR'), xx, y);
    r.patch(r.pictureByName('M_THERMO'), x + 8 + dot * 8, y);
  }

  /** the message box: each line centred, the block centred on the screen */
  drawMessage(r, text) {
    const glyph = (ch) => {
      const c = ch.toUpperCase().charCodeAt(0);
      return c >= 33 && c <= 95 ? r.pictureByName(`STCFN${String(c).padStart(3, '0')}`) : null;
    };
    const lh = glyph('A')?.h ?? 8;
    const lines = text.split('\n');
    let y = Math.floor(100 - (lines.length * lh) / 2);
    for (const line of lines) {
      const w = [...line].reduce((s, ch) => s + (glyph(ch)?.w ?? 4), 0);
      let x = Math.floor(160 - w / 2);
      for (const ch of line) {
        const g = glyph(ch);
        if (g) r.patch(g, x, y);
        x += g?.w ?? 4;
      }
      y += lh;
    }
  }
}

/** D_DoAdvanceDemo without the demos: the title, then the credits, round again. */
/**
 * D_DoAdvanceDemo: the pages and the demos between them. On a demo page
 * (DEMO1–3, DOOM II's DEMO4; `demo` is its number) the loop waits: the page
 * plays the demo, or none exists, and calls advance() when it's over.
 */
export class TitleLoop {
  constructor(doom2, retail, playMusic = () => {}) {
    this.playMusic = playMusic;
    this.pages = doom2
      ? [['TITLEPIC', 35 * 11, 'D_DM2TTL'], ['DEMO1'], ['CREDIT', 200, null], ['DEMO2'], ['TITLEPIC', 35 * 11, 'D_DM2TTL'], ['DEMO3'], ['DEMO4']]
      : [['TITLEPIC', 170, 'D_INTRO'], ['DEMO1'], ['CREDIT', 200, null], ['DEMO2'], [retail ? 'CREDIT' : 'HELP2', 200, null], ['DEMO3']];
    this.index = -1;
    this.advance();
  }

  advance() {
    this.index = (this.index + 1) % this.pages.length;
    const [page, tics, music] = this.pages[this.index];
    this.page = page;
    this.demo = page.startsWith('DEMO') ? Number(page.slice(4)) : 0;
    this.tics = tics ?? Infinity;
    if (music) this.playMusic(music);
  }

  tick() { if (!this.demo && --this.tics <= 0) this.advance(); }

  draw(r) { if (!this.demo) r.patch(r.pictureByName(this.page), 0, 0); }
}
