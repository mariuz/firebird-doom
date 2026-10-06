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
import { DoomAudio, musicLumpFor } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const statusEl = $('status');
const statsEl = $('stats');

const TIC_MS = 1000 / 35;

let db;
let wad;
let res;
let renderer;
let map = null;      // { name, lines, sides, sectors, skyTex, linedefs }
let hud = null;      // last DOOM_TIC row
let sidesRev = -1;
let running = false;
let paused = false;
let lastTic = 0;
// settings, remembered per browser
const settings = { game: 'freedoom1', detail: 'high', renderer: 'bsp', audio: true, sfx: 70, music: 50 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('firebird-doom:settings') || '{}'));
} catch { /* storage unavailable: defaults */ }
const saveSettings = () => {
  try { localStorage.setItem('firebird-doom:settings', JSON.stringify(settings)); } catch { /* ignore */ }
};
const viewWidth = () => (settings.detail === 'high' ? 320 : 160);
let showMap = false;
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
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Tab') showMap = !showMap;
  if (e.code.startsWith('Digit')) weaponSel = Number(e.code.slice(5));
  if (e.code === 'KeyP' || e.code === 'Pause') paused = !paused;
  if (e.code === 'KeyM') setAudio(!settings.audio);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('click', () => {
  // (some embedded browsers refuse pointer lock; the keyboard still works)
  if (running && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
});
canvas.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement === canvas && e.button === 0) fireClick = true;
});
window.addEventListener('mouseup', () => { fireClick = false; });
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) mouseTurn -= e.movementX * 0.0035;
});

// Touch: left half moves, right half turns, tap on the right fires.
const touch = { move: null, look: null };
canvas.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    const r = canvas.getBoundingClientRect();
    const left = t.clientX - r.left < r.width / 2;
    const rec = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0, t: performance.now() };
    if (left) touch.move = rec; else touch.look = rec;
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
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
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
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
}, { passive: false });

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
  setStatus(`Loading ${name} into Firebird…`);
  const t0 = performance.now();
  await loadMap(db, wad, res, name, { skill: 3, newGame });
  map = { name, skyTex: skyFor(name) };
  const { rows } = await db.query(
    'SELECT id, front_side, back_side, flags, light_delta, x1, y1, x2, y2, front_sector, back_sector FROM linedefs',
    [], { rowMode: 'array' });
  map.lines = new Map(rows.map((r) => [r[0], { fs: r[1], bs: r[2], flags: r[3], lightDelta: r[4] }]));
  map.linedefs = rows;
  await loadSides();
  sidesRev = -1;
  console.log(`[firebird-doom] ${name} loaded in ${(performance.now() - t0).toFixed(0)} ms`);
  setStatus('');
  $('mapname').textContent = name;
  audio.playMusic(musicLumpFor(name));
  lastTic = performance.now();
  running = true;
}

