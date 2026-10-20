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
// (phase 2: the map's zombiemen, shotgun guys and chaingunners in their spawn state, each
// partway into it, 1 + P_Random() % 10 tics, with mobjinfo's reaction time)
const onMap = await all(`SELECT t.thing_type, s.name, t.state_tic - g.tic left_tics, t.reaction, t.st FROM things t
  JOIN states s ON s.id = t.state CROSS JOIN game g WHERE g.id = 1 AND t.thing_type IN (3004, 9, 65, 3001)`);
const spawnName = { 3004: 'S_POSS_STND', 9: 'S_SPOS_STND', 65: 'S_CPOS_STND', 3001: 'S_TROO_STND' };
const offsets = new Set(onMap.map((r) => r.LEFT_TICS));
const unstated = await one('SELECT COUNT(*) n FROM things t WHERE t.thing_type IN (3004, 9, 65, 3001) AND t.state IS NULL');
assert(onMap.length > 0 && unstated.N === 0
  && onMap.every((r) => r.NAME.trim() === spawnName[r.THING_TYPE] && r.LEFT_TICS >= 1 && r.LEFT_TICS <= 10 && r.REACTION === 8 && r.ST.trim() === 'idle')
  && (onMap.length < 4 || offsets.size > 1),
  `the map's ${onMap.length} zombiemen, shotgun guys, chaingunners and imps start in their spawn states, 1 to 10 tics in (${[...offsets].sort((a, b) => a - b).join(',')}), reaction time 8`);
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
  && /^DSPODTH[123]$/.test(scream[0].SND) && scream[0].ORIGIN === z && solid0 === 1 && corpse.SOLID === 0 && corpse.STATE_TIC === null,
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

