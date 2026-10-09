// intermission-test.mjs – the screen between levels, without a screen: the
// par table, the counting and its sounds, skipping, and what comes after.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { Renderer } from '../src/renderer.js';
import { Intermission, IntermissionState, NetgameState, DeathmatchState, fragSum, levelOf, parTime } from '../src/intermission.js';
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

// a netgame's screens: co-op's rows of players (WI_updateNetgameStats) and the
// deathmatch frag matrix (WI_updateDeathmatchStats)
{
  // three players: 10/20 kills, 5/20, 20/20; player 1 killed player 2 twice and themself once, player 3 killed player 1
  const players = [
    { kills: 10, items: 5, secrets: 0, frags: [1, 2, 0] },
    { kills: 5, items: 10, secrets: 2, frags: [0, 0, 0] },
    { kills: 20, items: 0, secrets: 4, frags: [1, 0, 0] },
  ];
  const sums = players.map((_, i) => fragSum(players, i));
  assert(sums.join() === '1,0,1', `WI_fragSum: others killed less yourself: ${sums.join(' ')}`);
  const ngSounds = [];
  const ng = new NetgameState({ ...stats, totalKills: 20, totalItems: 20, totalSecrets: 4, players, me: 2 }, false, (x) => ngSounds.push(x));
  let t = 0;
  while (ng.ng !== 10 && t++ < 2000) ng.tick(false);
  const rows = ng.cnt.map((c) => `${c.kills}/${c.items}/${c.secret}/${c.frags}`);
  assert(ng.kind === 'coop' && ng.dofrags && rows.join(' ') === '50/25/0/1 25/50/50/0 100/0/100/1' && ngSounds.filter((x) => x === 'DSBAREXP').length === 3
    && ngSounds.at(-1) === 'DSPLDETH' && t > 35 * 4,
    `co-op: every player's kills, items and secrets count up together, then the frags (${rows.join('  ')}; ${t} tics, the frags end with a death cry)`);
  const ng0 = new NetgameState({ ...stats, players: players.map((p) => ({ ...p, frags: [0, 0, 0] })) }, false, () => {});
  t = 0;
  while (ng0.ng !== 10 && t++ < 2000) ng0.tick(false);
  assert(!ng0.dofrags && ng0.cnt.every((c) => c.frags === 0), 'without a frag between them, no frags column (dofrags)');
  ng.tick(true);
  assert(ng.stage === 'next', 'a press once it is all there: the episode map');
  const ng2 = new NetgameState({ ...stats, players }, true, () => {});
  ng2.tick(true);
  assert(ng2.ng === 10 && ng2.cnt[0].kills === ng2.final[0].kills, 'a press mid-count: the final numbers at once');

  const dmSounds = [];
  const dm = new DeathmatchState({ players, me: 1 }, false, (x) => dmSounds.push(x));
  t = 0;
  while (dm.dm !== 4 && t++ < 2000) dm.tick(false);
  assert(dm.kind === 'dm' && dm.frags.map((r) => r.join('')).join(' ') === '120 000 100' && dm.totals.join() === '1,0,1'
    && dmSounds.filter((x) => x === 'DSBAREXP').length === 1 && t > 35 * 2,
    `deathmatch: the frag matrix counts up one a tic (${dm.frags.map((r) => r.join(' ')).join(' | ')}), the totals with it (${dm.totals.join(' ')})`);
  dm.tick(true);
  assert(dm.stage === 'next' && dmSounds.at(-1) === 'DSSLOP', 'a press: a splat, and on');
  const big = new DeathmatchState({ players: [{ frags: [0, 150] }, { frags: [120, 0] }] }, true, () => {});
  big.tick(true);
  assert(big.frags[0][1] === 150 && big.totals[0] === 150, 'a press mid-count shows the real numbers');
  const neg = new DeathmatchState({ players: [{ frags: [3, 0] }, { frags: [0, 0] }] }, true, () => {});
  t = 0;
  while (neg.dm !== 4 && t++ < 2000) neg.tick(false);
  assert(neg.totals[0] === -3 && neg.frags[0][0] === 3, `three suicides: 3 in your own square, a total of ${neg.totals[0]}`);

  // drawn where vanilla draws them
  const calls = [];
  const stub = { pictureByName: (n) => ({ name: n, w: 10, h: 10, left: 0, top: 0 }), patch: (p, x, y) => calls.push(`${p?.name}@${x},${y}`), present() {}, sfb: new Uint8Array(64000) };
  const audio = { playMusic() {}, playEvents() {} };
  const wi = new Intermission(stub, audio, { lump: () => null }, 'MAP02', 'MAP03', { ...stats, players, me: 2 });
  for (let i = 0; i < 400; i++) wi.tick(false);
  wi.draw();
  const at = (n) => calls.filter((c) => c.startsWith(n + '@')).map((c) => c.split('@')[1]);
  // NG_STATSX = 32 + star.w/2 = 37 with frags: titles right-aligned at 37 + 64k, player 2's face (STPB1) with the star
  assert(wi.state.kind === 'coop' && at('WIOSTK')[0] === '91,50' && at('WIOSTI')[0] === '155,50' && at('WIOSTS')[0] === '219,50' && at('WIFRGS')[0] === '283,50'
    && at('STPB0')[0] === '27,60' && at('STPB1')[0] === '27,93' && at('STFST01')[0] === '27,93' && at('WIPCNT').length === 9 && at('WINUM1').length >= 2,
    `co-op's screen: the titles along the top (kills at ${at('WIOSTK')[0]}, frags at ${at('WIFRGS')[0]}), a row per player 33 apart, the star on player 2`);
  calls.length = 0;
  const wd = new Intermission(stub, audio, { lump: () => null }, 'E1M1', 'E1M2', { ...stats, players, me: 1, deathmatch: 1 });
  for (let i = 0; i < 400; i++) wd.tick(false);
  wd.draw();
  assert(wd.state.kind === 'dm' && at('WIKILRS')[0] === '10,100' && at('WIVCTMS')[0] === '5,50' && at('WIMSTT')[0] === '264,45'
    && at('STPB0').join(' ') === '77,35 37,68' && at('STPB2').join(' ') === '157,35 37,134' && at('STFDEAD0')[0] === '77,35' && at('STFST01')[0] === '37,68'
    && at('WINUM2')[0] === '122,78' && at('WINUM1').includes('269,78'),
    `deathmatch's screen: killers down the side, victims along the top, each player's face both ways (the dead one over your column), the matrix 40 apart (player 1's 2 kills of player 2 at ${at('WINUM2')[0]}), the totals at 269`);
}

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
