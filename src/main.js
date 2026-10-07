// main.js – boot Firebird in a Worker, load the WAD into it, run the loop.
//
// Per frame the browser does exactly two queries:
//   SELECT * FROM doom_tic(...)        – advance the game by N tics
//   SELECT * FROM frame_walls / frame_sprites / frame_sectors – what to draw
// and then rasterises the rows. All game state lives in Firebird tables.

import { FirebirdBrowser } from 'firebird-wasm/browser';
import schemaSql from '../sql/schema.sql';
import gameSql from '../sql/game.sql';
import renderSql from '../sql/render.sql';
import { Wad } from './wad.js';
import { createSchema, loadResources, loadMap, setView, setRenderer } from './loader.js';
import { Renderer } from './renderer.js';
import { drawStatusBar, drawText, drawWeapon } from './hud.js';
import { AM_COLORS, automapColor } from './automap.js';
import { clevMap, idmusMap, makeCheatReader, makeParamCheatReader } from './cheats.js';
import { nextMap } from './progress.js';
import { Finale, parseDehStrings, setFallbackStrings } from './finale.js';
import { Menu, TitleLoop } from './menu.js';
import { Intermission, levelOf } from './intermission.js';
import { THING_TYPES } from './thinginfo.js';
import { DoomAudio, musicLumpFor } from './audio.js';
import { createPresenter } from './present.js';

const $ = (id) => document.getElementById(id);
let canvas = $('screen');   // replaced by a fresh element when the display kind changes
const statusEl = $('status');
const statsEl = $('stats');

const TIC_MS = 1000 / 35;

let db;
let wad;
let res;
let renderer;
let presenter = null; // WebGL (palette shader) or Canvas 2D: present.js
let map = null;      // { name, lines, sides, sectors, skyTex, linedefs }
let hud = null;      // last DOOM_TIC row
let sidesRev = -1;
let running = false;
let paused = false;
let lastTic = 0;
// settings, remembered per browser
const settings = { game: 'freedoom1', detail: 'high', renderer: 'bsp', audio: true, sfx: 70, music: 50, display: 'webgl', smooth: false, skill: 3, messages: true, mouse: 5 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('firebird-doom:settings') || '{}'));
} catch { /* storage unavailable: defaults */ }
const saveSettings = () => {
  try { localStorage.setItem('firebird-doom:settings', JSON.stringify(settings)); } catch { /* ignore */ }
};
const viewWidth = () => (settings.detail === 'high' ? 320 : 160);
let showMap = false;
let finale = null;                  // text screens: DOOM II's (MAP06/11/20, the secret levels, MAP30) and DOOM I's E1M8
let finaleKey = false;              // a key went down: F_CastResponder
let intermission = null;            // the stats screen between levels (wi_stuff.c)
let menu = null;                    // m_menu.c, for this WAD
let title = null;                   // the title loop (before a game, after End Game or Quit)
let menuBackdrop = null;            // the screen as it was when the menu opened over the game
let menuOpenedAt = -1e9;
let lastPalette = 0;
let wiButtons = true;               // fire/use held last tic: only a new press accelerates
const didSecret = new Set();        // DOOM I episodes whose secret level is done (wbs->didsecret)
let amCheating = 0;                 // IDDT: 0, 1 (every line), 2 (…and every thing)
const iddt = makeCheatReader('iddt');
// ST_Responder: IDDQD and IDKFA, typed any time during play
const CHEATS = ['iddqd', 'idkfa', 'idfa', 'idclip', 'idspispopd', 'idchoppers', 'idbehold', 'idmypos']
  .map((code) => [code, makeCheatReader(code)]);
const idbehold = makeParamCheatReader('idbehold', 1);   // …then v, s, i, r, a or l
const idmus = makeParamCheatReader('idmus', 2);
const idclev = makeParamCheatReader('idclev', 2);
const audio = new DoomAudio();
audio.setVolumes(settings.sfx / 100, settings.music / 100);
audio.setEnabled(settings.audio);
let lastSoundId = 0;
// audio may only start after a user gesture
for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => audio.unlock(), { capture: true });
document.addEventListener('visibilitychange', () => audio.suspend(document.hidden));
let lastFrame = { tic: 0, walls: 0, sprites: 0, draw: 0, rows: 0 };

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}