// ── phase 2: the zombiemen, the shotgun guys and the chaingunners live on the tables ──
await db.exec('UPDATE player SET health = 10000 WHERE id = 1');   // (it takes a lot of fire here)
const facing = pl.ANGLE + Math.PI;   // (spawned in front of the player, looking at them)
const spawnAt = async (type, dist, ang) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
  EXECUTE PROCEDURE spawn_thing(${type}, ${pl.X + Math.cos(pl.ANGLE) * dist}, ${pl.Y + Math.sin(pl.ANGLE) * dist}, NULL, ${ang}) RETURNING_VALUES id; SUSPEND; END`)).ID;
const atTic = (tic) => db.exec(`UPDATE game SET tic = ${tic} WHERE id = 1`);
const sounds = async () => (await all('SELECT TRIM(sound) snd, origin FROM sound_events ORDER BY 1')).map((r) => r.SND);
const fx = async () => (await one('SELECT COUNT(*) n FROM things WHERE thing_type IN (9010, 9011)')).N;
const remove = (id) => db.exec(`DELETE FROM things WHERE id = ${id}`);

// spawned: its spawn state, its tics as they are, no action yet (P_SpawnMobj)
let P = 2000;
await atTic(P);
const sleeper = await spawnAt(3004, 200, pl.ANGLE);   // (its back to the player)
const s0 = await thing(sleeper);
assert(NAME(s0.STATE) === 'S_POSS_STND' && s0.STATE_TIC === P + 10, `a zombieman spawns in S_POSS_STND for its 10 tics (${NAME(s0.STATE)}, ends at +${s0.STATE_TIC - P})`);

// A_Look: its back to the player 200 units off, and nothing heard, it sleeps on; the
// player's gunfire heard in its sector wakes it (the see sound, one of three, and S_POSS_RUN1)
await db.exec('DELETE FROM sound_events');
const slept = await trace(sleeper, P, P + 30);
await db.exec(`UPDATE sectors SET sound_heard = 1 WHERE id = (SELECT sector_id FROM things WHERE id = ${sleeper})`);
const woke = await trace(sleeper, P + 30, P + 40);
const sightSnd = await sounds();
await db.exec('UPDATE sectors SET sound_heard = 0');
const cries = sightSnd.filter((x) => /^DSPOSIT[123]$/.test(x));
assert(/^0:S_POSS_STND( \d+:S_POSS_STND2?)+$/.test(slept) && /S_POSS_RUN1/.test(woke) && cries.length === 1,
  `A_Look: asleep with its back turned (${slept}); woken by gunfire heard in its sector (${woke}), crying ${cries.join()}`);
await remove(sleeper);

// …and one facing the player sees them, sound or no sound
P = 2100;
await atTic(P);
const watcher = await spawnAt(3004, 200, facing);
const saw = await trace(watcher, P, P + 12);
assert(/S_POSS_RUN1/.test(saw), `A_Look: a zombieman facing the player sees them (${saw})`);
await remove(watcher);

// A_Chase: hurt just now (MF_JUSTHIT) and with MOVECOUNT spent, it fires back at once:
// A_FaceTarget (10 tics), A_PosAttack (8: the pistol, one bullet – blood or a puff), 8 more,
// then the chase again, whose first step only picks a heading (MF_JUSTATTACKED)
P = 2200;
await atTic(P);
const gunner = await spawnAt(3004, 128, facing);
await db.exec(`UPDATE things SET just_hit = 1, movecount = 0, reaction = 0 WHERE id = ${gunner}`);
await db.exec('DELETE FROM sound_events');
const fx0 = await fx();
await setState(gunner, 'S_POSS_RUN1', P);
const attack = await trace(gunner, P, P + 30);
const shotSnd = await sounds();
const afterShot = await one(`SELECT just_hit, just_attacked FROM things WHERE id = ${gunner}`);
assert(attack.startsWith('0:S_POSS_ATK1 10:S_POSS_ATK2 18:S_POSS_ATK3 26:S_POSS_RUN1') && shotSnd.includes('DSPISTOL') && (await fx()) - fx0 === 1
  && afterShot.JUST_HIT === 0 && afterShot.JUST_ATTACKED === 0,
  `A_Chase → P_CheckMissileRange (MF_JUSTHIT) → the attack: ${attack}; A_PosAttack fires one bullet (${shotSnd.join()}); MF_JUSTATTACKED spent on the next step`);
await remove(gunner);

// the shotgun guy: A_SPosAttack, three pellets
P = 2300;
await atTic(P);
const sg = await spawnAt(9, 128, facing);
await db.exec('DELETE FROM sound_events');
const fx1 = await fx();
await setState(sg, 'S_SPOS_ATK2', P);
const sgSnd = await sounds();
assert(sgSnd.join() === 'DSSHOTGN' && (await fx()) - fx1 === 3, `A_SPosAttack: the shotgun, three pellets (${(await fx()) - fx1} hits)`);
await remove(sg);

// pain: hurt (pain chance 200 in 256) into S_POSS_PAIN, A_Pain's cry, and then the chase,
// where MF_JUSTHIT makes it fire back at once
P = 2400;
await atTic(P);
const hurt = await spawnAt(3004, 128, facing);
await db.exec(`UPDATE things SET movecount = 0, hp = 1000 WHERE id = ${hurt}`);
let tries = 0;
while (NAME((await thing(hurt)).STATE) !== 'S_POSS_PAIN' && tries++ < 20) {
  await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${hurt}, 1, (SELECT thing_id FROM player WHERE id = 1)); END`);
}
await db.exec('DELETE FROM sound_events');
const hurtRow = await one(`SELECT just_hit, threshold, target_id, tplayer FROM things WHERE id = ${hurt}`);
const pain = await trace(hurt, P, P + 10);
const painSnd = await sounds();
assert(hurtRow.JUST_HIT === 1 && hurtRow.THRESHOLD === 100 && hurtRow.TARGET_ID === null && hurtRow.TPLAYER === 1
  && pain === '0:S_POSS_PAIN 3:S_POSS_PAIN2 6:S_POSS_ATK1' && painSnd.join() === 'DSPOPAIN',
  `P_DamageMobj: the pain state (MF_JUSTHIT, the player its target for 100 steps), A_Pain (${painSnd.join()}), then straight back at them: ${pain}`);
await remove(hurt);

// the death: killed outright into S_POSS_DIE1 (0–3 tics shorter), its clip dropped and the kill
// counted; blown apart (below −20 health) into S_POSS_XDIE1, A_XScream's DSSLOP, a corpse at rest
P = 2500;
await atTic(P);
const kills0 = (await one('SELECT kills FROM player WHERE id = 1')).KILLS;
const victim = await spawnAt(3004, 128, facing);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${victim}, 20, (SELECT thing_id FROM player WHERE id = 1)); END`);
const dead1 = await thing(victim);
const clip = await one('SELECT COUNT(*) n FROM things WHERE thing_type = 2007 AND BIN_AND(flags, 65536) <> 0');
const kills1 = (await one('SELECT kills FROM player WHERE id = 1')).KILLS;
const gib = await spawnAt(3004, 160, facing);
await db.exec('DELETE FROM sound_events');
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${gib}, 100, (SELECT thing_id FROM player WHERE id = 1)); END`);
const gib1 = await thing(gib);
const gibbed = await trace(gib, P, P + 60);
const gibSnd = await sounds();
const rest = await one(`SELECT st, dead_tic, solid FROM things WHERE id = ${gib}`);
assert(NAME(dead1.STATE) === 'S_POSS_DIE1' && dead1.STATE_TIC >= P + 2 && dead1.STATE_TIC <= P + 5 && dead1.ST.trim() === 'dying'
  && clip.N >= 1 && kills1 === kills0 + 1
  && NAME(gib1.STATE) === 'S_POSS_XDIE1' && /S_POSS_XDIE2.*S_POSS_XDIE9$/.test(gibbed) && gibSnd.includes('DSSLOP')
  && rest.ST.trim() === 'dead' && rest.DEAD_TIC !== null && rest.SOLID === 0,
  `P_KillMobj: S_POSS_DIE1 for ${dead1.STATE_TIC - P} tics, a dropped clip, the kill counted; gibbed: ${gibbed}, ${gibSnd.join()}, a corpse at rest (dead)`);
