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
  JOIN states s ON s.id = t.state CROSS JOIN game g WHERE g.id = 1 AND t.thing_type IN (3004, 9, 65, 3001, 3002, 58, 3006, 3005, 3003, 69, 16, 7, 84, 71, 67, 68, 66, 64)`);
const spawnName = { 3004: 'S_POSS_STND', 9: 'S_SPOS_STND', 65: 'S_CPOS_STND', 3001: 'S_TROO_STND', 3002: 'S_SARG_STND', 58: 'S_SARG_STND', 3006: 'S_SKULL_STND', 3005: 'S_HEAD_STND', 3003: 'S_BOSS_STND', 69: 'S_BOS2_STND', 16: 'S_CYBER_STND', 7: 'S_SPID_STND', 84: 'S_SSWV_STND', 71: 'S_PAIN_STND', 67: 'S_FATT_STND', 68: 'S_BSPI_STND', 66: 'S_SKEL_STND', 64: 'S_VILE_STND' };
const offsets = new Set(onMap.map((r) => r.LEFT_TICS));
const unstated = await one('SELECT COUNT(*) n FROM things t WHERE t.thing_type IN (3004, 9, 65, 3001, 3002, 58, 3006, 3005, 3003, 69, 16, 7, 84, 71, 67, 68, 66, 64) AND t.state IS NULL');
assert(onMap.length > 0 && unstated.N === 0
  && onMap.every((r) => r.NAME.trim() === spawnName[r.THING_TYPE] && r.LEFT_TICS >= 1 && r.LEFT_TICS <= 10 && r.REACTION === 8 && r.ST.trim() === 'idle')
  && (onMap.length < 4 || offsets.size > 1),
  `the map's ${onMap.length} zombiemen, shotgun guys, chaingunners, imps, demons, lost souls, cacodemons, barons, bosses and DOOM II's start in their spawn states, 1 to 10 tics in (${[...offsets].sort((a, b) => a - b).join(',')}), reaction time 8`);
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

// the demon: A_Chase in reach plays its attacksound (DSSGTATK) as it goes into S_SARG_ATK1;
// A_SargAttack bites for (P_Random() % 10 + 1) × 4, and throws nothing from further off.
// With -fast its run, attack and pain states take half their tics (G_InitNew)
P = 2800;
await atTic(P);
const demon = await spawnAt(3002, 50, facing);
await db.exec(`UPDATE things SET reaction = 0 WHERE id = ${demon}`);
await db.exec('DELETE FROM sound_events');
const hpD = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await setState(demon, 'S_SARG_RUN1', P);
const bite = await trace(demon, P, P + 25);
const biteSnd = await sounds();
const bitten = hpD - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await db.exec(`UPDATE things SET x = x - ${Math.cos(pl.ANGLE) * 300}, y = y - ${Math.sin(pl.ANGLE) * 300} WHERE id = ${demon}`);
const before2 = (await one('SELECT COUNT(*) n FROM things')).N;
await setState(demon, 'S_SARG_ATK3', P + 50);
const thrown = (await one('SELECT COUNT(*) n FROM things')).N - before2;
await db.exec('UPDATE game SET fast = 1 WHERE id = 1');
await setState(demon, 'S_SARG_ATK1', P + 100);
const quick = await trace(demon, P + 100, P + 112);
await db.exec('UPDATE game SET fast = 0 WHERE id = 1');
await remove(demon);
assert(bite.startsWith('0:S_SARG_ATK1 8:S_SARG_ATK2 16:S_SARG_ATK3') && biteSnd.includes('DSSGTATK')
  && bitten >= 4 && bitten <= 40 && bitten % 4 === 0 && thrown === 0 && quick.startsWith('0:S_SARG_ATK1 4:S_SARG_ATK2 8:S_SARG_ATK3'),
  `the demon: ${bite.split(' ').slice(0, 3).join(' ')}, DSSGTATK, a bite of ${bitten}; nothing thrown from afar; with -fast ${quick.split(' ').slice(0, 3).join(' ')}`);

// the lost soul: S_SKULL_ATK1 (10 tics, A_FaceTarget), then A_SkullAttack (DSSKLATK,
// MF_SKULLFLY, 20 units a tic at the player's middle); flying on, it slams into the player
// for (P_Random() % 8 + 1) × 3 and goes back to its spawn state (whose A_Look, seeing the
// player, sends it straight on into the chase)
P = 2900;
await atTic(P);
const flag = (id) => one(`SELECT BIN_AND(flags, 262144) f, momx, momy, momz, x, y, z, state FROM things WHERE id = ${id}`);
const skull = await spawnAt(3006, 200, facing);
await db.exec('DELETE FROM sound_events');
const hpS = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await setState(skull, 'S_SKULL_ATK1', P);
const charge = await trace(skull, P, P + 30);
const slamSnd = await sounds();
const slammed = hpS - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
const landed = await flag(skull);
assert(/^0:S_SKULL_ATK1 10:S_SKULL_ATK2 14:S_SKULL_ATK3 .*S_SKULL_(STND|RUN)/.test(charge) && slamSnd.includes('DSSKLATK')
  && slammed >= 3 && slammed <= 24 && slammed % 3 === 0 && landed.F === 0 && landed.MOMX === 0 && landed.MOMY === 0,
  `the lost soul: ${charge.split(' ').slice(0, 3).join(' ')} (A_SkullAttack, DSSKLATK) … ${charge.split(' ').at(-1)}: it slams into the player for ${slammed} and stops`);

// flying away from the player it goes on until a wall stops it; shot in flight it stops
// dead (no pain state while MF_SKULLFLY), and stands the tic after
await db.exec(`UPDATE things SET flags = BIN_OR(flags, 262144), momx = ${Math.cos(pl.ANGLE) * 20}, momy = ${Math.sin(pl.ANGLE) * 20}, momz = 0,
  x = ${pl.X + Math.cos(pl.ANGLE) * 64}, y = ${pl.Y + Math.sin(pl.ANGLE) * 64} WHERE id = ${skull}`);
const fly0 = await flag(skull);
let flightTics = 0;
for (let t = P + 40; t < P + 240 && (await flag(skull)).F !== 0; t++) { await think(t); flightTics++; }
const fly1 = await flag(skull);
const travelled = Math.hypot(fly1.X - fly0.X, fly1.Y - fly0.Y);
await db.exec(`UPDATE things SET flags = BIN_OR(flags, 262144), momx = 20, momy = 0, hp = 100 WHERE id = ${skull}`);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${skull}, 1, (SELECT thing_id FROM player WHERE id = 1)); END`);
const hitInFlight = await flag(skull);
await think(P + 300);
const stoodAgain = await flag(skull);
assert(flightTics > 1 && travelled >= 20 && fly1.F === 0 && /S_SKULL_(STND|RUN)/.test(NAME(fly1.STATE))
  && hitInFlight.MOMX === 0 && hitInFlight.F !== 0 && !/PAIN/.test(NAME(hitInFlight.STATE)) && stoodAgain.F === 0 && /S_SKULL_(STND|RUN)/.test(NAME(stoodAgain.STATE)),
  `flying on, it stops at a wall (${travelled.toFixed(0)} units in ${flightTics} tics) and stands; shot in flight it stops dead without pain (${NAME(hitInFlight.STATE)}), then stands`);

