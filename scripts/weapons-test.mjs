// weapons-test.mjs – fire the rocket launcher, plasma gun and BFG at a monster
// inside the real engine and check what happens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://weapons', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const tic = (args) => db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', args).then((r) => r.rows[0]);
const IDLE = [1, 0, 0, 0, 0, 0, 0, 0];
const psprite = () => db.query('SELECT weapon, weapon_y, weapon_down, pending_weapon FROM player').then((r) => r.rows[0]);

/** Tics until the weapon in hand is up and no other is pending (A_Lower, A_Raise). */
async function settle() {
  let s = await tic(IDLE);
  for (let n = 0; n < 80; n++) {
    const w = await psprite();
    if (w.WEAPON_Y === 0 && w.WEAPON_DOWN === 0 && w.PENDING_WEAPON === 0) break;
    s = await tic(IDLE);
  }
  return s;
}

/** A weapon key, then wait for the change. */
async function select(key) {
  await tic([1, 0, 0, 0, 0, 0, key, 0]);
  return settle();
}

/** Stand 200 units from a fresh monster with a clear shot, facing it. */
async function lineUp() {
  const mons = (await db.query("SELECT t.id, t.x, t.y, t.z, t.hp FROM things t WHERE t.kind = 'monster' AND t.st <> 'dead' AND t.st <> 'dying' ORDER BY t.id")).rows;
  for (const m of mons) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const x = m.X + Math.cos(a) * 200;
      const y = m.Y + Math.sin(a) * 200;
      const r = (await db.query(`EXECUTE BLOCK RETURNS (ok SMALLINT, fz DOUBLE PRECISION, seen SMALLINT) AS
          DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
          BEGIN
            EXECUTE PROCEDURE check_position(-1, ${x}, ${y}, (SELECT floor_h FROM sectors WHERE id = sector_at(${x}, ${y})), 16, 56, 0)
              RETURNING_VALUES ok, fz, cz, dz, sec;
            seen = check_sight(${x}, ${y}, fz + 32, ${m.X}, ${m.Y}, ${m.Z} + 32);
            SUSPEND;
          END`)).rows[0];
      if (r.OK === 1 && r.SEEN === 1 && Math.abs(r.FZ - m.Z) < 24) {
        await db.exec(`UPDATE things t SET x = ${x}, y = ${y}, z = ${r.FZ}, angle = ${a + Math.PI}, momx = 0, momy = 0,
                       sector_id = sector_at(${x}, ${y}) WHERE t.kind = 'player'`);
        await db.exec(`UPDATE things SET hp = 1000, st = 'idle' WHERE id = ${m.ID}`); // let it soak a few hits
        return m.ID;
      }
    }
  }
  return null;
}

await loadMap(db, wad, res, wad.mapNames()[0]);
await db.exec(`UPDATE player SET has_launcher = 1, has_plasma = 1, has_bfg = 1, rockets = 10, cells = 200, health = 200`);

