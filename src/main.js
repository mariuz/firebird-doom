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
import { Renderer, viewGeometry } from './renderer.js';
import { drawStatusBar, FaceWidget, drawText, drawWeapon, extraLight } from './hud.js';
import { AM_COLORS, AM_STRINGS, AutomapView, GRID_COLOR, automapColor } from './automap.js';
import { cheatReaders, clevMap, idmusMap } from './cheats.js';
import { nextMap } from './progress.js';
import { Finale, parseDehStrings, setFallbackStrings } from './finale.js';
import { Menu, TitleLoop } from './menu.js';
import { captureGame, restoreGame, saveStore, exportSaves, importSaves, rememberFiles, recallFiles, SLOTS } from './savegame.js';
import { DemoPlayer, DemoRecorder, demoProblem, attractDemoFile, ATTRACT_DEMOS } from './demo.js';
import { Intermission, levelOf, setParOverrides } from './intermission.js';
import { THING_TYPES } from './thinginfo.js';
import { DoomAudio, musicLumpFor } from './audio.js';
import { createPresenter } from './present.js';
import { Melt } from './wipe.js';
import { Lockstep, createInvite, acceptInvite, MAX_PLAYERS } from './net.js';

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
const settings = { game: 'freedoom1', detail: 'high', renderer: 'bsp', audio: true, sfx: 70, music: 50, synth: 'opl2', display: 'webgl', smooth: false, skill: 3, messages: true, mouse: 5, screenSize: 10, gamma: 0 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('firebird-doom:settings') || '{}'));
} catch { /* storage unavailable: defaults */ }
const saveSettings = () => {
  try { localStorage.setItem('firebird-doom:settings', JSON.stringify(settings)); } catch { /* ignore */ }
};
// R_SetViewSize: the menu's Screen Size (screenblocks 3–11) and the detail
const view = () => viewGeometry(settings.screenSize, settings.detail);
async function applyView() {
  const g = view();
  await setView(db, g.w, g.h, g.scaledW / 2);
  renderer?.setSize(g.w, g.h, g);
}
let showMap = false;
let face = new FaceWidget();         // the status bar face (ST_updateFaceWidget), its own state
let lastFire = false;               // the attack button, as the face sees it (player->attackdown)
let amView = null;                  // the automap's window: zoom, follow, grid, marks (AutomapView)
let amMsg = null;                   // the page's own messages ({ text, tics }: the automap's, F5/F8/F11's), shown like the game's but kept out of Firebird
let finale = null;                  // text screens: DOOM II's (MAP06/11/20, the secret levels, MAP30) and DOOM I's E1M8
let finaleKey = false;              // a key went down: F_CastResponder
let intermission = null;            // the stats screen between levels (wi_stuff.c)
let menu = null;                    // m_menu.c, for this WAD
let title = null;                   // the title loop (before a game, after End Game or Quit)
let menuBackdrop = null;            // the screen as it was when the menu opened over the game
let menuOpenedAt = -1e9;
let lastPalette = 0;
// D_Display's wipe: the screen melts (f_wipe.c) when the state changes, and on every level load
let levelSerial = 0;                 // (G_DoLoadLevel's wipegamestate = -1: a new level always melts)
let shownState = null;               // what the last screen presented showed
let shownScreen = null;              // …and that screen (wipe_StartScreen)
let melt = null;
let meltPalette = 0;
const meltBuf = new Uint8Array(320 * 200);
const screenState = () => (title && !attract ? 'title' : intermission ? 'intermission' : finale ? 'finale' : `level ${levelSerial}`);
const saves = saveStore();          // IndexedDB: six slots per WAD
let wadKey = '';                    // which WAD the saves belong to
let saveSlots = Array(SLOTS).fill(null);   // the slots' descriptions, for the menu
let recorder = null;                // a demo being recorded (demo.js)
let demoPlayer = null;              // …or played back
let lastDemo = null;                // the last one recorded or loaded, for Play and Download
let attract = 0;                    // the title loop's demo playing now (D_DoAdvanceDemo's DEMOn), 0 outside it
let attractDemos = new Map();       // this WAD's bundled demos, by number
let lastSeed = null;                // the seed the current map started from
let wiButtons = true;               // fire/use held last tic: only a new press accelerates
const didSecret = new Set();        // DOOM I episodes whose secret level is done (wbs->didsecret)
let amCheating = 0;                 // IDDT: 0, 1 (every line), 2 (…and every thing)
// ST_Responder's cheats, typed any time during play (respelt by a DeHackEd patch: cheatReaders)
let cheats = cheatReaders();
const audio = new DoomAudio();
audio.setVolumes(settings.sfx / 100, settings.music / 100);
audio.setOpl3(settings.synth === 'opl3');
audio.setEnabled(settings.audio);
let lastSoundId = 0;
// audio may only start after a user gesture
for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => audio.unlock(), { capture: true });
document.addEventListener('visibilitychange', () => audio.suspend(document.hidden));
let lastFrame = { tic: 0, walls: 0, sprites: 0, draw: 0, rows: 0 };
// a netgame (net.js): { me, players, deathmatch, timer, ls: Lockstep, links: Map(player → link) }; null alone
let net = null;
// before it starts: the host's links so far and its open invite, or the guest's link
const lobby = { role: null, links: [], invite: null, guest: null };
let netWait = 0;                     // since when the netgame has been waiting for a tic

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
  // M_Responder's function keys, with the menu down
  if (/^F([1-9]|1[01])$/.test(e.key) && menu) {
    e.preventDefault();
    if (e.key === 'F5') { pageSay(menu.toggleDetail()); return; }
    if (e.key === 'F8') { pageSay(menu.toggleMessages(), true); return; }
    if (e.key === 'F11') { setGamma((settings.gamma + 1) % 5, true); return; }
    if ((e.key === 'F6' || e.key === 'F9') && (demoPlayer || net)) return;
    menuBackdrop = renderer.sfb.slice();
    keys.clear();
    ({ F1: () => menu.openReadThis(), F2: () => menu.openSave(), F3: () => menu.openLoad(), F4: () => menu.openSound(),
      F6: () => menu.quickSave(), F7: () => menu.endGame(), F9: () => menu.quickLoad(), F10: () => menu.quit() })[e.key]?.();
    return;
  }
  if (title && menu) {
    e.preventDefault();
    openMenu();
    return;
  }
  if (e.key === 'Escape' && demoPlayer) {
    e.preventDefault();
    endPlayback('stopped');
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
  // M_Responder: - and = shrink and grow the view (M_SizeDisplay), unless the automap has them
  if (!showMap && (e.code === 'Minus' || e.code === 'Equal') && menu && !title) {
    e.preventDefault();
    sizeDisplay(e.code === 'Equal' ? 1 : -1);
  }
  // AM_Responder: F follow, G grid, M mark, C clear marks, 0 the whole level;
  // = and - zoom and (follow off) the arrows pan while held – and the game
  // doesn't see them (so F doesn't fire, nor M switch the sound off)
  if (showMap && amView && running && !menu?.active) {
    const said = { KeyF: () => amView.toggleFollow(), KeyG: () => amView.toggleGrid(), KeyM: () => amView.addMark(),
      KeyC: () => amView.clearMarks(), Digit0: () => amView.toggleBig() }[e.code]?.();
    if (said) amSay(said);
    // (the cheat readers below still see the key, as ST_Responder does before AM_Responder)
    if (['KeyF', 'KeyG', 'KeyM', 'KeyC', 'Digit0', 'Minus', 'Equal', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) e.preventDefault();
  }
  // AM_Responder: the automap listens for IDDT while it's open
  if (showMap && cheats.iddt(e.key)) amCheating = (amCheating + 1) % 3;
  for (const [code, read] of cheats.fixed) {
    if (recorder || demoPlayer || net) break;   // (a cheat isn't an input: it would desync the demo, or the netgame)
    if (read(e.key)) db.query(`EXECUTE PROCEDURE cheat('${code}')`).catch((err) => console.error(err));
  }
  // IDMUS xy: S_ChangeMusic to another level's song, if there is such a song
  const song = cheats.idmus(e.key);
  if (song && settings.skill !== 5 && !net) {   // (ST_Responder: not on Nightmare)
    const mapFor = idmusMap(song, wad.mapNames().some((m) => m.startsWith('MAP')));
    const lump = mapFor && musicLumpFor(mapFor);
    const ok = lump && wad.lump(lump);
    if (ok) audio.playMusic(lump);
    db.query(`UPDATE player SET msg = '${ok ? 'Music Change' : 'IMPOSSIBLE SELECTION'}', msg_tics = 70 WHERE id = 1`)
      .catch((err) => console.error(err));
  }
  // IDCLEV xy: G_DeferedInitNew – a new game on that map, if this WAD has it
  const digits = cheats.idclev(e.key);
  const warp = digits && clevMap(digits, wad.mapNames());
  if (warp && !recorder && !demoPlayer && !net) {
    $('map').value = warp;
    startMap(warp, true).catch((err) => setStatus(err.message, true));
  }
  if (e.code.startsWith('Digit')) weaponSel = Number(e.code.slice(5));
  if ((e.code === 'KeyP' || e.code === 'Pause') && !net) paused = !paused;
  if (e.code === 'KeyM' && !showMap) setAudio(!settings.audio);
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
  if (net) leaveNet('you left the game');
  finale = null;
  intermission = null;
  if (attract) { demoPlayer = null; attract = 0; }
  menu?.close(true);
  const maps = wad.mapNames();
  title = new TitleLoop(maps.some((m) => m.startsWith('MAP')), !!wad.lump('E4M1'), (m) => audio.playMusic(m));
}

/** G_RecordDemo: a fresh start of this map, a new seed, and every tic from now */
async function startRecording() {
  if (!map || !db) return;
  await startMap(map.name, true);
  recorder = new DemoRecorder({ wad: wadKey, map: map.name, skill: settings.skill, seed: lastSeed });
  setStatus(`● Recording a demo of ${map.name}`);
  updateDemoButtons();
}

/** G_CheckDemoStatus, recording: keep it (and in this WAD's slot store) */
function finishRecording() {
  if (!recorder) return;
  const { demo } = recorder;
  const { levels, tics } = recorder;
  recorder = null;
  if (demo.calls.length) {
    lastDemo = demo;
    saves.put(`${wadKey}|demo`, demo).catch(() => {});
    setStatus(`Demo recorded: ${levels.join(' → ')}, ${tics} tics. Play or Download it below.`);
  } else setStatus('');
  updateDemoButtons();
}

/** G_DoPlayDemo: the demo's map, skill and seed, then its inputs */
async function playDemo(demo) {
  const problem = demoProblem(demo);
  if (problem) { setStatus(`Can't play that: ${problem}`, true); return; }
  if (demo.wad !== wadKey) { setStatus(`That demo was recorded with ${demo.wad.split('|')[0]}; load that WAD first`, true); return; }
  if (!wad.mapNames().includes(demo.map)) { setStatus(`This WAD has no ${demo.map}`, true); return; }
  $('map').value = demo.map;
  await startMap(demo.map, true, { skill: demo.skill, seed: demo.seed });
  demoPlayer = new DemoPlayer(demo);
  setStatus(`▶ Playing a demo of ${demo.map} (Esc stops it)`);
  updateDemoButtons();
}

function endPlayback(why) {
  if (attract) { endAttract(); return; }
  demoPlayer = null;
  setStatus(`Demo ended: ${why}.`);
  updateDemoButtons();
}

/**
 * D_DoAdvanceDemo's G_DeferedPlayDemo: the title loop has reached DEMOn. With
 * a bundled demo for this WAD, it plays (the title loop waits, melting in and
 * out like DOOM's wipe); without one – another WAD, or not fetched yet – the
 * loop moves on, where DOOM would stop for the missing lump.
 */
async function startAttract(n) {
  const demo = attractDemos.get(n);
  // (not while players are gathering for a netgame, or in one: the map is theirs)
  if (!demo || demo.wad !== wadKey || !wad.mapNames().includes(demo.map) || net || lobby.role) { title.advance(); return; }
  attract = n;
  frameStarting = true;
  try {
    await startMap(demo.map, true, { skill: demo.skill, seed: demo.seed, keepDemo: true, attract: true, fromFrame: true });
    if (attract !== n || !title) return;   // (a game started meanwhile)
    demoPlayer = new DemoPlayer(demo);
  } catch (err) {
    attract = 0;
    title?.advance();
    throw err;
  } finally { frameStarting = false; }
  updateDemoButtons();
}

/** the demo is over (or out of step): the title loop's next page, melting in over the level */
function endAttract() {
  demoPlayer = null;
  attract = 0;
  title?.advance();
  updateDemoButtons();
}

function updateDemoButtons() {
  $('demo-record').disabled = !!recorder || (!!demoPlayer && !attract);
  $('demo-stop').disabled = !recorder && (!demoPlayer || !!attract);
  $('demo-play').disabled = !lastDemo || !!recorder;
  $('demo-download').disabled = !lastDemo;
}

/** The six slots of this WAD, as the menu lists them. */
async function refreshSlots() {
  const key = wadKey;
  const found = await Promise.all(Array.from({ length: SLOTS }, (_, i) => saves.get(`${key}|${i}`).catch(() => null)));
  if (key === wadKey) saveSlots = found.map((r) => (r ? { name: r.name, map: r.map } : null));
}

/** G_SaveGame: the live tables, plus the automap's seen lines and DOOM I's visited secret levels */
async function saveToSlot(slot, name) {
  const save = await captureGame(db, { seen: [...map.seen], didSecret: [...didSecret] });
  await saves.put(`${wadKey}|${slot}`, { name, map: save.map, date: new Date().toISOString(), save });
  await refreshSlots();
  await db.exec("UPDATE player SET msg = 'Game saved.', msg_tics = 70 WHERE id = 1");
}

/** G_LoadGame: the map afresh, then the save written over it */
async function loadFromSlot(slot) {
  const rec = await saves.get(`${wadKey}|${slot}`);
  if (!rec?.save) return;
  const { save } = rec;
  settings.skill = save.skill;
  saveSettings();
  $('skill').value = String(save.skill);
  $('map').value = save.map;
  await startMap(save.map, true);
  running = false;                 // (nothing ticks until the save is back)
  if (inFrame) await inFrame.catch(() => {});
  try {
    await restoreGame(db, save);
    map.seen = new Set(save.extra?.seen ?? []);
    didSecret.clear();
    for (const e of save.extra?.didSecret ?? []) didSecret.add(e);
    await loadSides();
  } catch (err) {
    setStatus(`Couldn't load that save: ${err.message}`, true);
  }
  resume();
}

/** M_SizeDisplay: one step of the Screen Size, 3–11 */
function sizeDisplay(dir) {
  const next = Math.max(3, Math.min(11, settings.screenSize + dir));
  if (next === settings.screenSize) return;
  settings.screenSize = next;
  saveSettings();
  audio.playEvents([[0, 'DSSTNMOV', 'menu', null, null]], { x: 0, y: 0, angle: 0 });
  applyView().catch((err) => setStatus(err.message, true));
}

/** This WAD's menu, its options wired to the settings */
function makeMenu() {
  const maps = wad.mapNames();
  const doom2 = maps.some((m) => m.startsWith('MAP'));
  const strings = parseDehStrings(wad.dehacked() + '\n' + (dehPatch?.text ?? ''));
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
      get slots() { return saveSlots; },
      // (only in a game: not on the title, the intermission or an ending)
      get canSave() { return !!map && !title && !intermission && !finale && !net; },
      get inGame() { return !!map && !title; },     // (usergame: not the title loop, nor its demos)
      get netgame() { return !!net; },
      save: (slot, name) => saveToSlot(slot, name).catch((err) => setStatus(`Couldn't save: ${err.message}`, true)),
      load: (slot) => loadFromSlot(slot).catch((err) => setStatus(`Couldn't load: ${err.message}`, true)),
      quit() {
        play(quitSounds[Math.floor(Math.random() * quitSounds.length)]);
        goTitle();
      },
      // (the menu's thermometer counts 0–8; the menu plays its own slider sound)
      get screenSize() { return settings.screenSize - 3; },
      set screenSize(v) {
        settings.screenSize = v + 3;
        saveSettings();
        applyView().catch((err) => setStatus(err.message, true));
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
  const panning = showMap && amView && !amView.follow;   // (the arrows pan the map instead)
  const arrow = (c) => !panning && k(c);
  let fwd = (k('KeyW') || arrow('ArrowUp') ? 1 : 0) - (k('KeyS') || arrow('ArrowDown') ? 1 : 0);
  let side = (k('KeyD') || k('Period') ? 1 : 0) - (k('KeyA') || k('Comma') ? 1 : 0);
  const turnKeys = (arrow('ArrowLeft') ? 1 : 0) - (arrow('ArrowRight') ? 1 : 0);
  const run = k('ShiftLeft') || k('ShiftRight') ? 1 : 0;
  if (touch.move) {
    fwd = Math.max(-1, Math.min(1, -touch.move.dy / 40));
    side = Math.max(-1, Math.min(1, touch.move.dx / 40));
  }
  // angleturn 640/1280 per tic in DOOM ≈ 0.061 / 0.123 rad
  const turn = turnKeys * (run ? 0.123 : 0.07) * tics + mouseTurn;
  mouseTurn = 0;
  const fire = k('ControlLeft') || k('ControlRight') || (k('KeyF') && !showMap) || fireClick ? 1 : 0;
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

/** One map load at a time: a second start waits for the first and lands last. */
let mapQueue = Promise.resolve();
function startMap(name, newGame, opts) {
  const run = mapQueue.then(() => startMapNow(name, newGame, opts));
  mapQueue = run.catch(() => {});
  return run;
}

async function startMapNow(name, newGame, { skill = settings.skill, seed = null, keepDemo = false, netgame = false, attract: forTitle = false, fromFrame = false } = {}) {
  if (net && !netgame) leaveNet('you started another game');
  running = false;
  // (a start from outside the loop – the menu, the panel, a message – waits for
  // the frame in flight: its queries must be done before the tables go. Not
  // for a frame that's waiting on a start of its own, queued behind this one.)
  if (inFrame && !fromFrame && !frameStarting) await inFrame.catch(() => {});
  if (forTitle && !attract) return;   // (the title loop's demo, called off while it waited its turn)
  levelSerial++;
  finale = null;
  intermission = null;
  if (!forTitle) {
    title = null;
    attract = 0;
    menu?.close(true);
  }
  // a map you pick (a new game, a save, the Map selector) ends a demo; the game's
  // own next level doesn't (nextLevel); demo starts set theirs afterwards
  if (!keepDemo) {
    if (recorder) finishRecording();
    demoPlayer = null;
  }
  if (newGame) didSecret.clear();
  setStatus(`Loading ${name} into Firebird…`);
  const t0 = performance.now();
  // P_RANDOM's seed: a demo's own, or a fresh one for a new game (a new level carries on)
  const s = seed ?? (newGame ? 1 + Math.floor(Math.random() * 2147483646) : null);
  await loadMap(db, wad, res, name, {
    skill, newGame, players: net?.players ?? 1, deathmatch: net?.deathmatch ?? 0, timer: net?.timer ?? 0,
    nomonsters: net?.nomonsters ?? 0, respawn: net?.respawn ?? 0, fast: net?.fast ?? 0, seed: s,
  });
  await db.exec(`UPDATE viewcfg SET player_id = ${net?.me ?? 1} WHERE id = 1`);   // (consoleplayer)
  lastSeed = s;
  map = { name, skyTex: skyFor(name) };
  const { rows } = await db.query(
    'SELECT id, front_side, back_side, flags, light_delta, x1, y1, x2, y2, front_sector, back_sector, special FROM linedefs',
    [], { rowMode: 'array' });
  map.lines = new Map(rows.map((r) => [r[0], { fs: r[1], bs: r[2], flags: r[3], lightDelta: r[4], scroll: r[11] === 48 }]));
  map.linedefs = rows;
  map.seen = new Set();   // ML_MAPPED: every line the renderer has drawn on this level
  face = new FaceWidget();   // (ST_Start: the face starts over with each level)
  // AM_LevelInit: the level's extent, the window on it, no marks
  const xs = rows.flatMap((r) => [r[5], r[7]]);
  const ys = rows.flatMap((r) => [r[6], r[8]]);
  amView = new AutomapView({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
    wad.blockmapOrigin(name) ?? undefined);
  await loadSides();
  sidesRev = -1;
  console.log(`[firebird-doom] ${name} loaded in ${(performance.now() - t0).toFixed(0)} ms`);
  setStatus('');
  $('mapname').textContent = name;
  audio.playMusic(musicLumpFor(name));
  resume();
}

/**
 * G_DoLoadLevel within a game: the next level, or this one again after a
 * death. A demo goes on through it: recording notes the level and its seed,
 * playing takes them from the recording (a restart's seed is a new one).
 */
async function nextLevel(name, newGame) {
  let seed = null;
  if (demoPlayer) {
    const c = demoPlayer.take('map');
    if (c && c[1] === name) seed = c[2];
    else endPlayback(demoPlayer.done ? 'the demo is over' : 'it is out of step with the game');
  }
  const rec = recorder;
  frameStarting = true;
  try {
    await startMap(name, newGame, { seed, keepDemo: true, netgame: !!net, fromFrame: true });
  } finally { frameStarting = false; }
  rec?.push(['map', name, lastSeed, newGame ? 1 : 0]);
}

/** A demo being played whose next entry isn't KIND has run out, or out of step: stop it. Returns the entry. */
function demoTake(kind) {
  if (!demoPlayer) return null;
  const c = demoPlayer.take(kind);
  if (!c) endPlayback(demoPlayer.done ? 'the demo is over' : 'it is out of step with the game');
  return c;
}

// ── co-op over the network ────────────────────────────────────────────────
const IDLE_CMD = [0, 0, 0, 0, 0, 0, 0];

/**
 * One frame of a netgame: a command for each tic that has gone by (none while
 * the menu is up), then every tic the lockstep has complete, through NET_TIC.
 * False when no tic ran: nothing new to draw.
 */
async function netTics(tics) {
  const [, fwd, side, turn, fire, use, w, run] = readInput(tics);
  if (net.ls.error) return false;
  const mine = menu?.active ? IDLE_CMD : [fwd, side, turn / tics, fire, use, w, run];
  for (let i = 0; i < tics && net.ls.canSubmit(); i++) net.ls.submit(i === 0 ? mine : [...mine.slice(0, 5), 0, mine[6]]);
  let ran = 0;
  while (ran < 12) {
    const r = net.ls.take();
    if (!r) break;
    // (from the network: numbers, and only numbers, go into the SQL)
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
    const rows = r.cmds.map((c, i) => [i + 1, num(c[0], -1, 1), num(c[1], -1, 1), num(c[2], -Math.PI, Math.PI),
      num(c[3], 0, 1) | 0, num(c[4], 0, 1) | 0, num(c[5], 0, 9) | 0, num(c[6], 0, 1) | 0]);
    await db.query(`EXECUTE BLOCK AS BEGIN DELETE FROM ticcmd;
      ${rows.map((v) => `INSERT INTO ticcmd (player_id, fwd, side, turn, fire, use_key, weapon_sel, run) VALUES (${v.join(', ')});`).join('\n')} END`);
    hud = (await db.query('SELECT * FROM net_tic', [], { rowMode: 'object' })).rows[0];
    lastFire = rows[net.me - 1][4] === 1;
    ran++;
    // the consistency check (d_net.c's consistancy): the host compares everyone's
    if (r.tic % 35 === 0) {
      const sum = (await db.query('SELECT csum FROM net_checksum')).rows[0].CSUM;
      net.ls.report(r.tic, sum);
      net.sums.set(r.tic, sum);           // (the last few, for doom.net)
      if (net.sums.size > 8) net.sums.delete(net.sums.keys().next().value);
    }
    if (hud.EXIT_KIND) break;
  }
  if (net.ls.error) {
    setStatus(`Co-op stopped: ${net.ls.error}.`, true);
    netPanel();
    return false;
  }
  if (ran) {
    if (netWait && statusEl.textContent.startsWith('Waiting')) setStatus('');
    netWait = 0;
  } else if (!netWait) netWait = performance.now();
  else if (performance.now() - netWait > 1000) setStatus('Waiting for the other players…');
  return ran > 0 && !!hud;
}

/** WI_Start's wbs->plyr[]: every player's kills, items, secrets and frags, for the netgame screens */
async function netStats() {
  const arr = { rowMode: 'array' };
  const rows = (await db.query('SELECT p.id, p.kills, p.items, p.secrets FROM player p ORDER BY p.id', [], arr)).rows;
  const frags = (await db.query('SELECT killer, victim, n FROM frags', [], arr)).rows;
  const players = rows.map((r) => ({ kills: r[1], items: r[2], secrets: r[3], frags: rows.map(() => 0) }));
  for (const [k, v, n] of frags) if (players[k - 1] && v <= players.length) players[k - 1].frags[v - 1] = n;
  return { players, me: net.me, deathmatch: net.deathmatch };
}

/**
 * G_InitNew for a netgame: everyone the same map, skill, seed and options
 * (-nomonsters, -respawn, -fast); me is this browser's player.
 */
async function beginNet({ me, players, mapName, skill, seed, deathmatch = 0, timer = 0, nomonsters = 0, respawn = 0, fast = 0 }, links) {
  if (recorder) finishRecording();
  demoPlayer = null;
  paused = false;
  const send = (to, m) => {
    if (to === 'all') for (const l of links.values()) l.send(m);
    else links.get(to)?.send(m);
  };
  net = { me, players, deathmatch, timer, nomonsters, respawn, fast, links, ls: new Lockstep({ me, players, send }), sums: new Map() };
  netWait = 0;
  for (const [pid, link] of links) {
    link.onmessage = (m) => net?.links === links && net.ls.receive(pid, m);
    link.onclose = () => {
      if (net?.links !== links || net.ls.error) return;
      const why = pid === 1 ? 'the host left' : `player ${pid} left`;
      if (me === 1) send('all', { t: 'desync', why });
      net.ls.fail(why);
    };
  }
  settings.skill = skill;
  $('skill').value = String(skill);
  $('map').value = mapName;
  await startMap(mapName, true, { skill, seed, netgame: true });
  $('net-out').value = '';
  $('net-in').value = '';
  setStatus(`${deathmatch ? 'Deathmatch' : 'Co-op'}: you are player ${me} of ${players}.`);
  setTimeout(() => { if (/^(Co-op|Deathmatch): you/.test(statusEl.textContent)) setStatus(''); }, 4000);
  netPanel();
}

/** Out of the netgame (and the lobby): the links closed, back to one player at the next start. */
function leaveNet(why) {
  const links = net ? [...net.links.values()] : [...lobby.links.map((l) => l.link), lobby.guest].filter(Boolean);
  if (net && !net.ls.error) for (const l of links) l.send({ t: 'desync', why: `player ${net.me} left` });
  for (const l of links) l.close();
  lobby.invite?.cancel();
  Object.assign(lobby, { role: null, links: [], invite: null, guest: null });
  if (net) console.info(`[firebird-doom] co-op over: ${why}`);
  net = null;
  netPanel();
}

/** The Co-op panel's buttons and words, for where things stand */
function netPanel(say) {
  const host = lobby.role === 'host';
  $('net-host').disabled = !!net || lobby.role === 'guest' || !!lobby.invite || lobby.links.length >= MAX_PLAYERS - 1;
  $('net-join').disabled = !!net || !!lobby.role;
  $('net-start').disabled = !!net || !host || !lobby.links.length;
  $('net-leave').disabled = !net && !lobby.role;
  $('net-connect').disabled = !!net || !(lobby.invite || (lobby.role === 'guest' && !lobby.guest && !lobby.replied));
  if (say !== undefined) $('net-status').textContent = say;
  else if (net) $('net-status').textContent = net.ls.error ? `Stopped: ${net.ls.error}.` : `In the ${net.deathmatch ? 'deathmatch' : 'game'}: player ${net.me} of ${net.players}.`;
}

$('net-host').addEventListener('click', async () => {
  try {
    lobby.role = 'host';
    netPanel('Making an invite…');
    lobby.invite = await createInvite();
    $('net-out').value = lobby.invite.code;
    $('net-in').value = '';
    netPanel(`Send the code above to player ${lobby.links.length + 2}, then paste their reply and press Connect.`);
  } catch (err) { netPanel(`Couldn't make an invite: ${err.message}`); }
});
$('net-join').addEventListener('click', () => {
  lobby.role = 'guest';
  lobby.replied = false;
  $('net-out').value = '';
  $('net-in').value = '';
  netPanel("Paste the host's invite below and press Connect.");
});
$('net-connect').addEventListener('click', async () => {
  const code = $('net-in').value.trim();
  if (!code) return;
  try {
    if (lobby.role === 'host' && lobby.invite) {
      netPanel('Connecting…');
      const link = await lobby.invite.accept(code);
      lobby.invite = null;
      const pid = lobby.links.length + 2;
      lobby.links.push({ pid, link });
      link.onclose = () => {
        lobby.links = lobby.links.filter((l) => l.link !== link);
        if (!net) netPanel(`Player ${pid} went away.`);
      };
      $('net-out').value = '';
      $('net-in').value = '';
      netPanel(`${lobby.links.length + 1} players. Invite another, or Start (${$('map').value}, skill ${settings.skill}).`);
    } else if (lobby.role === 'guest') {
      netPanel('Making a reply…');
      const { reply, link } = await acceptInvite(code);
      lobby.replied = true;
      $('net-out').value = reply;
      netPanel('Send the reply above to the host, and wait for them to connect and start.');
      const l = await link;
      lobby.guest = l;
      netPanel(`Connected. Waiting for the host to start (load the same WAD: ${$('wadname').textContent}).`);
      l.onmessage = (m) => {
        if (m.t !== 'start' || net) return;
        // (from the network: check it all before it goes anywhere near the game)
        const ok = m.wad === wadKey && wad.mapNames().includes(m.map) && [1, 2, 3, 4, 5].includes(m.skill)
          && Number.isInteger(m.seed) && Number.isInteger(m.you) && m.you >= 2 && m.you <= m.players && m.players <= MAX_PLAYERS
          && [0, 1, 2].includes(m.dm) && Number.isInteger(m.timer) && m.timer >= 0 && m.timer < 1000
          && [m.nomonsters, m.respawn, m.fast].every((v) => v === 0 || v === 1);
        if (!ok) {
          l.send({ t: 'desync', why: `player ${m.you} has another WAD loaded` });
          netPanel(`The host is playing ${String(m.wad).split('|')[0]}: load that, and join again.`);
          return;
        }
        lobby.guest = null;
        lobby.role = null;
        $('net-mode').value = String(m.dm);
        $('net-timer').value = String(m.timer);
        for (const o of NET_OPTIONS) $(`net-${o}`).checked = m[o] === 1;
        beginNet({ me: m.you, players: m.players, mapName: m.map, skill: m.skill, seed: m.seed, deathmatch: m.dm, timer: m.timer,
          nomonsters: m.nomonsters, respawn: m.respawn, fast: m.fast }, new Map([[1, l]]))
          .catch((err) => setStatus(err.message, true));
      };
      l.onclose = () => { if (!net) { lobby.guest = null; lobby.role = null; netPanel('The host went away.'); } };
    }
  } catch (err) {
    netPanel(`That didn't work: ${err.message}`);
  }
});
// the launch options (-nomonsters, -respawn, -fast): a checkbox each, the host's choice for all
const NET_OPTIONS = ['nomonsters', 'respawn', 'fast'];
$('net-start').addEventListener('click', () => {
  if (lobby.role !== 'host' || !lobby.links.length || !db || !wad) return;
  const players = lobby.links.length + 1;
  const mapName = $('map').value;
  const skill = settings.skill;
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const dm = Number($('net-mode').value) || 0;
  const timer = Math.max(0, Math.min(999, Number($('net-timer').value) || 0));
  const opts = Object.fromEntries(NET_OPTIONS.map((o) => [o, $(`net-${o}`).checked ? 1 : 0]));
  const links = new Map(lobby.links.map(({ pid, link }) => [pid, link]));
  lobby.invite?.cancel();
  Object.assign(lobby, { role: null, links: [], invite: null, guest: null });
  for (const [pid, link] of links) link.send({ t: 'start', you: pid, players, map: mapName, skill, seed, wad: wadKey, dm, timer, ...opts });
  beginNet({ me: 1, players, mapName, skill, seed, deathmatch: dm, timer, ...opts }, links).catch((err) => setStatus(err.message, true));
});
$('net-leave').addEventListener('click', () => {
  const was = !!net;
  leaveNet('you left the game');
  netPanel(was ? 'You left the game.' : '');
  $('net-out').value = '';
});
netPanel();

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

let frames = 0;         // (frame() calls, for the tests' diagnostics)
let inFrame = null;     // the frame in flight (a map load waits for it: its queries must not meet the DELETEs)
let frameStarting = false;   // …unless that frame is itself waiting on a map start (its queries are done)
let loopAlive = false;  // frame() keeps scheduling itself until an error stops it; a map start revives it
function frame() {
  inFrame = frameNow().finally(() => { inFrame = null; });
}

/** running again, and the loop with it if an error had stopped it */
function resume() {
  lastTic = performance.now();
  running = true;
  if (!loopAlive) {
    loopAlive = true;
    nextFrame();
  }
}

async function frameNow() {
  frames++;
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

    // the melt runs on its own, and nothing else does meanwhile (D_Display's wipe loop)
    if (melt) {
      readInput(tics);                // (what's pressed meanwhile is dropped)
      const done = melt.tick(tics);
      renderer.presenter?.present(melt.draw(meltBuf), meltPalette);
      if (done) melt = null;
      nextFrame();
      return;
    }

    if (title?.demo && !attract) {
      // D_DoAdvanceDemo: a demo's turn in the title loop
      await startAttract(title.demo);
      nextFrame();
      return;
    }

    if ((title && !attract) || (menu?.active && !net && !attract)) {
      // the title loop, or the menu over a frozen game (single player waits;
      // a netgame, or the title loop's demo, goes on beneath it)
      for (let i = 0; i < tics; i++) { title?.tick(); menu?.tick(); }
      if (title) title.draw(renderer);
      else if (menuBackdrop) renderer.sfb.set(menuBackdrop);
      if (menu?.active) menu.draw(renderer);
      renderer.present(title ? 0 : lastPalette);
      nextFrame();
      return;
    }

    if (intermission) {
      // WI_Ticker: a new press of fire or use hurries it along (a demo's own presses, playing one)
      const c = demoTake('wi');
      const input = readInput(tics);
      const n = c ? c[1] : tics;
      const buttons = c ? c[2] === 1 : input[4] === 1 || input[5] === 1;
      recorder?.push(['wi', n, buttons ? 1 : 0]);
      for (let i = 0; i < n; i++) intermission.tick(i === 0 && buttons && !wiButtons);
      wiButtons = buttons;
      if (intermission.done) {
        // G_WorldDone: a text screen if this exit has one, else the next map
        const { secret, fromName } = intermission;
        intermission = null;
        if (Finale.available(wad, fromName, secret)) {
          finale = new Finale(renderer, audio, wad, THING_TYPES, fromName, secret);
          finaleKey = false;
        } else {
          await nextLevel(nextMap(fromName, secret, wad.mapNames()), false);
        }
      } else intermission.draw();
      nextFrame();
      return;
    }

    if (finale) {
      // the ending runs on its own clock: a key kills the one on stage (the
      // key that skips the text is spent before the cast starts), fire or
      // use held skips the text
      const c = demoTake('fin');
      const input = readInput(tics);
      const n = c ? c[1] : tics;
      const held = c ? c[2] === 1 : input[4] === 1 || input[5] === 1;
      const pressed = c ? c[3] === 1 : finaleKey;
      finaleKey = false;
      recorder?.push(['fin', n, held ? 1 : 0, pressed ? 1 : 0]);
      if (pressed) finale.press();
      for (let i = 0; i < n; i++) finale.tick(held);
      if (finale.done) {
        // G_WorldDone after a text screen: on to the next map (MAP31/32 after a
        // secret exit's), inventory kept. DOOM I's endings never get here: the
        // game is over, and their art stays until the menu starts another
        await nextLevel(nextMap(finale.from, finale.secret, wad.mapNames()), false);
        nextFrame();
        return;
      }
      finale.draw();
      nextFrame();
      return;
    }

    let t = performance.now();
    if (net) {
      // a netgame: this player's commands out, everyone's tics in (TryRunTics)
      const done = await netTics(tics);
      if (!done) { nextFrame(); return; }
    } else {
      // G_ReadDemoTiccmd / G_WriteDemoTiccmd
      let args;
      if (demoPlayer) {
        readInput(tics);              // (drained, so it doesn't pile up for later)
        // a demo plays in its own time: as many of its calls as the tics gone
        // by cover (at least one), whatever the frame rate it was recorded at
        let owed = tics;
        let ran = 0;
        while (owed > 0) {
          args = demoTake('tic');
          if (!args) break;
          hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', args, { rowMode: 'object' })).rows[0];
          owed -= args[0];
          ran++;
          lastFire = args[4] === 1;
          if (hud.EXIT_KIND) break;
        }
        if (!ran) { nextFrame(); return; }
      } else {
        args = readInput(tics);
        lastFire = args[4] === 1;
        recorder?.push(args);
        if (recorder && recorder.demo.calls.length % 35 === 0) setStatus(`● Recording a demo of ${map.name}: ${recorder.tics} tics`);
        hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', args, { rowMode: 'object' })).rows[0];
      }
    }
    lastFrame.tic = performance.now() - t;

    if (hud.EXIT_KIND) {
      const kind = hud.EXIT_KIND;
      const secret = kind === 2;
      // (a demo goes on: through the intermission to the next level, or the restart after a death)
      if (kind === 3) await nextLevel(map.name, true);
      else {
        await db.exec('UPDATE game SET exit_kind = 0 WHERE id = 1');
        const level = levelOf(map.name);
        if (!level.doom2 && level.map === 7 && Finale.available(wad, map.name, secret)) {
          // G_DoCompleted: DOOM I's E?M8 goes straight to the ending, no stats
          finale = new Finale(renderer, audio, wad, THING_TYPES, map.name, secret);
          finaleKey = false;
          setStatus(`The end of episode ${level.episode}. Esc for the menu: a new game, or another episode.`);
        } else {
          // WI_Start: kills, items, secrets, time and par; then G_WorldDone
          if (!level.doom2 && level.map === 8) didSecret.add(level.episode);   // E?M9 done
          intermission = new Intermission(renderer, audio, wad, map.name, nextMap(map.name, secret, wad.mapNames()), {
            kills: hud.KILLS, totalKills: hud.TOTAL_KILLS, items: hud.ITEMS, totalItems: hud.TOTAL_ITEMS,
            secrets: hud.SECRETS, totalSecrets: hud.TOTAL_SECRETS, time: hud.TIC,
            ...(net ? await netStats() : {}),
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
      q(`SELECT id, sound, origin, x, y FROM sound_events WHERE id > ${lastSoundId} AND COALESCE(listener, ${net?.me ?? 1}) = ${net?.me ?? 1} ORDER BY id`),
    ]);
    // the listener; on map 8 (E?M8, MAP08) S_AdjustSoundParams never quite fades a sound out
    const listener = { x: hud.PX, y: hud.PY, angle: hud.PANGLE, bossMap: /^(E\dM8|MAP08)$/.test(map.name) };
    if (sounds.length) {
      lastSoundId = sounds[sounds.length - 1][0];
      audio.playEvents(sounds, listener);
    }
    // S_UpdateSounds: the things sounding now, where they are (gone: their sound stops)
    const sounding = audio.channels.thingOrigins();
    const positions = new Map(sounding.length
      ? (await db.query(`SELECT id, x, y FROM things WHERE id IN (${sounding.join(', ')})`, [], arr)).rows.map((r) => [r[0], [r[1], r[2]]])
      : []);
    audio.update(listener, positions);
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
    renderer.drawView({ x: hud.PX, y: hud.PY, z: hud.VIEW_Z, angle: hud.PANGLE, tic: hud.TIC, palette, fixedColormap,
      extralight: hud.DEAD ? 0 : extraLight(hud) },
      walls, sprites, map);
    // R_DrawViewBorder round a small view (FLOOR7_2, DOOM II's GRNROCK)
    if (renderer.scaledW < 320) renderer.drawBorder(wad.mapNames().some((m) => m.startsWith('MAP')) ? 'GRNROCK' : 'FLOOR7_2');
    renderer.composeView();
    if (!hud.DEAD) drawWeapon(renderer, hud);
    if (showMap) drawAutomap(tics);
    // (the face still keeps its time with the bar off: ST_Ticker runs regardless)
    const faceNow = face.update(hud, tics, lastFire);
    // ST_Drawer: full screen (11) has no status bar, except over the automap
    if (settings.screenSize < 11 || showMap) drawStatusBar(renderer, hud, faceNow, net?.me ?? 0);
    if (amMsg) amMsg.tics -= tics;
    if (amMsg && amMsg.tics <= 0) amMsg = null;
    const msg = amMsg?.text ?? hud.MSG;
    if (msg && (settings.messages || amMsg?.always)) drawText(renderer, msg, 2, 2);
    if (paused) drawText(renderer, 'PAUSED', 136, 80);
    if ((net || attract) && menu?.active) {
      for (let i = 0; i < tics; i++) menu.tick();
      menu.draw(renderer);
    }
    lastPalette = palette;
    renderer.present(palette);
    lastFrame.draw = performance.now() - t;
    updateStats();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
    running = false;
    loopAlive = false;
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

/** An automap message (a DEHACKED string's name), the WAD's wording or Freedoom's. */
function amSay(key) {
  const strings = parseDehStrings(wad.dehacked() + '\n' + (dehPatch?.text ?? ''));
  amMsg = { text: strings.get(key) ?? AM_STRINGS[key], tics: 4 * 35 };   // (HU_MSGTIMEOUT)
}

/** A message of the page's own (F5, F8, F11), like the game's; ALWAYS shows it even with messages off (message_dontfuckwithme) */
function pageSay(text, always = false) {
  amMsg = { text, tics: 4 * 35, always };
}

/** F11 (and the setting): usegamma, the presenter's palettes through the gamma table, with its message */
function setGamma(level, say = false) {
  settings.gamma = Math.max(0, Math.min(4, level | 0));
  saveSettings();
  renderer?.setGamma(settings.gamma);
  if (say) {
    const strings = parseDehStrings(wad.dehacked() + '\n' + (dehPatch?.text ?? ''));
    pageSay(strings.get(`GAMMALVL${settings.gamma}`) ?? (settings.gamma ? `Gamma: level ${settings.gamma}` : 'Gamma: off'));
  }
}

function drawAutomap(tics = 1) {
  // AM_Ticker, then AM_Drawer into the 320×200 screen in palette colours;
  // the view behind stays faintly visible, darkened through COLORMAP 24
  const k = (c) => keys.has(c);
  amView.tick(tics, { zoomIn: k('Equal') || k('NumpadAdd'), zoomOut: k('Minus') || k('NumpadSubtract'),
    left: k('ArrowLeft'), right: k('ArrowRight'), up: k('ArrowUp'), down: k('ArrowDown') }, { x: hud.PX, y: hud.PY });
  renderer.dim(24);
  const tx = (x) => amView.toScreen(x, 0)[0];
  const ty = (y) => amView.toScreen(0, y)[1];
  const sc = amView.scale;
  // AM_drawGrid: the BLOCKMAP's 128-unit cells, under everything
  if (amView.grid) for (const [x1, y1, x2, y2] of amView.gridLines()) renderer.line(tx(x1), ty(y1), tx(x2), ty(y2), GRID_COLOR);
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
  // (the arrows keep their size on screen at any zoom, as DOOM's line art does: 16 and 8 units at the start)
  const z = Math.max(0.5, Math.min(2, sc / 0.12));
  if (map.amThings) {
    for (const [x, y, ang] of map.amThings) {
      const px = tx(x);
      const py = ty(y);
      if (px < -4 || px > 324 || py < -4 || py > 172) continue;
      tri(px, py, ang, 3 * z, 2.5 * z, AM_COLORS.thing);
    }
  }
  tri(tx(hud.PX), ty(hud.PY), hud.PANGLE, 6 * z, 5 * z, AM_COLORS.player);
  // AM_drawMarks: the numbers, AMMNUM0–9
  amView.marks.forEach(([x, y], i) => {
    const pic = renderer.pictureByName(`AMMNUM${i}`);
    if (pic) renderer.patch(pic, Math.round(tx(x)), Math.round(ty(y)));
  });
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

// what's loaded: the main WAD, PWADs on top of it (-file), and a DeHackEd patch (-deh)
let baseWad = null;                 // { buffer, label }
let pwads = [];                     // [{ buffer, name }]
let dehPatch = null;                // { text, name }

/** Load the main WAD, with the PWADs and patch last loaded over it (remembered in IndexedDB). */
async function useWad(buffer, label) {
  baseWad = { buffer, label };
  const kept = await recallFiles(saves, label);
  pwads = kept?.pwads ?? [];
  dehPatch = kept?.deh ?? null;
  if (!kept) { await loadWads(); return; }
  try {
    await loadWads();
  } catch (err) {
    // (they no longer load: forget them, and start on the main WAD alone)
    pwads = [];
    dehPatch = null;
    await rememberFiles(saves, label, [], null);
    await loadWads();
    setStatus(`The PWADs kept for ${label} didn't load (${err.message}); they're forgotten.`, true);
  }
}

/** Remember what's over the main WAD now for next time (first: loading takes a while), and load it. */
async function reloadWads() {
  await rememberFiles(saves, baseWad.label, pwads, dehPatch).catch(() => {});
  await loadWads();
}
const forgetFailed = () => rememberFiles(saves, baseWad.label, pwads, dehPatch).catch(() => {});

/** W_InitMultipleFiles: the main WAD, the PWADs over it, the patch over all; then the first map. */
async function loadWads() {
  running = false;
  wad = new Wad(baseWad.buffer, ...pwads.map((p) => p.buffer));
  const label = [baseWad.label, ...pwads.map((p) => p.name), ...(dehPatch ? [dehPatch.name] : [])].join(' + ');
  const maps = wad.mapNames();
  if (!maps.length) throw new Error(`${label} has no maps`);
  setStatus(`Copying ${label} resources into Firebird…`);
  res = await loadResources(db, wad, { width: view().w, height: view().h, projy: view().scaledW / 2, dehacked: dehPatch?.text ?? '' });
  await setRenderer(db, settings.renderer === 'bsp');
  renderer = new Renderer(wad, res);
  renderer.setGamma(settings.gamma);
  renderer.attach(presenter);
  // every present goes through here: a new state melts in from the last screen shown
  const present = renderer.present.bind(renderer);
  shownState = null;
  renderer.present = (palette = 0) => {
    const state = screenState();
    if (shownState !== null && state !== shownState && shownScreen) {
      melt = new Melt(shownScreen, renderer.sfb);   // wipe_StartScreen, wipe_EndScreen
      meltPalette = palette;
      renderer.presenter?.present(melt.draw(meltBuf), palette);
    } else present(palette);
    shownState = state;
    shownScreen = renderer.sfb.slice();
  };
  audio.setWad(wad);
  // DeHackEd: the WAD's patch respells cheats and sets par times (the rest went into Firebird)
  cheats = cheatReaders(res.dehacked.cheats);
  setParOverrides(res.dehacked.pars);
  if (res.dehacked.report.length) console.info(`DEHACKED (${label}): ${res.dehacked.report.join('; ')}`);
  wadKey = `${label}|${maps.length}`;
  // the title loop's demos (only the bundled WADs on their own have any)
  attractDemos = new Map();
  if (!pwads.length && !dehPatch) {
    const key = wadKey;
    for (let n = 1; n <= (ATTRACT_DEMOS[baseWad.label] ?? 0); n++) {
      fetch(new URL(`./demos/${attractDemoFile(baseWad.label, n)}`, location.href))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && key === wadKey && !demoProblem(d) && d.wad === key) attractDemos.set(n, d); })
        .catch(() => {});
    }
  }
  saveSlots = Array(SLOTS).fill(null);
  refreshSlots();
  lastDemo = null;
  saves.get(`${wadKey}|demo`).then((d) => { if (d && !demoProblem(d)) lastDemo = d; updateDemoButtons(); }).catch(() => {});
  makeMenu();
  renderer.setSize(view().w, view().h, view());
  const sel = $('map');
  sel.innerHTML = maps.map((m) => `<option>${m}</option>`).join('');
  $('wadname').textContent = label;
  $('pwad-clear').disabled = !pwads.length && !dehPatch;
  // (with a PWAD, start on its first map – vanilla would need -warp for that)
  const first = wad.pwadMapNames()[0] ?? maps[0];
  sel.value = first;
  await startMap(first, true);
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
      // to the map after the one named, as if you'd just finished it (DOOM I's
      // endings excepted: they end the game)
      get menu() { return menu; },
      get automap() { return { view: amView, open: showMap, message: amMsg?.text ?? null }; },
      get gamma() { return settings.gamma; },
      get debug() { return { running, paused, frames, loopAlive, levelSerial, shownState, menu: !!menu?.active, melt: !!melt, keys: [...keys], mouseTurn, showMap, amFollow: amView?.follow, ls: net && { submitted: net.ls.submitted, executed: net.ls.executed, ready: net.ls.ready.length, early: net.ls.early.size, pending: net.ls.pending.size, error: net.ls.error } }; },
      get message() { return amMsg?.text ?? hud?.MSG ?? null; },
      get files() { return { base: baseWad?.label, pwads: pwads.map((p) => p.name), deh: dehPatch?.name ?? null }; },
      addPwad: async (buffer, name) => { pwads.push({ buffer, name }); await reloadWads(); },
      useDeh: async (text, name = 'patch.deh') => { dehPatch = { text, name }; await reloadWads(); },
      get demo() { return { recording: !!recorder, playing: !!demoPlayer && !attract, attract, played: demoPlayer?.index ?? 0, last: lastDemo }; },
      get net() { return net && { me: net.me, players: net.players, deathmatch: net.deathmatch, timer: net.timer, nomonsters: net.nomonsters, respawn: net.respawn, fast: net.fast, tic: net.ls.executed, error: net.ls.error, sums: Object.fromEntries(net.sums) }; },
      record: () => startRecording(), stopDemo: () => $('demo-stop').click(), playDemo: (d = lastDemo) => playDemo(d),
      get title() { return title; },
      get melting() { return !!melt; },
      // the screen shown is the current one, no melt pending or running (melts queue up: a
      // level loaded behind another's melt gets its own after)
      get settled() { return !melt && shownState === screenState(); },
      get screen() { return screenState().replace(/ \d+$/, ''); },   // title, level, intermission, finale
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
    resume();    // (the loop is running since the first map; this would start it otherwise)
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
// PWADs on top of the main WAD, and a DeHackEd patch
$('pwadfile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length || !db || !baseWad) return;
  try {
    for (const f of files) pwads.push({ buffer: await f.arrayBuffer(), name: f.name });
    await reloadWads();
  } catch (err) {
    pwads = pwads.filter((p) => !files.some((f) => f.name === p.name));
    forgetFailed();
    setStatus(err.message, true);
  }
  e.target.value = '';
});
$('dehfile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !db || !baseWad) return;
  try {
    dehPatch = { text: new TextDecoder('latin1').decode(await f.arrayBuffer()), name: f.name };
    await reloadWads();
  } catch (err) {
    dehPatch = null;
    forgetFailed();
    setStatus(err.message, true);
  }
  e.target.value = '';
});
$('pwad-clear').addEventListener('click', async () => {
  pwads = [];
  dehPatch = null;
  try { await reloadWads(); } catch (err) { setStatus(err.message, true); }
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
  $('synth').disabled = !on;
  audio.setEnabled(on);
}
$('audio').checked = settings.audio;
$('sfxvol').disabled = !settings.audio;
$('musicvol').disabled = !settings.audio;
$('synth').disabled = !settings.audio;
$('synth').value = settings.synth;
$('synth').addEventListener('change', (e) => {
  settings.synth = e.target.value;
  saveSettings();
  audio.unlock();
  audio.setOpl3(settings.synth === 'opl3');
});
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
// demos: record, stop, play, download, load
$('demo-record').addEventListener('click', () => startRecording().catch((err) => setStatus(err.message, true)));
$('demo-stop').addEventListener('click', () => { if (recorder) finishRecording(); else if (demoPlayer) endPlayback('stopped'); });
$('demo-play').addEventListener('click', () => lastDemo && playDemo(lastDemo).catch((err) => setStatus(err.message, true)));
$('demo-download').addEventListener('click', () => {
  if (!lastDemo) return;
  const blob = new Blob([JSON.stringify(lastDemo)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `firebird-doom-${lastDemo.map}-${lastDemo.date.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('demo-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const demo = JSON.parse(await f.text());
    lastDemo = demo;
    updateDemoButtons();
    await playDemo(demo);
  } catch (err) { setStatus(`Can't read that demo: ${err.message}`, true); }
  e.target.value = '';
});
// saves as a file: this WAD's six slots out, a file's filled slots in
$('saves-export').addEventListener('click', async () => {
  if (!wadKey) return;
  try {
    const file = await exportSaves(saves, wadKey);
    if (!file.slots.some(Boolean)) { setStatus('No saves to export for this WAD yet.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
    a.download = `firebird-doom-saves-${wadKey.split('|')[0].replace(/\.wad$/i, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { setStatus(`Couldn't export the saves: ${err.message}`, true); }
});
$('saves-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !wadKey) return;
  try {
    const file = JSON.parse(await f.text());
    const over = (file.slots ?? []).map((r, i) => (r && saveSlots[i] ? i + 1 : 0)).filter(Boolean);
    if (over.length && !window.confirm(`Replace the saves in slot${over.length > 1 ? 's' : ''} ${over.join(', ')}?`)) return;
    const written = await importSaves(saves, wadKey, file);
    await refreshSlots();
    setStatus(`Imported ${written.length} save${written.length === 1 ? '' : 's'} (slot${written.length === 1 ? '' : 's'} ${written.map((i) => i + 1).join(', ')}).`);
  } catch (err) { setStatus(`Can't import those saves: ${err.message}`, true); }
});
updateDemoButtons();
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
  await applyView();
});

boot();
