// menu-test.mjs – the title loop and the menus, without a screen: navigation,
// New Game through episode and skill, Nightmare's question, the options and
// their sliders, Load/Save, Quit, and where m_menu.c draws everything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { Renderer } from '../src/renderer.js';
import { parseDehStrings } from '../src/finale.js';
import { Menu, TitleLoop } from '../src/menu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

const make = (opts = {}) => {
  const log = { games: [], sounds: [], ended: 0, quit: 0 };
  const state = { messages: true, detail: 'high', mouse: 5, sfx: 10, music: 7 };
  const actions = {
    newGame: (e, s) => log.games.push([e, s]), endGame: () => log.ended++, quit: () => log.quit++,
    get messages() { return state.messages; }, set messages(v) { state.messages = v; },
    get detail() { return state.detail; }, set detail(v) { state.detail = v; },
    get mouse() { return state.mouse; }, set mouse(v) { state.mouse = v; },
    get sfx() { return state.sfx; }, set sfx(v) { state.sfx = v; },
    get music() { return state.music; }, set music(v) { state.music = v; },
  };
  const m = new Menu({ episodes: 4, retail: true, sound: (s) => log.sounds.push(s), actions, ...opts });
  return { m, log, state };
};
const keys = (m, ...ks) => ks.forEach((k) => m.key(k));

// DOOM I: the main menu, New Game → episode → skill
{
  const { m, log } = make({ strings: new Map([['NIGHTMARE', 'Really?\n(Press Y to confirm)']]) });
  m.open();
  assert(m.active && m.current.name === 'main' && m.current.items.length === 6 && log.sounds[0] === 'DSSWTCHN',
    'Esc opens the main menu (six items with Read This!), with the switch sound');
  keys(m, 'Enter');
  assert(m.current.name === 'episode' && m.current.items.length === 4, 'New Game: the episode menu, four episodes');
  keys(m, 'ArrowDown', 'ArrowDown', 'Enter');
  assert(m.current.name === 'skill' && m.on === 2, 'episode 3 → the skill menu, Hurt Me Plenty (3) preselected');
  keys(m, 'ArrowDown', 'Enter');
  assert(log.games.join() === '3,4' && !m.active, 'skill 4 starts episode 3 on skill 4 and closes the menu');
  // the menus remember where the cursor was (lastOn): episode 3, Ultra-Violence
  m.open();
  keys(m, 'Enter');
  const ep = m.on;
  keys(m, 'Enter');
  assert(ep === 2 && m.on === 3, `reopened, New Game remembers episode ${ep + 1} and skill ${m.on + 1}`);
  // Nightmare asks first
  keys(m, 'ArrowDown', 'Enter');
  assert(m.message?.text === 'Really?\n(Press Y to confirm)' && m.message.yesno, 'Nightmare shows the WAD\'s NIGHTMARE question');
  keys(m, 'x');
  assert(m.message, '…any other key leaves it waiting');
  keys(m, 'n');
  assert(!m.message && m.active && log.games.length === 1, '…N backs out');
  keys(m, 'Enter', 'y');
  assert(log.games.at(-1).join() === '3,5', '…and Y starts Nightmare');
  // cursor wraps and skips empty rows; Backspace goes back; Esc closes
  m.open();
  keys(m, 'ArrowUp');
  assert(m.item.act === 'quit' && log.sounds.at(-1) === 'DSPSTOP', 'up from the top wraps to Quit (with the cursor click)');
  keys(m, 'ArrowDown', 'ArrowDown', 'Enter');
  assert(m.current.name === 'options', 'Options');
  keys(m, 'ArrowDown', 'ArrowDown', 'ArrowDown');
  assert(m.item.act === 'mouse', 'the cursor skips the blank rows to Mouse Sensitivity');
  keys(m, 'Backspace');
  assert(m.current.name === 'main', 'Backspace goes back a menu');
  keys(m, 'Escape');
  assert(!m.active && log.sounds.at(-1) === 'DSSWTCHX', 'Esc closes it');
}