// ── input ────────────────────────────────────────────────────────────────
const keys = new Set();
let mouseTurn = 0;
let fireClick = false;
let weaponSel = 0;
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyE', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Tab', 'Digit1', 'Digit2',
  'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'KeyF', 'Comma', 'Period']);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (!running) return;
  // M_Responder: the menu takes every key while it's open; on the title any
  // key opens it; in play Esc does. (Esc that just freed the mouse already did.)
  if (menu?.active) {
    e.preventDefault();
    if (!(e.key === 'Escape' && performance.now() - menuOpenedAt < 200)) menu.key(e.key);
    return;
  }
  if (title && menu) {
    e.preventDefault();
    openMenu();
    return;
  }
  if (e.key === 'Escape' && menu) {
    e.preventDefault();
    openMenu();
    return;
  }
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (finale) finaleKey = true;
  if (e.code === 'Tab') showMap = !showMap;
  // AM_Responder: the automap listens for IDDT while it's open
  if (showMap && iddt(e.key)) amCheating = (amCheating + 1) % 3;
  for (const [code, read] of CHEATS) {
    if (read(e.key)) db.query(`EXECUTE PROCEDURE cheat('${code}')`).catch((err) => console.error(err));
  }
  const power = idbehold(e.key)?.toLowerCase();
  if (power && 'vsiral'.includes(power)) {
    db.query(`EXECUTE PROCEDURE cheat('idbehold${power}')`).catch((err) => console.error(err));
  }
  // IDMUS xy: S_ChangeMusic to another level's song, if there is such a song
  const song = idmus(e.key);
  if (song && settings.skill !== 5) {   // (ST_Responder: not on Nightmare)
    const mapFor = idmusMap(song, wad.mapNames().some((m) => m.startsWith('MAP')));
    const lump = mapFor && musicLumpFor(mapFor);
    const ok = lump && wad.lump(lump);
    if (ok) audio.playMusic(lump);
    db.query(`UPDATE player SET msg = '${ok ? 'Music Change' : 'IMPOSSIBLE SELECTION'}', msg_tics = 70 WHERE id = 1`)
      .catch((err) => console.error(err));
  }
  // IDCLEV xy: G_DeferedInitNew – a new game on that map, if this WAD has it
  const digits = idclev(e.key);
  const warp = digits && clevMap(digits, wad.mapNames());
  if (warp) {
    $('map').value = warp;
    startMap(warp, true).catch((err) => setStatus(err.message, true));
  }
  if (e.code.startsWith('Digit')) weaponSel = Number(e.code.slice(5));
  if (e.code === 'KeyP' || e.code === 'Pause') paused = !paused;
  if (e.code === 'KeyM') setAudio(!settings.audio);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
function bindCanvas(c) {
  c.addEventListener('click', () => {
    // (some embedded browsers refuse pointer lock; the keyboard still works)
    if (running && document.pointerLockElement !== c) c.requestPointerLock?.()?.catch?.(() => {});
  });
  c.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement === c && e.button === 0) fireClick = true;
  });
  c.addEventListener('touchstart', touchStart, { passive: false });
  c.addEventListener('touchmove', touchMove, { passive: false });
  c.addEventListener('touchend', touchEnd, { passive: false });
}
window.addEventListener('mouseup', () => { fireClick = false; });
// letting go of the mouse in play (Esc, or switching away) brings up the menu, as Esc would
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && running && menu && !menu.active && !title) {
    openMenu();
    menuOpenedAt = performance.now();
  }
});

/** M_StartControlPanel: the menu over a frozen picture of the game */
function openMenu() {
  if (!menu || menu.active) return;
  menuBackdrop = renderer.sfb.slice();
  keys.clear();
  menu.open();
}

/** D_StartTitle: back to the title loop (End Game, Quit, and at boot) */
function goTitle() {
  finale = null;
  intermission = null;
  menu?.close(true);
  const maps = wad.mapNames();
  title = new TitleLoop(maps.some((m) => m.startsWith('MAP')), !!wad.lump('E4M1'), (m) => audio.playMusic(m));
}

