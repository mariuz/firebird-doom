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

await loadMap(db, wad, res, 'E1M1');
await db.exec(`UPDATE player SET has_launcher = 1, has_plasma = 1, has_bfg = 1, rockets = 10, cells = 200, health = 200`);

for (const [w, name, ammoCol, sound, ticsToHit] of [[5, 'rocket launcher', 'ROCKETS', 'DSRLAUNC', 20], [6, 'plasma gun', 'CELLS', 'DSPLASMA', 12], [7, 'BFG', 'CELLS', 'DSBFG', 40]]) {
  const target = await lineUp();
  assert(target != null, `${name}: found a monster to shoot`);
  if (!target) continue;
  const before = await tic([1, 0, 0, 0, 0, 0, w, 0]);
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

// rockets hurt whoever is close, including you
await db.exec(`UPDATE player SET health = 100, armor = 0, dead = 0`);
const p = (await db.query(`SELECT t.x, t.y, t.z FROM things t WHERE t.kind = 'player'`)).rows[0];
await db.exec(`EXECUTE PROCEDURE radius_attack(${p.X + 40}, ${p.Y}, ${p.Z}, 128, -1)`);
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
