// dehacked-test.mjs – DeHackEd patches: Freedoom's own lump, and a patch that
// changes things, ammo, the Misc rules and cheats, played out in Firebird.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { applyDehacked, parseDehacked } from '../src/dehacked.js';
import { THING_TYPES } from '../src/thinginfo.js';
import { cheatReaders } from '../src/cheats.js';
import { parTime, setParOverrides } from '../src/intermission.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// Freedoom's lump: frame tweaks (which this port can't take), [PARS], and Phase 1's cheat swap
const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad')));
const own = parseDehacked(new TextDecoder('latin1').decode(wad.data(wad.lump('DEHACKED'))));
const ownApplied = applyDehacked(THING_TYPES, own);
assert(own.pars.get('E1M1') === 30 && own.pars.get('E3M9') === 570 && own.pars.size === 27,
  `Freedoom 1's [PARS]: ${own.pars.size} par times (E1M1 ${own.pars.get('E1M1')} s, E3M9 ${own.pars.get('E3M9')} s)`);
assert(ownApplied.cheats.idspispopd === 'idclip' && ownApplied.cheats.idclip === 'idspispopd'
    && ownApplied.report.filter((r) => r.startsWith('Frame')).length === 7,
  `…its Cheat block swaps the two no-clipping codes; its 7 Frame patches are reported, not applied`);

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
assert(fireball.dmgLo === 9 && fireball.dmgHi === 72 && fireball.speed === 20 && spectre.shadow === 0 && imp.shadow === 1,
  `Thing 32: the imp's fireball does 9–72 at speed 20; Bits by name take the spectre's shadow away, by number give it to the imp`);
assert(THING_TYPES.find((t) => t.type === 3004).hp === 20, '…and THING_TYPES itself is left alone');
assert(app.report.some((r) => r.startsWith('Thing 2: initial frame')) && app.report.some((r) => r.startsWith('Frame 12'))
    && app.report.some((r) => r.startsWith('Text "POSS"')) && app.report.some((r) => r.startsWith('Misc: monsters infight')),
  `what it can't apply is reported: ${app.report.length} lines`);
assert(app.types.find((t) => t.type === 2007).amount === 20 && app.types.find((t) => t.type === 2048).amount === 100
    && app.types.find((t) => t.type === 2002).amount === 40 && app.types.find((t) => t.type === 2047).amount === 30
    && app.types.find((t) => t.type === 17).amount === 150 && app.types.find((t) => t.type === 2018).amount === 200
    && app.types.find((t) => t.type === 2013).amount === 50,
  'clip sizes set the pickups: a clip 20, a box 100, the chaingun 40, a cell 30, a pack 150; green armour class 2 is 200 points; the soulsphere 50');

// played out in Firebird
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://deh', { transport: new DirectTransport() });
await createSchema(db, sql);
const res = await loadResources(db, wad, { dehacked: PATCH });
const one = async (q) => (await db.query(q)).rows[0];
const tic = (n = 1) => db.query(`SELECT * FROM doom_tic(${n}, 0, 0, 0, 0, 0, 0, 0)`);
await loadMap(db, wad, res, 'E1M1', { skill: 3 });
await db.exec("UPDATE things SET st = 'dead', solid = 0 WHERE kind = 'monster'");
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
await db.exec('UPDATE player SET has_bfg = 1, cells = 35, weapon = 7, weapon_y = 0, weapon_down = 0, pending_weapon = 0, attack_tics = 0');
await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 1, 0, 0, 0)');
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

await db.close();
console.log(failures ? `${failures} failure(s)` : 'dehacked ok');
process.exit(failures ? 1 : 0);
