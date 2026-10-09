// intermission-test.mjs – the screen between levels, without a screen: the
// par table, the counting and its sounds, skipping, and what comes after.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { Renderer } from '../src/renderer.js';
import { Intermission, IntermissionState, levelOf, parTime } from '../src/intermission.js';
import { Melt } from '../src/wipe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// levels and par times (vanilla's pars / cpars tables)
const l = levelOf('E2M9');
assert(!l.doom2 && l.episode === 1 && l.map === 8 && levelOf('MAP07').doom2 && levelOf('MAP07').map === 6, 'level names: E2M9 is episode 1, map 8; MAP07 is map 6 (0-based)');
const pars = [['E1M1', 30], ['E1M8', 30], ['E3M9', 135], ['E4M1', null], ['MAP01', 30], ['MAP30', 180], ['MAP32', 30], ['MAP33', null]];
const badPar = pars.filter(([m, p]) => parTime(m) !== p).map(([m, p]) => `${m}: ${parTime(m)} ≠ ${p}`);
assert(badPar.length === 0, `par times (${pars.length} levels${badPar.length ? `; ${badPar.join(', ')}` : ''})`);

// the counting: 15/20 kills, 9/10 items, 1/4 secrets, 95 seconds against a par of 75
const stats = { kills: 15, totalKills: 20, items: 9, totalItems: 10, secrets: 1, totalSecrets: 4, time: 95 * 35, par: 75 };
const sounds = [];
const s = new IntermissionState(stats, false, (snd) => sounds.push(snd));
let ticks = 0;
while (s.sp !== 10 && ticks++ < 2000) s.tick(false);
const pistols = sounds.filter((x) => x === 'DSPISTOL').length;
const booms = sounds.filter((x) => x === 'DSBAREXP').length;
assert(s.cnt.kills === 75 && s.cnt.items === 90 && s.cnt.secret === 25 && s.cnt.time === 95 && s.cnt.par === 75,
  `it counts up to 75% kills, 90% items, 25% secrets, 1:35 against a par of 1:15 (${ticks} tics)`);
assert(booms === 4 && pistols > 20, `with ${pistols} pistol shots on the way and a barrel explosion as each settles (${booms})`);
for (let i = 0; i < 200; i++) s.tick(false);
assert(s.stage === 'stats', 'with everything counted it waits for you');
s.tick(true);
assert(s.stage === 'next' && sounds.at(-1) === 'DSSGCOCK', 'fire: the shotgun cocks and DOOM I shows the episode map');
let blink = new Set();
for (let i = 0; i < 4 * 35 - 1; i++) { s.tick(false); blink.add(s.pointer); }
assert(blink.size === 2 && s.stage === 'next', '"you are here" blinks for four seconds');
s.tick(false);
for (let i = 0; i < 10; i++) s.tick(false);
assert(s.done, '…then the next level');

// skipping: a press mid-count jumps to the final numbers
const s2 = new IntermissionState(stats, false, () => {});
for (let i = 0; i < 50; i++) s2.tick(false);
const mid = s2.cnt.kills;
s2.tick(true);
assert(mid > 0 && mid < 75 && s2.cnt.kills === 75 && s2.cnt.time === 95 && s2.sp === 10, `fire mid-count (kills at ${mid}%) shows the final numbers at once`);
s2.tick(true);
assert(s2.stage === 'next', 'and another press moves on');

// DOOM II: no episode map, a moment of "Entering", then on; nothing to count is 0%
const s3 = new IntermissionState({ ...stats, totalKills: 0, kills: 0 }, true, () => {});
s3.tick(true);
s3.tick(true);
assert(s3.cnt.kills === 0 && s3.stage === 'nostate', 'DOOM II: straight to "Entering" (and no monsters at all counts as 0%)');
for (let i = 0; i < 10; i++) s3.tick(false);
assert(s3.done, '…for ten tics, then on');

