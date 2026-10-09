// netgame-test.mjs – a co-op game for two in Firebird, without a network: both
// players' ticcmds go into TICCMD and NET_TIC runs the tic, as every peer of a
// netgame does. Each player moves, picks up, gets hurt, kills and respawns on
// their own; monsters go after whichever player they see; and the same two
// command streams from the same start give the same game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { captureGame } from '../src/savegame.js';
import { Lockstep } from '../src/net.js';
import { TRANSLATIONS } from '../src/renderer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://net', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
const map = wad.mapNames()[0];

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const one = async (q) => (await db.query(q)).rows[0];
const all = async (q) => (await db.query(q)).rows;
const IDLE = [0, 0, 0, 0, 0, 0, 0];

/** one netgame tic: CMDS[player-1] = [fwd, side, turn, fire, use, weapon, run]; the HUD of player ME */
async function tic(cmds, me = 1) {
  await db.exec(`UPDATE viewcfg SET player_id = ${me} WHERE id = 1`);
  await db.query(`EXECUTE BLOCK AS BEGIN
    DELETE FROM ticcmd;
    ${cmds.map((c, i) => `INSERT INTO ticcmd (player_id, fwd, side, turn, fire, use_key, weapon_sel, run) VALUES (${i + 1}, ${c.join(', ')});`).join('\n')}
  END`);
  return (await db.query('SELECT * FROM net_tic')).rows[0];
}
const thing = (pid) => one(`SELECT t.id, t.x, t.y, t.z, t.angle FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = ${pid}`);
const spawn = async (type, x, y) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
    EXECUTE PROCEDURE spawn_thing(${type}, ${x}, ${y}, NULL, 0) RETURNING_VALUES id; SUSPEND; END`)).ID;

// ── two players on the map ──
await loadMap(db, wad, res, map, { skill: 3, players: 2 });
const rows = await all('SELECT p.id, p.thing_id, p.health, p.bullets FROM player p ORDER BY p.id');
const starts = await all('SELECT ttype, x, y FROM map_things WHERE ttype IN (1, 2) ORDER BY ttype');
const p1 = await thing(1);
const p2 = await thing(2);
assert(rows.length === 2 && p1.ID !== p2.ID && starts.length === 2 && p2.X === starts[1].X && p2.Y === starts[1].Y,
  `${map}, a netgame for two: two players, each at their own start (P_SpawnPlayer)`);
const solo = (await one('SELECT COUNT(*) n FROM map_things m WHERE BIN_AND(m.flags, 16) <> 0 AND BIN_AND(m.flags, 2) <> 0')).N;
const net = (await one('SELECT COUNT(*) n FROM things t JOIN map_things m ON m.x = t.x AND m.y = t.y AND m.ttype = t.thing_type WHERE BIN_AND(m.flags, 16) <> 0')).N;
assert(solo === 0 || net > 0, `the multiplayer-only things are there in a netgame (${net} of them)`);

// each moves on their own command
for (let i = 0; i < 10; i++) await tic([IDLE, [1, 0, 0, 0, 0, 0, 0]]);
const q1 = await thing(1);
const q2 = await thing(2);
assert(q1.X === p1.X && q1.Y === p1.Y && Math.hypot(q2.X - p2.X, q2.Y - p2.Y) > 20,
  `player 2 walks on their ticcmd (${Math.hypot(q2.X - p2.X, q2.Y - p2.Y).toFixed(0)} units), player 1 stays put`);
for (let i = 0; i < 35; i++) await tic([IDLE, IDLE]);         // (friction: player 2 comes to a stop)
const hud2 = await tic([IDLE, IDLE], 2);
const at2 = await thing(2);
const hud1 = await tic([IDLE, IDLE], 1);
const q2b = await thing(2);
assert(hud2.PX === at2.X && hud2.PY === at2.Y && hud1.PX === q1.X && hud1.PY === q1.Y,
  "NET_TIC's HUD is VIEWCFG.PLAYER_ID's: each browser sees its own player");

// a pickup is the picker's, and so is its sound
await db.exec('UPDATE player SET health = 50');
await spawn(2012, q2b.X, q2b.Y);                       // a medikit under player 2
await tic([IDLE, IDLE]);
const h = await all('SELECT id, health, items FROM player ORDER BY id');
const ps = await one("SELECT FIRST 1 listener FROM sound_events WHERE sound = 'DSITEMUP' ORDER BY id DESC");
assert(h[0].HEALTH === 50 && h[1].HEALTH === 75 && ps?.LISTENER === 2, `player 2's medikit heals player 2 (${h[1].HEALTH}) and is heard only by player 2`);

