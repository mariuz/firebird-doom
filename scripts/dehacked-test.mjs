// dehacked-test.mjs – DeHackEd patches: Freedoom's own lump, a patch that changes things,
// ammo, the Misc rules and cheats, and one that changes DOOM's frame tables (Frame, Pointer,
// Weapon, a Thing's states and reaction time), each played out in Firebird.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { applyDehacked, parseDehacked } from '../src/dehacked.js';
import { THING_TYPES } from '../src/thinginfo.js';
import { STATES } from '../src/states.js';
import { cheatReaders } from '../src/cheats.js';
import { parTime, setParOverrides } from '../src/intermission.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// Freedoom's lump: frame tweaks, [PARS], and Phase 1's cheat swap
const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad')));
const own = parseDehacked(new TextDecoder('latin1').decode(wad.data(wad.lump('DEHACKED'))));
const ownApplied = applyDehacked(THING_TYPES, own);
assert(own.pars.get('E1M1') === 30 && own.pars.get('E3M9') === 570 && own.pars.size === 27,
  `Freedoom 1's [PARS]: ${own.pars.size} par times (E1M1 ${own.pars.get('E1M1')} s, E3M9 ${own.pars.get('E3M9')} s)`);
const ST = new Map(STATES.map((x, i) => [x[0], i]));
const brightNow = ['S_POSS_ATK2', 'S_CPOS_ATK4', 'S_CYBER_ATK2', 'S_CYBER_ATK4', 'S_CYBER_ATK6']
  .filter((n) => ownApplied.states[ST.get(n)][3] === 1 && STATES[ST.get(n)][3] === 0);
const ssgFlash = ['S_DSGUNFLASH1', 'S_DSGUNFLASH2'].map((n) => `${STATES[ST.get(n)][4]}→${ownApplied.states[ST.get(n)][4]}`);
assert(ownApplied.cheats.idspispopd === 'idclip' && ownApplied.cheats.idclip === 'idspispopd' && ownApplied.report.length === 0
    && brightNow.length === 5 && ssgFlash.join() === '5→4,4→3' && STATES[ST.get('S_DSGUNFLASH1')][4] === 5,
  `…its Cheat block swaps the two no-clipping codes; its 7 Frame patches apply: full bright ${brightNow.join(', ')}; `
  + `the super shotgun's flash ${ssgFlash.join(' and ')} tics (src/states.js left alone); nothing left unapplied`);

// a patch touching everything this port can apply, and some it can't
const PATCH = `Patch File for DeHackEd v3.0
Doom version = 19
Patch format = 6

Thing 2 (Trooper)
Hit points = 55
Speed = 12
Width = 1638400
Pain chance = 100
Alert sound = 39
Action sound = 77
Initial frame = 174

Thing 32 (Imp fireball)
Missile damage = 9
Speed = 1310720

Thing 14 (Spectre)
Bits = SOLID+SHOOTABLE+COUNTKILL

Thing 12 (Imp)
Bits = 4456454

Ammo 0
Max ammo = 300
Per ammo = 20

Ammo 2
Per ammo = 30

Misc 0
Initial Health = 150
Initial Bullets = 25
Max Health = 250
Soulsphere Health = 50
Max Soulsphere = 220
Megasphere Health = 300
God Mode Health = 175
IDKFA Armor = 100
IDKFA Armor Class = 1
BFG Cells/Shot = 30
Green Armor Class = 2
Monsters Infight = 202

Cheat 0
God mode = iddqx
Level Warp = idwarp

Frame 12
Duration = 3

Text 4 4
POSSZOMB
[PARS]
par 1 1 99
par 7 77
`;
const parsed = parseDehacked(PATCH);
const app = applyDehacked(THING_TYPES, parsed);
const zombie = app.types.find((t) => t.type === 3004);
const fireball = app.types.find((t) => t.type === 9000);
const spectre = app.types.find((t) => t.type === 58);
const imp = app.types.find((t) => t.type === 3001);
assert(zombie.hp === 55 && zombie.speed === 12 && zombie.radius === 25 && zombie.painChance === 100
    && zombie.seeSnd === 'DSBGSIT1' && zombie.activeSnd === 'DSDMACT',
  `Thing 2: the zombieman gets 55 hp, speed 12, radius 25, pain chance 100, an imp's sight sound and a demon's growl`);
assert(fireball.dmgLo === 9 && fireball.speed === 20 && spectre.shadow === 0 && imp.shadow === 1,
  `Thing 32: the imp's fireball does 9–72 at speed 20; Bits by name take the spectre's shadow away, by number give it to the imp`);