// a floater drifts 4 units a tic towards its target's middle (P_ZMovement), while it's
// closer than three times the height between them: here up 12, then 48 < 16 × 3 no more
// (put down on the floor 48 units from the player, whose middle is 28 up)
const lx = pl.X + Math.cos(pl.ANGLE) * 48;
const ly = pl.Y + Math.sin(pl.ANGLE) * 48;
await db.exec(`UPDATE things SET x = ${lx}, y = ${ly}, sector_id = sector_at(${lx}, ${ly}), momz = 0,
  z = (SELECT floor_h FROM sectors WHERE id = sector_at(${lx}, ${ly})), flags = BIN_AND(flags, BIN_NOT(131072)) WHERE id = ${skull}`);
const zStart = (await flag(skull)).Z;
const rises = [];
for (let t = P + 301; t <= P + 304; t++) { await think(t); rises.push((await flag(skull)).Z - zStart); }

// killed: S_SKULL_DIE1…6, A_Scream's DSFIRXPL, and then S_NULL: it's gone (no corpse)
await atTic(P + 304);
await db.exec('DELETE FROM sound_events');
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${skull}, 1000, (SELECT thing_id FROM player WHERE id = 1)); END`);
const popped = await trace(skull, P + 304, P + 350);
const popSnd = await sounds();
assert(rises.join() === '4,8,12,12' && /S_SKULL_DIE1.*S_SKULL_DIE6 \d+:null$/.test(popped) && popSnd.includes('DSFIRXPL') && (await thing(skull)) === undefined,
  `it rises towards the player's middle, 4 a tic (${rises.join(', ')}); killed, ${popped.split(' ').slice(-2).join(' ')}: removed, with ${popSnd.join()}`);

