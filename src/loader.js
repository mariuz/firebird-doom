// loader.js – copy a WAD into Firebird.
//
// Shared by the browser (src/main.js) and the Node smoke test
// (scripts/sql-smoke.mjs), so CI exercises exactly the SQL the page runs.

import { THING_TYPES, MOBJ_TYPE, SPAWN_STATE, ON_STATES } from './thinginfo.js';
import { STATES, MOBJINFO, RNDTABLE, FINESINE, TANTOANGLE } from './states.js';

// each thing type's eight states (spawn … raise), from its DOOM mobj type: by the
// map number, else MOBJ_TYPE; [] when DOOM has no such type
const MOBJ_BY_ED = new Map(Object.entries(MOBJINFO).filter(([, m]) => m.ednum > 0).map(([k, m]) => [m.ednum, k]));
const STATE_ID = new Map(STATES.map((s, i) => [s[0], i]));
/**
 * Each state's mode, the old rules' word for that stage of a thing's life (THINGS.ST):
 * every type's chains from its death, xdeath, spawn, see, missile, melee, pain and
 * raise states, each state taking the first chain to reach it; a death chain's
 * last state (tics -1) is the corpse, 'dead'. (The death chains go first: a
 * corpse's last frame is also the spawn state of the map's dead-monster
 * decorations, S_POSS_DIE5 for a dead former human, and must stay 'dead'.)
 */
export function stateModes(states = STATES, mobjinfo = MOBJINFO) {
  const mode = new Array(states.length).fill(null);
  const order = [[5, 'dying'], [6, 'dying'], [0, 'fly'], [0, 'idle'], [1, 'chase'], [4, 'attack'], [3, 'melee'], [2, 'pain'], [7, 'raise']];
  // (a projectile's flight is 'fly', as the old rules call it)
  const MISSILES = new Set(['MT_TROOPSHOT', 'MT_HEADSHOT', 'MT_BRUISERSHOT', 'MT_ROCKET', 'MT_PLASMA', 'MT_BFG', 'MT_TRACER',
    'MT_FATSHOT', 'MT_ARACHPLAZ', 'MT_SPAWNSHOT']);
  for (const [field, m] of order) {
    for (const [name, mobj] of Object.entries(mobjinfo)) {
      if (m === 'fly' && !MISSILES.has(name)) continue;
      for (let s = mobj.states[field], n = 0; s > 0 && mode[s] === null && n < 64; s = states[s][6], n++) {
        mode[s] = m === 'dying' && states[s][4] === -1 ? 'dead' : m;
      }
    }
  }
  return mode;
}
/** mobjinfo's spawnhealth for a thing type (every mobj has one: an item's or a decoration's is 1000), or null */
export function typeHealth(type, mobjinfo = MOBJINFO) {
  return mobjinfo[MOBJ_TYPE[type] ?? MOBJ_BY_ED.get(type)]?.health ?? null;
}
/** mobjinfo's radius and height for a thing type, in map units ({} if DOOM has no such type) */
export function typeSize(type) {
  const m = MOBJINFO[MOBJ_TYPE[type] ?? MOBJ_BY_ED.get(type)];
  return m ? { radius: m.radius, height: m.height } : {};
}
export function typeStates(type, mobjinfo = MOBJINFO) {
  const m = mobjinfo[MOBJ_TYPE[type] ?? MOBJ_BY_ED.get(type)];
  if (!m) return [0, 0, 0, 0, 0, 0, 0, 0];
  const s = [...m.states];
  if (SPAWN_STATE[type]) s[0] = STATE_ID.get(SPAWN_STATE[type]);
  return s;
}
import { applyDehacked, parseDehacked } from './dehacked.js';
import { parseDehStrings } from './finale.js';