// changing weapons takes time (P_SetupPsprites, A_WeaponReady, A_Lower, A_Raise)
{
  // (nobody to bother us while we count)
  const awake = (await db.query("SELECT id FROM things WHERE kind = 'monster' AND st <> 'dead'")).rows.map((r) => r.ID);
  if (awake.length) await db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE id IN (${awake.join()})`);
  // a level starts with the weapon coming up: RAISESPEED 6 a tic from 90 below
  let up = 0;
  const start = (await psprite()).WEAPON_Y;
  while ((await psprite()).WEAPON_Y > 0 && up < 40) { await tic(IDLE); up++; }
  // pistol to rocket launcher with the trigger held all the way: the pistol
  // goes down (16 tics), the launcher comes up (15), and only then it fires
  const b0 = (await db.query('SELECT bullets, rockets FROM player')).rows[0];
  let s = await tic([1, 0, 0, 0, 1, 0, 5, 0]);
  let n = 1;
  let deepest = s.WEAPON_Y;
  let shotEarly = false;
  let swapped = 0;
  while (s.ROCKETS === b0.ROCKETS && n < 60) {
    s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
    n++;
    deepest = Math.max(deepest, s.WEAPON_Y);
    if (s.BULLETS !== b0.BULLETS) shotEarly = true;
    if (!swapped && s.WEAPON === 5) swapped = n;
  }
  assert(start === 90 && up === 15, `a level starts with the weapon rising: ${start} below, up in ${up} tics`);
  assert(swapped === 16 && n === 32 && deepest >= 90 && !shotEarly && s.WEAPON === 5,
    `pistol to launcher, trigger held: lowered out of sight (${deepest}), the launcher in hand at tic ${swapped}, its first rocket at tic ${n}; nothing fired before`);
  // pressed while firing, the change waits for the attack to finish
  await settle();
  s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const fired = s.ATTACK_TICS;
  s = await tic([1, 0, 0, 0, 0, 0, 2, 0]);
  const mid = await psprite();
  assert(fired > 0 && mid.WEAPON === 5 && mid.PENDING_WEAPON === 2 && mid.WEAPON_Y === 0,
    'a key pressed mid-attack makes the pistol pending; the launcher finishes its shot first');
  s = await settle();
  assert(s.WEAPON === 2, `…and then the pistol comes up (weapon ${s.WEAPON})`);
  // out of ammo: no click, the next best weapon comes up
  // (P_CheckAmmo's order: the plasma gun first, while it has cells)
  await db.exec('UPDATE player SET bullets = 0');
  const c0 = (await db.query('SELECT cells FROM player')).rows[0].CELLS;
  s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const dry = await psprite();
  s = await settle();
  assert(dry.PENDING_WEAPON === 6 && dry.WEAPON === 2 && s.WEAPON === 6 && s.CELLS === c0 && s.ATTACK_TICS === 0,
    `out of bullets, the trigger brings up the plasma gun (weapon ${s.WEAPON}) without firing anything`);
  await db.exec('UPDATE player SET bullets = 50, rockets = 10');
  if (awake.length) await db.exec(`UPDATE things SET st = 'idle', solid = 1 WHERE id IN (${awake.join()})`);
}

for (const [w, name, ammoCol, sound, ticsToHit] of [[5, 'rocket launcher', 'ROCKETS', 'DSRLAUNC', 20], [6, 'plasma gun', 'CELLS', 'DSPLASMA', 12], [7, 'BFG', 'CELLS', 'DSBFG', 40]]) {
  const before = await select(w);           // (first: monsters get 31 tics to wander while it changes)
  const target = await lineUp();
  assert(target != null, `${name}: found a monster to shoot`);
  if (!target) continue;
  const hp0 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  const after = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  assert(after.WEAPON === w, `${name}: selected (weapon ${after.WEAPON})`);
  assert(after[ammoCol] < before[ammoCol], `${name}: used ammo (${before[ammoCol]} → ${after[ammoCol]})`);
  const snd = (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE sound = '${sound}'`)).rows[0].N;
  assert(snd > 0, `${name}: played ${sound}`);
  for (let i = 0; i < ticsToHit; i++) await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  const hp1 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0]?.HP ?? 0;
  assert(hp1 < hp0, `${name}: the monster took ${hp0 - hp1} damage`);
  for (let i = 0; i < 40; i++) await tic([1, 0, 0, 0, 0, 0, 0, 0]);
}
const spray = (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSRXPLOD'`)).rows[0].N;
assert(spray > 0, 'BFG ball exploded');

// the chainsaw: melee every 4 tics, with a hit sound when it bites
{
  await db.exec('UPDATE player SET has_chainsaw = 1');
  let s = await select(1);
  assert(s.WEAPON === 8, `chainsaw: key 1 selects it (weapon ${s.WEAPON})`);
  const target = await lineUp();
  // step in to 50 units: lineUp leaves us 200 away, facing the monster
  await db.exec(`UPDATE things t SET x = t.x + COS(t.angle) * 150, y = t.y + SIN(t.angle) * 150 WHERE t.kind = 'player'`);
  await db.exec(`UPDATE things t SET sector_id = sector_at(t.x, t.y) WHERE t.kind = 'player'`);
  const hp0 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  for (let i = 0; i < 16; i++) s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const hp1 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0]?.HP ?? 0;
  const snd = (await db.query("SELECT LIST(DISTINCT sound) l FROM sound_events WHERE sound STARTING WITH 'DSSAW'")).rows[0].L ?? '';
  assert(hp1 < hp0, `chainsaw: the monster took ${hp0 - hp1} damage`);
  assert(snd.includes('DSSAWUP') && snd.includes('DSSAWHIT'), `chainsaw: played ${snd}`);
  s = await select(1);
  assert(s.WEAPON === 1, 'chainsaw: key 1 again goes back to the fist');

  // the berserk pack: health back to 100, out comes the fist, and it hits ten times as hard
  // (it doesn't stand still beside you – P_NewChaseDir walks it round you – so put it back in reach)
  const inReach = () => db.exec(`UPDATE things m SET
      x = (SELECT p.x + COS(p.angle) * 50 FROM things p WHERE p.kind = 'player'),
      y = (SELECT p.y + SIN(p.angle) * 50 FROM things p WHERE p.kind = 'player'),
      z = (SELECT p.z FROM things p WHERE p.kind = 'player'), momz = 0 WHERE m.id = ${target}`)
    .then(() => db.exec(`UPDATE things t SET sector_id = sector_at(t.x, t.y) WHERE t.id = ${target}`));
  const punches = async (n) => {
    await inReach();
    const h0 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 18; i++) {
        // (held in its pain state, so it stays in reach)
        await db.exec(`UPDATE things SET st = 'pain', st_tics = 99, hp = MAXVALUE(hp, 100) WHERE id = ${target}`);
        await tic([1, 0, 0, 0, i === 0 ? 1 : 0, 0, 0, 0]);
      }
    }
    return h0 - (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  };
  // (everyone but the punching bag lies down: a woken monster mustn't hurt us between action and check)
  await db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE kind = 'monster' AND id <> ${target}`);
  await db.exec(`UPDATE things SET hp = 5000 WHERE id = ${target}`);
  const bare = await punches(4);
  await db.exec('UPDATE player SET health = 40, has_shotgun = 1, weapon = 3');
  const p = (await db.query("SELECT x, y FROM things WHERE kind = 'player'")).rows[0];
  await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
      EXECUTE PROCEDURE spawn_thing(2023, ${p.X}, ${p.Y}, NULL, 0) RETURNING_VALUES id; END`);
  s = await tic(IDLE);
  const healed = s.HEALTH;
  const strength = s.STRENGTH_TICS;
  const fistNext = (await psprite()).PENDING_WEAPON;
  s = await settle();
  assert(healed === 100 && fistNext === 1 && s.WEAPON === 1 && strength > 0,
    `berserk: health ${healed}, the fist pending (${fistNext}) and then up (weapon ${s.WEAPON}), strength ${strength}`);
  await db.exec(`UPDATE things SET hp = 5000 WHERE id = ${target}`);
  const mad = await punches(4);
  assert(bare > 0 && bare <= 80 && mad >= 80 && mad > bare,   // (each bare punch ≤ 20, each berserk one ≥ 20)
    `berserk: four punches did ${bare} bare, ${mad} berserk (2d10 × 10)`);
}

