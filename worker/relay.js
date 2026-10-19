// relay.js – Firebird DOOM's netgame relay, a Cloudflare Worker. The game itself
// stays peer to peer (WebRTC); this only helps the players find each other:
//
//   GET  /ice                  ICE servers for RTCPeerConnection: Cloudflare's STUN, and
//                              TURN with short-lived credentials minted from the TURN key
//                              (secrets TURN_KEY_ID and TURN_KEY_API_TOKEN), so players
//                              behind strict NATs can still connect through the relay
//   POST /room       {code}    keep a host's invite under a short room code: { room }
//   GET  /room/R               the invite in room R: { code }
//   POST /room/R/reply {code}  the guest's reply
//   GET  /room/R/reply         the reply once it's there ({ code }), 204 until then
//
// A room lasts ROOM_TTL_MS (10 minutes) and takes one reply; its state lives in a
// Durable Object (one per room code), so the host and the guest see the same thing
// wherever in the world they are. Only ALLOWED_ORIGINS (the game's site) may call it.
// Deploying: worker/README.md.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // (no I, O, 0 or 1: they're misread)
export const CODE_LENGTH = 6;
const MAX_CODE = 16384;                                  // an invite or reply code, in characters
const TURN_TTL = 4 * 3600;                               // seconds a TURN credential lasts

export const isRoomCode = (s) => new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(s);

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** CORS headers for this request's origin, or null when it isn't allowed. */
function cors(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const any = allowed.includes('*');
  if (!any && (!origin || !allowed.includes(origin))) return null;
  return {
    'Access-Control-Allow-Origin': any ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { ...headers, ...(body === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store' },
});

/** The ICE servers: TURN credentials minted for this call, else what ICE_SERVERS says, else STUN alone. */
async function iceServers(env) {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
    });
    if (!r.ok) throw new Error(`the TURN service said ${r.status}`);
    const { iceServers: servers } = await r.json();
    // (the page waits for all its candidates before it makes a code, and browsers
    // block port 53, so a TURN URL there would only make it wait)
    return (Array.isArray(servers) ? servers : [servers]).map((s) => ({
      ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    })).filter((s) => s.urls.length);
  }
  if (env.ICE_SERVERS) return JSON.parse(env.ICE_SERVERS);
  return [{ urls: ['stun:stun.cloudflare.com:3478'] }];
}

/** A code from the request's JSON body ({ code }), or a Response saying what's wrong with it. */
async function codeFrom(request) {
  const text = await request.text();
  if (text.length > MAX_CODE + 100) return json({ error: 'too big' }, 413);
  let code;
  try { ({ code } = JSON.parse(text)); } catch { return json({ error: 'not JSON' }, 400); }
  if (typeof code !== 'string' || !code || code.length > MAX_CODE) return json({ error: 'no code' }, 400);
  return code;
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (!headers) return new Response('origin not allowed', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    const room = (r, path, init) => env.ROOMS.get(env.ROOMS.idFromName(r)).fetch(new Request(`https://room/${path}`, init));
    const pass = async (res) => new Response(res.status === 204 ? null : await res.text(), {
      status: res.status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    try {
      if (parts[0] === 'ice' && parts.length === 1 && request.method === 'GET') {
        return json({ iceServers: await iceServers(env) }, 200, headers);
      }
      if (parts[0] === 'room' && parts.length === 1 && request.method === 'POST') {
        const code = await codeFrom(request);
        if (code instanceof Response) return pass(code);
        for (let i = 0; i < 5; i++) {   // (a code already taken: another)
          const r = newRoomCode();
          const res = await room(r, 'create', { method: 'POST', body: JSON.stringify({ code }) });
          if (res.status === 201) return json({ room: r }, 201, headers);
        }
        return json({ error: 'no free room' }, 503, headers);
      }
      if (parts[0] === 'room' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'reply'))) {
        const r = parts[1].toUpperCase();
        if (!isRoomCode(r)) return json({ error: 'not a room code' }, 400, headers);
        if (parts.length === 2 && request.method === 'GET') return pass(await room(r, 'invite'));
        if (parts.length === 3 && request.method === 'GET') return pass(await room(r, 'reply'));
        if (parts.length === 3 && request.method === 'POST') {
          const code = await codeFrom(request);
          if (code instanceof Response) return pass(code);
          return pass(await room(r, 'reply', { method: 'POST', body: JSON.stringify({ code }) }));
        }
      }
      return json({ error: 'not here' }, 404, headers);
    } catch (err) {
      return json({ error: err.message }, 502, headers);
    }
  },
};

/** One room: the invite, the reply once there is one, and when it all goes. */
export class Room {
  constructor(state, env) {
    this.storage = state.storage;
    this.ttl = Number(env?.ROOM_TTL_MS) || 10 * 60 * 1000;
  }

  async fetch(request) {
    const what = new URL(request.url).pathname.slice(1);
    const now = Date.now();
    let room = await this.storage.get('room');
    if (room && room.expires <= now) {
      await this.storage.deleteAll();
      room = null;
    }
    if (what === 'create') {
      if (room) return json({ error: 'taken' }, 409);
      const { code } = await request.json();
      const expires = now + this.ttl;
      await this.storage.put('room', { invite: code, reply: null, expires });
      await this.storage.setAlarm(expires);   // (and then nothing's left of it)
      return json({ ok: true }, 201);
    }
    if (!room) return json({ error: 'no such room (or it has expired)' }, 404);
    if (what === 'invite') return json({ code: room.invite }, 200);
    if (what === 'reply' && request.method === 'POST') {
      if (room.reply) return json({ error: 'someone has already joined this room' }, 409);
      room.reply = (await request.json()).code;
      await this.storage.put('room', room);
      return json({ ok: true }, 201);
    }
    if (what === 'reply') return room.reply ? json({ code: room.reply }, 200) : json(null, 204);
    return json({ error: 'not here' }, 404);
  }

  async alarm() { await this.storage.deleteAll(); }
}