// damage lands on the player hit
await db.exec('UPDATE player SET health = 100');
await db.exec(`EXECUTE PROCEDURE damage_player(30, NULL, 2)`);
const d = await all('SELECT health, damage_count FROM player ORDER BY id');
assert(d[0].HEALTH === 100 && d[1].HEALTH === 70 && d[1].DAMAGE_COUNT > 0, 'damage_player hurts the player it names, and only them');

// a monster goes after the player it sees (P_LookForPlayers): an imp in front of player 2 only
const ang2 = q2b.ANGLE;
const ix = q2b.X + Math.cos(ang2) * 200;
const iy = q2b.Y + Math.sin(ang2) * 200;
const imp = await spawn(3001, ix, iy);
await db.exec(`UPDATE things SET angle = ${ang2 + Math.PI}, st = 'idle', reaction = 0 WHERE id = ${imp}`);
await db.exec('UPDATE sectors SET sound_heard = 0');
let woke = null;
for (let i = 0; i < 24 && !woke; i++) {
  await tic([IDLE, IDLE]);
  const r = await one(`SELECT st, tplayer FROM things WHERE id = ${imp}`);
  if (r.ST !== 'idle') woke = r;
}
const sees1 = (await one(`SELECT check_sight(${ix}, ${iy}, 40, ${q1.X}, ${q1.Y}, 41) s FROM rdb$database`)).S;
assert(woke && (woke.TPLAYER === 2 || sees1 === 1), `the imp wakes and goes after player ${woke?.TPLAYER} (the one it can see${sees1 ? '; it sees player 1 too' : ''})`);
// player 2's gunfire kills it: player 2's kill
await db.exec(`UPDATE things SET hp = 1 WHERE id = ${imp}`);
const k0 = await all('SELECT kills FROM player ORDER BY id');
await db.exec(`EXECUTE PROCEDURE damage_thing(${imp}, 10, ${q2b.ID})`);
const k1 = await all('SELECT kills FROM player ORDER BY id');
assert(k1[1].KILLS === k0[1].KILLS + 1 && k1[0].KILLS === k0[0].KILLS, "P_KillMobj: player 2's kill counts for player 2");
await db.exec('UPDATE sectors SET sound_heard = 0');

// death and G_DoReborn: dead player 2 presses use and comes back at their start, the body left behind
await db.exec(`UPDATE player SET kills = 3, bullets = 120, has_shotgun = 1, keycards = 1 WHERE id = 2`);
await db.exec(`EXECUTE PROCEDURE damage_player(1000, NULL, 2)`);
for (let i = 0; i < 4; i++) await tic([IDLE, IDLE]);
const dead = await one('SELECT dead, thing_id FROM player WHERE id = 2');
await tic([IDLE, [0, 0, 0, 0, 1, 0, 0]]);
const back = await one('SELECT p.dead, p.thing_id, p.health, p.bullets, p.has_shotgun, p.keycards, p.kills, t.x, t.y FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 2');
const body = await one(`SELECT kind, st FROM things WHERE id = ${dead.THING_ID}`);
const exitKind = (await one('SELECT exit_kind FROM game')).EXIT_KIND;
assert(dead.DEAD === 1 && back.DEAD === 0 && back.THING_ID !== dead.THING_ID && back.X === starts[1].X && back.Y === starts[1].Y
    && back.HEALTH === 100 && back.BULLETS === 50 && back.HAS_SHOTGUN === 0 && back.KEYCARDS === 0 && back.KILLS === 3
    && body.KIND === 'decor' && exitKind === 0,
  'dead player 2 presses use: back at their start with the pistol and 50 bullets, kills kept, the body left behind, the level goes on');