function nextMap(name, secret) {
  const m = /^E(\d)M(\d)$/.exec(name);
  if (m) {
    const e = Number(m[1]);
    const n = Number(m[2]);
    const secretFrom = { 1: 3, 2: 5, 3: 6, 4: 2 }[e];
    let next;
    if (secret) next = `E${e}M9`;
    else if (n === 9) next = `E${e}M${secretFrom + 1}`;
    else if (n === 8) next = `E${e + 1}M1`;
    else next = `E${e}M${n + 1}`;
    return wad.lump(next) ? next : wad.mapNames()[0];
  }
  const n = Number(name.slice(3));
  const next = `MAP${String(n + 1).padStart(2, '0')}`;
  return wad.lump(next) ? next : wad.mapNames()[0];
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
  if (!running || paused || document.hidden) {
    lastTic = performance.now();
    nextFrame();
    return;
  }
  try {
    const now = performance.now();
    const tics = Math.max(1, Math.min(6, Math.round((now - lastTic) / TIC_MS)));
    lastTic += tics * TIC_MS;
    if (now - lastTic > 200) lastTic = now;

    let t = performance.now();
    hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', readInput(tics), { rowMode: 'object' })).rows[0];
    lastFrame.tic = performance.now() - t;

    if (hud.EXIT_KIND) {
      const kind = hud.EXIT_KIND;
      const stats = `Kills ${pct(hud.KILLS, hud.TOTAL_KILLS)}  Items ${pct(hud.ITEMS, hud.TOTAL_ITEMS)}  Secrets ${pct(hud.SECRETS, hud.TOTAL_SECRETS)}`;
      if (kind === 3) await startMap(map.name, true);
      else {
        setStatus(`${map.name} finished — ${stats}`);
        await new Promise((r) => setTimeout(r, 1500));
        await startMap(nextMap(map.name, kind === 2), false);
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
    lastFrame.walls = wallMs;
    lastFrame.sprites = spriteMs;
    lastFrame.rows = walls.length;

    t = performance.now();
    map.sectors = new Map(sectors.map((r) => [r[0], { floor: r[1], ceil: r[2], floorFlat: r[3], ceilFlat: r[4], light: r[5], sky: r[6] === 1 }]));
    const palette = hud.DAMAGE_COUNT ? Math.min(8, (hud.DAMAGE_COUNT + 7) >> 3)
      : hud.BONUS_COUNT ? Math.min(12, 8 + ((hud.BONUS_COUNT + 7) >> 3)) : 0;
    // invulnerable: the inverse colormap, flickering off in the last four seconds
    const fixedColormap = hud.INVULN_TICS > 4 * 32 || (hud.INVULN_TICS & 8) ? 32 : null;
    renderer.drawView({ x: hud.PX, y: hud.PY, z: hud.VIEW_Z, angle: hud.PANGLE, tic: hud.TIC, palette, fixedColormap },
      walls, sprites, map);
    renderer.composeView();
    if (!hud.DEAD) drawWeapon(renderer, hud, palette);
    drawStatusBar(renderer, hud, palette);
    if (hud.MSG) drawText(renderer, hud.MSG, 2, 2, palette);
    if (paused) drawText(renderer, 'PAUSED', 136, 80, palette);
    renderer.present();
    if (showMap) drawAutomap();
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

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

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
    `(${lastFrame.rows} slices, ${renderer.visplaneCount ?? 0} visplanes) · frame_sprites ${lastFrame.sprites.toFixed(0)} ms · raster ${lastFrame.draw.toFixed(0)} ms`;
}

function drawAutomap() {
  const ctx = renderer.ctx;
  const sc = 0.12;
  const cx = 160;
  const cy = 84;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 320, 168);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, 320, 168);
  ctx.lineWidth = 1;
  const tx = (x) => cx + (x - hud.PX) * sc;
  const ty = (y) => cy - (y - hud.PY) * sc;
  for (const r of map.linedefs) {
    const [, , bs, flags, , x1, y1, x2, y2, fsec, bsec] = r;
    if (flags & 128) continue; // ML_DONTDRAW
    const f = map.sectors.get(fsec);
    const b = bsec == null ? null : map.sectors.get(bsec);
    if (bs == null || !b) ctx.strokeStyle = '#fc0000';
    else if (f.floor !== b.floor) ctx.strokeStyle = '#bc7844';
    else if (f.ceil !== b.ceil) ctx.strokeStyle = '#fcfc00';
    else continue;
    ctx.beginPath();
    ctx.moveTo(tx(x1), ty(y1));
    ctx.lineTo(tx(x2), ty(y2));
    ctx.stroke();
  }
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  const a = hud.PANGLE;
  ctx.moveTo(cx + Math.cos(a) * 6, cy - Math.sin(a) * 6);
  ctx.lineTo(cx + Math.cos(a + 2.5) * 5, cy - Math.sin(a + 2.5) * 5);
  ctx.lineTo(cx + Math.cos(a - 2.5) * 5, cy - Math.sin(a - 2.5) * 5);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
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
  renderer = new Renderer(canvas, wad, res);
  audio.setWad(wad);
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
    // for the devtools console: await doom.sql('SELECT * FROM player')
    window.doom = { db, audio, sql: (q, p) => db.query(q, p).then((r) => r.rows) };
    await loadGame(settings.game);
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
$('detail').addEventListener('change', async (e) => {
  settings.detail = e.target.value;
  saveSettings();
  await setView(db, viewWidth(), 168);
  renderer.setSize(viewWidth(), 168);
});

boot();
