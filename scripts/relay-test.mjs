// relay-test.mjs – the netgame relay (worker/relay.js) under Node, through the
// stand-in in relay-dev.mjs: room codes, the invite and the reply, expiry, the
// limits, the origins it answers, and the ICE servers it hands out (Cloudflare's
// TURN API faked, so its request can be checked).
import { startRelay } from './relay-dev.mjs';
import { CODE_LENGTH, isRoomCode } from '../worker/relay.js';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const send = globalThis.fetch;   // (the test's own requests: the Worker's fetch is faked below)
const call = (base, path, { method = 'GET', body, origin = 'https://mariuz.github.io' } = {}) =>
  send(base + path, { method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json().catch(() => null) }));

// a room: the host's invite in, a short code out; the guest's reply in, and back to the host
{
  const relay = await startRelay({ env: { ALLOWED_ORIGINS: 'https://mariuz.github.io' } });
  const u = relay.url;
  const invite = 'A'.repeat(1200);
  const made = await call(u, '/room', { method: 'POST', body: { code: invite } });
  const room = made.body?.room;
  assert(made.status === 201 && isRoomCode(room) && room.length === CODE_LENGTH,
    `the host's invite gets a room code of ${CODE_LENGTH} letters and digits, none of I, O, 0, 1 (${room})`);
  const got = await call(u, `/room/${room.toLowerCase()}`);
  const before = await call(u, `/room/${room}/reply`);
  const replied = await call(u, `/room/${room}/reply`, { method: 'POST', body: { code: 'B'.repeat(900) } });
  const after = await call(u, `/room/${room}/reply`);
  const again = await call(u, `/room/${room}/reply`, { method: 'POST', body: { code: 'C' } });
  assert(got.status === 200 && got.body.code === invite && before.status === 204 && replied.status === 201
    && after.status === 200 && after.body.code === 'B'.repeat(900) && again.status === 409,
    'the guest reads the invite by the code (in any case), the host sees no reply, then the reply; a second reply is turned away');
  const none = await call(u, '/room/ZZZZZZ');
  const bad = await call(u, '/room/ab-cd!');
  const big = await call(u, '/room', { method: 'POST', body: { code: 'x'.repeat(20000) } });
  const empty = await call(u, '/room', { method: 'POST', body: { code: '' } });
  assert(none.status === 404 && bad.status === 400 && big.status === 413 && empty.status === 400,
    `an unknown room is 404, a malformed code 400, a code over 16 KB 413, an empty one 400 (${none.status}, ${bad.status}, ${big.status}, ${empty.status})`);
  const stranger = await call(u, '/ice', { origin: 'https://example.com' });
  const noOrigin = await send(`${u}/ice`).then((r) => r.status);
  const pre = await call(u, '/room', { method: 'OPTIONS' });
  assert(stranger.status === 403 && noOrigin === 403 && pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://mariuz.github.io'
    && made.headers.get('access-control-allow-origin') === 'https://mariuz.github.io',
    'only the game\'s own site may call it (another origin, or none: 403); the preflight and the answers carry its CORS headers');
  await relay.close();
}

// a room goes after its time
{
  const relay = await startRelay({ env: { ROOM_TTL_MS: '300' } });
  const { body: { room } } = await call(relay.url, '/room', { method: 'POST', body: { code: 'x' } });
  const soon = await call(relay.url, `/room/${room}`);
  await new Promise((r) => setTimeout(r, 400));
  const later = await call(relay.url, `/room/${room}`);
  assert(soon.status === 200 && later.status === 404, `a room expires (here after 0.3 s; deployed, 10 minutes): ${soon.status}, then ${later.status}`);
  await relay.close();
}

// the ICE servers: STUN alone without a TURN key; with one, credentials minted for the call
{
  const plain = await startRelay();
  const stun = await call(plain.url, '/ice');
  assert(stun.status === 200 && JSON.stringify(stun.body.iceServers) === '[{"urls":["stun:stun.cloudflare.com:3478"]}]',
    'with no TURN key: Cloudflare\'s STUN server alone');
  await plain.close();

  const realFetch = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://rtc.live.cloudflare.com/')) {
      asked = { url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'u1', credential: 'c1' },
      ] }), { status: 201 });
    }
    return realFetch(url, init);
  };
  const turn = await startRelay({ env: { TURN_KEY_ID: 'key123', TURN_KEY_API_TOKEN: 'tok456' } });
  const t = await call(turn.url, '/ice');
  const servers = t.body?.iceServers ?? [];
  assert(asked?.url === 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers'
    && asked.auth === 'Bearer tok456' && asked.body.ttl === 4 * 3600,
    'with a TURN key it asks Cloudflare for credentials lasting 4 hours, with the key\'s token');
  assert(servers.length === 2 && servers[1].username === 'u1' && servers[1].credential === 'c1'
    && servers.every((s) => s.urls.every((x) => !/:53(\?|$)/.test(x))) && servers[1].urls.length === 2,
    `…and hands the page what came back, less the port-53 URLs browsers block (${servers.map((s) => s.urls.length).join(' + ')} URLs)`);
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const down = await call(turn.url, '/ice').catch((e) => ({ status: e.message }));
  globalThis.fetch = realFetch;
  assert(down.status === 502, `the TURN service failing is a 502 for the page, which then goes on with STUN (${down.status})`);
  await turn.close();
}

console.log(failures ? `${failures} failure(s)` : 'relay ok');
process.exit(failures ? 1 : 0);
