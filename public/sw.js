// sw.js – offline play. The build (scripts/build.mjs) fills in VERSION and SHELL.
//
// The page's own files (SHELL: the HTML, the code, the engine and its .wasm, the
// music worklet, the attract demos, Freedoom's story text) are stored whole when
// this version installs, under a cache of its own, so offline there's always one
// complete, matching set. Online they still come from the network first (a new
// build is never hidden behind an old copy); the cache is the fallback.
//
// The WADs are too big to fetch twice: the page stores the one it just
// downloaded (keepWad in main.js) in WADS, and here they too are network first,
// the cache when there's no network. A WAD never fetched isn't there offline.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const PAGE = `firebird-doom-page-${VERSION}`;
const WADS = 'firebird-doom-wads';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(PAGE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // the older versions' page caches go; the WADs stay
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('firebird-doom-page-') && k !== PAGE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const wad = /\.wad$/i.test(new URL(req.url).pathname);
  e.respondWith(fetch(req).catch(async () => {
    // offline: the page (whatever its ?options) is index.html; the rest by its own URL
    const hit = req.mode === 'navigate'
      ? await caches.match(new URL('./', self.registration.scope).href, { cacheName: PAGE })
        ?? await caches.match(new URL('./index.html', self.registration.scope).href, { cacheName: PAGE })
      : await caches.match(req, { cacheName: wad ? WADS : PAGE, ignoreSearch: !wad });
    // (nothing kept: a plain 504 that says so, not a network error, which WebKit
    // reports as a page error however the page handles it)
    return hit ?? new Response('offline, and not kept here', { status: 504, statusText: 'Offline', headers: { 'x-offline': '1' } });
  }));
});