/** This WAD's menu, its options wired to the settings */
function makeMenu() {
  const maps = wad.mapNames();
  const doom2 = maps.some((m) => m.startsWith('MAP'));
  const deh = wad.lump('DEHACKED');
  const strings = deh ? parseDehStrings(new TextDecoder('latin1').decode(wad.data(deh))) : new Map();
  const quitSounds = ['DSPLDETH', 'DSDMPAIN', 'DSPOPAIN', 'DSSLOP', 'DSTELEPT', 'DSPOSIT1', 'DSPOSIT3', 'DSSGTATK'];
  const play = (lump) => audio.playEvents([[0, lump, 'menu', null, null]], { x: 0, y: 0, angle: 0 });
  menu = new Menu({
    doom2,
    episodes: [1, 2, 3, 4].filter((e) => maps.includes(`E${e}M1`)).length || 1,
    retail: !!wad.lump('E4M1'),
    strings,
    sound: play,
    actions: {
      newGame(episode, skill) {
        settings.skill = skill;
        saveSettings();
        $('skill').value = String(skill);
        const first = doom2 ? (maps.includes('MAP01') ? 'MAP01' : maps[0]) : `E${episode}M1`;
        $('map').value = first;
        startMap(first, true).catch((err) => setStatus(err.message, true));
      },
      endGame: () => goTitle(),
      quit() {
        play(quitSounds[Math.floor(Math.random() * quitSounds.length)]);
        goTitle();
      },
      get messages() { return settings.messages; },
      set messages(v) { settings.messages = v; saveSettings(); },
      get detail() { return settings.detail; },
      set detail(v) { $('detail').value = v; $('detail').dispatchEvent(new Event('change')); },
      get mouse() { return settings.mouse; },
      set mouse(v) { settings.mouse = v; saveSettings(); },
      // the 0–15 thermometers on the 0–100 sliders
      get sfx() { return Math.round((settings.sfx * 15) / 100); },
      set sfx(v) { $('sfxvol').value = Math.round((v * 100) / 15); $('sfxvol').dispatchEvent(new Event('input')); },
      get music() { return Math.round((settings.music * 15) / 100); },
      set music(v) { $('musicvol').value = Math.round((v * 100) / 15); $('musicvol').dispatchEvent(new Event('input')); },
    },
  });
}
window.addEventListener('mousemove', (e) => {
  // (mouse sensitivity 0–9 from the Options menu; 5 is the old fixed rate)
  if (document.pointerLockElement === canvas) mouseTurn -= e.movementX * 0.0035 * ((settings.mouse + 1) / 6);
});

// Touch: left half moves, right half turns, tap on the right fires.
const touch = { move: null, look: null };
function touchStart(e) {
  for (const t of e.changedTouches) {
    const r = canvas.getBoundingClientRect();
    const left = t.clientX - r.left < r.width / 2;
    const rec = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0, t: performance.now() };
    if (left) touch.move = rec; else touch.look = rec;
  }
  e.preventDefault();
}
function touchMove(e) {
  for (const t of e.changedTouches) {
    for (const k of ['move', 'look']) {
      const rec = touch[k];
      if (rec && rec.id === t.identifier) {
        if (k === 'look') mouseTurn -= (t.clientX - rec.x - rec.dx) * 0.01;
        rec.dx = t.clientX - rec.x;
        rec.dy = t.clientY - rec.y;
      }
    }
  }
  e.preventDefault();
}
function touchEnd(e) {
  for (const t of e.changedTouches) {
    for (const k of ['move', 'look']) {
      const rec = touch[k];
      if (rec && rec.id === t.identifier) {
        if (k === 'look' && Math.abs(rec.dx) < 10 && performance.now() - rec.t < 250) fireClick = 'tap';
        if (k === 'move' && Math.abs(rec.dx) < 10 && Math.abs(rec.dy) < 10 && performance.now() - rec.t < 250) keys.add('TapUse');
        touch[k] = null;
      }
    }
  }
}
bindCanvas(canvas);

/**
 * Put the chosen presenter on a fresh canvas (a canvas keeps whichever kind of
 * context it gave out first). WebGL that can't be had falls back to 2D.
 */
function applyDisplay() {
  const fresh = () => {
    const c = canvas.cloneNode(false);
    canvas.replaceWith(c);
    canvas = c;
    bindCanvas(c);
    return c;
  };
  presenter = createPresenter(fresh(), settings.display);
  if (!presenter && settings.display !== '2d') presenter = createPresenter(fresh(), '2d');
  presenter?.setSmooth(settings.smooth);
  renderer?.attach(presenter);
  $('display-kind').textContent = presenter?.kind === 'webgl' ? 'WebGL' : presenter ? 'Canvas 2D' : 'none';
}

