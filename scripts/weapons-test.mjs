// weapons-test.mjs – the weapons on DOOM's frame tables (p_pspr.c's psprites): raising,
// lowering and changing them, each one's fire cycle in tics, and the rocket launcher,
// plasma gun and BFG fired at a monster inside the real engine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { parseDehStrings } from '../src/finale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://weapons', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const tic = (args) => db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', args).then((r) => r.rows[0]);
const IDLE = [1, 0, 0, 0, 0, 0, 0, 0];
// the weapon's psprite: its state, where it is (PSP_SY: WEAPONTOP 32 up, WEAPONBOTTOM 128
// out of sight), and READY while it's in a state that calls A_WeaponReady
const psprite = () => db.query(`SELECT p.weapon, p.psp_sy, p.pending_weapon, TRIM(s.name) psp, IIF(s.action = 'A_WeaponReady', 1, 0) ready,
    (SELECT TRIM(f.name) FROM states f WHERE f.id = p.flash_state) flash, p.extralight
    FROM player p LEFT JOIN states s ON s.id = p.psp_state`).then((r) => r.rows[0]);

/** Tics until the weapon in hand is up and ready and no other is pending (A_Lower, A_Raise). */
async function settle() {
  let s = await tic(IDLE);
  for (let n = 0; n < 80; n++) {
    const w = await psprite();
    if (w.READY === 1 && w.PSP_SY === 32 && w.PENDING_WEAPON === 0) break;
    s = await tic(IDLE);
  }
  return s;
}

/**
 * One press of the trigger with the weapon in hand ready: every change of the weapon's state
 * and its flash's, as tic offsets from the press, until it's ready again; and the view's light
 * while the flash burns ([offset, extralight] at each change).
 */