// how player 2 looks to player 1 (S_PLAY…, in player 2's colours): player 2 put in front of
// player 1, facing away
{
  const me = await thing(1);
  const other = (await thing(2)).ID;
  await db.exec(`UPDATE things SET x = ${me.X + Math.cos(me.ANGLE) * 160}, y = ${me.Y + Math.sin(me.ANGLE) * 160},
    angle = ${me.ANGLE}, momx = 0, momy = 0 WHERE id = ${other}`);
  const look = async () => one(`SELECT TRIM(t.frame) frame, t.translation, (SELECT FIRST 1 s.tr FROM frame_sprites s WHERE s.id = t.id) tr,
    (SELECT FIRST 1 sf.sprite || sf.frame FROM frame_sprites s JOIN sprite_frames sf ON sf.lump = s.lump WHERE s.id = t.id) pic
    FROM things t WHERE t.id = ${other}`);
  await tic([IDLE, IDLE]);
  const stand = await look();
  const p1tr = (await one('SELECT t.translation FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1')).TRANSLATION;
  assert(stand.FRAME === 'A' && stand.PIC === 'PLAYA' && stand.TR === 1 && p1tr === 0,
    `standing, player 2 is PLAYA to player 1, drawn through translation ${stand.TR} (indigo; player 1's is ${p1tr}, green)`);
  const seen = new Set();
  for (let i = 0; i < 16; i++) { await tic([IDLE, [1, 0, 0, 0, 0, 0, 0]]); seen.add((await look()).FRAME); }
  for (let i = 0; i < 70; i++) await tic([IDLE, IDLE]);   // (friction: until it's slower than STOPSPEED)
  const stopped = (await look()).FRAME;
  assert([...seen].every((f) => 'ABCD'.includes(f)) && seen.size === 4 && stopped === 'A',
    `running, player 2 goes through ${[...seen].sort().join('')} (S_PLAY_RUN1–4), and stands (A) once stopped`);
  await tic([IDLE, [0, 0, 0, 1, 0, 0, 0]]);
  const shot = (await look()).FRAME;
  for (let i = 0; i < 8; i++) await tic([IDLE, IDLE]);
  const after = (await look()).FRAME;
  for (let i = 0; i < 14; i++) await tic([IDLE, IDLE]);
  const done = (await look()).FRAME;
  assert(shot === 'F' && after === 'E' && done === 'A', `a shot: ${shot} (the flash, S_PLAY_ATK2), then ${after} (S_PLAY_ATK1), then ${done}`);
  await db.exec('EXECUTE PROCEDURE damage_player(5, NULL, 2)');
  const pain = (await look()).FRAME;
  for (let i = 0; i < 6; i++) await tic([IDLE, IDLE]);
  assert(pain === 'G' && (await look()).FRAME === 'A', `hurt: ${pain} (S_PLAY_PAIN), then A again`);
  await db.exec('UPDATE player SET armor = 0, health = 100 WHERE id = 2');
  await db.exec('EXECUTE PROCEDURE damage_player(110, NULL, 2)');
  const dying = (await look()).FRAME;
  for (let i = 0; i < 80; i++) await tic([IDLE, IDLE]);
  const dead2 = (await look()).FRAME;
  await tic([IDLE, [0, 0, 0, 0, 1, 0, 0]]);
  const body = await one(`SELECT kind, TRIM(frame) frame, translation FROM things WHERE id = ${other}`);
  const reborn = await one('SELECT TRIM(t.frame) frame, t.translation FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 2');
  assert(dying === 'H' && dead2 === 'N' && body.KIND === 'decor' && body.FRAME === 'N' && body.TRANSLATION === 1
    && reborn.FRAME === 'A' && reborn.TRANSLATION === 1,
    `killed: ${dying}…${dead2} (S_PLAY_DIE1–7); the body stays, indigo, and player 2 comes back indigo`);
  await db.exec(`UPDATE things SET x = ${me.X + Math.cos(me.ANGLE) * 160}, y = ${me.Y + Math.sin(me.ANGLE) * 160} WHERE id = ${(await thing(2)).ID}`);
  await db.exec('UPDATE player SET armor = 0, health = 100 WHERE id = 2');
  await db.exec('EXECUTE PROCEDURE damage_player(250, NULL, 2)');
  const gib = (await one(`SELECT TRIM(t.frame) frame FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 2`)).FRAME;
  for (let i = 0; i < 60; i++) await tic([IDLE, IDLE]);
  const gibbed = (await one(`SELECT TRIM(t.frame) frame FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 2`)).FRAME;
  await tic([IDLE, [0, 0, 0, 0, 1, 0, 0]]);
  assert(gib === 'O' && gibbed === 'W', `below -100 health: ${gib}…${gibbed} (S_PLAY_XDIE1–9)`);
}
// R_InitTranslationTables: the green ramp, and only it, becomes indigo, brown or red
assert(TRANSLATIONS.length === 3 && TRANSLATIONS[0][0x70] === 0x60 && TRANSLATIONS[1][0x7f] === 0x4f
  && TRANSLATIONS[2][0x75] === 0x25 && TRANSLATIONS[0][0x6f] === 0x6f && TRANSLATIONS[2][0x80] === 0x80,
  'the translation tables: 0x70–0x7F to 0x60, 0x40 and 0x20 for players 2, 3 and 4');