assert(spectre.countKill === 1 && imp.countKill === 1 && !spectre.countItem,
  'Bits: COUNTKILL (by name, and 0x400000 by number) keeps both in the kill tally, and no COUNTITEM keeps them out of the item tally');
assert(THING_TYPES.find((t) => t.type === 3004).hp === 20, '…and THING_TYPES itself is left alone');
assert(app.report.some((r) => r.startsWith('Text "POSS"')) && app.report.some((r) => r.startsWith('Misc: monsters infight'))
    && !app.report.some((r) => /^(Thing 2|Frame 12)/.test(r)) && app.mobjinfo.MT_POSSESSED.states[0] === 174 && app.states[12][4] === 3,
  `what it can't apply is reported (${app.report.length} lines: a Text block, a Misc field); a Thing's Initial frame and a Frame's Duration apply`);
assert(app.types.find((t) => t.type === 2007).amount === 20 && app.types.find((t) => t.type === 2048).amount === 100
    && app.types.find((t) => t.type === 2002).amount === 40 && app.types.find((t) => t.type === 2047).amount === 30
    && app.types.find((t) => t.type === 17).amount === 150 && app.types.find((t) => t.type === 2018).amount === 200
    && app.types.find((t) => t.type === 2013).amount === 50,
  'clip sizes set the pickups: a clip 20, a box 100, the chaingun 40, a cell 30, a pack 150; green armour class 2 is 200 points; the soulsphere 50');

// played out in Firebird
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://deh', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const res = await loadResources(db, wad, { dehacked: PATCH });
const one = async (q) => (await db.query(q)).rows[0];
const tic = (n = 1) => db.query(`SELECT * FROM doom_tic(${n}, 0, 0, 0, 0, 0, 0, 0)`);
await loadMap(db, wad, res, 'E1M1', { skill: 3 });
await db.exec("UPDATE things SET st = 'dead', state = NULL, state_tic = NULL, solid = 0 WHERE kind = 'monster'");
const start = await one('SELECT health, bullets, max_bullets FROM player');
const tt = await one('SELECT hp, speed, see_snd FROM thing_types WHERE thing_type = 3004');
assert(start.HEALTH === 150 && start.BULLETS === 25 && start.MAX_BULLETS === 300 && tt.HP === 55 && tt.SEE_SND === 'DSBGSIT1',
  `a new game starts with 150 health and 25 of 300 bullets; THING_TYPES in Firebird has the patched zombieman`);