function readInput(tics) {
  const k = (c) => keys.has(c);
  let fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
  let side = (k('KeyD') || k('Period') ? 1 : 0) - (k('KeyA') || k('Comma') ? 1 : 0);
  const turnKeys = (k('ArrowLeft') ? 1 : 0) - (k('ArrowRight') ? 1 : 0);
  const run = k('ShiftLeft') || k('ShiftRight') ? 1 : 0;
  if (touch.move) {
    fwd = Math.max(-1, Math.min(1, -touch.move.dy / 40));
    side = Math.max(-1, Math.min(1, touch.move.dx / 40));
  }
  // angleturn 640/1280 per tic in DOOM ≈ 0.061 / 0.123 rad
  const turn = turnKeys * (run ? 0.123 : 0.07) * tics + mouseTurn;
  mouseTurn = 0;
  const fire = k('ControlLeft') || k('ControlRight') || k('KeyF') || fireClick ? 1 : 0;
  if (fireClick === 'tap') fireClick = false;
  const use = k('Space') || k('KeyE') || k('TapUse') ? 1 : 0;
  keys.delete('TapUse');
  const w = weaponSel;
  weaponSel = 0;
  return [tics, fwd, side, turn, fire, use, w, run];
}

// ── maps ─────────────────────────────────────────────────────────────────
function skyFor(name) {
  const m = /^E(\d)M/.exec(name);
  const n = m ? Math.min(4, Number(m[1])) : Number(name.slice(3)) < 12 ? 1 : Number(name.slice(3)) < 21 ? 2 : 3;
  return res.texId.get(`SKY${n}`) ?? res.texId.get('SKY1') ?? 0;
}

async function loadSides() {
  const { rows } = await db.query('SELECT id, xoff, yoff, upper_tex, lower_tex, mid_tex, sector_id FROM sidedefs', [], { rowMode: 'array' });
  map.sides = new Map(rows.map((r) => [r[0], { xoff: r[1], yoff: r[2], upper: r[3], lower: r[4], mid: r[5], sector: r[6] }]));
}

async function startMap(name, newGame) {
  running = false;
  finale = null;
  intermission = null;
  title = null;
  menu?.close(true);
  if (newGame) didSecret.clear();
  setStatus(`Loading ${name} into Firebird…`);
  const t0 = performance.now();
  await loadMap(db, wad, res, name, { skill: settings.skill, newGame });
  map = { name, skyTex: skyFor(name) };
  const { rows } = await db.query(
    'SELECT id, front_side, back_side, flags, light_delta, x1, y1, x2, y2, front_sector, back_sector, special FROM linedefs',
    [], { rowMode: 'array' });
  map.lines = new Map(rows.map((r) => [r[0], { fs: r[1], bs: r[2], flags: r[3], lightDelta: r[4] }]));
  map.linedefs = rows;
  map.seen = new Set();   // ML_MAPPED: every line the renderer has drawn on this level
  await loadSides();
  sidesRev = -1;
  console.log(`[firebird-doom] ${name} loaded in ${(performance.now() - t0).toFixed(0)} ms`);
  setStatus('');
  $('mapname').textContent = name;
  audio.playMusic(musicLumpFor(name));
  lastTic = performance.now();
  running = true;
}

// ── the loop ─────────────────────────────────────────────────────────────
// requestAnimationFrame, with a timer as backstop: rAF stalls in occluded
// panes and iframes even while the page counts as visible.
function nextFrame() {
  let done = false;
  const go = () => {
    if (!done) {
      done = true;
      frame();
    }
  };
  requestAnimationFrame(go);
  setTimeout(go, 50);
}