async function fireCycle() {
  const seen = [];
  const flash = [];
  const light = [];
  for (let t = 0; t < 120; t++) {
    await tic([1, 0, 0, 0, t === 0 ? 1 : 0, 0, 0, 0]);
    const w = await psprite();
    if (w.PSP !== seen.at(-1)?.[1]) seen.push([t, w.PSP]);
    if (w.FLASH !== flash.at(-1)?.[1] && (w.FLASH || flash.length)) flash.push([t, w.FLASH]);
    if (w.EXTRALIGHT !== (light.at(-1)?.[1] ?? 0)) light.push([t, w.EXTRALIGHT]);
    if (t > 0 && w.READY === 1) break;
  }
  const fmt = (a) => a.map(([t, n]) => `${t}:${n}`).join(' ');
  return { trace: fmt(seen), flash: fmt(flash), light: fmt(light) };
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
  if (awake.length) await db.exec(`UPDATE things SET st = 'dead', state = NULL, state_tic = NULL, solid = 0 WHERE id IN (${awake.join()})`);
  // a level starts with the weapon coming up (P_SetupPsprites): from WEAPONBOTTOM, its first
  // A_Raise at once (122), then RAISESPEED 6 a tic to WEAPONTOP
  let up = 0;
  const start = await psprite();
  while ((await psprite()).PSP_SY > 32 && up < 40) { await tic(IDLE); up++; }
  const ready = await psprite();
  // pistol to rocket launcher with the trigger held all the way: the pistol goes down
  // (A_Lower, 16 tics), the launcher comes up (A_Raise, 15), A_WeaponReady fires it, and the
  // rocket leaves 8 tics later (S_MISSILE1, A_GunFlash; then S_MISSILE2's A_FireMissile)
  const b0 = (await db.query('SELECT bullets, rockets FROM player')).rows[0];
  let s = await tic([1, 0, 0, 0, 1, 0, 5, 0]);
  let n = 1;
  let deepest = s.PSP_SY;
  let shotEarly = false;
  let swapped = 0;
  while (s.ROCKETS === b0.ROCKETS && n < 60) {
    s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
    n++;
    deepest = Math.max(deepest, s.PSP_SY);
    if (s.BULLETS !== b0.BULLETS) shotEarly = true;
    if (!swapped && s.WEAPON === 5) swapped = n;
  }
  assert(start.PSP === 'S_PISTOLUP' && start.PSP_SY === 122 && up === 15 && ready.PSP === 'S_PISTOL' && ready.READY === 1,
    `a level starts with the weapon rising: ${start.PSP} at ${start.PSP_SY}, up in ${up} tics, then ${ready.PSP}`);
  // (at WEAPONBOTTOM the launcher's first A_Raise comes in the same tic: the deepest seen is 122)
  assert(swapped === 16 && n === 39 && deepest === 122 && !shotEarly && s.WEAPON === 5,
    `pistol to launcher, trigger held: lowered out of sight (${deepest}), the launcher in hand at tic ${swapped}, its first rocket at tic ${n}; nothing fired before`);
  // pressed while firing, the change waits for the attack to finish
  await settle();
  s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const fired = await psprite();
  s = await tic([1, 0, 0, 0, 0, 0, 2, 0]);
  const mid = await psprite();
  assert(fired.READY === 0 && mid.WEAPON === 5 && mid.PENDING_WEAPON === 2 && mid.PSP_SY === 32,
    `a key pressed mid-attack (${fired.PSP}) makes the pistol pending; the launcher finishes its shot first`);
  s = await settle();
  assert(s.WEAPON === 2, `…and then the pistol comes up (weapon ${s.WEAPON})`);
  // out of ammo: no click, the next best weapon comes up
  // (P_CheckAmmo's order: the plasma gun first, while it has cells)
  await db.exec('UPDATE player SET bullets = 0');
  const c0 = (await db.query('SELECT cells FROM player')).rows[0].CELLS;
  s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  const dry = await psprite();
  s = await settle();
  const dryUp = await psprite();
  assert(dry.PENDING_WEAPON === 6 && dry.WEAPON === 2 && dry.PSP === 'S_PISTOLDOWN' && s.WEAPON === 6 && s.CELLS === c0 && dryUp.READY === 1,
    `out of bullets, the trigger (P_CheckAmmo) puts the pistol down (${dry.PSP}) and brings up the plasma gun (weapon ${s.WEAPON}) without firing anything`);
  await db.exec('UPDATE player SET bullets = 50, rockets = 10');

  // each weapon's fire cycle, at info.c's tics: the pistol's 4 + 6 + 4 + 5 (A_FirePistol at 4,
  // A_ReFire at the end), its flash at light 1 (A_Light1, then S_LIGHTDONE's A_Light0): 7 tics,
  // the first counted off in the tic it's lit (P_MovePsprites moves the flash after the weapon)
  s = await select(2);
  const pistol = await fireCycle();
  const pistolShot = (await psprite());
  assert(pistol.trace === '0:S_PISTOL1 4:S_PISTOL2 10:S_PISTOL3 14:S_PISTOL4 19:S_PISTOL'
    && pistol.flash === '4:S_PISTOLFLASH 10:null' && pistol.light === '4:1 10:0' && pistolShot.READY === 1,
    `the pistol's cycle: ${pistol.trace}; its flash ${pistol.flash}, the view lit ${pistol.light}`);
  // the shotgun: its flash's two frames, light 1 then 2 (A_Light2)
  await db.exec('UPDATE player SET has_shotgun = 1, shells = 20');
  s = await select(3);
  const shotgun = await fireCycle();
  assert(/^0:S_SGUN1 3:S_SGUN2 10:S_SGUN3 15:S_SGUN4 20:S_SGUN5 24:S_SGUN6 29:S_SGUN7 34:S_SGUN8 37:S_SGUN9 44:S_SGUN$/.test(shotgun.trace)
    && shotgun.flash === '3:S_SGUNFLASH1 6:S_SGUNFLASH2 9:null' && shotgun.light === '3:1 6:2 9:0',
    `the shotgun's cycle: ${shotgun.trace}; its flash ${shotgun.flash}, the view lit ${shotgun.light}`);
  // the chaingun, held: A_FireCGun on each of its two frames (4 tics), A_ReFire round again; each
  // shot's flash matches its frame (S_CHAINFLASH1, 2); the first cycle's two bullets go dead
  // straight (!refire), the next cycles' don't
  await db.exec('UPDATE player SET has_chaingun = 1, bullets = 50');
  s = await select(4);
  const cg = [];
  for (let t = 0; t < 16; t++) {
    s = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
    const w = await psprite();
    cg.push(`${w.PSP.slice(2)}/${w.FLASH ? w.FLASH.slice(-1) : '-'}/${s.BULLETS}`);
  }
  const refire = (await db.query('SELECT refire FROM player')).rows[0].REFIRE;
  s = await settle();
  assert(cg.slice(0, 4).join() === 'CHAIN1/1/49,CHAIN1/1/49,CHAIN1/1/49,CHAIN1/1/49' && cg[4] === 'CHAIN2/2/48' && s.BULLETS === 46 && refire === 1,
    `the chaingun held for 16 tics: a bullet every 4 (${cg.filter((c, i) => i % 4 === 0).join(' ')}), ${50 - s.BULLETS} in all, refire ${refire}`);
  s = await select(2);
  if (awake.length) await db.exec(`UPDATE things SET st = 'idle', solid = 1 WHERE id IN (${awake.join()})`);
}

