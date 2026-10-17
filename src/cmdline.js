// cmdline.js – d_main.c's command line, as the page's URL parameters:
//
//   ?warp=E1M3&skill=4&fast          a game at once, as `doom -warp 1 3 -skill 4 -fast`
//
// DOOM read its options with M_CheckParm in D_DoomMain; a link can carry the
// same ones. A parameter without a value is a switch (`&fast`). What the
// options mean, and which start a game straight away (autostart), is DOOM's:
//
//   iwad=freedoom1|freedoom2     -iwad: which of the bundled WADs (this visit only)
//   warp=E1M3 | MAP07 | 1,3 | 13 | 7   -warp: that map (DOOM: `-warp e m`, DOOM II `-warp m`)
//   episode=2                    -episode: E2M1
//   skill=1…5                    -skill (the Skill setting, as if chosen)
//   nomonsters, respawn, fast    -nomonsters, -respawn, -fast
//   nomusic, nosfx, nosound      -nomusic, -nosfx, -nosound: silent for this visit
//   record                       -record: the game starts recording a demo
//   playdemo=demo1…4 | last      -playdemo: a demo (the title loop's, or the last recorded)
//   timedemo=demo1…4 | last      -timedemo: the demo as fast as it will go, timed (G_TimeDemo)
//   deathmatch, altdeath, timer=N   -deathmatch, -altdeath, -timer: the netgame panel's
//
// Anything else is ignored, as DOOM ignores what it doesn't look for.

import { clevMap } from './cheats.js';

const SWITCHES = ['nomonsters', 'respawn', 'fast', 'nomusic', 'nosfx', 'nosound', 'record', 'deathmatch', 'altdeath'];
const VALUED = ['iwad', 'warp', 'episode', 'skill', 'playdemo', 'timedemo', 'timer'];

/**
 * The options in a query string, checked as far as they can be before a WAD
 * is loaded: { iwad, warp, episode, skill, options, sound, record, demo,
 * netgame, autostart, unknown, problems }.
 */
export function parseCommandLine(search) {
  const q = new URLSearchParams(search);
  const has = (k) => q.has(k);
  const cl = {
    iwad: null, warp: null, episode: null, skill: null,
    options: { nomonsters: has('nomonsters') ? 1 : 0, respawn: has('respawn') ? 1 : 0, fast: has('fast') ? 1 : 0 },
    sound: { music: !has('nomusic') && !has('nosound'), sfx: !has('nosfx') && !has('nosound') },
    record: has('record'),
    demo: null,              // { name, timed }
    netgame: { deathmatch: has('altdeath') ? 2 : has('deathmatch') ? 1 : null, timer: null },
    autostart: false,
    unknown: [...q.keys()].filter((k) => !SWITCHES.includes(k) && !VALUED.includes(k)),
    problems: [],
  };
  const iwad = q.get('iwad');
  if (iwad !== null) {
    const name = iwad.toLowerCase().replace(/\.wad$/, '');
    if (name === 'freedoom1' || name === 'freedoom2') cl.iwad = name;
    else cl.problems.push(`iwad: only freedoom1 and freedoom2 are bundled (${iwad})`);
  }
  if (q.get('warp')) { cl.warp = q.get('warp').trim(); cl.autostart = true; }
  const ep = q.get('episode');
  if (ep !== null) {
    if (/^[1-4]$/.test(ep)) { cl.episode = Number(ep); cl.autostart = true; } else cl.problems.push(`episode: 1 to 4 (${ep})`);
  }
  const skill = q.get('skill');
  if (skill !== null) {
    // (D_DoomMain: -skill starts a game too)
    if (/^[1-5]$/.test(skill)) { cl.skill = Number(skill); cl.autostart = true; } else cl.problems.push(`skill: 1 to 5 (${skill})`);
  }
  for (const [k, timed] of [['playdemo', false], ['timedemo', true]]) {
    const v = q.get(k);
    if (v === null) continue;
    if (/^(demo[1-4]|last)$/i.test(v)) cl.demo = { name: v.toLowerCase(), timed };
    else cl.problems.push(`${k}: demo1 to demo4, or last (${v})`);
  }
  const timer = q.get('timer');
  if (timer !== null) {
    if (/^\d{1,3}$/.test(timer)) cl.netgame.timer = Number(timer); else cl.problems.push(`timer: minutes, 0 to 999 (${timer})`);
  }
  return cl;
}

/**
 * The map a game starts on, with the WAD's maps known: -warp's (E1M3, MAP07,
 * `1,3` or `1 3` as DOOM's two numbers, or IDCLEV's digits: 13 is E1M3 in DOOM,
 * MAP13 in DOOM II, and a single digit is padded), else -episode's first map,
 * else null (the title, or the Map selector's choice). Throws when it isn't there.
 */
export function startMapFor(cl, mapNames) {
  const doom2 = mapNames.some((m) => m.startsWith('MAP'));
  if (cl.warp) {
    const w = cl.warp.toUpperCase();
    let name = null;
    if (/^(E\dM\d|MAP\d\d)$/.test(w)) name = w;
    else if (/^\d[ ,.]\d$/.test(w)) name = doom2 ? null : `E${w[0]}M${w[2]}`;
    else if (/^\d\d?$/.test(w)) name = clevMap(w.padStart(2, '0'), mapNames);
    if (!name || !mapNames.includes(name)) throw new Error(`warp: this WAD has no map ${cl.warp}`);
    return name;
  }
  if (cl.episode) {
    if (doom2) return mapNames[0];   // (DOOM II has no episodes: -episode starts at MAP01)
    const name = `E${cl.episode}M1`;
    if (!mapNames.includes(name)) throw new Error(`episode: this WAD has no episode ${cl.episode}`);
    return name;
  }
  return cl.autostart ? (mapNames.find((m) => m === 'E1M1' || m === 'MAP01') ?? mapNames[0]) : null;
}
