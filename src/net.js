// net.js – co-op over the network, the way DOOM played it: lockstep.
//
// Nothing about the game crosses the wire but each player's ticcmd, once a
// tic: [fwd, side, turn, fire, use, weapon, run]. Every peer runs the same
// simulation (Firebird's NET_TIC) on the same commands from the same start,
// and the same game unfolds on every screen – what d_net.c did over IPX.
//
// Lockstep: the host (player 1) gathers every player's command for tic T and
// sends the full set to everyone; each peer runs tic T once it has it. A peer
// submits its own commands a few tics ahead (the input delay), so the host has
// them in time. Every 35 tics each peer reports a checksum of its game, and the
// host compares them: any difference is a desync, and the game stops.
//
// The connection: WebRTC data channels, peer to peer, a star through the
// host. With no server to introduce the players, they swap codes themselves
// (the host's invite, the guest's reply): an SDP offer and answer, sent once
// ICE gathering has finished, through a public STUN server.

export const NET_VERSION = 1;
export const MAX_PLAYERS = 4;
const IDLE = [0, 0, 0, 0, 0, 0, 0];

/** The lockstep protocol, transport aside: send(to, msg) delivers MSG to player TO (or 'all'). */
export class Lockstep {
  /**
   * @param me       this peer's player number (1 = the host)
   * @param players  how many in the game
   * @param send     (to: number | 'all', msg) → void
   * @param delay    tics of input delay
   * @param ahead    how far past the last tic run a peer may submit
   */
  constructor({ me, players, send, delay = 3, ahead = 12 }) {
    this.me = me;
    this.players = players;
    this.send = send;
    this.delay = delay;
    this.ahead = ahead;
    this.host = me === 1;
    this.submitted = 0;          // the last tic this peer submitted a command for
    this.executed = 0;           // the last tic taken by the game
    this.broadcast = 0;          // (host) the last tic sent out complete
    this.pending = new Map();    // (host) tic → array of commands so far
    this.ready = [];             // complete tics, in order: { tic, cmds }
    this.early = new Map();      // (guest) tic → commands, however they arrived
    this.sums = new Map();       // (host) tic → { player: checksum }
    this.error = null;
    // the pipeline starts with DELAY tics of standing still
    for (let i = 0; i < delay; i++) this.submit(IDLE);
  }

  /** Room for another of this peer's commands? */
  canSubmit() { return !this.error && this.submitted - this.executed < this.ahead; }

  /** This peer's command for its next tic. */
  submit(cmd) {
    const tic = ++this.submitted;
    if (this.host) this.collect(1, tic, cmd);
    else this.send(1, { t: 'cmd', tic, cmd });
    return tic;
  }

  /** A message from player FROM. */
  receive(from, m) {
    if (this.error) return;
    if (m.t === 'cmd' && this.host) this.collect(from, m.tic, m.cmd);
    else if (m.t === 'tic' && !this.host) { if (m.tic > this.executed) this.early.set(m.tic, m.cmds); }
    else if (m.t === 'sum' && this.host) this.checksum(from, m.tic, m.sum);
    else if (m.t === 'desync') this.fail(m.why);
  }

  /** (host) a command in; any tic now complete goes out, in order */
  collect(from, tic, cmd) {
    if (tic <= this.broadcast) return;
    let row = this.pending.get(tic);
    if (!row) { row = Array(this.players).fill(null); this.pending.set(tic, row); }
    row[from - 1] = cmd;
    for (;;) {
      const next = this.pending.get(this.broadcast + 1);
      if (!next || next.some((c) => c === null)) break;
      this.broadcast++;
      this.pending.delete(this.broadcast);
      this.send('all', { t: 'tic', tic: this.broadcast, cmds: next });
      this.ready.push({ tic: this.broadcast, cmds: next });
    }
  }

  /** The next complete tic for the game to run, or null. */
  take() {
    // a guest runs the host's tics strictly in order, whatever order they came in
    for (let next = this.early.get(this.executed + 1 + this.ready.length); next;
      next = this.early.get(this.executed + 1 + this.ready.length)) {
      const tic = this.executed + 1 + this.ready.length;
      this.early.delete(tic);
      this.ready.push({ tic, cmds: next });
    }
    const r = this.ready.shift() ?? null;
    if (r) this.executed = r.tic;
    return r;
  }

  /** After running tic TIC, this peer's game checksum (every 35 tics). */
  report(tic, sum) {
    if (this.host) this.checksum(1, tic, sum);
    else this.send(1, { t: 'sum', tic, sum });
  }

  /** (host) all the checksums for a tic in: they must agree */
  checksum(from, tic, sum) {
    let s = this.sums.get(tic);
    if (!s) { s = {}; this.sums.set(tic, s); }
    s[from] = sum;
    if (Object.keys(s).length < this.players) return;
    this.sums.delete(tic);
    const values = Object.values(s);
    if (values.some((v) => v !== values[0])) {
      const who = Object.entries(s).filter(([, v]) => v !== s[1]).map(([p]) => p).join(', ');
      const why = `out of sync at tic ${tic} (player ${who})`;
      this.send('all', { t: 'desync', why });
      this.fail(why);
    }
  }

  fail(why) { this.error = why; }
}

// ── the connection ─────────────────────────────────────────────────────────
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const encode = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const decode = (s) => JSON.parse(decodeURIComponent(escape(atob(String(s).trim()))));

/** Wait for ICE gathering to finish (or a few seconds: what's there by then will do). */
function gathered(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

/**
 * A data channel to one peer: { send(msg), onmessage, onclose, close() }.
 * Messages are JSON, ordered and reliable.
 */
function wrap(pc, ch) {
  const link = {
    pc, ch,
    onmessage: () => {},
    onclose: () => {},
    send(m) { if (ch.readyState === 'open') ch.send(JSON.stringify(m)); },
    close() { try { ch.close(); pc.close(); } catch { /* gone */ } },
  };
  ch.onmessage = (e) => link.onmessage(JSON.parse(e.data));
  ch.onclose = () => link.onclose();
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) link.onclose();
  });
  return link;
}

const opened = (ch) => new Promise((resolve, reject) => {
  if (ch.readyState === 'open') { resolve(); return; }
  ch.onopen = () => resolve();
  ch.onerror = (e) => reject(e.error ?? new Error('the connection failed'));
});

/**
 * The host's side: an invite code for one guest, and accept(reply) to finish
 * the handshake with their reply code. accept resolves to a link once open.
 */
export async function createInvite({ iceServers = ICE } = {}) {
  const pc = new RTCPeerConnection({ iceServers });
  const ch = pc.createDataChannel('doom', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    code: encode({ v: NET_VERSION, sdp: pc.localDescription.sdp }),
    async accept(reply) {
      const r = decode(reply);
      if (r.v !== NET_VERSION || !r.sdp) throw new Error('not a reply code from this game');
      await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
      await opened(ch);
      return wrap(pc, ch);
    },
    cancel() { pc.close(); },
  };
}

/** The guest's side: from the host's invite code, a reply code; link resolves once open. */
export async function acceptInvite(invite, { iceServers = ICE } = {}) {
  const o = decode(invite);
  if (o.v !== NET_VERSION || !o.sdp) throw new Error('not an invite code from this game');
  const pc = new RTCPeerConnection({ iceServers });
  const channel = new Promise((resolve) => { pc.ondatachannel = (e) => resolve(e.channel); });
  await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return {
    reply: encode({ v: NET_VERSION, sdp: pc.localDescription.sdp }),
    link: channel.then(async (ch) => { await opened(ch); return wrap(pc, ch); }),
  };
}