// determinism: the same start and the same two command streams, the same game
let s = 3;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const stream = Array.from({ length: 120 }, () => [0, 1].map(() => [rnd() < 0.7 ? 1 : 0, rnd() < 0.2 ? 1 : 0, (rnd() - 0.5) * 0.2, rnd() < 0.2 ? 1 : 0, rnd() < 0.05 ? 1 : 0, 0, rnd() < 0.3 ? 1 : 0]));
async function play() {
  await loadMap(db, wad, res, map, { skill: 4, players: 2 });
  await db.exec('UPDATE game SET rng = 777 WHERE id = 1');
  await db.exec('UPDATE player SET health = 100000');
  for (const c of stream) await tic(c);
  return JSON.stringify((await captureGame(db)).tables);
}
const a = await play();
const b = await play();
assert(a === b, `two players' 120 tics of commands, played twice from the same start, give the same game, row for row`);

// ── two peers in lockstep (net.js), each with its own Firebird, linked by a
// pretend network that delivers messages late and out of step with each other ──
{
  const db2 = new FirebirdBrowser('memory://net-peer2', { transport: new DirectTransport() });
  await createSchema(db2, sql);
  const res2 = await loadResources(db2, wad);
  const peers = [{ db, me: 1 }, { db: db2, me: 2 }];
  for (const p of peers) {
    await loadMap(p.db, wad, p.me === 1 ? res : res2, map, { skill: 4, players: 2, newGame: true });
    await p.db.exec('UPDATE game SET rng = 4321 WHERE id = 1');
    await p.db.exec('UPDATE player SET health = 100000');
    await p.db.exec(`UPDATE viewcfg SET player_id = ${p.me} WHERE id = 1`);
  }
  let rs = 11;
  const r = () => ((rs = (rs * 48271) % 2147483647) / 2147483647);
  const wire = [];                                       // in flight: { at, to, from, m }
  let clock = 0;
  const sender = (from) => (to, m) => {
    for (const t of to === 'all' ? peers.map((p) => p.me).filter((x) => x !== from) : [to]) {
      wire.push({ at: clock + 1 + Math.floor(r() * 6), to: t, from, m: JSON.parse(JSON.stringify(m)) });
    }
  };
  for (const p of peers) p.ls = new Lockstep({ me: p.me, players: 2, send: sender(p.me), delay: 3 });
  const ran = { 1: 0, 2: 0 };
  let stalled = 0;
  for (clock = 1; clock <= 400 && Math.min(ran[1], ran[2]) < 200; clock++) {
    for (const w of wire.filter((x) => x.at <= clock)) peers[w.to - 1].ls.receive(w.from, w.m);
    wire.splice(0, wire.length, ...wire.filter((x) => x.at > clock));
    for (const p of peers) {
      // player 2 goes quiet for a while: nobody may run ahead without its commands
      const quiet = p.me === 2 && clock > 50 && clock < 80;
      if (!quiet && p.ls.canSubmit() && p.ls.submitted < 200) {
        p.ls.submit([r() < 0.7 ? 1 : 0, r() < 0.2 ? 1 : 0, (r() - 0.5) * 0.2, r() < 0.2 ? 1 : 0, 0, 0, r() < 0.3 ? 1 : 0]);
      }
      for (let t = p.ls.take(); t; t = p.ls.take()) {
        await p.db.query(`EXECUTE BLOCK AS BEGIN DELETE FROM ticcmd;
          ${t.cmds.map((c, i) => `INSERT INTO ticcmd (player_id, fwd, side, turn, fire, use_key, weapon_sel, run) VALUES (${i + 1}, ${c.join(', ')});`).join('\n')} END`);
        await p.db.query('SELECT * FROM net_tic');
        ran[p.me] = t.tic;
        if (t.tic % 35 === 0) p.ls.report(t.tic, (await p.db.query('SELECT csum FROM net_checksum')).rows[0].CSUM);
      }
      if (clock === 79 && p.me === 1) stalled = ran[1];
    }
  }
  const snap = async (d) => JSON.stringify((await captureGame(d)).tables);
  const [s1, s2] = [await snap(db), await snap(db2)];
  assert(ran[1] === 200 && ran[2] === 200 && s1 === s2 && !peers[0].ls.error,
    `two peers in lockstep over a late, jittery link run the same ${ran[1]} tics into the same game, row for row`);
  assert(stalled <= 50 + 3 + 12, `while player 2 is silent the host doesn't run ahead of it (it stopped at tic ${stalled})`);
  // a peer whose game differs is caught at the next checksum
  await db2.exec(`UPDATE things SET x = x + 1 WHERE id = (SELECT MIN(id) FROM things WHERE kind = 'monster')`);
  for (let k = 0; k < 40; k++) {
    for (const p of peers) {
      if (p.ls.canSubmit()) p.ls.submit([0, 0, 0, 0, 0, 0, 0]);
      for (const w of wire.splice(0)) peers[w.to - 1].ls.receive(w.from, w.m);
      for (let t = p.ls.take(); t; t = p.ls.take()) {
        await p.db.query('SELECT * FROM net_tic');
        if (t.tic % 35 === 0) p.ls.report(t.tic, (await p.db.query('SELECT csum FROM net_checksum')).rows[0].CSUM);
      }
    }
  }
  for (const w of wire.splice(0)) peers[w.to - 1].ls.receive(w.from, w.m);
  assert(/out of sync/.test(peers[0].ls.error ?? '') && /out of sync/.test(peers[1].ls.error ?? ''),
    `a game that drifts apart is caught by the checksum, on both sides: "${peers[0].ls.error}"`);
  await db2.close();
  await db.exec('UPDATE viewcfg SET player_id = 1 WHERE id = 1');
}