const p = await one("SELECT x, y FROM things WHERE kind = 'player'");
const pick = async (type) => {
  await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN EXECUTE PROCEDURE spawn_thing(${type}, ${p.X}, ${p.Y}, NULL, 0) RETURNING_VALUES id; END`);
  await tic();
  return one('SELECT health, armor, armor_type, bullets, cells, max_bullets FROM player');
};
const clip = await pick(2007);
const soul = await pick(2013);
await db.exec('UPDATE player SET health = 240');
const bonus = await pick(2014);
const mega = await pick(83);
await db.exec('UPDATE player SET armor = 0, armor_type = 0');
const green = await pick(2018);
const pack = await pick(8);
assert(clip.BULLETS === 45 && soul.HEALTH === 200 && bonus.HEALTH === 241 && mega.HEALTH === 300 && mega.ARMOR === 200
    && green.ARMOR === 200 && green.ARMOR_TYPE === 2 && pack.MAX_BULLETS === 600,
  `pickups: a clip +20, the soulsphere +50 (up to 220), a health bonus past 200 (up to 250), the megasphere 300, green armour 200 of type 2, a backpack doubles to 600`);
await db.exec(`EXECUTE PROCEDURE cheat('iddqd')`);
const god = await one('SELECT health FROM player');
await db.exec(`EXECUTE PROCEDURE cheat('iddqd')`);
await db.exec(`EXECUTE PROCEDURE cheat('idkfa')`);
const kfa = await one('SELECT armor, armor_type FROM player');
assert(god.HEALTH === 175 && kfa.ARMOR === 100 && kfa.ARMOR_TYPE === 1, `IDDQD heals to 175; IDKFA gives 100 armour of class 1`);
await db.exec('UPDATE player SET has_bfg = 1, cells = 35, weapon = 7');
await db.exec('UPDATE player p SET pending_weapon = 0, psp_sy = 32, psp_tics = 1, flash_state = NULL, psp_state = (SELECT wi.ready_state FROM weapon_info wi WHERE wi.weapon = p.weapon)');   // (the BFG up and ready)
await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 1, 0, 0, 0)');
await db.query('SELECT * FROM doom_tic(30, 0, 0, 0, 0, 0, 0, 0)');   // (A_BFGsound 20 tics, A_GunFlash 10, then A_FireBFG)
const bfg = await one('SELECT cells FROM player');
assert(bfg.CELLS === 5, `the BFG takes 30 cells a shot (35 → ${bfg.CELLS})`);

// the cheats, respelt, and the par times
const c = cheatReaders(res.dehacked.cheats);
const god2 = c.fixed.find(([k]) => k === 'iddqd')[1];
const typed = (r, s) => [...s].map((ch) => r(ch)).some(Boolean);
const warp = (s) => [...s].map((ch) => c.idclev(ch)).find((v) => v);
assert(typed(god2, 'iddqx') && !typed(god2, 'iddqd') && warp('idwarp13') === '13' && !warp('idclev13'),
  'the Cheat block respells IDDQD as IDDQX and IDCLEV as IDWARP');
setParOverrides(res.dehacked.pars);
const e1m1 = parTime('E1M1');
const map07 = parTime('MAP07');
const e1m2 = parTime('E1M2');
setParOverrides(null);
assert(e1m1 === 99 && map07 === 77 && e1m2 === 120 && parTime('E1M1') === 30,
  `[PARS]: E1M1 ${e1m1} s, MAP07 ${map07} s; E1M2 keeps the patch it came with (${e1m2} s, Freedoom's); without a patch, DOOM's own (${parTime('E1M1')} s)`);

// a patch to DOOM's frame tables, played out: the imp attacks four times as fast (Frame: its
// S_TROO_ATK1 and ATK2 take 2 tics, not 8); the zombieman's fire is the imp's (Pointer: S_POSS_ATK2
// takes S_TROO_ATK3's action, A_TroopAttack – an imp's fireball whoever throws it); the pistol
// fires as the shotgun does (Weapon 1: its shooting frame is S_SGUN1); the imp waits 2 tics, not
// 8, before it fights back (Thing 12: Reaction time); its standing frame shows the zombieman's
// sprite, full bright (Sprite number, Sprite subnumber); and frame 966, past DOS DeHackEd's table,
// lands in the fist's weaponinfo (its deselect frame: the pistol's)
const FRAMES = `Patch File for DeHackEd v3.0
Doom version = 19
Patch format = 6

Frame ${ST.get('S_TROO_ATK1')}
Duration = 2

Frame ${ST.get('S_TROO_ATK2')}
Duration = 2

Pointer 76 (Frame ${ST.get('S_POSS_ATK2')})
Codep Frame = ${ST.get('S_TROO_ATK3')}

Weapon 1
Shooting frame = ${ST.get('S_SGUN1')}

Thing 12 (Imp)
Reaction time = 2

Frame ${ST.get('S_TROO_STND')}
Sprite number = 29
Sprite subnumber = 32769

Frame 966
Next frame = ${ST.get('S_PISTOLDOWN')}
`;
const fapp = applyDehacked(THING_TYPES, parseDehacked(FRAMES));
assert(fapp.report.length === 0 && fapp.states[ST.get('S_TROO_STND')].slice(1, 4).join() === 'POSS,B,1'
    && fapp.states[ST.get('S_POSS_ATK2')][5] === 'A_TroopAttack' && fapp.weapons[1].states[3] === ST.get('S_SGUN1')
    && fapp.weapons[0].states[1] === ST.get('S_PISTOLDOWN') && fapp.types.find((t) => t.type === 3001).reaction === 2,
  'Frame, Pointer, Weapon, a Thing\'s reaction time and the frame-966 overflow all parse and apply');
const res2 = await loadResources(db, wad, { dehacked: FRAMES });
await loadMap(db, wad, res2, 'E1M1', { skill: 3 });
await db.exec("UPDATE things SET st = 'dead', state = NULL, state_tic = NULL, solid = 0 WHERE kind = 'monster'");
await db.exec('UPDATE player SET health = 10000');
const me = await one("SELECT t.id, t.x, t.y, t.angle FROM things t WHERE t.kind = 'player'");
const name = (id) => (id == null ? null : STATES[id][0]);
const spawnAhead = async (type, dist) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
  EXECUTE PROCEDURE spawn_thing(${type}, ${me.X + Math.cos(me.ANGLE) * dist}, ${me.Y + Math.sin(me.ANGLE) * dist}, NULL, ${me.ANGLE + Math.PI})
    RETURNING_VALUES id; SUSPEND; END`)).ID;
