// lmp-sync.mjs – how long the port keeps step with vanilla DOOM on a .lmp demo.
//
// A demo plays through DOOM_TIC (src/lmp.js turns its ticcmds into the port's), and after each
// tic the port's state is read in DOOM's units (16.16 fixed point, BAM angles) and set against
// the oracle's trace of the same demo (scripts/oracle: Chocolate Doom, tic by tic). What it
// compares, a line per tic (and one for the level as it's set up, tic 0):
//
//   leveltime prndindex  the player's x y z angle momx momy health  count of mobjs, and the
//   sums of their x, y, z, health and state
//
// → for each field, the first tic it differs (null: never), and the values there.
//
//   node scripts/lmp-sync.mjs DEMO.lmp TRACE [WAD]      (a report; the library for test:lmp)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLmp, lmpMapName, portCmd } from '../src/lmp.js';
import { MOBJINFO } from '../src/states.js';
import { MOBJ_TYPE } from '../src/thinginfo.js';

export const FIELDS = ['leveltime', 'prndindex', 'x', 'y', 'z', 'angle', 'momx', 'momy', 'health',
  'mobjs', 'sumx', 'sumy', 'sumz', 'sumhealth', 'sumstate'];
// the fields that say where the player is and how: "in sync" means all of these agree
export const PLAYER_FIELDS = ['x', 'y', 'z', 'angle', 'momx', 'momy', 'health'];

/** An oracle trace: a row of FIELDS per tic (BigInt where a sum can pass 2^53). */
export function parseTrace(text) {
  return text.trim().split('\n').filter(Boolean).map((l) => {
    const v = l.trim().split(/\s+/);
    return Object.fromEntries(FIELDS.map((f, i) => [f, i >= 9 ? BigInt(v[i]) : Number(v[i])]));
  });
}

const fixed = (v) => Math.round(v * 65536);
const bam = (rad) => {
  const turns = rad / (2 * Math.PI);
  return Math.round((turns - Math.floor(turns)) * 4294967296) % 4294967296;
};

/** The port's state now, in the trace's terms (prndindex: GAME.RNG) */
export async function portRow(db) {
  const one = async (q) => (await db.query(q)).rows[0];
  const p = await one(`SELECT g.tic, g.rng, t.x, t.y, t.z, t.angle, t.momx, t.momy, p.health
      FROM player p JOIN things t ON t.id = p.thing_id CROSS JOIN game g WHERE p.id = 1 AND g.id = 1`);
  const all = (await db.query('SELECT t.x, t.y, t.z, t.hp, t.state FROM things t', [], { rowMode: 'array' })).rows;
  let sx = 0n; let sy = 0n; let sz = 0n; let shp = 0n; let sst = 0n;
  for (const [x, y, z, hp, st] of all) {
    sx += BigInt(fixed(x)); sy += BigInt(fixed(y)); sz += BigInt(fixed(z));
    shp += BigInt(hp ?? 0); sst += BigInt(st ?? 0);
  }
  return {
    leveltime: p.TIC, prndindex: Number(p.RNG), x: fixed(p.X), y: fixed(p.Y), z: fixed(p.Z), angle: bam(p.ANGLE),
    momx: fixed(p.MOMX), momy: fixed(p.MOMY), health: p.HEALTH,
    mobjs: BigInt(all.length), sumx: sx, sumy: sy, sumz: sz, sumhealth: shp, sumstate: sst,
  };
}

/**
 * Play DEMO (parsed) in the port, a tic at a time, against TRACE (parsed). The map must be the
 * demo's (loadMap with its skill and options first). → { tics, first: { field: { tic, port, vanilla } | null },
 * synced: tics the player stayed in step (every PLAYER_FIELDS agreeing) }
 */
