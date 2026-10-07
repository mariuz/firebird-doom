// pwad-test.mjs – a PWAD on top of the IWAD (W_AddFile): its map, flat, sprite,
// music and DEHACKED replace or join the IWAD's, played out in Firebird.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { parseDehStrings } from '../src/finale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

/** A WAD file from [name, bytes] pairs. */
function writeWad(magic, lumps) {
  const size = lumps.reduce((n, [, b]) => n + b.length, 0);
  const out = new Uint8Array(12 + size + 16 * lumps.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(magic), 0);
  dv.setInt32(4, lumps.length, true);
  dv.setInt32(8, 12 + size, true);
  let pos = 12;
  lumps.forEach(([name, bytes], i) => {
    out.set(bytes, pos);
    const d = 12 + size + 16 * i;
    dv.setInt32(d, pos, true);
    dv.setInt32(d + 4, bytes.length, true);
    out.set(new TextEncoder().encode(name.padEnd(8, '\0').slice(0, 8)), d + 8);
    pos += bytes.length;
  });
  return out;
}

const iwadBytes = fs.readFileSync(path.join(root, 'public/wads/freedoom1.wad'));
const iwad = new Wad(iwadBytes);
// the PWAD: E2M1's map as E1M1, a new NUKAGE1, the zombieman drawn as an imp, other music, and a patch
const mapLumps = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'];
const e2m1 = iwad.lump('E2M1');
const mapPart = mapLumps.map((n, k) => [n, iwad.data(iwad.lumps[e2m1.index + 1 + k])]);
const flat = new Uint8Array(4096).fill(176);
const imp = iwad.data(iwad.lump('TROOA1'));
const deh = new TextEncoder().encode('Patch File for DeHackEd v3.0\nDoom version = 19\nPatch format = 6\n\nThing 2 (Trooper)\nHit points = 77\n\n[STRINGS]\nGOTARMOR = Picked up some PWAD armour.\n');
const pwadBytes = writeWad('PWAD', [
  ['E1M1', new Uint8Array(0)], ...mapPart,
  ['FF_START', new Uint8Array(0)], ['NUKAGE1', flat], ['FF_END', new Uint8Array(0)],
  ['SS_START', new Uint8Array(0)], ['POSSA1', imp], ['SS_END', new Uint8Array(0)],
  ['D_E1M1', iwad.data(iwad.lump('D_E1M2'))],
  ['DEHACKED', deh],
]);

const wad = new Wad(iwadBytes, pwadBytes);
const maps = wad.mapNames();
assert(maps.length === iwad.mapNames().length && maps[0] === 'E1M1' && wad.pwadMapNames().join() === 'E1M1',
  `the merged directory lists each map once (${maps.length}); the PWAD brings E1M1`);
assert(wad.lump('E1M1').file === 1 && wad.lump('D_E1M1').file === 1 && wad.lump('PLAYPAL').file === 0,
  'a name finds the PWAD\'s lump where it has one (E1M1, D_E1M1), else the IWAD\'s (PLAYPAL)');
const things = wad.map('E1M1').things.length;
assert(things === iwad.map('E2M1').things.length && things !== iwad.map('E1M1').things.length,
  `E1M1 is the PWAD's (E2M1's ${things} things, not E1M1's ${iwad.map('E1M1').things.length})`);
const nukage = wad.flatLumps().filter((l) => l.name === 'NUKAGE1');
const poss = wad.spriteFrames().filter((f) => f.sprite === 'POSS' && f.frame === 'A' && f.rot === 1);
assert(nukage.length === 2 && nukage.at(-1).file === 1 && poss.at(-1).lump === wad.lump('POSSA1').index,
  'flats and sprites are gathered from both files, the PWAD\'s last (so they win)');
const strings = parseDehStrings(wad.dehacked());
assert(strings.get('GOTARMOR') === 'Picked up some PWAD armour.' && strings.has('E1TEXT'),
  'DEHACKED strings: the PWAD\'s replace the IWAD\'s by name, and the rest of Freedoom\'s stay');

// in Firebird
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://pwad', { transport: new DirectTransport() });
await createSchema(db, sql);
const res = await loadResources(db, wad, { dehacked: 'Misc 0\nInitial Health = 123\n' });
const flatEntry = res.flats.find((l) => l.name === 'NUKAGE1');
await loadMap(db, wad, res, 'E1M1', { skill: 4 });
const n = (await db.query('SELECT COUNT(*) n FROM things')).rows[0].N;
const hp = (await db.query('SELECT hp FROM thing_types WHERE thing_type = 3004')).rows[0].HP;
const health = (await db.query('SELECT health FROM player')).rows[0].HEALTH;
assert(n > 0 && flatEntry?.file === 1 && hp === 77 && health === 123 && res.dehacked.pars.get('E1M1') === 30,
  `Firebird gets the PWAD's E1M1 (${n} things) and NUKAGE1, its patch (zombieman ${hp} hp), the .deh on top (health ${health}), and still Freedoom's pars`);

// a second load into the same database (another WAD, a PWAD added, a game switch) starts clean
let again = true;
try { await loadResources(db, iwad); } catch (err) { again = err.message; }
const rules = (await db.query('SELECT COUNT(*) n, MAX(init_health) h FROM rules')).rows[0];
assert(again === true && rules.N === 1 && rules.H === 100, `loading again replaces the rules row (${again === true ? `${rules.N} row, health ${rules.H}` : again})`);

await db.close();
console.log(failures ? `${failures} failure(s)` : 'pwad ok');
process.exit(failures ? 1 : 0);