// P_TouchSpecialThing's message for each item: the string it shows (by its
// DEHACKED name: Freedoom's DEHACKED has them all), else our own plain words
// (id's own messages stay out of the repository). GOTMEDINEED is never
// shown: vanilla tests health < 25 after adding the 25, so it can't be true.
const ITEM_MESSAGES = {
  STIM: ['GOTSTIM', 'Stimpack.'], MEDI: ['GOTMEDIKIT', 'Medikit.'], BON1: ['GOTHTHBONUS', 'Health bonus.'],
  SOUL: ['GOTSUPER', 'Soulsphere!'], BON2: ['GOTARMBONUS', 'Armor bonus.'], ARM1: ['GOTARMOR', 'Green armor.'],
  ARM2: ['GOTMEGA', 'Blue armor.'], CLIP: ['GOTCLIP', 'Bullets.'], AMMO: ['GOTCLIPBOX', 'Box of bullets.'],
  SHEL: ['GOTSHELLS', 'Shells.'], SBOX: ['GOTSHELLBOX', 'Box of shells.'], SHOT: ['GOTSHOTGUN', 'Shotgun!'],
  MGUN: ['GOTCHAINGUN', 'Chaingun!'], BPAK: ['GOTBACKPACK', 'Backpack!'],
  BKEY: ['GOTBLUECARD', 'Blue keycard.'], YKEY: ['GOTYELWCARD', 'Yellow keycard.'], RKEY: ['GOTREDCARD', 'Red keycard.'],
  BSKU: ['GOTBLUESKUL', 'Blue skull key.'], YSKU: ['GOTYELWSKUL', 'Yellow skull key.'], RSKU: ['GOTREDSKULL', 'Red skull key.'],
  PSTR: ['GOTBERSERK', 'Berserk!'], PMAP: ['GOTMAP', 'Computer map.'], PINV: ['GOTINVUL', 'Invulnerability!'],
  PINS: ['GOTINVIS', 'Partial invisibility.'], SUIT: ['GOTSUIT', 'Radiation suit.'], PVIS: ['GOTVISOR', 'Light amplification visor.'],
  CSAW: ['GOTCHAINSAW', 'Chainsaw!'], SGN2: ['GOTSHOTGUN2', 'Super shotgun!'], MEGA: ['GOTMSPHERE', 'Megasphere!'],
  LAUN: ['GOTLAUNCHER', 'Rocket launcher!'], PLAS: ['GOTPLASMA', 'Plasma gun!'], BFUG: ['GOTBFG9000', 'BFG9000!'],
  ROCK: ['GOTROCKET', 'Rocket.'], BROK: ['GOTROCKBOX', 'Box of rockets.'], CELL: ['GOTCELL', 'Energy cell.'],
  CELP: ['GOTCELLBOX', 'Energy cell pack.'],
};
const itemMessage = (sprite, strings) => {
  const m = ITEM_MESSAGES[sprite];
  return m ? (strings.get(m[0]) ?? m[1]).replace(/\n/g, ' ').slice(0, 80) : sprite;
};

/**
 * REJECT, re-cut into one row per sector: [sector, hex digits of the sectors
 * it can't see (digit k: sectors 4k–4k+3, lowest bit first)]. A short lump
 * reads as zeros past its end; rows with nothing rejected are left out.
 */
export function rejectRows(bytes, n) {
  const bit = (i) => (i >> 3 < bytes.length ? (bytes[i >> 3] >> (i & 7)) & 1 : 0);
  const rows = [];
  for (let s1 = 0; s1 < n; s1++) {
    let hex = '';
    let any = false;
    for (let k = 0; k < Math.ceil(n / 4); k++) {
      let nib = 0;
      for (let j = 0; j < 4 && 4 * k + j < n; j++) nib |= bit(s1 * n + 4 * k + j) << j;
      if (nib) any = true;
      hex += nib.toString(16);
    }
    if (any) rows.push([s1, hex]);
  }
  return rows;
}

