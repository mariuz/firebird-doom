// relay-dev.mjs – the netgame relay (worker/relay.js) run locally under Node,
// with an in-memory stand-in for Cloudflare's Durable Objects. For the tests and
// for trying the room codes without deploying anything:
//
//   node scripts/relay-dev.mjs            → http://localhost:8787 (any origin)
//   then open the page with ?relay=http://localhost:8787
//
// It serves the Worker's own code; only the platform around it is pretend.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import relay, { Room } from '../worker/relay.js';

/** env.ROOMS as the Worker sees it: one Room object per name, its storage a Map */
function roomNamespace(env) {
  const rooms = new Map();
  return {
    idFromName: (name) => name,
    get(id) {
      if (!rooms.has(id)) {
        const data = new Map();
        const storage = {
          get: async (k) => structuredClone(data.get(k)),
          put: async (k, v) => { data.set(k, structuredClone(v)); },
          deleteAll: async () => { data.clear(); },
          setAlarm: async () => {},   // (expiry is checked on every call anyway)
        };
        rooms.set(id, new Room({ storage }, env));
      }
      const room = rooms.get(id);
      return { fetch: (req) => room.fetch(req) };
    },
  };
}

/** The relay on PORT (0: a free one): { url, env, close() }. ENV adds to (or replaces) its settings. */
export async function startRelay({ port = 0, env: extra = {} } = {}) {
  const env = { ALLOWED_ORIGINS: '*', ...extra };
  env.ROOMS = roomNamespace(env);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(req.url, 'http://relay.local'), {
      method: req.method,
      headers: Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await relay.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://localhost:${server.address().port}`, env, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await startRelay({ port: Number(process.env.PORT ?? 8787) });
  console.log(`the netgame relay on ${r.url} (open the page with ?relay=${r.url})`);
}