export async function playAgainst(db, demo, trace, { limit = Infinity } = {}) {
  const first = Object.fromEntries(FIELDS.map((f) => [f, null]));
  // the trace's first line is the level as P_SetupLevel left it (leveltime 0), before any tic
  const setup = trace[0]?.leveltime === 0 ? 1 : 0;
  const n = Math.min(demo.tics.length, trace.length - setup, limit);
  let synced = null;
  const compare = async (tic, theirs) => {
    const mine = await portRow(db);
    for (const f of FIELDS) {
      if (first[f] || mine[f] === null) continue;
      // (the demo's tic: the trace's leveltime starts over if vanilla's player dies and the level restarts)
      if (mine[f] !== theirs[f]) first[f] = { tic, port: String(mine[f]), vanilla: String(theirs[f]) };
    }
    if (synced === null && PLAYER_FIELDS.some((f) => first[f])) synced = Math.max(0, tic - 1);
  };
  if (setup) await compare(0, trace[0]);
  for (let t = 0; t < n; t++) {
    const [fwd, side, turn, fire, use, weapon, run] = portCmd(demo.tics[t][demo.consoleplayer] ?? demo.tics[t][0]);
    await db.query('SELECT * FROM doom_tic(1, ?, ?, ?, ?, ?, ?, ?)', [fwd, side, turn, fire, use, weapon, run]);
    await compare(t + 1, trace[t + setup]);
  }
  return { tics: n, first, synced: synced ?? n };
}

// ── every thinker, one by one (dump.c's ORACLE_MOBJS: NAME.mobjs) ──
const MT_NAMES = Object.keys(MOBJINFO);
const MT_BY_ED = new Map(Object.entries(MOBJINFO).filter(([, m]) => m.ednum > 0).map(([k, m]) => [m.ednum, k]));
export const MOBJ_FIELDS = ['x', 'y', 'z', 'angle', 'health', 'state', 'tics'];
const THINKER_NAME = { flash: 'T_LightFlash', strobe: 'T_StrobeFlash', glow: 'T_Glow', flicker: 'T_FireFlicker',
  door: 'T_VerticalDoor', lift: 'T_PlatRaise', floor: 'T_MoveFloor', crush: 'T_MoveCeiling' };

/** NAME.mobjs → Map leveltime → the thinkers in the list's order, from the level's first life
 * (when vanilla's player dies the level starts again from leveltime 0) */
export function parseMobjs(text) {
  const byTic = new Map();
  let prev = -1;
  let life = 0;
  for (const l of text.trim().split('\n')) {
    const v = l.split(' ');
    const t = Number(v[0]);
    if (t < prev || (t === prev && v[1] === '0')) life++;
    prev = t;
    if (life > 0) continue;
    if (!byTic.has(t)) byTic.set(t, []);
    if (v[2] === 'T') { if (v[3] !== 'removed') byTic.get(t).push({ kind: v[3] }); continue; }
    const n = v.map(Number);
    byTic.get(t).push({ kind: 'mobj', type: MT_NAMES[n[3]], spawn: n[6] ? `${n[4]},${n[5]},${n[6]}` : null,
      x: n[8], y: n[9], z: n[10], angle: n[11], health: n[15], state: n[16], tics: n[17] });
  }
  return byTic;
}