// the episode maps' animations (WI_updateAnimatedBack)
{
  const { BackAnims } = await import('../src/intermission.js');
  // episode 1: ten of them, three frames 11 tics apart (started together here: random 0)
  const e1 = new BackAnims(0, 3, () => 0);
  const seen = [];
  for (let bcnt = 1; bcnt <= 40; bcnt++) { e1.update(bcnt, true); seen.push(e1.frames[0]?.lump ?? '-'); }
  assert(e1.list.length === 10 && seen[0] === 'WIA00000' && seen[11] === 'WIA00001' && seen[22] === 'WIA00002' && seen[33] === 'WIA00000',
    `episode 1: ten animations, each cycling WIA00000 → 01 → 02 every 11 tics`);
  // a random start staggers them
  let k = 0;
  const e1r = new BackAnims(0, 3, () => [0, 0.5, 0.9][k++ % 3]);
  assert(new Set(e1r.list.map((a) => a.nexttic)).size === 3, 'their starts are staggered within the period');

  // episode 2: only the level being entered lights up, and stays lit
  const e2 = new BackAnims(1, 3, () => 0);
  for (let bcnt = 1; bcnt <= 60; bcnt++) e2.update(bcnt, true);
  const lit = e2.frames.map((f) => f.lump);
  assert(lit.join() === 'WIA10200', `episode 2, entering E2M4: only its light, the one waiting for map 3 (${lit.join()})`);
  // entering E2M9 (next 8): the three-frame one waits for the stats, then plays and holds; the ninth borrows the fifth's pictures
  const e9 = new BackAnims(1, 8, () => 0);
  for (let bcnt = 1; bcnt <= 30; bcnt++) e9.update(bcnt, true);
  const during = e9.frames.map((f) => f.lump).join();
  e9.reset(30);
  for (let bcnt = 31; bcnt <= 120; bcnt++) e9.update(bcnt, false);
  const after = e9.frames.map((f) => f.lump).join();
  assert(during === 'WIA10400' && after === 'WIA10702,WIA10400',
    `entering E2M9: during the count only ${during} (the fifth's picture); afterwards the big one plays to its last frame (${after})`);
  // episode 3 has a faster one; DOOM II and episode 4 have none
  const e3 = new BackAnims(2, 0, () => 0);
  assert(e3.list.length === 6 && e3.list[5].period === 8 && new BackAnims(3, 0).list.length === 0 && new BackAnims(-1, 0).list.length === 0,
    'episode 3: six, the last at 8 tics; episode 4 and DOOM II: none');

  // drawn where vanilla draws them, between the background and the stats
  const calls = [];
  const stub = { pictureByName: (n) => ({ name: n, w: 10, h: 10, left: 0, top: 0 }), patch: (p, x, y) => calls.push(`${p?.name}@${x},${y}`), present() {}, sfb: new Uint8Array(64000) };
  const wad1 = { lump: () => null };
  const wi = new Intermission(stub, { playMusic() {}, playEvents() {} }, wad1, 'E1M3', 'E1M4', stats);
  wi.anims = new BackAnims(0, 3, () => 0);
  wi.tick(false);
  wi.draw();
  assert(calls[0] === 'WIMAP0@0,0' && calls[1] === 'WIA00000@224,104' && calls[10] === 'WIA00900@64,24' && calls[11].startsWith('WILV02'),
    `drawn on the map, under the stats: ${calls.slice(0, 3).join(' ')} … ${calls[10]}`);
}

// DOOM II's secret levels: their names, pars and "Entering" (none on the way into MAP31)
{
  const shown = (from, to) => {
    const calls = [];
    const stub = { pictureByName: (n) => ({ name: n, w: 10, h: 10, left: 0, top: 0 }), patch: (p) => calls.push(p?.name), present() {}, sfb: new Uint8Array(64000) };
    const wi = new Intermission(stub, { playMusic() {}, playEvents() {} }, { lump: () => null }, from, to, stats);
    wi.draw();
    const title = calls.find((n) => n?.startsWith('CWILV'));
    wi.tick(true);
    wi.tick(true);   // (DOOM II: straight from the stats to "Entering")
    calls.length = 0;
    wi.draw();
    const entering = calls.includes('WIENTER') ? calls.find((n) => n?.startsWith('CWILV')) : null;
    return `${title} par ${wi.state.final.par} → ${entering ?? 'no Entering'}`;
  };
  const routes = [
    ['MAP15', 'MAP31', 'CWILV14 par 210 → no Entering'],
    ['MAP31', 'MAP32', 'CWILV30 par 120 → CWILV31'],
    ['MAP31', 'MAP16', 'CWILV30 par 120 → CWILV15'],
    ['MAP32', 'MAP16', 'CWILV31 par 30 → CWILV15'],
    ['MAP30', 'MAP01', 'CWILV29 par 180 → no Entering'],
  ];
  const wrong = routes.filter(([f, t, want]) => shown(f, t) !== want).map(([f, t, want]) => `${f}→${t}: ${shown(f, t)} ≠ ${want}`);
  assert(wrong.length === 0, `the secret levels' intermissions (${routes.length} routes${wrong.length ? `; ${wrong.join('; ')}` : ''})`);
}

