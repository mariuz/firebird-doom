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

// and alone it's still player 1 and DOOM_TIC
await loadMap(db, wad, res, map, { skill: 3, players: 1 });
const n = (await one('SELECT COUNT(*) n FROM player')).N;
const pl = (await one("SELECT COUNT(*) n FROM things WHERE kind = 'player'")).N;
assert(n === 1 && pl === 1, 'back to one player: one row, one player thing');

await db.close();
console.log(failures ? `${failures} failure(s)` : 'netgame ok');
process.exit(failures ? 1 : 0);