async function frame() {
  if (!running || document.hidden || (paused && !menu?.active)) {
    lastTic = performance.now();
    nextFrame();
    return;
  }
  try {
    const now = performance.now();
    const tics = Math.max(1, Math.min(6, Math.round((now - lastTic) / TIC_MS)));
    lastTic += tics * TIC_MS;
    if (now - lastTic > 200) lastTic = now;

    if (title || menu?.active) {
      // the title loop, or the menu over a frozen game (single player waits)
      for (let i = 0; i < tics; i++) { title?.tick(); menu?.tick(); }
      if (title) title.draw(renderer);
      else if (menuBackdrop) renderer.sfb.set(menuBackdrop);
      if (menu?.active) menu.draw(renderer);
      renderer.present(title ? 0 : lastPalette);
      nextFrame();
      return;
    }

    if (intermission) {
      // WI_Ticker: a new press of fire or use hurries it along
      const input = readInput(tics);
      const buttons = input[4] === 1 || input[5] === 1;
      for (let i = 0; i < tics; i++) intermission.tick(i === 0 && buttons && !wiButtons);
      wiButtons = buttons;
      if (intermission.done) {
        // G_WorldDone: a text screen if this exit has one, else the next map
        const { secret, fromName } = intermission;
        intermission = null;
        if (Finale.available(wad, fromName, secret)) {
          finale = new Finale(renderer, audio, wad, THING_TYPES, fromName, secret);
          finaleKey = false;
        } else {
          await startMap(nextMap(fromName, secret, wad.mapNames()), false);
        }
      } else intermission.draw();
      nextFrame();
      return;
    }

    if (finale) {
      // the ending runs on its own clock: a key kills the one on stage (the
      // key that skips the text is spent before the cast starts), fire or
      // use held skips the text
      const input = readInput(tics);
      if (finaleKey) { finale.press(); finaleKey = false; }
      for (let i = 0; i < tics; i++) finale.tick(input[4] === 1 || input[5] === 1);
      if (finale.done) {
        // G_WorldDone after a text screen: on to the next map (MAP31/32 after a
        // secret exit's; the next episode after E1M8's), inventory kept
        await startMap(nextMap(finale.from, finale.secret, wad.mapNames()), false);
        nextFrame();
        return;
      }
      finale.draw();
      nextFrame();
      return;
    }

    let t = performance.now();
    hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', readInput(tics), { rowMode: 'object' })).rows[0];
    lastFrame.tic = performance.now() - t;

    if (hud.EXIT_KIND) {
      const kind = hud.EXIT_KIND;
      const secret = kind === 2;
      if (kind === 3) await startMap(map.name, true);
      else {
        await db.exec('UPDATE game SET exit_kind = 0 WHERE id = 1');
        const level = levelOf(map.name);
        if (!level.doom2 && level.map === 7 && Finale.available(wad, map.name, secret)) {
          // G_DoCompleted: DOOM I's E?M8 goes straight to the ending, no stats
          finale = new Finale(renderer, audio, wad, THING_TYPES, map.name, secret);
          finaleKey = false;
        } else {
          // WI_Start: kills, items, secrets, time and par; then G_WorldDone
          if (!level.doom2 && level.map === 8) didSecret.add(level.episode);   // E?M9 done
          intermission = new Intermission(renderer, audio, wad, map.name, nextMap(map.name, secret, wad.mapNames()), {
            kills: hud.KILLS, totalKills: hud.TOTAL_KILLS, items: hud.ITEMS, totalItems: hud.TOTAL_ITEMS,
            secrets: hud.SECRETS, totalSecrets: hud.TOTAL_SECRETS, time: hud.TIC,
          }, didSecret.has(level.episode));
          intermission.secret = secret;
          wiButtons = true;   // (the button that pulled the switch doesn't count)
        }
      }
      nextFrame();
      return;
    }
    if (hud.SIDES_REV !== sidesRev) {
      if (sidesRev !== -1) await loadSides();
      sidesRev = hud.SIDES_REV;
    }

    // queued together so the Worker never sits idle between them
    t = performance.now();
    const arr = { rowMode: 'array' };
    const q = (sql) => db.query(sql, [], arr).then((r) => {
      const ms = performance.now() - t;
      t = performance.now();
      return [r.rows, ms];
    });
    const [[walls, wallMs], [sectors], [sprites, spriteMs], [sounds]] = await Promise.all([
      q('SELECT * FROM frame_walls'), q('SELECT * FROM frame_sectors'), q('SELECT * FROM frame_sprites'),
      q(`SELECT id, sound, origin, x, y FROM sound_events WHERE id > ${lastSoundId} ORDER BY id`),
    ]);
    if (sounds.length) {
      lastSoundId = sounds[sounds.length - 1][0];
      audio.playEvents(sounds, { x: hud.PX, y: hud.PY, angle: hud.PANGLE });
    }
    for (const r of walls) map.seen.add(r[3]);
    // AM_drawThings (IDDT twice): where everything is
    map.amThings = showMap && amCheating === 2
      ? (await db.query("SELECT x, y, angle FROM things WHERE kind NOT IN ('player', 'marker')", [], arr)).rows
      : null;
    lastFrame.walls = wallMs;
    lastFrame.sprites = spriteMs;
    lastFrame.rows = walls.length;

    t = performance.now();
    map.sectors = new Map(sectors.map((r) => [r[0], { floor: r[1], ceil: r[2], floorFlat: r[3], ceilFlat: r[4], light: r[5], sky: r[6] === 1 }]));
    // P_PlayerThink's fixedcolormap: invulnerable, the inverse greys (32);
    // with the goggles, nearly full bright (1) – both flicker off in the last four seconds
    const blink = (n) => n > 4 * 32 || (n & 8);
    const fixedColormap = blink(hud.INVULN_TICS) ? 32 : blink(hud.INFRA_TICS) ? 1 : null;
    // ST_doPaletteStuff: pain red (berserk's red, fading over 768 tics, counts
    // as pain), else pickup gold, else the radiation suit's green (13)
    const red = Math.max(hud.DAMAGE_COUNT, hud.STRENGTH_TICS ? 12 - (hud.STRENGTH_TICS >> 6) : 0);
    const palette = red > 0 ? Math.min(8, (red + 7) >> 3)
      : hud.BONUS_COUNT ? Math.min(12, 8 + ((hud.BONUS_COUNT + 7) >> 3))
        : blink(hud.IRON_TICS) ? 13 : 0;
    renderer.drawView({ x: hud.PX, y: hud.PY, z: hud.VIEW_Z, angle: hud.PANGLE, tic: hud.TIC, palette, fixedColormap },
      walls, sprites, map);
    renderer.composeView();
    if (!hud.DEAD) drawWeapon(renderer, hud);
    if (showMap) drawAutomap();
    drawStatusBar(renderer, hud);
    if (hud.MSG && settings.messages) drawText(renderer, hud.MSG, 2, 2);
    if (paused) drawText(renderer, 'PAUSED', 136, 80);
    lastPalette = palette;
    renderer.present(palette);
    lastFrame.draw = performance.now() - t;
    updateStats();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
    running = false;
    return;
  }
  nextFrame();
}