await remove(victim);
await remove(gib);

// the chaingunner: A_CPosRefire keeps it firing while it sees the player; with the player
// dead it goes back to the chase, finds nobody, and stands again (S_CPOS_STND)
P = 2600;
await atTic(P);
const cg = await spawnAt(65, 128, facing);
await setState(cg, 'S_CPOS_ATK1', P);
const burst = await trace(cg, P, P + 40);
await db.exec('UPDATE player SET dead = 1 WHERE id = 1');
const stop = await trace(cg, P + 40, P + 120);
await db.exec('UPDATE player SET dead = 0 WHERE id = 1');
assert(!/RUN/.test(burst) && (burst.match(/S_CPOS_ATK2/g) ?? []).length >= 3 && /S_CPOS_ATK4/.test(burst) && /S_CPOS_STND2?$/.test(stop),
  `A_CPosRefire: a burst while the player is in sight (${burst}); the player dead, it stops: …${stop.split(' ').slice(-3).join(' ')}`);
await remove(cg);

// the imp: A_TroopAttack claws within reach ((P_Random() % 8 + 1) × 3, DSCLAW), else throws a
// fireball (DSFIRSHT); 8 + 8 + 6 tics, then the chase, whose first A_Chase, still within reach,
// goes straight back into the attack (P_CheckMeleeRange: no MOVECOUNT wait for a melee)
P = 2700;
await atTic(P);
const impNear = await spawnAt(3001, 40, facing);
await db.exec('DELETE FROM sound_events');
const hp0 = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
const balls0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9000')).N;
await setState(impNear, 'S_TROO_ATK1', P);
const clawTrace = await trace(impNear, P, P + 25);
const clawSnd = await sounds();
const clawed = hp0 - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await remove(impNear);
const impFar = await spawnAt(3001, 256, facing);
await db.exec('DELETE FROM sound_events');
await setState(impFar, 'S_TROO_ATK3', P + 30);
const throwSnd = await sounds();
const balls = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9000')).N - balls0;
const ball = await one(`SELECT owner_id, SQRT(momx * momx + momy * momy) v FROM things WHERE thing_type = 9000 ORDER BY id DESC ROWS 1`);
await remove(impFar);
await db.exec('DELETE FROM things WHERE thing_type = 9000');
assert(clawTrace.startsWith('0:S_TROO_ATK1 8:S_TROO_ATK2 16:S_TROO_ATK3 22:S_TROO_ATK1') && clawSnd.includes('DSCLAW') && !clawSnd.includes('DSFIRSHT')
  && clawed >= 3 && clawed <= 24 && clawed % 3 === 0
  && throwSnd.join() === 'DSFIRSHT' && balls === 1 && ball.OWNER_ID === impFar && Math.abs(ball.V - 10) < 0.01,
  `the imp: ${clawTrace.split(' ').slice(0, 4).join(' ')}; up close A_TroopAttack claws (${clawed} damage, ${clawSnd.join()}), further off it throws a fireball (${throwSnd.join()}, speed ${ball.V})`);

// an old save, from before these types were on the tables: ADOPT_STATES puts each where it was
const olds = [await spawnAt(3004, 128, facing), await spawnAt(9, 160, facing), await spawnAt(65, 192, facing)];
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'idle' WHERE id = ${olds[0]}`);
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'chase' WHERE id = ${olds[1]}`);
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'dead', solid = 0 WHERE id = ${olds[2]}`);
await db.query('EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE adopt_states; END');
const adopted = await Promise.all(olds.map(async (id) => NAME((await thing(id)).STATE)));
assert(adopted.join() === 'S_POSS_STND,S_SPOS_RUN1,S_CPOS_DIE7', `an old save's monsters join the tables: asleep, chasing and a corpse → ${adopted.join(', ')}`);
for (const id of olds) await remove(id);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'states ok');
process.exit(failures ? 1 : 0);
