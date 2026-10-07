// intermission-test.mjs – the screen between levels, without a screen: the
// par table, the counting and its sounds, skipping, and what comes after.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { Renderer } from '../src/renderer.js';
import { Intermission, IntermissionState, levelOf, parTime } from '../src/intermission.js';

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

console.log(failures ? `${failures} failure(s)` : 'intermission ok');
process.exit(failures ? 1 : 0);
