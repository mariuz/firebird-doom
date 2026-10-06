// bench.mjs – time individual SQL statements against a loaded map.
//   node scripts/bench.mjs queries.sql   (statements separated by lines starting with -- @@)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://bench', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
await loadMap(db, wad, res, process.env.MAP ?? 'E1M1');
await db.query('SELECT * FROM doom_tic(1,0,0,0,0,0,0,0)');
const queries = fs.readFileSync(process.argv[2], 'utf8').split(/^-- @@.*$/m).map((q) => q.trim()).filter(Boolean);
for (const q of queries) {
  const t0 = performance.now();
  try {
    const r = await db.query(q, [], { rowMode: 'array' });
    console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${String(r.rows.length).padStart(6)} rows  ${q.split('\n')[0].slice(0, 90)}`, r.rows.length < 4 ? JSON.stringify(r.rows) : '');
  } catch (e) { console.log('ERR', e.message.slice(0, 300)); }
}
process.exit(0);
