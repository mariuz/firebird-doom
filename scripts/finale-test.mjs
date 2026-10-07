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

  // after the hero, the cast starts over
  const loop = new FinaleState('', cast);
  loop.startCast();
  for (let k = 0; k < cast.length; k++) { loop.press(); for (let i = 0; i < 200 && loop.mode === 'death'; i++) loop.tick(false); }
  assert(loop.castnum === 0, 'after the last of the cast, the first comes back');
}

console.log(failures ? `${failures} failure(s)` : 'finale ok');
process.exit(failures ? 1 : 0);
