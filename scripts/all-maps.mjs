// all-maps.mjs – load every map in the WAD, run tics, render, and report.
//   node scripts/all-maps.mjs [path/to.wad]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://all', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.argv[2] ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
let failures = 0;
for (const name of wad.mapNames()) {
  try {
    const t0 = performance.now();
    await loadMap(db, wad, res, name);
    const load = performance.now() - t0;
    await db.query("UPDATE things SET st = 'chase' WHERE kind = 'monster'");
    let t = performance.now();
    for (let i = 0; i < 5; i++) await db.query('SELECT * FROM doom_tic(2, 1, 0, 0.2, 1, 0, 0, 0)');
    const ticMs = (performance.now() - t) / 10;
    t = performance.now();
    const w = await db.query('SELECT COUNT(*) n, COUNT(DISTINCT col) c FROM frame_walls');
    const s = await db.query('SELECT COUNT(*) n FROM frame_sprites');
    const frameMs = performance.now() - t;
    let tele = '';
    const tl = (await db.query('SELECT FIRST 1 id, tag FROM linedefs WHERE special IN (39, 97) AND tag > 0')).rows[0];
    if (tl) {
      await db.exec(`EXECUTE PROCEDURE activate_line(${tl.ID}, 'walk')`);
      const after = (await db.query("SELECT x, y FROM things WHERE kind = 'player'")).rows[0];
      // success = standing on the destination (the walk may already have used a teleporter to it)
      const dest = (await db.query(`SELECT FIRST 1 t.x, t.y FROM things t JOIN sectors s ON s.id = t.sector_id
                                      WHERE t.thing_type = 14 AND s.tag = ${tl.TAG}`)).rows[0];
      tele = dest && after.X === dest.X && after.Y === dest.Y ? ' teleport ok'
        : dest ? ' TELEPORT FAILED' : ' (no destination)';
      if (tele.includes('FAILED')) failures++;
    }
    const ok = w.rows[0].C === 320;
    if (!ok) failures++;
    console.log(`${name.padEnd(6)} load ${load.toFixed(0).padStart(5)} ms  tic ${ticMs.toFixed(1).padStart(5)} ms  frame ${frameMs.toFixed(0).padStart(4)} ms  slices ${String(w.rows[0].N).padStart(5)}  cols ${w.rows[0].C}  sprites ${s.rows[0].N}${tele}${ok ? '' : '  <-- MISSING COLUMNS'}`);
  } catch (e) {
    failures++;
    console.log(`${name} FAILED: ${e.message.split('\n').slice(0, 3).join(' | ')}`);
  }
}
console.log(failures ? `${failures} failure(s)` : 'all maps ok');
process.exit(failures ? 1 : 0);