let bfgBurst = 0;
// the projectile weapons: the trigger, then the shot – the rocket 8 tics on (S_MISSILE1's A_GunFlash
// first), the plasma at once (A_FirePlasma, its flash one of two), the BFG 30 tics on (A_BFGsound,
// 20 tics; A_GunFlash, 10; then A_FireBFG and its 40 cells)
for (const [w, name, ammoCol, sound, delay, used, ticsToHit] of [[5, 'rocket launcher', 'ROCKETS', 'DSRLAUNC', 8, 1, 20],
  [6, 'plasma gun', 'CELLS', 'DSPLASMA', 0, 1, 12], [7, 'BFG', 'CELLS', 'DSBFG', 30, 40, 40]]) {
  // (the monsters these wake fight back: health enough for each weapon's turn)
  await db.exec('UPDATE player SET health = 200');
  const before = await select(w);           // (first: monsters get 31 tics to wander while it changes)
  const target = await lineUp();
  assert(target != null, `${name}: found a monster to shoot`);
  if (!target) continue;
  const hp0 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  await db.exec('DELETE FROM sound_events');
  let after = await tic([1, 0, 0, 0, 1, 0, 0, 0]);
  let wait = 0;
  while (after[ammoCol] === before[ammoCol] && wait < 60) { after = await tic(IDLE); wait++; }
  assert(after.WEAPON === w, `${name}: selected (weapon ${after.WEAPON})`);
  assert(wait === delay && before[ammoCol] - after[ammoCol] === used,
    `${name}: the shot ${wait} tics after the trigger, ${before[ammoCol] - after[ammoCol]} ${ammoCol.toLowerCase()} (${before[ammoCol]} → ${after[ammoCol]})`);
  const snd = (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE sound = '${sound}'`)).rows[0].N;
  assert(snd > 0, `${name}: played ${sound}`);
  for (let i = 0; i < ticsToHit; i++) await tic([1, 0, 0, 0, 0, 0, 0, 0]);
  // (sound events are kept 70 tics: count the BFG ball's burst now)
  if (w === 7) bfgBurst = (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE sound = 'DSRXPLOD'`)).rows[0].N;
  const hp1 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0]?.HP ?? 0;
  assert(hp1 < hp0, `${name}: the monster took ${hp0 - hp1} damage`);
  for (let i = 0; i < 40; i++) await tic([1, 0, 0, 0, 0, 0, 0, 0]);
}
assert(bfgBurst > 0, 'BFG ball exploded');