let fpsT = performance.now();
let fpsN = 0;
let fps = 0;
function updateStats() {
  fpsN++;
  const now = performance.now();
  if (now - fpsT > 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
  statsEl.textContent =
    `${fps.toFixed(1)} fps · ${settings.renderer === 'bsp' ? 'BSP' : 'brute'} · doom_tic ${lastFrame.tic.toFixed(0)} ms · frame_walls ${lastFrame.walls.toFixed(0)} ms ` +
    `(${lastFrame.rows} slices, ${renderer.visplaneCount ?? 0} visplanes) · frame_sprites ${lastFrame.sprites.toFixed(0)} ms · raster ${lastFrame.draw.toFixed(0)} ms` +
    ` · ${presenter?.kind === 'webgl' ? 'WebGL' : '2D'}${settings.smooth ? ' smooth' : ''}`;
}

function drawAutomap() {
  // AM_Drawer, into the 320×200 screen in palette colours; the view behind
  // stays faintly visible, darkened through COLORMAP 24
  const sc = 0.12;
  const cx = 160;
  const cy = 84;
  renderer.dim(24);
  const tx = (x) => cx + (x - hud.PX) * sc;
  const ty = (y) => cy - (y - hud.PY) * sc;
  for (const r of map.linedefs) {
    const [id, , bs, flags, , x1, y1, x2, y2, fsec, bsec, special] = r;
    const f = map.sectors.get(fsec);
    const b = bs == null || bsec == null ? null : map.sectors.get(bsec);
    const color = automapColor({ flags, special }, f, b, map.seen.has(id), hud.ALLMAP === 1, amCheating);
    if (color == null) continue;
    renderer.line(tx(x1), ty(y1), tx(x2), ty(y2), color);
  }
  // a little triangle: the arrow for you, thintriangle_guy for things
  const tri = (px, py, ang, tip, back, color) => {
    const p = [[ang, tip], [ang + 2.5, back], [ang - 2.5, back]].map(([d, r]) => [px + Math.cos(d) * r, py - Math.sin(d) * r]);
    renderer.line(p[0][0], p[0][1], p[1][0], p[1][1], color);
    renderer.line(p[1][0], p[1][1], p[2][0], p[2][1], color);
    renderer.line(p[2][0], p[2][1], p[0][0], p[0][1], color);
  };
  if (map.amThings) {
    for (const [x, y, ang] of map.amThings) {
      const px = tx(x);
      const py = ty(y);
      if (px < -4 || px > 324 || py < -4 || py > 172) continue;
      tri(px, py, ang, 3, 2.5, AM_COLORS.thing);
    }
  }
  tri(cx, cy, hud.PANGLE, 6, 5, AM_COLORS.player);
}

// ── SQL console ─────────────────────────────────────────────────────────
async function runConsole() {
  const sqlText = $('sql').value.trim();
  if (!sqlText || !db) return;
  const out = $('sql-out');
  const t0 = performance.now();
  try {
    const r = /^\s*(select|with|execute\s+block)/i.test(sqlText)
      ? await db.query(sqlText, [], { rowMode: 'object' })
      : { rows: [], fields: [], exec: await db.exec(sqlText) };
    const ms = (performance.now() - t0).toFixed(1);
    if (!r.rows.length) {
      out.textContent = `OK (${ms} ms)`;
      return;
    }
    const cols = Object.keys(r.rows[0]);
    const lines = [cols.join('\t'), ...r.rows.slice(0, 200).map((row) => cols.map((c) => fmt(row[c])).join('\t'))];
    out.textContent = `${r.rows.length} row(s), ${ms} ms\n${lines.join('\n')}`;
  } catch (err) {
    out.textContent = err.message;
  }
}
const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));