/**
 * Bulk insert: one INSERT prepared once and run for every row, in one call to
 * the engine (firebird-wasm's execBatch, on Firebird's IBatch). The values are
 * bound as parameters, numbers in binary, so a double lands exactly – written
 * out as text, Firebird's parser puts about one fraction in ten a bit off.
 */
export async function insertRows(db, table, cols, rows) {
  if (!rows.length) return;
  const bound = rows.map((r) => r.map((v) => (v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v)));
  await db.execBatch(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, bound);
}

export async function createSchema(db, sql) {
  await db.exec(sql.schema);
  await db.exec(sql.game);
  await db.exec(sql.render);
}

/**
 * Resources: everything that does not change between maps.
 * Returns the lookup tables the JS renderer needs alongside.
 */
export async function loadResources(db, wad, { width = 320, height = 168, projy = 160, dehacked = '' } = {}) {
  // DeHackEd: the WAD's DEHACKED lump, then any patch given (a .deh file)
  const dehText = wad.dehacked() + '\n' + (dehacked ?? '');
  // (each type DOOM's own size first, mobjinfo's radius and height – collisions, P_ChangeSector's
  // fit and a hanging thing's place go by them – then whatever a patch changes)
  const deh = applyDehacked(THING_TYPES.map((t) => ({ ...t, ...typeSize(t.type) })), parseDehacked(dehText));
  const strings = parseDehStrings(dehText);
  // Wall textures: first definition of a name wins (R_TextureNumForName).
  const texDefs = [];
  const texId = new Map();
  for (const def of wad.textureDefs()) {
    if (texId.has(def.name)) continue;
    texDefs.push(def);
    texId.set(def.name, texDefs.length);
  }
  // Flats: last lump of a name wins (W_GetNumForName).
  const flatByName = new Map();
  for (const l of wad.flatLumps()) if (l.size === 4096) flatByName.set(l.name, l);
  const flats = [...flatByName.values()];
  const flatId = new Map(flats.map((l, i) => [l.name, i + 1]));

  // Sprite frames: later lumps replace earlier ones with the same key.
  const frames = new Map();
  for (const f of wad.spriteFrames()) frames.set(`${f.sprite}${f.frame}${f.rot}`, f);

  await db.exec('DELETE FROM textures; DELETE FROM flats; DELETE FROM sprite_frames; DELETE FROM thing_types; DELETE FROM states; DELETE FROM weapon_info; DELETE FROM rndtable; DELETE FROM finesine; DELETE FROM tantoangle; DELETE FROM screen_cols; DELETE FROM game; DELETE FROM player; DELETE FROM viewcfg; DELETE FROM rules');
  await insertRows(db, 'textures', ['id', 'name', 'w', 'h'], texDefs.map((d, i) => [i + 1, d.name, d.w, d.h]));
  await insertRows(db, 'flats', ['id', 'name', 'is_sky'], flats.map((l, i) => [i + 1, l.name, l.name === 'F_SKY1' ? 1 : 0]));
  await insertRows(
    db, 'sprite_frames', ['sprite', 'frame', 'rot', 'lump', 'flip', 'w', 'h', 'leftoff', 'topoff'],
    [...frames.values()].map((f) => [f.sprite, f.frame, f.rot, f.lump, f.flip, f.w, f.h, f.left, f.top]),
  );
  await insertRows(
    db, 'thing_types',
    ['thing_type', 'sprite', 'kind', 'radius', 'height', 'solid', 'hp', 'speed', 'pain_chance', 'dmg_lo',
      'drop_type', 'pickup', 'amount', 'label', 'see_snd', 'atk_snd', 'pain_snd', 'death_snd', 'hang',
      'mass', 'floats', 'nogravity', 'shadow', 'active_snd',
      'count_kill', 'count_item', 'reaction_time', 'spawn_state', 'see_state', 'pain_state', 'melee_state', 'missile_state',
      'death_state', 'xdeath_state', 'raise_state', 'on_states'],
    deh.types.map((t) => [
      t.type, t.sprite, t.kind, t.radius, t.height, t.solid ?? 0, t.hp ?? typeHealth(t.base ?? t.type, deh.mobjinfo), t.speed ?? null, t.painChance ?? null,
      t.dmgLo ?? null, t.drop ?? null, t.pickup ?? null, t.amount ?? null, itemMessage(t.sprite, strings),
      t.seeSnd ?? null, t.atkSnd ?? null, t.painSnd ?? null, t.deathSnd ?? null, t.hang ?? 0,
      t.mass ?? 100, t.floats ?? 0, t.nogravity ?? 0, t.shadow ?? 0, t.activeSnd ?? null, t.countKill ?? 0, t.countItem ?? 0,
      // (mobjinfo's reaction time: 8, the player's 0; its states and whether it's on the tables
      // are the type's it was, even if an ID # patch gave it another map number)
      t.reaction ?? (t.base === 1 ? 0 : 8), ...typeStates(t.base ?? t.type, deh.mobjinfo), ON_STATES.has(t.base ?? t.type) ? 1 : 0,
    ]),
  );
  // DOOM's state table (src/states.js), as the patch left it
  const modes = stateModes(deh.states, deh.mobjinfo);
  // (G_InitNew's -fast halves these: the demons' run, attack and pain states)
  const fastFrom = STATE_ID.get('S_SARG_RUN1');
  const fastTo = STATE_ID.get('S_SARG_PAIN2');
  await insertRows(db, 'states', ['id', 'name', 'sprite', 'frame', 'bright', 'tics', 'action', 'next_state', 'misc1', 'misc2', 'mode', 'fast'],
    deh.states.map((s, i) => [i, ...s, modes[i], i >= fastFrom && i <= fastTo ? 1 : 0]));
  await insertRows(db, 'rndtable', ['i', 'v'], RNDTABLE.map((v, i) => [i, v]));
  await insertRows(db, 'finesine', ['i', 'v'], FINESINE.map((v, i) => [i, v]));
  await insertRows(db, 'tantoangle', ['i', 'v'], TANTOANGLE.map((v, i) => [i, v]));
  // weaponinfo[], weapon k + 1 for DOOM's weapontype_t k
  await insertRows(db, 'weapon_info', ['weapon', 'ammo', 'up_state', 'down_state', 'ready_state', 'atk_state', 'flash_state'],
    deh.weapons.map((w, k) => [k + 1, w.ammo, ...w.states]));
  await db.exec(`SET TERM ^ ;
EXECUTE BLOCK AS DECLARE i INTEGER = 0;
BEGIN WHILE (i < 1280) DO BEGIN INSERT INTO screen_cols (x) VALUES (:i); i = i + 1; END END^
SET TERM ; ^`);
  await db.exec('INSERT INTO game (id) VALUES (1); INSERT INTO player (id) VALUES (1)');
  const rk = Object.keys(deh.rules);
  await db.exec(`INSERT INTO rules (id, ${rk.join(', ')}) VALUES (1, ${rk.map((k) => Math.trunc(deh.rules[k])).join(', ')})`);
  await setView(db, width, height, projy);

  return { texDefs, texId, flats, flatId, dehacked: { cheats: deh.cheats, pars: deh.pars, report: deh.report, types: deh.types, states: deh.states, mobjinfo: deh.mobjinfo } };
}

