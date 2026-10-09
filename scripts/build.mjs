// build.mjs – assemble the static site into dist/.
//
//   node scripts/build.mjs            build
//   node scripts/build.mjs --serve    build, then serve dist/ on :8080 WITHOUT
//                                     COOP/COEP headers – exactly like GitHub
//                                     Pages – so the service worker is tested.
//
// Everything is referenced relatively: a project site lives under /<repo>/.

import { build } from 'esbuild-wasm';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'dist');
const PKG = path.join(root, 'node_modules/firebird-wasm/dist');

// wasm-loader.js has a Node-only require() of the Emscripten glue; browsers
// take the globalThis path, so keep the glue out of the bundle.
const EXTERNAL = ['*firebird-embedded.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(OUT, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: true,
  loader: { '.sql': 'text' },
  external: EXTERNAL,
  logLevel: 'warning',
});

// The music's AudioWorklet (DMX on the emulated OPL2): a module of its own
await build({
  entryPoints: [path.join(root, 'src/opl-worklet.js')],
  outfile: path.join(OUT, 'opl-worklet.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  logLevel: 'warning',
});

// The engine Worker: a classic script that loads the Emscripten glue first and
// finds the .wasm next to itself, whatever path prefix the site is served from.
const worker = await build({
  entryPoints: [path.join(PKG, 'browser/worker-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  write: false,
  minify: true,
  external: EXTERNAL,
  logLevel: 'warning',
});
fs.writeFileSync(
  path.join(OUT, 'firebird-engine-worker.js'),
  "importScripts(new URL('./firebird-embedded.js', self.location.href).href);\n" +
    'self.FIREBIRD_WORKER_OPTIONS = { locateFile: (f) => new URL(f, self.location.href).href };\n' +
    worker.outputFiles[0].text,
);

for (const f of ['firebird-embedded.js', 'firebird-embedded.wasm']) {
  fs.copyFileSync(path.join(PKG, 'wasm', f), path.join(OUT, f));
}

// public/ verbatim (index.html, css, service worker, wads/ if present)
fs.cpSync(path.join(root, 'public'), OUT, { recursive: true });
// The fallback story text for IWADs that keep theirs in the executable (id's
// doom2.wad): Freedoom Phase 2's C1TEXT–C6TEXT, BSD-licensed like the WADs.
{
  const wad2 = path.join(root, 'public/wads/freedoom2.wad');
  if (fs.existsSync(wad2)) {
    const { Wad } = await import('../src/wad.js');
    const { freedoomStrings } = await import('../src/finale.js');
    const strings = freedoomStrings(new Wad(fs.readFileSync(wad2)));
    fs.writeFileSync(path.join(OUT, 'wads/freedoom-strings.json'), JSON.stringify(strings, null, 1));
  }
}
// GitHub Pages runs Jekyll by default, which drops _underscored paths.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`dist/ ${(size(OUT) / 1024 / 1024).toFixed(1)} MB`);
if (!fs.existsSync(path.join(OUT, 'wads/freedoom1.wad'))) {
  console.warn('note: no public/wads/freedoom1.wad – run `npm run fetch-wad`, or pick a WAD in the page');
}

if (process.argv.includes('--serve')) {
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm', '.map': 'application/json', '.wad': 'application/octet-stream', '.svg': 'image/svg+xml',
  };
  const port = Number(process.env.PORT ?? 8080);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(OUT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!path.resolve(file).startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`serving dist/ on http://localhost:${port}/ (no COOP/COEP, like Pages)`));
}
