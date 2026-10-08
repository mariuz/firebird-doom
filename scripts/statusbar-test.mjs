// statusbar-test.mjs – the status bar face (ST_updateFaceWidget) and what it
// reads from Firebird: who hurt you (player->attacker) and the death camera.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { FaceWidget } from '../src/hud.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── the face, headless ───────────────────────────────────────────────────
const base = { HEALTH: 100, DAMAGE_COUNT: 0, BONUS_COUNT: 0, ATTACKER_ANGLE: null, PANGLE: 0, GOD: 0, INVULN_TICS: 0,
  HAS_SHOTGUN: 0, HAS_CHAINGUN: 0, HAS_LAUNCHER: 0, HAS_PLASMA: 0, HAS_BFG: 0, HAS_CHAINSAW: 0, HAS_SSG: 0 };
const fixed = (v) => () => v;
const pains = [100, 81, 80, 61, 60, 41, 40, 21, 20, 1].map((h) => FaceWidget.painOffset(h) / 8);
assert(pains.join() === '0,0,0,1,1,2,2,3,3,4', `pain levels by ST_calcPainOffset (8 × (100 - health) × 5 / 101, rounded down): ${pains.join(' ')} for 100, 81, 80, 61, 60, 41, 40, 21, 20, 1`);

let f = new FaceWidget(fixed(0.3));
const idle = f.update(base, 1);
assert(idle === 'STFST01', `idle at full health: a straight face, picked at random (${idle})`);

// hit from the left, the right, ahead
const hurt = (angle) => { const w = new FaceWidget(fixed(0)); w.update(base, 1); return w.update({ ...base, HEALTH: 70, DAMAGE_COUNT: 10, ATTACKER_ANGLE: angle }, 1); };
const left = hurt(Math.PI / 2);
const right = hurt(-Math.PI / 2);
const ahead = hurt(0.2);
const wrap = hurt(-0.2);
assert(left === 'STFTL10' && right === 'STFTR10' && ahead === 'STFKILL1' && wrap === 'STFTR10',
  `hurt from the left the face looks left (${left}), from the right right (${right}), head-on it rampages (${ahead}); just right of ahead it turns, as vanilla's unsigned angles make it (${wrap})`);

// the ouch face: vanilla's test is backwards (health up by more than 20 while hurt)
f = new FaceWidget(fixed(0));
f.update({ ...base, HEALTH: 30 }, 1);
const ouch = f.update({ ...base, HEALTH: 60, DAMAGE_COUNT: 5, ATTACKER_ANGLE: 1 }, 1);
f = new FaceWidget(fixed(0));
f.update({ ...base, HEALTH: 90 }, 1);
const bigHit = f.update({ ...base, HEALTH: 40, DAMAGE_COUNT: 50, ATTACKER_ANGLE: 3 }, 1);
assert(ouch === 'STFOUCH1' && bigHit !== 'STFOUCH2', `ouch only when health rose by over 20 while hurt (${ouch}); a 50-point hit doesn't show it (${bigHit})`);

// slime and the like: the rampage face; the god face; holding fire two seconds; the evil grin; dead
f = new FaceWidget(fixed(0));
f.update(base, 1);   // (the first tic compares with ST_initData's -1)
const slime = f.update({ ...base, HEALTH: 95, DAMAGE_COUNT: 5 }, 1);
const god = new FaceWidget(fixed(0)).update({ ...base, GOD: 1 }, 1);
f = new FaceWidget(fixed(0));
const early = f.update(base, 70, true);   // (the first tic arms ST_RAMPAGEDELAY, 70 more count it down)
const rampage = f.update(base, 1, true);
f = new FaceWidget(fixed(0));
f.update(base, 1);
const grin = f.update({ ...base, BONUS_COUNT: 6, HAS_SHOTGUN: 1 }, 1);
const grinLater = f.update({ ...base, HAS_SHOTGUN: 1 }, 69);
const stillGrin = f.update({ ...base, HAS_SHOTGUN: 1 }, 1);
const dead = new FaceWidget(fixed(0)).update({ ...base, HEALTH: 0 }, 1);
assert(slime === 'STFKILL0' && god === 'STFGOD0' && early !== 'STFKILL0' && rampage === 'STFKILL0'
    && grin === 'STFEVL0' && grinLater === 'STFEVL0' && stillGrin !== 'STFEVL0' && dead === 'STFDEAD0',
  `slime: ${slime}; god mode: ${god}; firing, the rampage face at two seconds (${rampage}); a new weapon: the evil grin for two seconds (${grin}, ${grinLater} 69 tics on, then ${stillGrin}); dead: ${dead}`);

// ── what Firebird tells it ───────────────────────────────────────────────
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://sbar', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
await loadMap(db, wad, res, 'E1M1', { skill: 3 });
await db.exec("UPDATE things SET st = 'dead', solid = 0 WHERE kind = 'monster'");
const one = async (q) => (await db.query(q)).rows[0];
const tic = async (n = 1) => (await db.query(`SELECT * FROM doom_tic(${n}, 0, 0, 0, 0, 0, 0, 0)`)).rows[0];
const p = await one("SELECT id, x, y, angle FROM things WHERE kind = 'player'");
const imp = (await one(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN
    EXECUTE PROCEDURE spawn_thing(3001, ${p.X + 200}, ${p.Y}, NULL, 0) RETURNING_VALUES id; SUSPEND; END`)).ID;
await db.exec(`UPDATE things SET st = 'dead', solid = 0 WHERE id = ${imp}`);   // (it only has to be there)
await db.exec(`UPDATE things SET angle = ${Math.PI / 2} WHERE id = ${p.ID}`);
await db.exec(`EXECUTE PROCEDURE damage_player(5, ${imp})`);
const h1 = await tic();
await db.exec('EXECUTE PROCEDURE damage_player(5)');
const h2 = await tic();
assert(Math.abs(h1.ATTACKER_ANGLE) < 1e-9 && h2.ATTACKER_ANGLE === null,
  `DOOM_TIC tells the face where the attacker is (an imp due east: ${h1.ATTACKER_ANGLE?.toFixed(3)} rad); after the world hurts you, nobody (${h2.ATTACKER_ANGLE})`);

// the death camera: dead, you turn to face your killer, 5° a tic
await db.exec(`EXECUTE PROCEDURE damage_player(10000, ${imp})`);
const turns = [];
for (let i = 0; i < 20; i++) turns.push((await tic()).PANGLE);
const last = turns.at(-1);
assert(Math.abs(turns[0] - (Math.PI / 2 - Math.PI / 36)) < 1e-6 && Math.abs(last) < 1e-6,
  `dead, the view turns toward the killer 5° a tic (90° → ${(turns[0] * 180 / Math.PI).toFixed(0)}°) and stops on it (${(last * 180 / Math.PI).toFixed(1)}°)`);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'statusbar ok');
process.exit(failures ? 1 : 0);