// the cacodemon: 5 + 5 + 5 tics, and A_HeadAttack bites within reach for (P_Random() % 6 + 1)
// × 10, silently, else spits a fireball (DSFIRSHT); afloat, it rises towards the player's
// middle, and killed it falls
P = 3400;
await atTic(P);
const caco = await spawnAt(3005, 50, facing);   // (within 44 + the player's 16)
await db.exec('DELETE FROM sound_events');
const hpC = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await setState(caco, 'S_HEAD_ATK1', P);
const headTrace = await trace(caco, P, P + 16);
const biteSndC = await sounds();
const bitC = hpC - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await db.exec(`UPDATE things SET x = ${pl.X + Math.cos(pl.ANGLE) * 200}, y = ${pl.Y + Math.sin(pl.ANGLE) * 200}, sector_id = sector_at(${pl.X + Math.cos(pl.ANGLE) * 200}, ${pl.Y + Math.sin(pl.ANGLE) * 200}) WHERE id = ${caco}`);
await db.exec('DELETE FROM sound_events');
const heads0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9001')).N;
await setState(caco, 'S_HEAD_ATK3', P + 30);
const spitSnd = await sounds();
const heads = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9001')).N - heads0;
await db.exec('DELETE FROM things WHERE thing_type = 9001');
// (lifted 40 above the floor, then killed: it drops, 1 unit/tic² more each tic)
await db.exec(`UPDATE things SET z = (SELECT floor_h FROM sectors WHERE id = sector_at(things.x, things.y)) + 40, momz = 0 WHERE id = ${caco}`);
await atTic(P + 40);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${caco}, 10000, (SELECT thing_id FROM player WHERE id = 1)); END`);
const zc = [];
for (let t = P + 41; t <= P + 43; t++) { await think(t); zc.push((await one(`SELECT momz FROM things WHERE id = ${caco}`)).MOMZ); }
await remove(caco);
assert(headTrace.startsWith('0:S_HEAD_ATK1 5:S_HEAD_ATK2 10:S_HEAD_ATK3') && bitC >= 10 && bitC <= 60 && bitC % 10 === 0 && !biteSndC.includes('DSFIRSHT')
  && heads === 1 && spitSnd.includes('DSFIRSHT') && zc.join() === '-1,-2,-3',
  `the cacodemon: ${headTrace.split(' ').slice(0, 3).join(' ')}; a bite of ${bitC} up close, a fireball further off (${spitSnd.join()}); killed in the air it falls (momz ${zc.join(', ')})`);

// the barons: A_BruisAttack claws within reach for (P_Random() % 8 + 1) × 10 with DSCLAW, else
// throws a green fireball; the knight cries DOOM II's DSKNTSIT
P = 3500;
await atTic(P);
const baron = await spawnAt(3003, 50, facing);
await db.exec('DELETE FROM sound_events');
const hpB = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await setState(baron, 'S_BOSS_ATK1', P);
const baronTrace = await trace(baron, P, P + 25);
const clawB = await sounds();
const clawedB = hpB - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await remove(baron);
const knight = await spawnAt(69, 300, facing);
await db.exec('DELETE FROM sound_events');
const green0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9002')).N;
await setState(knight, 'S_BOS2_ATK3', P + 30);
const green = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9002')).N - green0;
await db.exec('DELETE FROM things WHERE thing_type = 9002');
await db.exec('DELETE FROM sound_events');
await setState(knight, 'S_BOS2_STND', P + 40);   // (A_Look: facing the player, it sees them)
const kntSnd = await sounds();
await remove(knight);
assert(baronTrace.startsWith('0:S_BOSS_ATK1 8:S_BOSS_ATK2 16:S_BOSS_ATK3') && clawB.includes('DSCLAW') && clawedB >= 10 && clawedB <= 80 && clawedB % 10 === 0
  && green === 1 && kntSnd.includes('DSKNTSIT'),
  `the barons: ${baronTrace.split(' ').slice(0, 3).join(' ')}, a claw of ${clawedB}; the knight throws ${green} fireball from afar and cries ${kntSnd.join()}`);

// the cyberdemon: A_CyberAttack three times (a rocket each, DSRLAUNC), 6 + 12 × 5 tics, then
// S_CYBER_RUN1's A_Hoof (DSHOOF, and A_Chase). The spider mastermind: 20 tics to aim, then
// A_SPosAttack's three pellets every 4 tics, A_SpidRefire between; S_SPID_RUN1's A_Metal
P = 3600;
await atTic(P);
const cyber = await spawnAt(16, 320, facing);
await db.exec('DELETE FROM sound_events');
const rockets0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9003')).N;
await setState(cyber, 'S_CYBER_ATK1', P);
const cyberTrace = await trace(cyber, P, P + 66);
const rockets = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9003')).N - rockets0;
const cyberSnd = await sounds();
await db.exec('DELETE FROM things WHERE thing_type = 9003');
await remove(cyber);
const spider = await spawnAt(7, 320, facing);
await db.exec('DELETE FROM sound_events');
const fxSp = await fx();
await setState(spider, 'S_SPID_ATK1', P + 100);
const spiderTrace = await trace(spider, P + 100, P + 130);
const pellets = (await fx()) - fxSp;
await db.exec('DELETE FROM sound_events');
await setState(spider, 'S_SPID_RUN1', P + 140);
const metal = await sounds();
await remove(spider);
assert(cyberTrace.startsWith('0:S_CYBER_ATK1 6:S_CYBER_ATK2 18:S_CYBER_ATK3 30:S_CYBER_ATK4 42:S_CYBER_ATK5 54:S_CYBER_ATK6 66:S_CYBER_')
  && cyberSnd.filter((x) => x === 'DSRLAUNC').length === 3 && cyberSnd.includes('DSHOOF')
  && spiderTrace.startsWith('0:S_SPID_ATK1 20:S_SPID_ATK2 24:S_SPID_ATK3 28:S_SPID_ATK4') && pellets >= 9 && metal.includes('DSMETAL'),
  `the cyberdemon: ${cyberSnd.filter((x) => x === 'DSRLAUNC').length} rockets fired, attack frames at ${cyberTrace.split(' ').slice(1, 6).map((x) => x.split(':')[0]).join(', ')} tics, then its hoof; the spider mastermind: ${spiderTrace.split(' ').slice(0, 4).join(' ')}…, ${pellets} pellets, A_Metal`);

// DOOM II's first five. The SS guard: 10 + 10 to aim, A_CPosAttack, 6, A_CPosAttack, then
// A_CPosRefire back to its second aim. The mancubus: A_FatRaise (DSMANATK, 20 tics), then
// deathSouls volleys of two fireballs, the first aimed at the player and the second 11.25° left of
// it. The arachnotron: plasma (DSPLASMA) every 5 tics through A_SpidRefire, and A_BabyMetal.
// The pain elemental: A_PainAttack spits a charging lost soul; dying, three where there's room. Keen: hanging,
// dying through A_KeenDie to lie dead
P = 3800;
await atTic(P);
const ss = await spawnAt(84, 200, facing);
await setState(ss, 'S_SSWV_ATK1', P);
const ssTrace = await trace(ss, P, P + 40);
await remove(ss);
const fat = await spawnAt(67, 300, facing);
await db.exec('DELETE FROM sound_events');
const fat0 = (await one('SELECT COALESCE(MAX(id), 0) m FROM things')).M;
await setState(fat, 'S_FATT_ATK1', P + 100);
// (the fireballs fly off and burst now: each one's heading is read in the tic it appears)
const fatSeen = new Map();
const fatStates = [[0, NAME((await thing(fat)).STATE)]];
for (let t = P + 101; t <= P + 180; t++) {
  await think(t);
  const now = NAME((await thing(fat)).STATE);
  if (now !== fatStates.at(-1)[1]) fatStates.push([t - P - 100, now]);
  for (const r of await all(`SELECT id, angle a FROM things WHERE thing_type = 9007 AND id > ${fat0}`)) if (!fatSeen.has(r.ID)) fatSeen.set(r.ID, r.A);
}
const fatTrace = fatStates.map(([t, n]) => `${t}:${n}`).join(' ');
const fatSnd = await sounds();
const fatBalls = [...fatSeen.entries()].sort((x, y) => x[0] - y[0]).map(([, a]) => ({ A: a }));
const aimAt = Math.atan2(pl.Y - (pl.Y + Math.sin(pl.ANGLE) * 300), pl.X - (pl.X + Math.cos(pl.ANGLE) * 300));
const turnDeg = (a) => Math.round((((a - aimAt) * 180) / Math.PI + 540) % 360 - 180);
const fatSpreads = fatBalls.map((r) => turnDeg(r.A));
await db.exec('DELETE FROM things WHERE thing_type = 9007');
await remove(fat);
const bspi = await spawnAt(68, 300, facing);
await db.exec('DELETE FROM sound_events');
const plasma0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9008')).N;
await setState(bspi, 'S_BSPI_ATK1', P + 200);
const bspiTrace = await trace(bspi, P + 200, P + 232);
const plasma = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9008')).N - plasma0;
await setState(bspi, 'S_BSPI_RUN1', P + 240);
const bspiSnd = await sounds();
await db.exec('DELETE FROM things WHERE thing_type = 9008');
await remove(bspi);
const pe = await spawnAt(71, 200, facing);
const souls0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 3006')).N;
await setState(pe, 'S_PAIN_ATK4', P + 300);
const spatSoul = await one(`SELECT COUNT(*) n, MAX(BIN_AND(flags, 262144)) f FROM things WHERE thing_type = 3006`);
await db.exec(`DELETE FROM things WHERE thing_type = 3006 AND id > ${pe}`);
await setState(pe, 'S_PAIN_DIE5', P + 310);
const deathSouls = (await one(`SELECT COUNT(*) n FROM things WHERE thing_type = 3006 AND id > ${pe}`)).N;
await db.exec(`DELETE FROM things WHERE thing_type = 3006 AND id > ${pe}`);
await remove(pe);
await atTic(P + 400);
const keen = await spawnAt(72, 160, facing);
const keen0 = await thing(keen);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${keen}, 1000, (SELECT thing_id FROM player WHERE id = 1)); END`);
const keenTrace = await trace(keen, P + 400, P + 480);
const keenEnd = await one(`SELECT st, solid FROM things WHERE id = ${keen}`);
await remove(keen);
assert(ssTrace.startsWith('0:S_SSWV_ATK1 10:S_SSWV_ATK2 20:S_SSWV_ATK3 24:S_SSWV_ATK4 30:S_SSWV_ATK5 34:S_SSWV_ATK6 35:S_SSWV_ATK2')
  && fatTrace.startsWith('0:S_FATT_ATK1 20:S_FATT_ATK2 30:S_FATT_ATK3') && /80:S_FATT_RUN1/.test(fatTrace) && fatSnd.includes('DSMANATK')
  && fatSpreads.join() === '0,11,0,-22,-6,6'
  && bspiTrace.startsWith('0:S_BSPI_ATK1 20:S_BSPI_ATK2 24:S_BSPI_ATK3 28:S_BSPI_ATK4 29:S_BSPI_ATK2') && plasma >= 2 && bspiSnd.includes('DSPLASMA') && bspiSnd.includes('DSBSPWLK')
  && spatSoul.N === souls0 + 1 && spatSoul.F !== 0 && deathSouls >= 2
  && NAME(keen0.STATE) === 'S_KEENSTND' && keen0.STATE_TIC === null && /S_COMMKEEN11 \d+:S_COMMKEEN12$/.test(keenTrace) && keenEnd.ST.trim() === 'dead' && keenEnd.SOLID === 0,
  `DOOM II's: the SS guard ${ssTrace.split(' ').slice(0, 7).map((x) => x.split(':')[0]).join('/')}; the mancubus's six fireballs at ${fatSpreads.join('°, ')}°; the arachnotron's ${plasma} plasma balls; the pain elemental spits a charging soul, and ${deathSouls} dying (three where there's room); Keen ${keenTrace.split(' ').at(-1)}, dead`);

