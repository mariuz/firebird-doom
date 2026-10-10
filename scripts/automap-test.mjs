// automap-test.mjs – the automap's window (am_map.c): zoom, follow, panning,
// the whole-level view, marks and the grid, headless.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../src/wad.js';
import { AM_COLORS, AM_STRINGS, AutomapView, MAPBLOCKUNITS, automapPlayers, THEIR_COLORS, INVISIBLE_COLOR } from '../src/automap.js';
import { parseDehStrings } from '../src/finale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad')));
const m = wad.map('E1M1');
const xs = m.vertexes.map((v) => v.x);
const ys = m.vertexes.map((v) => v.y);
const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
const origin = wad.blockmapOrigin('E1M1');
const am = new AutomapView(bounds, origin);
const none = {};
const start = m.things.find((t) => t.type === 1);
const player = { x: start.x, y: start.y };   // (the player start)

// AM_LevelInit: whole level at the smallest scale, the start at min / 0.7, following
const fits = (bounds.maxX - bounds.minX) * am.minScale <= 320 + 1e-9 && (bounds.maxY - bounds.minY) * am.minScale <= 168 + 1e-9;
assert(fits && near(am.scale, am.minScale / 0.7) && near(am.maxScale, 168 / 32) && am.follow && !am.grid && origin,
  `E1M1: the whole level fits at ${am.minScale.toFixed(3)} px/unit, the map opens at ${am.scale.toFixed(3)}, up to ${am.maxScale}; BLOCKMAP origin ${origin}`);

// following: the window sits on the player
am.tick(1, none, player);
const [sx, sy] = am.toScreen(player.x, player.y);
assert(am.x === player.x && am.y === player.y && sx === 160 && sy === 84, 'following, the player is in the middle of the window');

// = and -: 1.02 a tic, within the limits
const s0 = am.scale;
am.tick(10, { zoomIn: true }, player);
const zoomed = am.scale;
am.tick(1000, { zoomIn: true }, player);
const top = am.scale;
am.tick(1000, { zoomOut: true }, player);
assert(near(zoomed, s0 * 1.02 ** 10) && near(top, am.maxScale) && near(am.scale, am.minScale),
  `zoom: ten tics of = make it ${(zoomed / s0).toFixed(4)}×; held, it stops at the largest scale, and - at the smallest`);

// follow off: the arrows pan four pixels a tic, kept within the level
am.scale = 0.25;
const said = am.toggleFollow();
am.tick(10, { right: true, up: true }, player);
const panned = [am.x - player.x, am.y - player.y];
am.tick(100000, { left: true }, player);
assert(said === 'AMSTR_FOLLOWOFF' && near(panned[0], 160) && near(panned[1], 160) && near(am.x, bounds.minX),
  `follow off ("${AM_STRINGS[said]}"): ten tics right and up move the window 40 pixels (160 units at 0.25), and it stops at the level's edge`);
assert(am.toggleFollow() === 'AMSTR_FOLLOWON' && (am.tick(1, none, player), am.x === player.x), 'F again: back on the player');

// 0: the whole level, centred; again, back
const before = { x: am.x, y: am.y, scale: am.scale };
am.toggleBig();
const big = { x: am.x, y: am.y, scale: am.scale, follow: am.follow };
am.toggleBig();
assert(near(big.scale, am.minScale) && near(big.x, (bounds.minX + bounds.maxX) / 2) && !big.follow
    && am.x === before.x && am.y === before.y && am.scale === before.scale,
  '0 shows the whole level, centred (following stops); 0 again puts the window back');

// marks: ten, at the window's centre, the oldest replaced; C clears them
for (let i = 0; i < 12; i++) { am.x = i * 100; am.addMark(); }
const marks = am.marks.map(([x]) => x);
const cleared = am.clearMarks();
assert(marks.length === 10 && marks[0] === 1000 && marks[1] === 1100 && marks[2] === 200 && am.marks.length === 0 && cleared === 'AMSTR_MARKSCLEARED',
  `M marks the window's centre, ten at most (the 11th and 12th replace the first two: ${marks.slice(0, 3).join(', ')}…); C clears them`);

// G: the grid follows the BLOCKMAP's 128-unit cells from its origin
am.toggleGrid();
am.tick(1, none, player);
const grid = am.gridLines();
const vertical = grid.filter(([x1, , x2]) => x1 === x2).map(([x]) => x);
assert(am.grid && vertical.length > 2 && vertical.every((x) => near(((x - origin[0]) % MAPBLOCKUNITS + MAPBLOCKUNITS) % MAPBLOCKUNITS, 0))
    && vertical.every((x) => Math.abs(x - am.x) <= 160 / am.scale + 1e-9),
  `G: ${vertical.length} vertical grid lines across the window, every one on a BLOCKMAP cell edge`);

// the messages: Freedoom's DEHACKED has its own wording, and the fallback is the same
const strings = parseDehStrings(wad.dehacked());
assert(Object.keys(AM_STRINGS).every((k) => strings.get(k) === AM_STRINGS[k]),
  'the messages come from DEHACKED (AMSTR_*); without one, Freedoom\'s same words');

// AM_drawPlayers: alone, your arrow in white; in co-op everyone's in their
// colour (near black while invisible); in deathmatch only your own
{
  const four = [1, 2, 3, 4].map((id) => ({ id, x: id * 100, y: 0, angle: 0, invis: id === 3 ? 50 : 0 }));
  const solo = automapPlayers(four.slice(0, 1), { me: 1 });
  const coop = automapPlayers(four, { me: 2, netgame: true });
  const dm = automapPlayers(four, { me: 2, netgame: true, deathmatch: 1 });
  const dmInvis = automapPlayers(four, { me: 3, netgame: true, deathmatch: 2 });
  assert(solo.length === 1 && solo[0].color === AM_COLORS.player && AM_COLORS.player === 209,
    'alone: your arrow, in white (YOURCOLORS)');
  assert(coop.map((a) => a.color).join() === [112, 96, INVISIBLE_COLOR, 176].join() && THEIR_COLORS.join() === '112,96,64,176' && INVISIBLE_COLOR === 246,
    `co-op: four arrows, green, grey, brown and red (their_colors[]), the invisible one near black (${coop.map((a) => a.color).join(', ')})`);
  assert(dm.length === 1 && dm[0].id === 2 && dm[0].color === 96 && dmInvis.length === 1 && dmInvis[0].color === INVISIBLE_COLOR,
    'deathmatch: only your own arrow, in your colour (near black while you\'re invisible)');
}

console.log(failures ? `${failures} failure(s)` : 'automap ok');
process.exit(failures ? 1 : 0);