/**
 * The view: 90° wide like DOOM. Vertical scale is always that of a 320-wide
 * screen, so "low detail" (160 columns) just makes each column twice as wide.
 */
/** The view: WIDTH columns, HEIGHT rows, vertical scale PROJY (the view's width on the screen / 2). */
export async function setView(db, width, height, projy = 160) {
  await db.exec(
    `UPDATE OR INSERT INTO viewcfg (id, w, h, proj, projy, near_z) VALUES (1, ${width}, ${height}, ${width / 2}, ${projy}, 4) MATCHING (id)`,
  );
}

/** true: BSP front-to-back with solidsegs (RENDER_SLICES_BSP); false: project every linedef. */
export async function setRenderer(db, useBsp) {
  await db.exec(`UPDATE viewcfg SET use_bsp = ${useBsp ? 1 : 0} WHERE id = 1`);
}

/** P_SetupLevel: replace the current map with `name` from the WAD. */
/**
 * P_SetupLevel: map NAME into Firebird. PLAYERS (a netgame: 2–4) sets how
 * many players the game has; left out, it keeps what the game had (1 to start).
 * DEATHMATCH (0 co-op, 1, 2 for -altdeath) and TIMER (-timer, minutes) likewise, and
 * the launch options NOMONSTERS, RESPAWN and FAST (0 or 1).
 * SEED sets P_RANDOM's state before the map loads (left out: it carries on).
 */