// the revenant: S_SKEL_MISS1 (0 tics), 10, then A_SkelMissile's homing missile (DSSKEATK), a
// step ahead; A_SkelFist out of reach throws nothing. The arch-vile: A_VileStart's DSVILATK, the
// flame lit 10 tics in (A_VileTarget, DSFLAMST), A_VileAttack 66 in, 20 more, then the chase
P = 4300;
await atTic(P);
const skel = await spawnAt(66, 300, facing);
await db.exec('DELETE FROM sound_events');
const tracers0 = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9006')).N;
await setState(skel, 'S_SKEL_MISS1', P);
const skelTrace = await trace(skel, P, P + 25);
const skelSnd = await sounds();
const tracer = await one(`SELECT COUNT(*) n, MAX(SQRT((x - ${pl.X + Math.cos(pl.ANGLE) * 300}) * (x - ${pl.X + Math.cos(pl.ANGLE) * 300}) + (y - ${pl.Y + Math.sin(pl.ANGLE) * 300}) * (y - ${pl.Y + Math.sin(pl.ANGLE) * 300}))) d FROM things WHERE thing_type = 9006`);
await db.exec('DELETE FROM things WHERE thing_type = 9006');
await setState(skel, 'S_SKEL_FIST4', P + 40);
const fistThrown = (await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9006')).N;
await remove(skel);
const vile = await spawnAt(64, 300, facing);
await db.exec('DELETE FROM sound_events');
await setState(vile, 'S_VILE_ATK1', P + 100);
const vileTrace = await trace(vile, P + 100, P + 195);
const vileSnd = await sounds();
await db.exec("DELETE FROM things WHERE kind = 'flame'");
await remove(vile);
assert(skelTrace.startsWith('0:S_SKEL_MISS2 10:S_SKEL_MISS3 20:S_SKEL_MISS4') && tracer.N === tracers0 + 1 && tracer.D > 30 && skelSnd.includes('DSSKEATK') && fistThrown === 0
  && vileTrace.startsWith('0:S_VILE_ATK2 10:S_VILE_ATK3 18:S_VILE_ATK4') && /66:S_VILE_ATK10 74:S_VILE_ATK11 94:S_VILE_/.test(vileTrace)
  && ['DSVILATK', 'DSFLAMST', 'DSBAREXP'].every((n) => vileSnd.includes(n)),
  `the revenant: ${skelTrace.split(' ').slice(0, 3).join(' ')}, a homing missile ${tracer.D.toFixed(0)} units out, no missile from A_SkelFist out of reach; the arch-vile: ${vileTrace.split(' ').slice(0, 3).join(' ')} … 66:ATK10 74:ATK11, ${vileSnd.filter((n) => /VIL|FLAM|BAREXP/.test(n)).join(', ')}`);

// phase 3, the projectiles: an imp's fireball starts half a move out from the imp (P_CheckMissileSpawn),
// its first frame 1–4 tics; it flies 10 a tic and hits the player for (P_Random() % 8 + 1) × 3, then
// bursts (S_TBALLX1, DSFIRXPL) and is gone. A rk goes 20 a tic in two half moves, and bursts on
// an imp in its way, A_Explode's splash on top
P = 4600;
await atTic(P);
const fbImp = await spawnAt(3001, 200, facing);
const ix = pl.X + Math.cos(pl.ANGLE) * 200, iy = pl.Y + Math.sin(pl.ANGLE) * 200;
await db.exec('DELETE FROM sound_events');
const hpF = (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await setState(fbImp, 'S_TROO_ATK3', P);
const fb = await one(`SELECT id, x, y, state_tic, SQRT(momx * momx + momy * momy) v FROM things WHERE thing_type = 9000 ORDER BY id DESC ROWS 1`);
const startOut = Math.hypot(fb.X - ix, fb.Y - iy);
const ballTrace = await trace(fb.ID, P, P + 40);
const ballSnd = await sounds();
const ballHit = hpF - (await one('SELECT health FROM player WHERE id = 1')).HEALTH;
await remove(fbImp);
const rocketTarget = await spawnAt(3001, 160, facing);
await db.exec(`UPDATE things SET hp = 1000 WHERE id = ${rocketTarget}`);
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE fire_missile(9003, (SELECT thing_id FROM player WHERE id = 1), ${pl.X}, ${pl.Y}, (SELECT z FROM things WHERE kind = 'player'), ${pl.ANGLE}); END`);
const rk = await one('SELECT id, x, y FROM things WHERE thing_type = 9003 ORDER BY id DESC ROWS 1');
await think(P + 50);
const rk2 = await one(`SELECT x, y FROM things WHERE id = ${rk.ID}`);
const rocketTrace = await trace(rk.ID, P + 50, P + 70);
const impHurt = 1000 - (await one(`SELECT hp FROM things WHERE id = ${rocketTarget}`)).HP;
await remove(rocketTarget);
assert(Math.abs(startOut - 5) < 0.01 && fb.STATE_TIC - P >= 1 && fb.STATE_TIC - P <= 4 && fb.V === 10
  && /S_TBALLX1.*null$/.test(ballTrace) && ballSnd.includes('DSFIRXPL') && ballHit >= 3 && ballHit <= 24 && ballHit % 3 === 0
  && Math.abs(Math.hypot(rk2.X - rk.X, rk2.Y - rk.Y) - 20) < 0.01 && /S_EXPLODE1/.test(rocketTrace) && impHurt > 20,
  `missiles: a fireball starts ${startOut.toFixed(0)} out, its first frame ${fb.STATE_TIC - P} tics, flies ${fb.V} a tic, hits the player for ${ballHit} and bursts (${ballTrace.split(' ').slice(-2).join(' ')}); a rocket goes 20 a tic and bursts on an imp (${impHurt} damage with the splash)`);

// the boss brain: A_BrainSpit throws a cube (DSBOSPIT) at each spawn spot in turn, its reaction time
// DOOM's (dy / momy) / 3; when that runs out, A_SpawnFly makes a monster there and the cube is gone.
// Killed, the brain's A_BrainScream sets off 65 rockets along the wall behind it, and 120 tics later
// A_BrainDie ends the level
P = 4800;
await atTic(P);
const bbSpotAng = pl.ANGLE + 0.3;
const bbSpotAt = async (d) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
  EXECUTE PROCEDURE spawn_thing(87, ${pl.X + Math.cos(bbSpotAng) * d}, ${pl.Y + Math.sin(bbSpotAng) * d}, NULL, 0) RETURNING_VALUES id; SUSPEND; END`)).ID;
