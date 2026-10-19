// build.mjs – assemble the static site into dist/.
//
//   node scripts/build.mjs            build
//   NO_BUILD=1 node scripts/build.mjs --serve   serve the dist/ there is, unbuilt
//   node scripts/build.mjs --serve    build, then serve dist/ on :8080 WITHOUT
//                                     COOP/COEP headers – exactly like GitHub
//                                     Pages, which the page doesn't need.
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
const EXTERNAL = ['*firebird-embedded.js', '*firebird-embedded-st.js'];

// NO_BUILD=1 with --serve: serve the dist/ that's there (test-all.mjs builds once
// and runs the browser tests side by side, which mustn't each write it again)
const skipBuild = process.argv.includes('--serve') && process.env.NO_BUILD === '1' && fs.existsSync(path.join(OUT, 'index.html'));
if (!skipBuild) {
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
// It's firebird-wasm's build without threads (firebird-embedded-st): no
// SharedArrayBuffer, so the page needs no cross-origin isolation, and it ran
// the game faster than the threaded one (a tic ~15 ms against ~18, a map load
// ~0.5 s against ~0.7, the engine started in half the time).
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
  "importScripts(new URL('./firebird-embedded-st.js', self.location.href).href);\n" +
    'self.FIREBIRD_WORKER_OPTIONS = { threads: false, locateFile: (f) => new URL(f, self.location.href).href };\n' +
    worker.outputFiles[0].text,
);

for (const f of ['firebird-embedded-st.js', 'firebird-embedded-st.wasm']) {
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
// The service worker (offline play): the page's files it stores whole at install,
// and a version from their contents, so each build's set replaces the last one's.
{
  const { createHash } = await import('node:crypto');
  const shell = ['index.html', 'style.css', 'main.js', 'opl-worklet.js', 'firebird-engine-worker.js',
    'firebird-embedded-st.js', 'firebird-embedded-st.wasm', 'wads/freedoom-strings.json', 'wads/FREEDOOM-COPYING.txt',
    ...(fs.existsSync(path.join(OUT, 'demos')) ? fs.readdirSync(path.join(OUT, 'demos')).sort().map((f) => `demos/${f}`) : [])]
    .filter((f) => fs.existsSync(path.join(OUT, f)));
  const hash = createHash('sha256');
  for (const f of shell) hash.update(f).update(fs.readFileSync(path.join(OUT, f)));
  const sw = path.join(OUT, 'sw.js');
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8')
    .replace("'__VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 12)))
    .replace('__SHELL__', JSON.stringify(['./', ...shell])));
}
// The netgame relay the site uses (worker/relay.js, deployed): RELAY_URL at build
// time, CI's repository variable of that name. None: room codes are off.
if (process.env.RELAY_URL) fs.writeFileSync(path.join(OUT, 'relay.json'), JSON.stringify({ url: process.env.RELAY_URL }));
// GitHub Pages runs Jekyll by default, which drops _underscored paths.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`dist/ ${(size(OUT) / 1024 / 1024).toFixed(1)} MB`);
if (!fs.existsSync(path.join(OUT, 'wads/freedoom1.wad'))) {
  console.warn('note: no public/wads/freedoom1.wad – run `npm run fetch-wad`, or pick a WAD in the page');
}

}   // (!skipBuild)

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
