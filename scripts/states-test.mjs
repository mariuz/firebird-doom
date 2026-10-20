// states-test.mjs – DOOM's frame tables, phase 0 (docs/ROADMAP.md): info.c's
// states and mobjinfo's state columns (src/states.js), loaded into Firebird,
// whole and consistent, and each of this port's thing types tied to its DOOM
// type. Nothing plays from them yet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, typeStates } from '../src/loader.js';
import { STATES, MOBJINFO } from '../src/states.js';
import { THING_TYPES, MOBJ_TYPE } from '../src/thinginfo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://states', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
await loadResources(db, wad);
const all = async (q) => (await db.query(q)).rows;
const one = async (q) => (await all(q))[0];

// the table, whole
const n = await one('SELECT COUNT(*) n, MIN(id) lo, MAX(id) hi FROM states');
const dangling = await one('SELECT COUNT(*) n FROM states s WHERE NOT EXISTS (SELECT 1 FROM states t WHERE t.id = s.next_state)');
const forever = await one('SELECT COUNT(*) n FROM states WHERE tics = -1');
assert(n.N === 967 && n.LO === 0 && n.HI === 966 && dangling.N === 0 && STATES.length === 967,
  `info.c's ${n.N} states in Firebird (DOOM II's NUMSTATES), every next state one that exists; ${forever.N} last for ever (tics -1)`);

// spot checks, against the source
const st = (name) => one(`SELECT s.*, (SELECT n.name FROM states n WHERE n.id = s.next_state) nxt FROM states s WHERE s.name = '${name}'`);
const checks = [
  ['S_POSS_ATK1', 'POSS', 'E', 0, 10, 'A_FaceTarget', 'S_POSS_ATK2'],   // the zombieman takes aim…
  ['S_POSS_ATK2', 'POSS', 'F', 0, 8, 'A_PosAttack', 'S_POSS_ATK3'],      // …fires…
  ['S_POSS_ATK3', 'POSS', 'E', 0, 8, null, 'S_POSS_RUN1'],               // …and goes back to chasing
  ['S_PISTOL1', 'PISG', 'A', 0, 4, null, 'S_PISTOL2'],
  ['S_PISTOL2', 'PISG', 'B', 0, 6, 'A_FirePistol', 'S_PISTOL3'],
  ['S_PISTOLFLASH', 'PISF', 'A', 1, 7, 'A_Light1', 'S_LIGHTDONE'],       // full bright
  ['S_TROO_ATK3', 'TROO', 'G', 0, 6, 'A_TroopAttack', 'S_TROO_RUN1'],
  ['S_BRAINEXPLODE1', 'MISL', 'B', 1, 10, null, 'S_BRAINEXPLODE2'],
];
const wrong = [];
for (const [name, sprite, frame, bright, tics, action, next] of checks) {
  const s = await st(name);
  const t = (v) => (typeof v === 'string' ? v.trim() : v);   // (CHAR columns come back padded)
  const got = [t(s?.SPRITE), t(s?.FRAME), s?.BRIGHT, s?.TICS, t(s?.ACTION) ?? null, t(s?.NXT)];
  if (JSON.stringify(got) !== JSON.stringify([sprite, frame, bright, tics, action, next])) wrong.push(`${name}: ${JSON.stringify(got)}`);
}
assert(wrong.length === 0, `${checks.length} states as info.c has them (the zombieman's 10 + 8 + 8 tics to fire, the pistol, the imp, the boss brain's explosions)${wrong.length ? `; ${wrong.join('; ')}` : ''}`);

// the actions: every one is DOOM's (A_…), and those this port already has are named in game.sql
const actions = (await all('SELECT DISTINCT action FROM states WHERE action IS NOT NULL ORDER BY 1')).map((r) => r.ACTION.trim());
const game = sql.game;
const known = actions.filter((a) => game.includes(a));
assert(actions.length > 70 && actions.every((a) => /^A_\w+$/.test(a)),
  `${actions.length} different actions, all DOOM's; ${known.length} of them already named in game.sql (the rest come with the phases that need them)`);

// every thing type of ours has a DOOM type, and it's the right one: its spawn state shows
// the same sprite. (The markers DOOM never draws, the teleport destination and the boss
// brain's targets, spawn in S_NULL; the brain's monster spawner is drawn as SSWV in
// DOOM and has BOSF here, which is never seen.)
const types = await all('SELECT thing_type, sprite, spawn_state, see_state, death_state FROM thing_types ORDER BY thing_type');
const sprite = new Map((await all('SELECT id, sprite FROM states')).map((r) => [r.ID, r.SPRITE.trim()]));
const eds = new Set(Object.values(MOBJINFO).map((m) => m.ednum));
const unknown = types.filter((t) => !MOBJ_TYPE[t.THING_TYPE] && !eds.has(t.THING_TYPE)).map((t) => t.THING_TYPE);
const invisible = types.filter((t) => t.SPAWN_STATE === 0).map((t) => t.THING_TYPE);
const mismatched = types.filter((t) => t.SPAWN_STATE > 0 && sprite.get(t.SPAWN_STATE) !== t.SPRITE.trim() && t.THING_TYPE !== 89)
  .map((t) => `${t.THING_TYPE} ${t.SPRITE.trim()} → ${sprite.get(t.SPAWN_STATE)}`);
assert(types.length === THING_TYPES.length && unknown.length === 0 && mismatched.length === 0 && invisible.join() === '14,87',
  `all ${types.length} of this port's thing types tied to their DOOM type, whose spawn state shows the same sprite (only the markers, ${invisible.join(' and ')}, in S_NULL)${unknown.length ? `; no DOOM type for ${unknown.join(' ')}` : ''}${mismatched.length ? `; ${mismatched.join(', ')}` : ''}`);
const zombie = await one('SELECT s1.name spawn, s2.name see, s3.name death FROM thing_types t JOIN states s1 ON s1.id = t.spawn_state JOIN states s2 ON s2.id = t.see_state JOIN states s3 ON s3.id = t.death_state WHERE t.thing_type = 3004');
const shot = typeStates(9013);
assert(zombie.SPAWN.trim() === 'S_POSS_STND' && zombie.SEE.trim() === 'S_POSS_RUN1' && zombie.DEATH.trim() === 'S_POSS_DIE1'
  && STATES[shot[0]][0] === 'S_BRAINEXPLODE1' && MOBJ_TYPE[9013] === 'MT_ROCKET' && Object.keys(MOBJINFO).length === 137,
  'the zombieman (3004) stands in S_POSS_STND, chases from S_POSS_RUN1, dies from S_POSS_DIE1; the boss brain\'s explosions are rockets starting at S_BRAINEXPLODE1');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'states ok');
process.exit(failures ? 1 : 0);
