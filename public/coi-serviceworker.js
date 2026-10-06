/*
 * coi-serviceworker.js – cross-origin isolation on a static host.
 *
 * Firebird WASM uses pthreads → SharedArrayBuffer → the page must be
 * cross-origin isolated (COOP + COEP headers). GitHub Pages cannot send
 * custom headers, so this service worker re-issues every response with them.
 * A service worker cannot control the load that registered it, so the first
 * visit reloads once.
 *
 * Same technique as electric-firebird's demo/public/coi-serviceworker.js
 * (Apache-2.0) and gzuidhof/coi-serviceworker (MIT).
 */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    // Revalidate our own files (cheap 304s) so a fresh deploy never mixes an
    // old page with new scripts out of the 10-minute GitHub Pages cache.
    const sameOrigin = new URL(req.url).origin === self.location.origin && req.method === 'GET';
    const upstream = !sameOrigin ? req
      : req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        : new Request(req, { cache: 'no-cache' });
    event.respondWith(
      (upstream instanceof Promise ? upstream : fetch(upstream))
        .then((res) => {
          if (res.status === 0) return res;
          const headers = new Headers(res.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        })
        .catch((err) => new Response(`network error: ${err.message}`, { status: 503 })),
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    const KEY = 'firebird-doom:coi-reloads';
    const tries = Number(sessionStorage.getItem(KEY) || '0');
    if (tries >= 2) return; // give up rather than reload forever; the page explains
    navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
      const reload = () => {
        sessionStorage.setItem(KEY, String(tries + 1));
        window.location.reload();
      };
      if (reg.active && !navigator.serviceWorker.controller) reload();
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', (e) => {
        if (e.target.state === 'activated') reload();
      }));
    }, (err) => console.error('[firebird-doom] service worker registration failed', err));
  })();
}