const bbSpots = [await bbSpotAt(160), await bbSpotAt(320)];
await db.exec(`UPDATE things SET thing_type = 0 WHERE thing_type = 87 AND id NOT IN (${bbSpots.join()})`);   // (only these two)
const bbSpitter = await spawnAt(89, 1, 0);
await db.exec('DELETE FROM sound_events');
await db.exec('UPDATE game SET brain_on = 0 WHERE id = 1');
const bbCubes0 = (await one('SELECT COALESCE(MAX(id), 0) m FROM things')).M;
await setState(bbSpitter, 'S_BRAINEYE1', P);
await setState(bbSpitter, 'S_BRAINEYE1', P + 1);
const bbCubes = await all(`SELECT id, owner_id, reaction, momy, y FROM things WHERE thing_type = 9009 AND id > ${bbCubes0} ORDER BY id`);
const bbSpitY = pl.Y + Math.sin(pl.ANGLE) * 1;
const bbWantReact = (spot, cube) => Math.trunc(Math.trunc((spot.Y - bbSpitY) / cube.MOMY) / 3);
const bbSpotRows = await all(`SELECT id, y FROM things WHERE id IN (${bbSpots.join()}) ORDER BY id`);
const bbSpitSnd = await sounds();
const bbMonsters0 = (await one("SELECT COUNT(*) n FROM things WHERE kind = 'monster'")).N;
for (let t = P + 1; t <= P + 120 && (await one(`SELECT COUNT(*) n FROM things WHERE id = ${bbCubes[0].ID}`)).N; t++) await think(t);
const bbLanded = (await one(`SELECT COUNT(*) n FROM things WHERE id = ${bbCubes[0].ID}`)).N === 0;
const bbSpawned = (await one("SELECT COUNT(*) n FROM things WHERE kind = 'monster'")).N - bbMonsters0;
await db.exec(`DELETE FROM things WHERE thing_type IN (9009, 9014) OR id IN (${bbSpitter}, ${bbSpots.join()}) OR (kind = 'monster' AND id > ${bbCubes0})`);
await atTic(P + 200);
const brainId = await spawnAt(88, 400, facing);
await db.exec('DELETE FROM sound_events');
const rockets9013 = (await one('SELECT COALESCE(MAX(id), 0) m FROM things')).M;
await db.query(`EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE damage_thing(${brainId}, 1000, (SELECT thing_id FROM player WHERE id = 1)); END`);
const bbRow = (await one(`SELECT COUNT(*) n FROM things WHERE thing_type = 9013 AND id > ${rockets9013}`)).N;
const bbBrainCry = await sounds();
await db.exec('UPDATE game SET exit_kind = 0 WHERE id = 1');
const bbBrainTrace = await trace(brainId, P + 200, P + 330);
const bbEnded = (await one('SELECT exit_kind FROM game WHERE id = 1')).EXIT_KIND;
await db.exec('UPDATE game SET exit_kind = 0 WHERE id = 1');
await db.exec(`DELETE FROM things WHERE thing_type = 9013 OR id = ${brainId}`);
assert(bbCubes.length === 2 && bbCubes[0].OWNER_ID === bbSpotRows[0].ID && bbCubes[1].OWNER_ID === bbSpotRows[1].ID
  && bbCubes.every((c, i) => c.REACTION === bbWantReact(bbSpotRows[i], c)) && bbSpitSnd.includes('DSBOSPIT')
  && bbLanded && bbSpawned === 1
  && bbRow === 65 && bbBrainCry.includes('DSBOSDTH') && /S_BRAIN_DIE4$/.test(bbBrainTrace) && bbEnded === 1,
  `the boss brain: two cubes, one at each spot in turn (reaction ${bbCubes.map((c) => c.REACTION).join(', ')}); the first lands and makes a monster; dying, ${bbRow} rockets and ${bbBrainTrace.split(' ').at(-1)}, the level ends`);

