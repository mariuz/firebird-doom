// states-test.mjs – DOOM's frame tables (docs/ROADMAP.md). Phase 0: info.c's
// states and mobjinfo's state columns (src/states.js), loaded into Firebird,
// whole and consistent, and each of this port's thing types tied to its DOOM
// type. Phase 1: the machine (SET_STATE, STATES_THINK) takes a thing through
// the table with its timings, calls the actions it knows, removes a thing at
// S_NULL, and draws the state's frame; today's rules leave a stated thing alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap, typeStates } from '../src/loader.js';
import { STATES, MOBJINFO } from '../src/states.js';
import { THING_TYPES, MOBJ_TYPE } from '../src/thinginfo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://states', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
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

// ── phase 1: the machine ──
await loadMap(db, wad, res, wad.mapNames()[0], { skill: 3 });
const ID = new Map(STATES.map((x, i) => [x[0], i]));
const NAME = (i) => (i == null ? null : STATES[i][0]);
const pl = await one("SELECT t.x, t.y, t.angle FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1");
const spawn = async (type, dist = 96) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
  EXECUTE PROCEDURE spawn_thing(${type}, ${pl.X + Math.cos(pl.ANGLE) * dist}, ${pl.Y + Math.sin(pl.ANGLE) * dist}, NULL, 0) RETURNING_VALUES id; SUSPEND; END`)).ID;
const setState = async (id, name, tic) => (await one(`EXECUTE BLOCK RETURNS (alive SMALLINT) AS BEGIN
  EXECUTE PROCEDURE set_state(${id}, ${ID.get(name)}, ${tic}) RETURNING_VALUES alive; SUSPEND; END`)).ALIVE;
const think = (tic) => db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE states_think(${tic}); END`);
const thing = (id) => one(`SELECT state, state_tic, solid, st, st_tics, frame FROM things WHERE id = ${id}`);
/** run STATES_THINK from tic FROM to TO; [tic, state name] at each change */
async function trace(id, from, to) {
  const seen = [[from, NAME((await thing(id))?.STATE)]];
  for (let t = from + 1; t <= to; t++) {
    await think(t);
    const now = NAME((await thing(id))?.STATE ?? null);
    if (now !== seen.at(-1)[1]) seen.push([t, now]);
  }
  return seen.map(([t, n]) => `${t - from}:${n}`).join(' ');
}

// the zombieman takes aim, fires, and goes back to chasing: 10 + 8 + 8 tics, then 4 a step
const z = await spawn(3004);
const T = 1000;
await setState(z, 'S_POSS_ATK1', T);
const fire = await trace(z, T, T + 40);
assert(fire === '0:S_POSS_ATK1 10:S_POSS_ATK2 18:S_POSS_ATK3 26:S_POSS_RUN1 30:S_POSS_RUN2 34:S_POSS_RUN3 38:S_POSS_RUN4',
  `SET_STATE and STATES_THINK take a zombieman through info.c's states at its timings: ${fire}`);

// drawn as the state's frame: POSS E while it takes aim, F as it fires
const drawn = async () => (await one(`SELECT TRIM(sf.sprite) || sf.frame pic FROM frame_sprites s JOIN sprite_frames sf ON sf.lump = s.lump WHERE s.id = ${z}`))?.PIC;
await setState(z, 'S_POSS_ATK1', T + 100);
const aim = await drawn();
await setState(z, 'S_POSS_ATK2', T + 100);
const fired = await drawn();
assert(aim === 'POSSE' && fired === 'POSSF', `FRAME_SPRITES draws a thing on the table with its state's frame (${aim}, then ${fired})`);

// today's rules leave it alone: MONSTERS_THINK doesn't move a stated monster on
const before = await thing(z);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE monsters_think(${T + 101}); EXECUTE PROCEDURE monsters_think(${T + 109}); END`);
const after = await thing(z);
assert(JSON.stringify(before) === JSON.stringify(after), 'MONSTERS_THINK leaves a thing on the table alone (its old mode, countdown and frame untouched)');

// dying: A_Scream's sound as it enters S_POSS_DIE2, A_Fall's MF_SOLID off at DIE3, and DIE5 for ever
await db.exec('DELETE FROM sound_events');
await db.exec(`UPDATE game SET tic = ${T + 200} WHERE id = 1`);
const D = T + 200;
await setState(z, 'S_POSS_DIE1', D);
const solid0 = (await thing(z)).SOLID;
const death = await trace(z, D, D + 60);
const scream = await all(`SELECT TRIM(sound) snd, origin FROM sound_events`);
const corpse = await thing(z);
assert(death === '0:S_POSS_DIE1 5:S_POSS_DIE2 10:S_POSS_DIE3 15:S_POSS_DIE4 20:S_POSS_DIE5' && scream.length === 1
  && scream[0].SND === 'DSPODTH1' && scream[0].ORIGIN === z && solid0 === 1 && corpse.SOLID === 0 && corpse.STATE_TIC === null,
  `a death: ${death}; A_Scream plays ${scream[0]?.SND} from it, A_Fall lets it be walked over, and the last state lasts for ever (tics -1)`);

// a puff runs out to S_NULL and is removed (P_RemoveMobj); a 0-tic state goes straight on
const puff = await spawn(9010, 64);
await setState(puff, 'S_PUFF1', T);
const puffed = await trace(puff, T, T + 20);
const gone = await thing(puff);
const flash = await spawn(9010, 64);
const alive = await setState(flash, 'S_LIGHTDONE', T);   // (0 tics, A_Light0, then S_NULL)
assert(puffed === '0:S_PUFF1 4:S_PUFF2 8:S_PUFF3 12:S_PUFF4 16:null' && gone === undefined && alive === 0 && (await thing(flash)) === undefined,
  `a puff's four frames, 4 tics each, then S_NULL removes it (${puffed}); a 0-tic state goes straight on to the next in the same tic`);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'states ok');
process.exit(failures ? 1 : 0);