// the options and their sliders
{
  const { m, state } = make();
  m.open();
  keys(m, 'ArrowDown', 'Enter');                // Options
  keys(m, 'ArrowDown', 'Enter');                // Messages: on → off
  keys(m, 'ArrowDown', 'ArrowRight');           // Detail: high → low
  keys(m, 'ArrowDown', 'ArrowLeft', 'ArrowLeft');   // Mouse: 5 → 3
  keys(m, 'ArrowDown', 'Enter');                // Sound Volume
  keys(m, 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight');   // sfx 10 → 15 (no further)
  keys(m, 'ArrowDown', 'ArrowLeft');            // music 7 → 6
  assert(!state.messages && state.detail === 'low' && state.mouse === 3 && state.sfx === 15 && state.music === 6,
    `options: messages off, detail ${state.detail}, mouse ${state.mouse}, sfx ${state.sfx} (capped at 15), music ${state.music}`);
  keys(m, 'Backspace', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Enter');   // (from Sound Volume, over the blanks)
  assert(m.message?.yesno && m.current.name === 'options', 'End Game asks first');
}

// Load and Save say they're not here yet; Quit asks with the WAD's message; Read This! pages
{
  const { m, log } = make({ strings: new Map([['QUITMSG', 'Leaving so soon?']]) });
  m.open();
  keys(m, 'ArrowDown', 'ArrowDown', 'Enter');
  const load = m.message;
  keys(m, 'Enter');
  assert(load && !load.yesno && !m.message && m.active, 'Load: a message, any key dismisses it');
  keys(m, 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter');
  assert(m.message?.text === 'Leaving so soon?\n\n(press y to quit)', 'Quit: the WAD\'s quit message, with "press y" added');
  keys(m, 'y');
  assert(log.quit === 1 && !m.active, '…Y quits (to the title, in a browser)');
  m.open();
  keys(m, 'ArrowUp', 'Enter');   // (the cursor is still on Quit)
  const p1 = m.page;
  keys(m, 'Enter');
  const p2 = m.page;
  keys(m, 'Enter');
  assert(p1 === 'HELP1' && p2 === 'CREDIT' && !m.page && m.current.name === 'main', 'Read This!: HELP1, then CREDIT on a four-episode WAD, then back');
}

// DOOM II: no episodes, no Read This!
{
  const { m, log } = make({ doom2: true, episodes: 0 });
  m.open();
  keys(m, 'Enter');
  assert(m.current.items.length === 5 || m.current.name === 'skill', 'DOOM II: five main items (no Read This!)');
  assert(m.current.name === 'skill' && m.current.prev === 'main', '…and New Game goes straight to the skill menu');
  keys(m, 'Enter');
  assert(log.games.at(-1).join() === '1,3', '…starting MAP01 on skill 3');
}

// where things are drawn (m_menu.c's coordinates)
{
  const calls = [];
  const stub = { pictureByName: (n) => ({ name: n, w: 8, h: 8, left: 0, top: 0 }), patch: (p, x, y) => calls.push(`${p?.name}@${x},${y}`) };
  const { m } = make();
  m.open();
  m.draw(stub);
  assert(calls[0] === 'M_DOOM@94,2' && calls[1] === 'M_NGAME@97,64' && calls[6] === 'M_QUITG@97,144' && calls[7] === 'M_SKULL1@65,59',
    `the main menu: ${calls[0]}, ${calls[1]} … ${calls[6]}, skull ${calls[7]}`);
  for (let i = 0; i < 8; i++) m.tick();
  calls.length = 0;
  m.draw(stub);
  assert(calls.at(-1).startsWith('M_SKULL2'), 'the skull blinks every 8 tics');
  keys(m, 'ArrowDown', 'Enter', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter');
  calls.length = 0;
  m.draw(stub);
  assert(calls.includes('M_SVOL@60,38') && calls.includes('M_THERML@80,80') && calls.includes('M_THERMO@168,80'),
    'the sound menu: the title and a thermometer at volume 10');
}

// the title loop
{
  const music = [];
  const t = new TitleLoop(false, true, (m) => music.push(m));
  const seen = [t.page];
  for (let i = 0; i < 170 + 200 + 200 + 1; i++) { t.tick(); if (seen.at(-1) !== t.page) seen.push(t.page); }
  assert(seen.join() === 'TITLEPIC,CREDIT,TITLEPIC' && music.join() === 'D_INTRO,D_INTRO',
    `DOOM I's title loop: ${seen.join(' → ')}, the title music each time round`);
  const t2 = new TitleLoop(true, false, (m) => music.push(m));
  assert(t2.page === 'TITLEPIC' && t2.tics === 385 && music.at(-1) === 'D_DM2TTL', 'DOOM II: TITLEPIC for 11 seconds, to D_DM2TTL');
}

// with the real WADs: every graphic the menus draw is there, and the strings
for (const file of ['freedoom1.wad', 'freedoom2.wad']) {
  const p = path.join(root, 'public/wads', file);
  if (!fs.existsSync(p)) { console.log(`(no ${file})`); continue; }
  const wad = new Wad(fs.readFileSync(p));
  const doom2 = file.includes('2');
  const strings = parseDehStrings(new TextDecoder('latin1').decode(wad.data(wad.lump('DEHACKED'))));
  const missing = new Set();
  const r = new Renderer(wad, { texDefs: [], flats: [] });
  const real = { pictureByName: (n) => { const pic = r.pictureByName(n); if (!pic) missing.add(n); return pic; }, patch: (pic, x, y) => r.patch(pic, x, y) };
  const { m } = make({ doom2, episodes: doom2 ? 0 : 4, strings });
  const t = new TitleLoop(doom2, !doom2);
  t.draw(real);
  m.open();
  for (const route of [[], ['Enter'], ['Enter', 'Enter'], ['Escape'], ['ArrowDown', 'Enter'], ['ArrowDown', 'Enter', 'ArrowUp', 'Enter']]) {
    m.close(true);
    m.open();
    keys(m, ...route);
    m.draw(real);
  }
  assert(missing.size === 0 && strings.get('NIGHTMARE'), `${file}: every menu and title graphic is in the WAD${missing.size ? ` (missing ${[...missing].join(' ')})` : ''}, and its NIGHTMARE string`);
}

console.log(failures ? `${failures} failure(s)` : 'menu ok');
process.exit(failures ? 1 : 0);