/** set a thing's state at tic T, then step the tables: [offset, state] at each change, and the missiles it threw */
async function attack(id, st, T, n) {
  await db.exec(`UPDATE game SET tic = ${T} WHERE id = 1`);
  await db.exec('DELETE FROM sound_events');
  await db.query(`EXECUTE BLOCK AS DECLARE a SMALLINT; BEGIN EXECUTE PROCEDURE set_state(${id}, ${ST.get(st)}, ${T}) RETURNING_VALUES a; END`);
  const seen = [[0, st]];
  let shot = null;
  for (let t = T + 1; t <= T + n; t++) {
    await db.query(`EXECUTE BLOCK AS BEGIN UPDATE game SET tic = ${t} WHERE id = 1; EXECUTE PROCEDURE states_think(${t}); END`);
    const now = name((await one(`SELECT state FROM things WHERE id = ${id}`)).STATE);
    if (now !== seen.at(-1)[1]) seen.push([t - T, now]);
    if (shot === null && (await one(`SELECT COUNT(*) n FROM things WHERE owner_id = ${id} AND thing_type = 9000`)).N > 0) shot = t - T;
  }
  const snd = (await db.query('SELECT TRIM(sound) s FROM sound_events')).rows.map((r) => r.S);
  return { trace: seen.map(([t, x]) => `${t}:${x}`).join(' '), shot, snd };
}
const fImp = await spawnAhead(3001, 256);
const fImpRow = await one(`SELECT t.reaction, TRIM(s.sprite) sprite, TRIM(s.frame) frame, s.bright FROM things t JOIN states s ON s.id = t.state WHERE t.id = ${fImp}`);
const fImpAtk = await attack(fImp, 'S_TROO_ATK1', 7000, 8);
await db.exec(`DELETE FROM things WHERE id = ${fImp} OR owner_id = ${fImp}`);   // (out of the zombieman's way)
const zombie2 = await spawnAhead(3004, 256);
const zombieAtk = await attack(zombie2, 'S_POSS_ATK1', 7100, 14);
assert(fImpRow.REACTION === 2 && `${fImpRow.SPRITE}${fImpRow.FRAME}${fImpRow.BRIGHT}` === 'POSSB1'
    && /^0:S_TROO_ATK1 2:S_TROO_ATK2 4:S_TROO_ATK3/.test(fImpAtk.trace) && fImpAtk.shot === 4,
  `the imp: reaction time ${fImpRow.REACTION}; stands as ${fImpRow.SPRITE} ${fImpRow.FRAME}${fImpRow.BRIGHT ? ', full bright' : ''}; attacks ${fImpAtk.trace}, its fireball at tic ${fImpAtk.shot}`);
assert(/^0:S_POSS_ATK1 10:S_POSS_ATK2/.test(zombieAtk.trace) && zombieAtk.shot === 10 && zombieAtk.snd.includes('DSFIRSHT') && !zombieAtk.snd.includes('DSPISTOL'),
  `the zombieman with the imp's attack: ${zombieAtk.trace.split(' ').slice(0, 2).join(' ')}, an imp's fireball at tic ${zombieAtk.shot} (${zombieAtk.snd.join(', ')})`);
// (the pistol, up and ready, fired: S_SGUN1's 3 tics, then A_FireShotgun – 7 pellets from one bullet)
await db.exec('UPDATE player SET weapon = 2, bullets = 50');
await db.exec('UPDATE player p SET pending_weapon = 0, psp_sy = 32, psp_tics = 1, flash_state = NULL, psp_state = (SELECT wi.ready_state FROM weapon_info wi WHERE wi.weapon = p.weapon)');
await db.exec('DELETE FROM sound_events');
await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 1, 0, 0, 0)');
const pistolNow = await one('SELECT TRIM(s.name) n FROM player p JOIN states s ON s.id = p.psp_state WHERE p.id = 1');
await db.query('SELECT * FROM doom_tic(3, 0, 0, 0, 0, 0, 0, 0)');
const pistolShot = await one('SELECT p.bullets FROM player p WHERE p.id = 1');
const pistolSnd = (await db.query('SELECT TRIM(sound) s FROM sound_events')).rows.map((r) => r.S);
const fist = await one('SELECT down_state FROM weapon_info WHERE weapon = 1');
assert(pistolNow.N === 'S_SGUN1' && pistolShot.BULLETS === 49 && pistolSnd.includes('DSSHOTGN') && fist.DOWN_STATE === ST.get('S_PISTOLDOWN'),
  `the pistol fires through ${pistolNow.N}: one bullet (${pistolShot.BULLETS} left), the shotgun's blast (${pistolSnd.join(', ')}); the fist's deselect frame is the pistol's (frame 966's overflow)`);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'dehacked ok');
process.exit(failures ? 1 : 0);
