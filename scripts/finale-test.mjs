// finale-test.mjs – DOOM II's ending, without a screen: the DEHACKED
// strings, the text's typing and skipping, and the cast call's walking,
// attacking, dying and moving on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { THING_TYPES } from '../src/thinginfo.js';
import { FinaleState, buildCast, parseDehStrings, Finale, frontLump } from '../src/finale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// BEX strings: \n escapes and backslash-continued lines
const s = parseDehStrings('Patch File for DeHackEd v3.0\n[STRINGS]\nCC_IMP = little devil\nC4TEXT = One line.\\n\\\n   Two lines.\\n\n[PARS]\n');
assert(s.get('CC_IMP') === 'little devil' && s.get('C4TEXT') === 'One line.\nTwo lines.\n', 'BEX [STRINGS]: plain, escaped and continued values');

const wadPath = path.join(root, 'public/wads/freedoom2.wad');
if (!fs.existsSync(wadPath)) {
  console.log('(no freedoom2.wad: run npm run fetch-wad)');
} else {
  const wad = new Wad(fs.readFileSync(wadPath));
  assert(Finale.available(wad, 'MAP30') && !Finale.available(wad, 'MAP29'), 'the ending follows MAP30, not MAP29');
  const strings = parseDehStrings(new TextDecoder('latin1').decode(wad.data(wad.lump('DEHACKED'))));
  const cast = buildCast(THING_TYPES, strings);
  const text = strings.get('C4TEXT');
  assert(text && text.length > 100 && cast.length === 17 && cast.every((c) => c.name && c.walk && c.death),
    `the WAD's story text (${text?.length} characters) and a cast of ${cast.length}, ending with "${cast.at(-1).name}"`);
  const names = wad.lumps.map((l) => l.name);
  const missing = cast.flatMap((c) => [...new Set([...c.walk, ...(c.attack ?? ''), ...(c.melee ?? ''), ...c.death])]
    .filter((f) => !frontLump(names, c.sprite, f)).map((f) => c.sprite + f));
  assert(missing.length === 0, `every cast frame has a front-facing sprite${missing.length ? ` (missing ${missing.join(' ')})` : ''}`);
  const d = frontLump(names, 'SKEL', 'D');
  assert(d?.name === 'SKELA1D1' && d.flip === true && frontLump(names, 'SKEL', 'A')?.flip === false,
    `a frame found in the second half of a name is drawn flipped (SKEL D: ${d?.name}, flip ${d?.flip})`);

  const sounds = [];
  const f = new FinaleState(text, cast, (snd) => sounds.push(snd));
  // the text types at a character every 3 tics, after 10
  for (let i = 0; i < 40; i++) f.tick(false);
  assert(f.stage === 'text' && f.shown === 10, `40 tics in, ${f.shown} characters showing`);
  f.tick(true);
  assert(f.stage === 'text', 'fire does nothing before 50 tics');
  for (let i = 0; i < 10; i++) f.tick(false);
  f.tick(true);
  assert(f.stage === 'cast' && f.castnum === 0 && sounds.includes(cast[0].seeSnd),
    `after 50 tics fire starts the cast with ${cast[0].name}, who announces itself (${cast[0].seeSnd})`);

  // walks for 12 frames, then attacks
  const modes = new Set();
  for (let i = 0; i < 12 * 4 + 2; i++) { f.tick(false); modes.add(f.mode); }
  assert(modes.has('see') && modes.has('attack') && sounds.includes(cast[0].atkSnd), `it walks, then attacks (${[...modes].join(', ')})`);

  // a key kills it: its death frames, then the next one comes on
  f.press();
  const deathFrames = [];
  for (let i = 0; i < 200 && f.castnum === 0; i++) { if (deathFrames.at(-1) !== f.pose.frame) deathFrames.push(f.pose.frame); f.tick(false); }
  assert(deathFrames.join('') === cast[0].death && sounds.includes(cast[0].deathSnd) && f.castnum === 1,
    `a key kills it (${deathFrames.join('')}, ${cast[0].deathSnd}), then ${cast[1].name} comes on`);
  f.press();
  f.press();   // (a second key while it's dying changes nothing)
  let ticks = 0;
  while (f.castnum === 1 && ticks++ < 200) f.tick(false);
  assert(f.castnum === 2, `one death per key (${ticks} tics for ${cast[1].name}'s)`);

  // the revenant alternates punch and missile
  const rev = new FinaleState('', [cast[11]]);
  rev.startCast();
  const attacks = [];
  for (let i = 0; i < 400 && attacks.length < 3; i++) { const was = rev.mode; rev.tick(false); if (rev.mode !== was && rev.mode !== 'see') attacks.push(rev.mode); }
  assert(attacks.join() === 'attack,melee,attack', `${cast[11].name}: missile, punch, missile (${attacks.join(', ')})`);

  // the story so far after MAP06, MAP11 and MAP20: text only, then the next map
  const quiet = { playMusic() {}, playEvents() {} };
  for (const [m, key] of [['MAP06', 'C1TEXT'], ['MAP11', 'C2TEXT'], ['MAP20', 'C3TEXT']]) {
    const fin = new Finale(null, quiet, wad, THING_TYPES, m);
    for (let i = 0; i < 60; i++) fin.tick(false);
    const waiting = fin.state.stage;
    fin.tick(true);
    assert(Finale.available(wad, m) && fin.state.text === strings.get(key) && waiting === 'text' && fin.done && fin.state.stage === 'done',
      `${m}: ${key} (${fin.state.text.length} characters), and fire goes on to the next map, no cast`);
  }
  assert(!Finale.available(wad, 'MAP07') && !Finale.available(wad, 'MAP15'), 'no text screen after other maps');

  // the secret levels' screens: only on the secret exit, and then on into the secret level
  const { nextMap } = await import('../src/progress.js');
  const maps = wad.mapNames();
  for (const [m, key, to] of [['MAP15', 'C5TEXT', 'MAP31'], ['MAP31', 'C6TEXT', 'MAP32']]) {
    const fin = new Finale(null, quiet, wad, THING_TYPES, m, true);
    for (let i = 0; i < 60; i++) fin.tick(false);
    fin.tick(true);
    const next = nextMap(m, fin.secret, maps);
    assert(Finale.available(wad, m, true) && !Finale.available(wad, m, false) && fin.state.text === strings.get(key)
      && fin.done && next === to,
      `${m}'s secret exit: ${key} (${fin.state.text.length} characters), then ${next}; its normal exit shows nothing`);
  }

  // after the hero, the cast starts over
  const loop = new FinaleState('', cast);
  loop.startCast();
  for (let k = 0; k < cast.length; k++) { loop.press(); for (let i = 0; i < 200 && loop.mode === 'death'; i++) loop.tick(false); }
  assert(loop.castnum === 0, 'after the last of the cast, the first comes back');
}