// ── deathmatch ──
{
  const dmStarts = await all('SELECT x, y FROM map_things WHERE ttype = 11');
  const keysOnMap = (await one("SELECT COUNT(*) n FROM map_things m JOIN thing_types tt ON tt.thing_type = m.ttype WHERE tt.pickup = 'key'")).N;
  await loadMap(db, wad, res, map, { skill: 3, players: 2, deathmatch: 1 });
  await db.exec('UPDATE game SET rng = 99 WHERE id = 1');
  const at = await all('SELECT p.id, p.keycards, t.x, t.y FROM player p JOIN things t ON t.id = p.thing_id ORDER BY p.id');
  const onStart = (q) => dmStarts.some((d) => d.X === q.X && d.Y === q.Y);
  const keys = (await one("SELECT COUNT(*) n FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE tt.pickup = 'key'")).N;
  assert(dmStarts.length >= 4 && at.every(onStart) && !(at[0].X === at[1].X && at[0].Y === at[1].Y),
    `${map} deathmatch: both players on deathmatch starts (${dmStarts.length} of them), not the same one (G_DeathMatchSpawnPlayer)`);
  assert(keys === 0 && at.every((p) => p.KEYCARDS === 7),
    `no keys on the map (MF_NOTDMATCH, ${keysOnMap} left out), every card in each player's pocket (P_SpawnPlayer)`);
  const d2 = await thing(2);
  // P_GiveWeapon in a netgame: a placed weapon stays, and gives five clips
  const sg = await spawn(2001, d2.X, d2.Y);
  await db.exec('UPDATE player SET shells = 0, has_shotgun = 0 WHERE id = 2');
  await db.exec('DELETE FROM sound_events');
  await tic([IDLE, IDLE]);
  const got = await one('SELECT has_shotgun, shells, pending_weapon, msg_tics FROM player WHERE id = 2');
  const still = await one(`SELECT COUNT(*) n FROM things WHERE id = ${sg}`);
  const wsnd = await one("SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSWPNUP' AND listener = 2");   // (player 1 may stand on a weapon too)
  assert(got.HAS_SHOTGUN === 1 && got.SHELLS === 20 && got.PENDING_WEAPON === 3 && still.N === 1 && wsnd.N === 1,
    `player 2 walks over a shotgun: has it, 20 shells (five clips), it stays on the map, the sound for player 2 alone`);
  await db.exec('UPDATE player SET shells = 50 WHERE id = 2');
  await db.exec('DELETE FROM sound_events');
  await tic([IDLE, IDLE]);
  const again = await one("SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSWPNUP' AND listener = 2");
  assert((await one('SELECT shells FROM player WHERE id = 2')).SHELLS === 50 && again.N === 0, 'with it and full shells: nothing, not even the sound');
  await db.exec(`DELETE FROM things WHERE id = ${sg}`);
  // frags: player 2 kills player 1, player 1 kills themself
  const t1 = await thing(1);
  await db.exec(`EXECUTE PROCEDURE damage_player(1000, ${d2.ID}, 1)`);
  const f1 = await all('SELECT killer, victim, n FROM frags WHERE n > 0 ORDER BY killer, victim');
  const h2 = await tic([IDLE, IDLE], 2);
  const h1 = await tic([IDLE, IDLE], 1);
  assert(f1.length === 1 && f1[0].KILLER === 2 && f1[0].VICTIM === 1 && f1[0].N === 1 && h2.FRAGS === 1 && h1.FRAGS === 0 && h1.DEATHMATCH === 1,
    `player 2 kills player 1: frags[2][1] = 1; the status bar says 1 for player 2, 0 for player 1`);
  for (let i = 0; i < 4; i++) await tic([IDLE, IDLE]);
  await tic([[0, 0, 0, 0, 1, 0, 0], IDLE]);
  const back = await one('SELECT p.keycards, p.dead, t.x, t.y, t.id FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1');
  assert(back.DEAD === 0 && back.ID !== t1.ID && onStart(back) && back.KEYCARDS === 7, 'reborn: at a deathmatch start, with every card again');
  await db.exec(`EXECUTE PROCEDURE damage_player(1000, ${back.ID}, 1)`);
  const h1b = await tic([IDLE, IDLE], 1);
  assert((await one('SELECT n FROM frags WHERE killer = 1 AND victim = 1')).N === 1 && h1b.FRAGS === -1, 'player 1 blows themself up: frags[1][1] = 1, and the status bar says -1');
  await db.exec('EXECUTE PROCEDURE damage_player(1000, NULL, 2)');
  const h2b = await tic([IDLE, IDLE], 2);
  assert(h2b.FRAGS === 1 && (await one('SELECT SUM(n) s FROM frags')).S === 2, "the world (slime, a crusher) killing player 2 is nobody's frag");
  // -timer: the level ends after a minute
  await db.exec('UPDATE game SET time_limit = 1 WHERE id = 1');
  await db.exec('UPDATE game SET tic = 2098 WHERE id = 1');
  await tic([IDLE, IDLE]);
  const e0 = (await one('SELECT exit_kind FROM game')).EXIT_KIND;
  await tic([IDLE, IDLE]);
  const e1 = (await one('SELECT exit_kind, tic FROM game'));
  assert(e0 === 0 && e1.EXIT_KIND === 1 && e1.TIC === 2100, '-timer 1: the level exits at tic 2100, a minute in');

  // -altdeath: what's picked up comes back 30 seconds later, in a puff of fog
  await loadMap(db, wad, res, map, { skill: 3, players: 2, deathmatch: 2 });
  await db.exec('UPDATE game SET rng = 99 WHERE id = 1');
  const a2 = await thing(2);
  await db.exec('UPDATE player SET health = 50, armor = 0, shells = 0, has_shotgun = 0');
  const medi = await spawn(2012, a2.X, a2.Y);
  const sg2 = await spawn(2001, a2.X + 1, a2.Y);
  const sphere = await spawn(2022, a2.X, a2.Y + 1);
  const clip = await spawn(2007, a2.X + 1, a2.Y + 1);
  await db.exec(`UPDATE things SET flags = BIN_OR(flags, 65536) WHERE id = ${clip}`);   // (MF_DROPPED: as a zombie drops it)
  await db.exec('UPDATE player SET bullets = 0');
  await tic([IDLE, IDLE]);
  const gone = (await one(`SELECT COUNT(*) n FROM things WHERE id IN (${medi}, ${sg2}, ${sphere}, ${clip})`)).N;
  const queue = await all('SELECT id, ttype, tic FROM respawn_queue ORDER BY id');   // (plus whatever lay on that start)
  const p2 = await one('SELECT health, has_shotgun, shells, invuln_tics, bullets FROM player WHERE id = 2');
  const queued = (t) => queue.some((q) => q.TTYPE === t);
  assert(gone === 0 && p2.HEALTH === 75 && p2.HAS_SHOTGUN === 1 && p2.SHELLS >= 8 && p2.INVULN_TICS > 0 && p2.BULLETS === 5
    && queued(2012) && queued(2001) && !queued(2022) && !queued(2007),
    `altdeath: a medikit, shotgun, invulnerability and a dropped clip are all taken (the shotgun like in single player); the first two queue to respawn (${queue.length} things do), the sphere and the dropped clip never`);
  // (both players out of the way: whoever stands on the spot would take it right back, as in DOOM)
  await db.exec("UPDATE things SET x = x + 300, y = y + 300 WHERE kind = 'player'");
  for (let i = 0; i < 30 * 35 - 1; i++) await tic([IDLE, IDLE]);
  const early = (await one('SELECT COUNT(*) n FROM respawn_queue')).N;
  const perTic = [];
  for (let k = 0; k < queue.length; k++) {
    await tic([IDLE, IDLE]);
    perTic.push((await one('SELECT COUNT(*) n FROM respawn_queue')).N);
  }
  const backMedi = await one(`SELECT COUNT(*) n FROM things WHERE thing_type = 2012 AND x = ${a2.X} AND y = ${a2.Y}`);
  const backSg = await one(`SELECT COUNT(*) n FROM things WHERE thing_type = 2001 AND x = ${a2.X + 1} AND y = ${a2.Y}`);
  const fog = await one('SELECT COUNT(*) n FROM things WHERE thing_type = 9017');
  const itmbk = await one("SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSITMBK'");
  assert(early === queue.length && perTic.every((n, k) => n === queue.length - k - 1) && backMedi.N === 1 && backSg.N === 1
    && fog.N === queue.length && itmbk.N === queue.length,
    `P_RespawnSpecials: 30 seconds on they come back where they were, one a tic (${perTic.join(', ')} left), each in fog with its sound`);
  // co-op (no deathmatch): placed weapons stay too, but the keys are there and the players at their own starts
  await loadMap(db, wad, res, map, { skill: 3, players: 2, deathmatch: 0, timer: 0 });
  const c2 = await thing(2);
  const coopKeys = (await one("SELECT COUNT(*) n FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE tt.pickup = 'key'")).N;
  const sg3 = await spawn(2001, c2.X, c2.Y);
  await db.exec('UPDATE player SET shells = 0, has_shotgun = 0, keycards = 0');
  await tic([IDLE, IDLE]);
  const coop = await one('SELECT has_shotgun, shells, keycards FROM player WHERE id = 2');
  assert(coopKeys === keysOnMap && c2.X === starts[1].X && coop.HAS_SHOTGUN === 1 && coop.SHELLS === 20 && coop.KEYCARDS === 0
    && (await one(`SELECT COUNT(*) n FROM things WHERE id = ${sg3}`)).N === 1,
    'co-op: keys on the map, no cards given, players at their own starts; a placed shotgun stays and gives five clips here too');
}

// and alone it's still player 1 and DOOM_TIC
await loadMap(db, wad, res, map, { skill: 3, players: 1 });
const n = (await one('SELECT COUNT(*) n FROM player')).N;
const pl = (await one("SELECT COUNT(*) n FROM things WHERE kind = 'player'")).N;
assert(n === 1 && pl === 1, 'back to one player: one row, one player thing');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'netgame ok');
process.exit(failures ? 1 : 0);