/** The port's thinkers now, in the list's order (RUN_THINKERS' keys), as parseMobjs gives vanilla's */
export async function portThinkers(db) {
  const tic = (await db.query('SELECT tic FROM game WHERE id = 1')).rows[0].TIC;
  const rows = (await db.query(`SELECT 'T' w, COALESCE(t.think_key, 2 * t.id) k, t.thing_type, m.x mx, m.y my, m.ttype,
       t.x, t.y, t.z, t.angle, t.hp, t.state, t.state_tic, CAST(NULL AS VARCHAR(8)) lfx
       FROM things t LEFT JOIN map_things m ON m.id = t.mthing
     UNION ALL SELECT 'L', s.lfx_key, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, s.lfx FROM sectors s WHERE s.lfx IS NOT NULL
     UNION ALL SELECT 'D', m.think_key, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, m.kind FROM movers m
     ORDER BY 2`)).rows;
  return rows.map((r) => (r.W.trim() !== 'T' ? { kind: THINKER_NAME[r.LFX.trim()] ?? r.LFX.trim() } : {
    kind: 'mobj', type: MOBJ_TYPE[r.THING_TYPE] ?? MT_BY_ED.get(r.THING_TYPE) ?? `?${r.THING_TYPE}`,
    spawn: r.MX == null ? null : `${r.MX},${r.MY},${r.TTYPE}`,
    x: fixed(r.X), y: fixed(r.Y), z: fixed(r.Z), angle: bam(r.ANGLE), health: r.HP, state: r.STATE,
    tics: r.STATE_TIC == null ? -1 : r.STATE_TIC - tic,
  }));
}

/**
 * Vanilla's thinkers against the port's, one by one in the list's order: where the order first
 * differs (a kind, a mobj's type or map spot), and for each of MOBJ_FIELDS the mobjs that differ
 * ([index, port, vanilla, its type]).
 */
export function compareThinkers(van, port) {
  const label = (t) => (t ? (t.kind === 'mobj' ? `${t.type}@${t.spawn ?? 'new'}` : t.kind) : 'none');
  let order = null;
  const fields = Object.fromEntries(MOBJ_FIELDS.map((f) => [f, []]));
  const n = Math.max(van.length, port.length);
  for (let i = 0; i < n; i++) {
    const v = van[i];
    const p = port[i];
    if (label(v) !== label(p)) { order = { at: i, port: label(p), vanilla: label(v) }; break; }
    if (v.kind !== 'mobj') continue;
    for (const f of MOBJ_FIELDS) if (p[f] !== v[f]) fields[f].push([i, p[f], v[f], label(v)]);
  }
  return { order, fields, count: [port.length, van.length] };
}

/** Load the demo's map in the port as the demo starts it (G_InitNew: skill, options; M_ClearRandom) */
export async function startDemo(db, wad, res, demo, loadMap) {
  const commercial = wad.mapNames().some((m) => m.startsWith('MAP'));
  await loadMap(db, wad, res, lmpMapName(demo, commercial), {
    skill: demo.skill, players: demo.players.filter(Boolean).length, deathmatch: demo.deathmatch,
    respawn: demo.respawn, fast: demo.fast, nomonsters: demo.nomonsters, seed: 0,
  });
}

// the command line: a report on one demo
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lmpPath, tracePath, wadArg] = process.argv.slice(2);
  if (!lmpPath || !tracePath) {
    console.log('usage: node scripts/lmp-sync.mjs DEMO.lmp TRACE [WAD]');
    process.exit(1);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { FirebirdBrowser, DirectTransport } = await import('firebird-wasm/browser');
  const { Wad } = await import('../src/wad.js');
  const { createSchema, loadResources, loadMap } = await import('../src/loader.js');
  const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
  const db = new FirebirdBrowser('memory://lmpsync', { transport: new DirectTransport({ threads: false }) });
  await createSchema(db, sql);
  const wad = new Wad(fs.readFileSync(wadArg ?? path.join(root, 'public/wads/freedoom1.wad')));
  const res = await loadResources(db, wad);
  const demo = parseLmp(fs.readFileSync(lmpPath));
  await startDemo(db, wad, res, demo, loadMap);
  const r = await playAgainst(db, demo, parseTrace(fs.readFileSync(tracePath, 'utf8')));
  console.log(`${path.basename(lmpPath)}: ${r.tics} tics; the player in step for ${r.synced}`);
  for (const f of FIELDS) {
    const d = r.first[f];
    console.log(`  ${f.padEnd(10)} ${d ? `differs at tic ${d.tic}: port ${d.port}, vanilla ${d.vanilla}` : 'agrees throughout'}`);
  }
  await db.close();
}