$('run-sql').addEventListener('click', runConsole);
$('sql').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runConsole();
});
for (const b of document.querySelectorAll('[data-sql]')) {
  b.addEventListener('click', () => {
    $('sql').value = b.dataset.sql;
    runConsole();
  });
}

// ── boot ────────────────────────────────────────────────────────────────
async function openDatabase() {
  if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator &&
      Number(sessionStorage.getItem('firebird-doom:coi-reloads') || '0') < 2) {
    // coi-serviceworker.js is about to reload the page with COOP/COEP in place
    setStatus('Enabling cross-origin isolation for Firebird WASM (one-time reload)…');
    return new Promise(() => {});
  }
  if (!window.crossOriginIsolated) {
    throw new Error('This page is not cross-origin isolated, so Firebird WASM cannot start. ' +
      'Reload once (the service worker enables it), and use HTTPS or localhost.');
  }
  setStatus('Starting Firebird 6 (WebAssembly)…');
  const instance = new FirebirdBrowser('memory://doom', {
    worker: new Worker(new URL('./firebird-engine-worker.js', import.meta.url)),
    multiTab: 'allow-unsafe',
    autoPersist: false,
  });
  const v = await instance.query("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database");
  $('engine').textContent = `Firebird ${v.rows[0].V}`;
  setStatus('Creating the DOOM schema…');
  await createSchema(instance, { schema: schemaSql, game: gameSql, render: renderSql });
  return instance;
}

async function useWad(buffer, label) {
  running = false;
  wad = new Wad(buffer);
  const maps = wad.mapNames();
  if (!maps.length) throw new Error(`${label} has no maps`);
  setStatus(`Copying ${label} resources into Firebird…`);
  res = await loadResources(db, wad, { width: viewWidth(), height: 168 });
  await setRenderer(db, settings.renderer === 'bsp');
  renderer = new Renderer(wad, res);
  renderer.attach(presenter);
  audio.setWad(wad);
  makeMenu();
  renderer.setSize(viewWidth(), 168);
  const sel = $('map');
  sel.innerHTML = maps.map((m) => `<option>${m}</option>`).join('');
  $('wadname').textContent = label;
  await startMap(maps[0], true);
}

/** Fetch one of the bundled Freedoom IWADs and load it into Firebird. */
async function loadGame(game) {
  const file = game === 'freedoom2' ? 'freedoom2.wad' : 'freedoom1.wad';
  setStatus(`Downloading ${file}…`);
  const resp = await fetch(new URL(`./wads/${file}`, location.href));
  if (!resp.ok) throw new Error(`could not fetch ${file} (${resp.status}); pick a WAD file instead`);
  await useWad(await resp.arrayBuffer(), file);
}