/**
 * A BLOCKMAP for a map without one, as a node builder makes it: 128-unit blocks from 8 below
 * and left of the lowest vertex, each list starting with 0 and then every linedef whose box
 * overlaps the block's, in linedef order.
 */
function buildBlockmap(m) {
  const xs = m.vertexes.map((v) => v.x);
  const ys = m.vertexes.map((v) => v.y);
  const orgX = Math.min(...xs) - 8;
  const orgY = Math.min(...ys) - 8;
  const w = Math.floor((Math.max(...xs) - orgX) / 128) + 1;
  const h = Math.floor((Math.max(...ys) - orgY) / 128) + 1;
  const lists = Array.from({ length: w * h }, () => [0]);
  for (const l of m.linedefs) {
    const a = m.vertexes[l.v1];
    const b = m.vertexes[l.v2];
    const x0 = Math.floor((Math.min(a.x, b.x) - orgX) / 128);
    const x1 = Math.floor((Math.max(a.x, b.x) - orgX) / 128);
    const y0 = Math.floor((Math.min(a.y, b.y) - orgY) / 128);
    const y1 = Math.floor((Math.max(a.y, b.y) - orgY) / 128);
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) if (l.id !== 0) lists[by * w + bx].push(l.id);
  }
  const blocks = [];
  lists.forEach((list, k) => list.forEach((line, seq) => blocks.push([k % w, Math.floor(k / w), seq, line])));
  return { orgX, orgY, w, h, blocks };
}