// DOOM I: the end of episode 1
const wad1Path = path.join(root, 'public/wads/freedoom1.wad');
if (fs.existsSync(wad1Path)) {
  const wad1 = new Wad(fs.readFileSync(wad1Path));
  const strings1 = parseDehStrings(new TextDecoder('latin1').decode(wad1.data(wad1.lump('DEHACKED'))));
  const music = [];
  const fin = new Finale(null, { playMusic: (m) => music.push(m), playEvents() {} }, wad1, THING_TYPES, 'E1M8');
  const len = fin.state.text.length;
  assert(Finale.available(wad1, 'E1M8') && !Finale.available(wad1, 'E1M7') && fin.state.text === strings1.get('E1TEXT')
    && music[0] === 'D_VICTOR' && fin.art === 'CREDIT',
    `E1M8: E1TEXT (${len} characters) to ${music[0]}, then ${fin.art} (a four-episode WAD)`);
  // the text can't be skipped; TEXTWAIT tics after the last character, the art
  for (let i = 0; i < 10 + len * 3 + 250; i++) fin.tick(true);
  const held = fin.state.stage;
  fin.tick(false);
  assert(held === 'text' && fin.state.stage === 'art', `fire held all along doesn't skip the text; ${10 + len * 3 + 250} tics in, the art screen`);
  // …and that's the end of the game: no key moves on (F_Ticker's finalestage 1)
  for (let i = 0; i < 35 * 60; i++) fin.tick(i % 2 === 0);
  fin.press();
  assert(fin.state.stage === 'art' && !fin.done, 'the art stays for good: a minute of fire and a key press later it is still up (the game is over)');

  // episodes 2–4: their own text, flat and art, and the end
  for (const [m, key, art] of [['E2M8', 'E2TEXT', 'VICTORY2'], ['E3M8', 'E3TEXT', 'bunny'], ['E4M8', 'E4TEXT', 'ENDPIC']]) {
    const tunes = [];
    const shots = [];
    const f = new Finale(null, { playMusic: (t) => tunes.push(t), playEvents: (rows) => shots.push(rows[0][1]) }, wad1, THING_TYPES, m);
    const n = f.state.text.length;
    for (let i = 0; i < 10 + n * 3 + 251; i++) f.tick(false);
    const atArt = f.state.stage;
    for (let i = 0; i < 1300; i++) f.tick(false);   // (the bunny's whole show)
    f.tick(true);
    const pic = art === 'bunny' ? 'PFUB1' : art;
    assert(Finale.available(wad1, m) && f.state.text === strings1.get(key) && f.art === art && !!wad1.lump(pic)
      && atArt === 'art' && !f.done && f.state.stage === 'art'
      && (art !== 'bunny' || (tunes.join() === 'D_VICTOR,D_BUNNY' && shots.filter((s) => s === 'DSPISTOL').length === 6)),
      `${m}: ${key} (${n} characters), then ${art}${art === 'bunny' ? ` to ${tunes[1]} with ${shots.filter((s) => s === 'DSPISTOL').length} pistol shots` : ''}, for good`);
  }
} else console.log('(no freedoom1.wad)');