async function boot() {
  try {
    db = await openDatabase();
    // DOOM II's story text for WADs without it (id's doom2.wad): Freedoom's, built at deploy
    fetch(new URL('./wads/freedoom-strings.json', location.href))
      .then((r) => (r.ok ? r.json() : null)).then((d) => d && setFallbackStrings(d)).catch(() => {});
    // for the devtools console: await doom.sql('SELECT * FROM player')
    window.doom = {
      db, audio, sql: (q, p) => db.query(q, p).then((r) => r.rows),
      get renderer() { return renderer; }, get presenter() { return presenter; },
      // previews for testing a WAD's screens without playing to them (try id's
      // doom.wad: doom.finale('E3M8') is the bunny); afterwards the game goes on
      // to the map after the one named, as if you'd just finished it
      get menu() { return menu; },
      get title() { return title; },
      finale(name, secret = false) {
        if (!Finale.available(wad, name, secret)) return `no screen after ${name}${secret ? "'s secret exit" : ''} in this WAD`;
        intermission = null;
        title = null;
        menu?.close(true);
        finale = new Finale(renderer, audio, wad, THING_TYPES, name, secret);
        finaleKey = false;
        return `showing the screen after ${name}`;
      },
      intermission(from, to = nextMap(from, false, wad.mapNames()), stats = {}) {
        finale = null;
        title = null;
        menu?.close(true);
        intermission = new Intermission(renderer, audio, wad, from, to, {
          kills: 17, totalKills: 20, items: 30, totalItems: 37, secrets: 2, totalSecrets: 3, time: 95 * 35, ...stats,
        }, didSecret.has(levelOf(from).episode));
        intermission.secret = false;
        wiButtons = true;
        return `showing the intermission ${from} → ${to}`;
      },
    };
    await loadGame(settings.game);
    goTitle();   // DOOM starts on its title screen; a key brings up the menu
    nextFrame();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

$('wadfile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !db) return;
  try {
    await useWad(await f.arrayBuffer(), f.name);
  } catch (err) {
    setStatus(err.message, true);
  }
});
$('game').value = settings.game;
$('game').addEventListener('change', async (e) => {
  settings.game = e.target.value;
  saveSettings();
  if (!db) return;
  try {
    await loadGame(settings.game);
  } catch (err) {
    setStatus(err.message, true);
  }
});
$('map').addEventListener('change', (e) => startMap(e.target.value, true).catch((err) => setStatus(err.message, true)));
$('detail').value = settings.detail;
$('renderer').value = settings.renderer;
function setAudio(on) {
  settings.audio = on;
  saveSettings();
  $('audio').checked = on;
  $('sfxvol').disabled = !on;
  $('musicvol').disabled = !on;
  audio.setEnabled(on);
}
$('audio').checked = settings.audio;
$('sfxvol').disabled = !settings.audio;
$('musicvol').disabled = !settings.audio;
$('audio').addEventListener('change', (e) => setAudio(e.target.checked));
$('sfxvol').value = settings.sfx;
$('musicvol').value = settings.music;
for (const id of ['sfxvol', 'musicvol']) {
  $(id).addEventListener('input', () => {
    settings.sfx = Number($('sfxvol').value);
    settings.music = Number($('musicvol').value);
    saveSettings();
    audio.unlock();
    audio.setVolumes(settings.sfx / 100, settings.music / 100);
  });
}
$('renderer').addEventListener('change', async (e) => {
  settings.renderer = e.target.value;
  saveSettings();
  if (db) await setRenderer(db, settings.renderer === 'bsp');
});
// the skill: a new game on the current map, as DOOM's New Game menu would
$('skill').value = String(settings.skill);
$('skill').addEventListener('change', (e) => {
  settings.skill = Number(e.target.value);
  saveSettings();
  if (db && map) startMap(map.name, true).catch((err) => setStatus(err.message, true));
});
$('display').value = settings.display;
$('smooth').checked = settings.smooth;
$('display').addEventListener('change', (e) => {
  settings.display = e.target.value;
  saveSettings();
  applyDisplay();
});
$('smooth').addEventListener('change', (e) => {
  settings.smooth = e.target.checked;
  saveSettings();
  presenter?.setSmooth(settings.smooth);
});
applyDisplay();
$('detail').addEventListener('change', async (e) => {
  settings.detail = e.target.value;
  saveSettings();
  await setView(db, viewWidth(), 168);
  renderer.setSize(viewWidth(), 168);
});

boot();