export async function loadMap(db, wad, res, name, {
  skill = 3, newGame = true, players = null, deathmatch = null, timer = null, nomonsters = null, respawn = null, fast = null, seed = null,
} = {}) {
  const m = wad.map(name);
  if (players != null) await db.exec(`UPDATE game SET players = ${Math.max(1, Math.min(4, players | 0))} WHERE id = 1`);
  if (deathmatch != null) await db.exec(`UPDATE game SET deathmatch = ${Math.max(0, Math.min(2, deathmatch | 0))} WHERE id = 1`);
  if (timer != null) await db.exec(`UPDATE game SET time_limit = ${Math.max(0, timer | 0)} WHERE id = 1`);
  for (const [col, v] of [['nomonsters', nomonsters], ['respawn', respawn], ['fast', fast]]) {
    if (v != null) await db.exec(`UPDATE game SET ${col} = ${v ? 1 : 0} WHERE id = 1`);
  }
  const tex = (n) => (n && n !== '-' ? res.texId.get(n) ?? 0 : 0);
  const flat = (n) => res.flatId.get(n) ?? null;

  await db.exec(
    'DELETE FROM sound_events; DELETE FROM movers; DELETE FROM buttons; DELETE FROM line_blocks; DELETE FROM blockmap; DELETE FROM blockmap_info; DELETE FROM things; DELETE FROM map_things; DELETE FROM nodes; DELETE FROM ssectors; ' +
      'DELETE FROM segs; DELETE FROM linedefs; DELETE FROM sidedefs; DELETE FROM sectors; DELETE FROM vertexes; DELETE FROM reject',
  );
  await insertRows(db, 'vertexes', ['id', 'x', 'y'], m.vertexes.map((v) => [v.id, v.x, v.y]));
  await insertRows(db, 'reject', ['sector_id', 'bits'], rejectRows(m.reject, m.sectors.length));
  await insertRows(
    db, 'sectors', ['id', 'floor_h', 'ceil_h', 'floor_flat', 'ceil_flat', 'light', 'special', 'tag'],
    m.sectors.map((s) => [s.id, s.floor, s.ceil, flat(s.floorTex), flat(s.ceilTex), s.light, s.special, s.tag]),
  );
  await insertRows(
    db, 'sidedefs', ['id', 'xoff', 'yoff', 'upper_tex', 'lower_tex', 'mid_tex', 'sector_id'],
    m.sidedefs.map((s) => [s.id, s.xoff, s.yoff, tex(s.upper), tex(s.lower), tex(s.middle), s.sector]),
  );
  await insertRows(
    db, 'linedefs', ['id', 'v1', 'v2', 'flags', 'special', 'tag', 'front_side', 'back_side'],
    m.linedefs.map((l) => [l.id, l.v1, l.v2, l.flags, l.special, l.tag, l.right < 0 ? null : l.right, l.left < 0 ? null : l.left]),
  );
  await insertRows(db, 'segs', ['id', 'v1', 'v2', 'linedef', 'side_', 'xoff'],
    m.segs.map((s) => [s.id, s.v1, s.v2, s.linedef, s.side, s.offset]));
  await insertRows(db, 'ssectors', ['id', 'seg_count', 'first_seg'], m.ssectors.map((s) => [s.id, s.count, s.first]));
  await insertRows(
    db, 'nodes',
    ['id', 'x', 'y', 'dx', 'dy', 'right_child', 'left_child',
      'r_top', 'r_bot', 'r_left', 'r_right', 'l_top', 'l_bot', 'l_left', 'l_right'],
    m.nodes.map((n) => [n.id, n.x, n.y, n.dx, n.dy, n.right, n.left, ...n.rbox, ...n.lbox]),
  );
  await insertRows(db, 'map_things', ['id', 'x', 'y', 'angle', 'ttype', 'flags'],
    m.things.map((t) => [t.id, t.x, t.y, t.angle, t.type, t.flags]));
  // the map's BLOCKMAP lump (or one built here for a map without), for P_CheckPosition's and
  // P_PathTraverse's order
  const bm = m.blockmap ?? buildBlockmap(m);
  await db.exec(`INSERT INTO blockmap_info (id, org_x, org_y, w, h) VALUES (1, ${bm.orgX}, ${bm.orgY}, ${bm.w}, ${bm.h})`);
  await insertRows(db, 'blockmap', ['bx', 'by_', 'seq', 'line_id'], bm.blocks);

  const skillBit = skill <= 2 ? 1 : skill === 3 ? 2 : 4;
  // the same thing ids on every load, so a level always starts identical (demos)
  await db.exec('ALTER SEQUENCE thing_seq RESTART WITH 1');   // (from 1: origin 0 means the player's own sounds)
  await db.exec('ALTER SEQUENCE link_seq RESTART WITH 1');    // (and the blocklinks' order: the same on every load)
  // P_Random's index goes in first (G_InitNew's M_ClearRandom, 0, comes before the level): the
  // map's things draw from it as they spawn. A seed is where in rndtable to start (mod 256).
  if (seed != null) await db.exec(`UPDATE game SET rng = ${((Number(seed) % 256) + 256) % 256} WHERE id = 1`);
  await db.exec(`EXECUTE PROCEDURE init_map('${name}', ${skillBit}, ${newGame ? 1 : 0}, ${skill})`);
  return m;
}