// the cheats: IDFA and IDKFA arm you to the teeth, IDDQD toggles god mode
{
  // (nobody nibbling at the health checks; they get up again afterwards)
  const sleepers = (await db.query("SELECT id FROM things WHERE kind = 'monster' AND st <> 'dead'")).rows.map((r) => r.ID);
  if (sleepers.length) await db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE id IN (${sleepers.join()})`);
  const disarm = () => db.exec(`UPDATE player SET has_shotgun = 0, has_chaingun = 0, has_launcher = 0, has_plasma = 0,
                 has_bfg = 0, has_chainsaw = 0, has_ssg = 0, bullets = 1, shells = 0, rockets = 0, cells = 0, armor = 0, keycards = 0`);
  await disarm();
  await db.exec(`EXECUTE PROCEDURE cheat('idfa')`);
  const f = (await db.query('SELECT * FROM player')).rows[0];
  assert(f.HAS_SHOTGUN && f.HAS_CHAINGUN && f.HAS_LAUNCHER && f.HAS_PLASMA && f.HAS_BFG && f.HAS_CHAINSAW
    && f.BULLETS === f.MAX_BULLETS && f.CELLS === f.MAX_CELLS && f.ARMOR === 200 && f.KEYCARDS === 0
    && f.MSG === 'Ammo (no keys) Added',
    `IDFA: every weapon, full ammo, armor ${f.ARMOR}, but no keys (${f.KEYCARDS}): "${f.MSG}"`);
  await disarm();
  await db.exec(`EXECUTE PROCEDURE cheat('IDKFA')`);
  const k = (await db.query('SELECT * FROM player')).rows[0];   // (before a tic: the monster nearby is awake)
  const phase2 = wad.mapNames()[0].startsWith('MAP');
  assert(k.HAS_SHOTGUN && k.HAS_CHAINGUN && k.HAS_LAUNCHER && k.HAS_PLASMA && k.HAS_BFG && k.HAS_CHAINSAW
    && k.HAS_SSG === (phase2 ? 1 : 0) && k.BULLETS === k.MAX_BULLETS && k.SHELLS === k.MAX_SHELLS
    && k.ROCKETS === k.MAX_ROCKETS && k.CELLS === k.MAX_CELLS && k.ARMOR === 200 && k.ARMOR_TYPE === 2 && k.KEYCARDS === 7
    && k.MSG === 'Very Happy Ammo Added',
    `IDKFA: every weapon (super shotgun ${k.HAS_SSG}), ${k.BULLETS}/${k.SHELLS}/${k.ROCKETS}/${k.CELLS} ammo, armor ${k.ARMOR}, keys ${k.KEYCARDS}`);

  await db.exec('UPDATE player SET health = 30');
  await db.exec(`EXECUTE PROCEDURE cheat('iddqd')`);
  const g = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  await db.exec('UPDATE player SET armor = 0');
  await db.exec('EXECUTE PROCEDURE damage_player(999)');
  const g2 = (await db.query('SELECT health, god FROM player')).rows[0];
  assert(g.GOD === 1 && g.HEALTH === 100 && g.MSG === 'Degreelessness Mode On' && g2.HEALTH === 100,
    `IDDQD: god mode on (god ${g.GOD}, "${g.MSG}"), healed to ${g.HEALTH}, and a hit for 999 does nothing (health ${g2.HEALTH})`);
  await db.exec(`EXECUTE PROCEDURE cheat('iddqd')`);
  const o = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  await db.exec('EXECUTE PROCEDURE damage_player(10)');
  const o2 = (await db.query('SELECT health FROM player')).rows[0];
  assert(o.GOD === 0 && o.MSG === 'Degreelessness Mode Off' && o2.HEALTH === 90, `IDDQD again: off, and damage hurts (health ${o2.HEALTH})`);

  // IDMYPOS: where you are, in DOOM's own units – BAMs and 16.16 fixed point, in hex
  const here = (await db.query("SELECT x, y, angle FROM things WHERE kind = 'player'")).rows[0];
  await db.exec(`UPDATE things SET x = 1, y = -1, angle = ${Math.PI / 2} WHERE kind = 'player'`);
  await db.exec(`EXECUTE PROCEDURE cheat('idmypos')`);
  const pos = (await db.query('SELECT msg FROM player')).rows[0].MSG;
  await db.exec(`UPDATE things SET x = ${here.X}, y = ${here.Y}, angle = ${here.ANGLE} WHERE kind = 'player'`);
  assert(pos === 'ang=0x40000000;x,y=(0x10000,0xffff0000)', `IDMYPOS at (1, -1) facing north: "${pos}"`);

  // IDCHOPPERS: the chainsaw, and vanilla's one tic of "invulnerability"
  await db.exec('UPDATE player SET has_chainsaw = 0, invuln_tics = 500');
  await db.exec(`EXECUTE PROCEDURE cheat('idchoppers')`);
  const c = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  assert(c.HAS_CHAINSAW === 1 && c.INVULN_TICS === 0 && c.MSG === "... doesn't suck - GM",
    `IDCHOPPERS: the chainsaw (${c.HAS_CHAINSAW}), and a running invulnerability cut to one tic (${c.INVULN_TICS} left)`);

  // IDBEHOLD: the list, then each letter toggles its power-up
  await db.exec(`UPDATE player SET invuln_tics = 0, strength_tics = 0, invis_tics = 0, iron_tics = 0, allmap = 0,
                 infra_tics = 0, health = 50`);
  await db.exec(`EXECUTE PROCEDURE cheat('idbehold')`);
  const list = (await db.query('SELECT msg FROM player')).rows[0].MSG;
  for (const l of 'vsiral') await db.exec(`EXECUTE PROCEDURE cheat('idbehold${l}')`);
  const on = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  for (const l of 'vsiral') await db.exec(`EXECUTE PROCEDURE cheat('idbehold${l}')`);
  const off = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  assert(list === 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp'
    && on.INVULN_TICS > 1040 && on.STRENGTH_TICS > 0 && on.HEALTH === 100 && on.INVIS_TICS > 2090
    && on.IRON_TICS > 2090 && on.ALLMAP === 1 && on.INFRA_TICS > 4190 && on.MSG === 'Power-up Toggled'
    && off.INVULN_TICS === 0 && off.STRENGTH_TICS === 0 && off.INVIS_TICS === 0 && off.IRON_TICS === 0
    && off.ALLMAP === 1 && off.INFRA_TICS === 0,
    `IDBEHOLD v/s/i/r/a/l: all on (${on.INVULN_TICS}/${on.STRENGTH_TICS}/${on.INVIS_TICS}/${on.IRON_TICS}/${on.ALLMAP}/${on.INFRA_TICS}), `
    + `again all off but the map (${off.INVULN_TICS}/${off.STRENGTH_TICS}/${off.INVIS_TICS}/${off.IRON_TICS}/${off.ALLMAP}/${off.INFRA_TICS})`);
  await db.exec('UPDATE player SET health = 200');
  if (sleepers.length) await db.exec(`UPDATE things SET st = 'idle', solid = 1 WHERE id IN (${sleepers.join()})`);
}

// the super shotgun, where the WAD has its graphics (DOOM II / Phase 2)
if (wad.lump('SHT2A0')) {
  const target = await lineUp();
  await db.exec('UPDATE player SET has_ssg = 1, has_shotgun = 1, shells = 20');
  let s = await select(3);
  assert(s.WEAPON === 9, `super shotgun: key 3 selects it (weapon ${s.WEAPON})`);
  const hp0 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const hp1 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0]?.HP ?? 0;
  assert(s.SHELLS === 18, `super shotgun: two shells per shot (${s.SHELLS} left)`);
  assert(hp1 < hp0, `super shotgun: 20 pellets did ${hp0 - hp1} damage`);
  for (let i = 0; i < 60; i++) await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  const snd = (await db.query("SELECT LIST(DISTINCT sound) l FROM sound_events WHERE sound IN ('DSDSHTGN', 'DSDBOPN', 'DSDBLOAD', 'DSDBCLS')")).rows[0].L ?? '';
  assert(['DSDSHTGN', 'DSDBOPN', 'DSDBLOAD', 'DSDBCLS'].every((n) => snd.includes(n)), `super shotgun: fire and reload sounds (${snd})`);
  s = await select(3);
  assert(s.WEAPON === 3, 'super shotgun: key 3 again goes back to the shotgun');
} else {
  console.log('(this WAD has no super shotgun graphics; skipping it)');
}


// a dead player's weapon drops out of sight
await db.exec('UPDATE player SET health = 100, god = 0, invuln_tics = 0');
await db.exec('EXECUTE PROCEDURE damage_player(10000)');
let gone = null;
for (let i = 0; i < 20; i++) gone = await tic(IDLE);
assert(gone.DEAD === 1 && gone.WEAPON_Y === 96, `dead, the weapon goes down out of sight (${gone.WEAPON_Y} below)`);

// rockets hurt whoever is close, including you
await db.exec(`UPDATE player SET health = 100, armor = 0, dead = 0`);
const p = (await db.query(`SELECT t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`)).rows[0];
await db.exec(`EXECUTE PROCEDURE radius_attack(${p.X + 1}, ${p.Y}, ${p.Z}, 128, -1)`);   // (right beside you: 40 away can be inside a wall)
const hp = (await db.query('SELECT health FROM player')).rows[0].HEALTH;
assert(hp < 100, `splash damage reaches the player (${100 - hp})`);

// pickups
await db.exec(`UPDATE player SET has_launcher = 0, has_plasma = 0, rockets = 0, cells = 0, weapon = 2, dead = 0, health = 100`);
for (const [type, check] of [[2003, 'HAS_LAUNCHER'], [2004, 'HAS_PLASMA'], [2046, 'ROCKETS'], [17, 'CELLS']]) {
  await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
      EXECUTE PROCEDURE spawn_thing(${type}, (SELECT x FROM things WHERE kind = 'player'), (SELECT y FROM things WHERE kind = 'player'), NULL, 0) RETURNING_VALUES id;
    END`);
  const s = await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  assert(s[check] > 0, `picking up type ${type} sets ${check} (${s[check]})`);
}

await db.close();
console.log(failures ? `${failures} failure(s)` : 'weapons ok');
process.exit(failures ? 1 : 0);