// every type on the tables lies down 'dead' at the end of its death (and its gibbing), even
// where that last frame is also a decoration's spawn state (S_POSS_DIE5: a dead former human)
const deadEnds = [];
for (const t of await all('SELECT thing_type, death_state, xdeath_state FROM thing_types WHERE on_states = 1 ORDER BY thing_type')) {
  for (const start of [t.DEATH_STATE, t.XDEATH_STATE]) {
    let id = start;
    for (let n = 0; id > 0 && n < 64; n++) {
      const st = await one(`SELECT tics, next_state, mode FROM states WHERE id = ${id}`);
      if (st.TICS === -1) { deadEnds.push(`${t.THING_TYPE}:${NAME(id)}:${st.MODE?.trim()}`); break; }
      id = st.NEXT_STATE;
    }
  }
}
assert(deadEnds.length >= 8 && deadEnds.every((e) => e.endsWith(':dead')),
  `every corpse on the tables is 'dead': ${deadEnds.filter((e) => !e.endsWith(':dead')).join(', ') || `${deadEnds.length} death and gibbing ends`}`);

// an old save, from before these types were on the tables: ADOPT_STATES puts each where it was
const olds = [await spawnAt(3004, 128, facing), await spawnAt(9, 160, facing), await spawnAt(65, 192, facing)];
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'idle' WHERE id = ${olds[0]}`);
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'chase' WHERE id = ${olds[1]}`);
await db.exec(`UPDATE things SET state = NULL, state_tic = NULL, st = 'dead', solid = 0 WHERE id = ${olds[2]}`);
// (and a corpse from phase 2's first saves, in S_POSS_DIE5 but labelled 'idle')
const misread = await spawnAt(3004, 224, facing);
await db.exec(`UPDATE things SET state = (SELECT id FROM states WHERE name = 'S_POSS_DIE5'), state_tic = NULL, st = 'idle', dead_tic = NULL WHERE id = ${misread}`);
await db.query('EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE adopt_states; END');
const adopted = await Promise.all(olds.map(async (id) => NAME((await thing(id)).STATE)));
const mended = await one(`SELECT st, dead_tic FROM things WHERE id = ${misread}`);
assert(adopted.join() === 'S_POSS_STND,S_SPOS_RUN1,S_CPOS_DIE7' && mended.ST.trim() === 'dead' && mended.DEAD_TIC !== null,
  `an old save's monsters join the tables: asleep, chasing and a corpse → ${adopted.join(', ')}; a corpse once labelled idle lies ${mended.ST.trim()}`);
for (const id of [...olds, misread]) await remove(id);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'states ok');
process.exit(failures ? 1 : 0);