// the chainsaw: melee every 4 tics, with a hit sound when it bites
{
  await db.exec('UPDATE player SET has_chainsaw = 1, health = 200');
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
      for (let i = 0; i < 24; i++) {   // (S_PUNCH1–5: 22 tics, A_Punch at 4)
        // (held in its pain state, so it stays in reach)
        await db.exec(`UPDATE things SET st = 'pain', st_tics = 99, hp = MAXVALUE(hp, 100) WHERE id = ${target}`);
        await tic([1, 0, 0, 0, i === 0 ? 1 : 0, 0, 0, 0]);
      }
    }
    return h0 - (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0].HP;
  };
  // (everyone but the punching bag lies down: a woken monster mustn't hurt us between action and check)
  await db.exec(`UPDATE things SET st = 'dead', state = NULL, state_tic = NULL, solid = 0 WHERE kind = 'monster' AND id <> ${target}`);
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
  if (sleepers.length) await db.exec(`UPDATE things SET st = 'dead', state = NULL, state_tic = NULL, solid = 0 WHERE id IN (${sleepers.join()})`);
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
  // its long cycle: 3 tics, A_FireShotgun2 (7), then A_CheckReload, A_OpenShotgun2, A_LoadShotgun2,
  // A_CloseShotgun2 and A_ReFire, 7 + 7 + 7 + 7 + 7 + 6 + 6 + 5 more
  const ssg = await fireCycle();
  const hp1 = (await db.query(`SELECT hp FROM things WHERE id = ${target}`)).rows[0]?.HP ?? 0;
  s = await tic(IDLE);
  assert(s.SHELLS === 18, `super shotgun: two shells per shot (${s.SHELLS} left)`);
  assert(hp1 < hp0, `super shotgun: 20 pellets did ${hp0 - hp1} damage`);
  assert(ssg.trace === '0:S_DSGUN1 3:S_DSGUN2 10:S_DSGUN3 17:S_DSGUN4 24:S_DSGUN5 31:S_DSGUN6 38:S_DSGUN7 45:S_DSGUN8 51:S_DSGUN9 57:S_DSGUN10 62:S_DSGUN'
    && ssg.flash === '3:S_DSGUNFLASH1 7:S_DSGUNFLASH2 11:null',
    `super shotgun's cycle: ${ssg.trace}; its flash ${ssg.flash}`);
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
const goneW = await psprite();
assert(gone.DEAD === 1 && gone.PSP_SY === 128 && /DOWN$/.test(goneW.PSP), `dead, the weapon goes down out of sight (P_DropWeapon, A_Lower: ${goneW.PSP} at ${gone.PSP_SY})`);

// rockets hurt whoever is close, including you
await db.exec(`UPDATE player SET health = 100, armor = 0, dead = 0`);
// (and the body stood up again: dead, it lies in its death states, not solid and not to be hit)
await db.exec(`UPDATE things SET st = 'idle', solid = 1, state = (SELECT tt.spawn_state FROM thing_types tt WHERE tt.thing_type = 1), state_tic = NULL WHERE kind = 'player'`);
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