// id's own doom.wad keeps the texts in the executable: no DEHACKED. Simulated
// by hiding Freedoom's (and, for the registered three-episode WAD, E4M1).
if (fs.existsSync(wad1Path)) {
  const base = new Wad(fs.readFileSync(wad1Path));
  const idLike = (hide) => {
    const w = Object.create(base);
    w.lump = (n) => (hide.includes(n) ? null : base.lump(n));
    return w;
  };
  const ultimate = idLike(['DEHACKED']);
  const registered = idLike(['DEHACKED', 'E4M1']);
  const tunes = [];
  const b = new Finale(null, { playMusic: (t) => tunes.push(t), playEvents() {} }, ultimate, THING_TYPES, 'E3M8');
  for (let i = 0; i < 1300; i++) b.tick(false);
  assert(Finale.available(ultimate, 'E3M8') && b.state.text === '' && b.art === 'bunny' && tunes[0] === 'D_BUNNY'
    && b.state.stage === 'art' && b.lastEnd === 6,
    `an id-style WAD (no DEHACKED): E3M8 goes straight to the bunny scroll, to ${tunes[0]}, all the way to THE END`);
  const e1u = new Finale(null, { playMusic() {}, playEvents() {} }, ultimate, THING_TYPES, 'E1M8');
  const e1r = new Finale(null, { playMusic() {}, playEvents() {} }, registered, THING_TYPES, 'E1M8');
  const e2 = new Finale(null, { playMusic() {}, playEvents() {} }, registered, THING_TYPES, 'E2M8');
  assert(e1u.art === 'CREDIT' && e1r.art === 'HELP2' && e1u.state.stage === 'art' && e2.art === 'VICTORY2' && e2.state.stage === 'art',
    `…E1M8 shows ${e1u.art} on the Ultimate DOOM layout, ${e1r.art} on the registered one; E2M8 ${e2.art}`);
  // DOOM II's text screens have nothing to show without their words
  const d2Path = path.join(root, 'public/wads/freedoom2.wad');
  if (fs.existsSync(d2Path)) {
    const d2 = new Wad(fs.readFileSync(d2Path));
    const id2 = Object.create(d2);
    id2.lump = (n) => (n === 'DEHACKED' ? null : d2.lump(n));
    const cm = [];
    const c = new Finale(null, { playMusic: (m) => cm.push(m), playEvents() {} }, id2, THING_TYPES, 'MAP30');
    assert(!Finale.available(id2, 'MAP06') && Finale.available(id2, 'MAP30') && c.state.stage === 'cast' && cm[0] === 'D_EVIL',
      `an id-style DOOM II with no fallback: no MAP06 text screen; MAP30 goes straight to the cast call, to ${cm[0]}`);

    // with the fallback the page loads (Freedoom Phase 2's text, as the build extracts it)
    const { setFallbackStrings, freedoomStrings } = await import('../src/finale.js');
    const extracted = freedoomStrings(d2);
    setFallbackStrings(extracted);
    const t6 = new Finale(null, { playMusic() {}, playEvents() {} }, id2, THING_TYPES, 'MAP06');
    const t30 = new Finale(null, { playMusic() {}, playEvents() {} }, id2, THING_TYPES, 'MAP30');
    const t15 = Finale.available(id2, 'MAP15', true);
    const own = new Finale(null, { playMusic() {}, playEvents() {} }, d2, THING_TYPES, 'MAP06');
    assert(Object.keys(extracted.strings).length === 6 && Finale.available(id2, 'MAP06') && t6.borrowed
      && t6.state.text === extracted.strings.C1TEXT && t30.state.stage === 'text' && t15 && !own.borrowed,
      `…with the fallback: MAP06 shows Freedoom's C1TEXT (${t6.state.text.length} characters), MAP30 its text before the cast, MAP15's secret exit C5TEXT; Freedoom's own WAD needn't borrow`);
    // DOOM I's endings don't borrow: without words they still go straight to the art
    const e3 = new Finale(null, { playMusic() {}, playEvents() {} }, ultimate, THING_TYPES, 'E3M8');
    assert(e3.state.stage === 'art' && !e3.borrowed, '…and DOOM I\'s endings still go straight to their art');
    setFallbackStrings(null);
  }
}

// F_BunnyScroll's clock: the scroll, then THE END a letter every 5 tics
{
  const { bunnyFrame } = await import('../src/finale.js');
  const at = (c) => { const b = bunnyFrame(c); return `${b.scrolled}/${b.end}`; };
  const cases = [[0, '320/null'], [230, '320/null'], [430, '220/null'], [870, '0/null'], [1130, '0/END0'], [1180, '0/END0'], [1185, '0/END1'], [1210, '0/END6'], [5000, '0/END6']];
  const bad = cases.filter(([c, want]) => at(c) !== want).map(([c, want]) => `${c}: ${at(c)} ≠ ${want}`);
  assert(bad.length === 0, `the bunny scroll's timing (${cases.length} moments${bad.length ? `; ${bad.join(', ')}` : ''})`);
}

console.log(failures ? `${failures} failure(s)` : 'finale ok');
process.exit(failures ? 1 : 0);