// the screens draw from each WAD's own graphics
for (const [file, from, to] of [['freedoom1.wad', 'E1M3', 'E1M4'], ['freedoom2.wad', 'MAP07', 'MAP08']]) {
  const p = path.join(root, 'public/wads', file);
  if (!fs.existsSync(p)) { console.log(`(no ${file})`); continue; }
  const wad = new Wad(fs.readFileSync(p));
  const r = new Renderer(wad, { texDefs: [], flats: [] });
  const music = [];
  const wi = new Intermission(r, { playMusic: (m) => music.push(m), playEvents() {} }, wad, from, to, stats);
  let drew = 0;
  try {
    for (let i = 0; i < 400; i++) { wi.tick(i === 300); wi.draw(); drew++; }
  } catch (err) { console.log(err); }
  const lit = r.sfb.reduce((n, v) => n + (v ? 1 : 0), 0);
  assert(drew === 400 && lit > 20000 && music[0] === (from.startsWith('MAP') ? 'D_DM2INT' : 'D_INTER'),
    `${file}: ${from} → ${to} draws (${lit} pixels lit) to ${music[0]}`);
}

// the screen melt (f_wipe.c): the old screen slides down in two-pixel columns over the new one
{
  const old = new Uint8Array(320 * 200).fill(1);
  const neu = new Uint8Array(320 * 200).fill(2);
  for (let x = 0; x < 320; x++) old[x] = 3;                   // the old screen's top row
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256) / 256;
  const m = new Melt(old, neu, rnd);
  const y0 = [...m.y];
  const steps = y0.slice(1).map((y, i) => Math.abs(y - y0[i]));
  assert(y0.every((y) => y <= 0 && y > -16) && Math.max(...steps) <= 1,
    `wipe_initMelt: 160 columns start 0–15 tics late, each within a tic of its neighbour (${Math.min(...y0)}…${Math.max(...y0)})`);
  const out = new Uint8Array(320 * 200);
  m.draw(out);
  const same = out.every((v, i) => v === old[i]);
  // the earliest column, after its wait and one tic, has dropped 1 pixel: a row of the new
  // screen over the old one's top row; a column still waiting hasn't moved
  const lead = Math.max(...y0);
  const c = y0.indexOf(lead);
  const late = y0.indexOf(Math.min(...y0));
  m.tick(1 - lead);
  m.draw(out);
  const moved = out[c * 2] === 2 && out[c * 2 + 1] === 2 && out[320 + c * 2] === 3 && out[late * 2] === 3;
  let tics = 1 - lead;
  const seen = [];
  while (!m.tick(1)) {
    tics++;
    if (tics === 10) seen.push(m.draw(out).filter((v) => v === 2).length);
  }
  m.draw(out);
  assert(same && moved && seen[0] > 0 && seen[0] < 320 * 200 && out.every((v) => v === 2),
    `wipe_doMelt: it starts as the old screen, a due column drops 1 pixel, then 2, 3… then 8 a tic; done in ${tics} tics, the new screen whole`);
  assert(tics >= 30 && tics <= 50, `…which takes about a second (${tics} tics; vanilla's is 15 + ~30)`);
}

console.log(failures ? `${failures} failure(s)` : 'intermission ok');
process.exit(failures ? 1 : 0);