// MF_DROPPED: what a zombie drops is worth half (P_GiveAmmo(…, 0), P_GiveWeapon's dropped);
// P_GiveWeapon: a weapon you own stays put when its ammo is full; MF_COUNTKILL / MF_COUNTITEM
const mult = [1, 5].includes((await db.query('SELECT skill FROM game')).rows[0].SKILL) ? 2 : 1;
const one = async (sql) => (await db.query(sql)).rows[0];
const spawnHere = async (type) => (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
    EXECUTE PROCEDURE spawn_thing(${type}, (SELECT x FROM things WHERE kind = 'player'), (SELECT y FROM things WHERE kind = 'player'), NULL, 0) RETURNING_VALUES id;
    SUSPEND; END`)).ID;
const killHere = async (type) => {
  const id = await spawnHere(type);
  await db.query(`EXECUTE PROCEDURE damage_thing(${id}, 10000)`);
  return one(`SELECT FIRST 1 t.id, t.thing_type, t.flags FROM things t WHERE t.kind = 'item' ORDER BY t.id DESC`);
};
// (in god mode: the barrels earlier sections set off are still going off around you)
await db.exec(`UPDATE player SET bullets = 0, shells = 0, has_shotgun = 1, has_chaingun = 1, has_chainsaw = 0, dead = 0, health = 100, god = 1`);
const k0 = await one('SELECT kills, items FROM player');
const clip = await killHere(3004);
assert(clip.THING_TYPE === 2007 && (clip.FLAGS & 65536) !== 0, `a dead zombieman drops a clip marked MF_DROPPED (flags ${clip.FLAGS})`);
let s = await tic(IDLE);
assert(s.BULLETS === 5 * mult, `a dropped clip gives half a clip (${s.BULLETS}, expected ${5 * mult})`);
const k1 = await one('SELECT kills, items FROM player');
assert(k1.KILLS === k0.KILLS + 1, `the zombieman counts as a kill (${k0.KILLS} → ${k1.KILLS})`);
assert(k1.ITEMS === k0.ITEMS, `a clip isn't in the item tally (${k0.ITEMS} → ${k1.ITEMS})`);
await db.exec('UPDATE player SET bullets = 0');
await spawnHere(2007);
s = await tic(IDLE);
assert(s.BULLETS === 10 * mult, `a clip from the map gives a whole clip (${s.BULLETS})`);
const sg = await killHere(9);
assert(sg.THING_TYPE === 2001 && (sg.FLAGS & 65536) !== 0, 'a dead shotgun guy drops a shotgun marked MF_DROPPED');
s = await tic(IDLE);
assert(s.SHELLS === 4 * mult, `a dropped shotgun gives one clip of shells (${s.SHELLS}, expected ${4 * mult})`);
await db.exec('UPDATE player SET bullets = 0');
await killHere(65);
s = await tic(IDLE);
assert(s.BULLETS === 10 * mult, `a dropped chaingun gives one clip of bullets (${s.BULLETS}, expected ${10 * mult})`);
const k2 = await one('SELECT kills FROM player');
await killHere(3006);
assert((await one('SELECT kills FROM player')).KILLS === k2.KILLS, 'a lost soul is not a kill (no MF_COUNTKILL)');
// a weapon you own, its ammo full: left on the floor
await db.exec('UPDATE player SET shells = max_shells');
const full = await spawnHere(2001);
await tic(IDLE);
assert((await db.query(`SELECT id FROM things WHERE id = ${full}`)).rows.length === 1, 'an owned shotgun stays put when your shells are full');
await db.exec('UPDATE player SET shells = 0');
await tic(IDLE);
assert((await db.query(`SELECT id FROM things WHERE id = ${full}`)).rows.length === 0, '…and is taken once there is room for its shells');
const saw = await spawnHere(2005);
await tic(IDLE);
assert((await one('SELECT has_chainsaw FROM player')).HAS_CHAINSAW === 1, 'the first chainsaw is taken');
await spawnHere(2005);
await tic(IDLE);
assert((await db.query(`SELECT id FROM things WHERE thing_type = 2005 AND id > ${saw}`)).rows.length === 1, 'a second chainsaw is left (it has no ammo to give)');
const i0 = (await one('SELECT items FROM player')).ITEMS;
await spawnHere(2014);
await tic(IDLE);
assert((await one('SELECT items FROM player')).ITEMS === i0 + 1, 'a health bonus is in the item tally (MF_COUNTITEM)');
const tot = await one(`SELECT (SELECT COUNT(*) FROM thing_types WHERE count_item = 1) ci, (SELECT COUNT(*) FROM thing_types WHERE count_kill = 1 AND thing_type = 3006) cs FROM rdb$database`);
assert(Number(tot.CI) === 9 && Number(tot.CS) === 0, `nine item types count (${tot.CI}), the lost soul doesn't`);

// P_TouchSpecialThing's messages: the WAD's GOT* strings; a key speaks only the first time
const got = parseDehStrings(wad.dehacked());
await db.exec("UPDATE player SET shells = 0, msg = NULL, keycards = 0");
await spawnHere(2001);
await tic(IDLE);
const sgMsg = (await one('SELECT msg FROM player')).MSG;
assert(sgMsg === got.get('GOTSHOTGUN'), `a shotgun says the WAD's GOTSHOTGUN: "${sgMsg}"`);
await spawnHere(5);
await tic(IDLE);
const k1msg = (await one('SELECT msg FROM player')).MSG;
await db.exec("UPDATE player SET msg = 'quiet', msg_tics = 0");
await spawnHere(5);
await tic(IDLE);
const k2msg = (await one('SELECT msg, keycards FROM player'));
assert(k1msg === got.get('GOTBLUECARD') && k2msg.MSG === 'quiet' && k2msg.KEYCARDS === 1,
  `a blue keycard says "${k1msg}"; a second one is taken without a word`);
const missing = (await db.query("SELECT LIST(sprite) l FROM thing_types WHERE kind = 'item' AND label = sprite")).rows[0].L;
assert(!missing, `every item has a message (${missing ?? 'none missing'})`);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'weapons ok');
process.exit(failures ? 1 : 0);
