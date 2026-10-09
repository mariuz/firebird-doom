// loader.js – copy a WAD into Firebird.
//
// Shared by the browser (src/main.js) and the Node smoke test
// (scripts/sql-smoke.mjs), so CI exercises exactly the SQL the page runs.

import { THING_TYPES } from './thinginfo.js';
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

const lit = (v) =>
  v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
      : `'${String(v).replace(/'/g, "''")}'`;

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

/** Bulk insert: one EXECUTE BLOCK per chunk, so one Worker round trip each. */
// Each INSERT is one "context" and a block may hold at most 256 of them.
export async function insertRows(db, table, cols, rows, chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    const body = rows
      .slice(i, i + chunk)
      .map((r) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${r.map(lit).join(', ')});`)
      .join('\n');
    await db.exec(`SET TERM ^ ;\nEXECUTE BLOCK AS BEGIN\n${body}\nEND^\nSET TERM ; ^`);
  }
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
  const deh = applyDehacked(THING_TYPES, parseDehacked(dehText));
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

  await db.exec('DELETE FROM textures; DELETE FROM flats; DELETE FROM sprite_frames; DELETE FROM thing_types; DELETE FROM screen_cols; DELETE FROM game; DELETE FROM player; DELETE FROM viewcfg; DELETE FROM rules');
  await insertRows(db, 'textures', ['id', 'name', 'w', 'h'], texDefs.map((d, i) => [i + 1, d.name, d.w, d.h]));
  await insertRows(db, 'flats', ['id', 'name', 'is_sky'], flats.map((l, i) => [i + 1, l.name, l.name === 'F_SKY1' ? 1 : 0]));
  await insertRows(
    db, 'sprite_frames', ['sprite', 'frame', 'rot', 'lump', 'flip', 'w', 'h', 'leftoff', 'topoff'],
    [...frames.values()].map((f) => [f.sprite, f.frame, f.rot, f.lump, f.flip, f.w, f.h, f.left, f.top]),
  );
  await insertRows(
    db, 'thing_types',
    ['thing_type', 'sprite', 'kind', 'radius', 'height', 'solid', 'hp', 'speed', 'pain_chance', 'walk_fr', 'atk_fr',
      'pain_fr', 'death_fr', 'death_sprite', 'bright', 'atk_kind', 'missile_type', 'dmg_lo', 'dmg_hi', 'shots',
      'drop_type', 'pickup', 'amount', 'label', 'see_snd', 'atk_snd', 'pain_snd', 'death_snd', 'hang',
      'melee_fr', 'melee_snd', 'melee_hit_snd', 'melee_dmg', 'melee_rolls', 'mass', 'floats', 'shadow', 'active_snd',
      'count_kill', 'count_item'],
    deh.types.map((t) => [
      t.type, t.sprite, t.kind, t.radius, t.height, t.solid ?? 0, t.hp ?? null, t.speed ?? null, t.painChance ?? null,
      t.walk ?? 'A', t.attack ?? null, t.pain ?? null, t.death ?? null, t.deathSprite ?? null, t.bright ?? 0,
      t.atk ?? null, t.missile ?? null, t.dmgLo ?? null, t.dmgHi ?? null, t.shots ?? null, t.drop ?? null,
      t.pickup ?? null, t.amount ?? null, itemMessage(t.sprite, strings),
      t.seeSnd ?? null, t.atkSnd ?? null, t.painSnd ?? null, t.deathSnd ?? null, t.hang ?? 0,
      t.meleeFr ?? null, t.meleeSnd ?? null, t.meleeHitSnd ?? null, t.meleeDmg ?? null, t.meleeRolls ?? null,
      t.mass ?? 100, t.floats ?? 0, t.shadow ?? 0, t.activeSnd ?? null, t.countKill ?? 0, t.countItem ?? 0,
    ]),
  );
  await db.exec(`SET TERM ^ ;
EXECUTE BLOCK AS DECLARE i INTEGER = 0;
BEGIN WHILE (i < 1280) DO BEGIN INSERT INTO screen_cols (x) VALUES (:i); i = i + 1; END END^
SET TERM ; ^`);
  await db.exec('INSERT INTO game (id) VALUES (1); INSERT INTO player (id) VALUES (1)');
  const rk = Object.keys(deh.rules);
  await db.exec(`INSERT INTO rules (id, ${rk.join(', ')}) VALUES (1, ${rk.map((k) => Math.trunc(deh.rules[k])).join(', ')})`);
  await setView(db, width, height, projy);

  return { texDefs, texId, flats, flatId, dehacked: { cheats: deh.cheats, pars: deh.pars, report: deh.report, types: deh.types } };
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
 * DEATHMATCH (0 co-op, 1, 2 for -altdeath) and TIMER (-timer, minutes) likewise.
 * SEED sets P_RANDOM's state before the map loads (left out: it carries on).
 */
export async function loadMap(db, wad, res, name, { skill = 3, newGame = true, players = null, deathmatch = null, timer = null, seed = null } = {}) {
  const m = wad.map(name);
  if (players != null) await db.exec(`UPDATE game SET players = ${Math.max(1, Math.min(4, players | 0))} WHERE id = 1`);
  if (deathmatch != null) await db.exec(`UPDATE game SET deathmatch = ${Math.max(0, Math.min(2, deathmatch | 0))} WHERE id = 1`);
  if (timer != null) await db.exec(`UPDATE game SET time_limit = ${Math.max(0, timer | 0)} WHERE id = 1`);
  const tex = (n) => (n && n !== '-' ? res.texId.get(n) ?? 0 : 0);
  const flat = (n) => res.flatId.get(n) ?? null;

  await db.exec(
    'DELETE FROM sound_events; DELETE FROM movers; DELETE FROM line_blocks; DELETE FROM things; DELETE FROM map_things; DELETE FROM nodes; DELETE FROM ssectors; ' +
      'DELETE FROM segs; DELETE FROM linedefs; DELETE FROM sidedefs; DELETE FROM sectors; DELETE FROM vertexes; DELETE FROM reject',
  );
  await insertRows(db, 'vertexes', ['id', 'x', 'y'], m.vertexes.map((v) => [v.id, v.x, v.y]));
  await insertRows(db, 'reject', ['sector_id', 'bits'], rejectRows(m.reject, m.sectors.length));
  await insertRows(
    db, 'sectors', ['id', 'floor_h', 'ceil_h', 'floor_flat', 'ceil_flat', 'light', 'base_light', 'special', 'tag'],
    m.sectors.map((s) => [s.id, s.floor, s.ceil, flat(s.floorTex), flat(s.ceilTex), s.light, s.light, s.special, s.tag]),
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

  const skillBit = skill <= 2 ? 1 : skill === 3 ? 2 : 4;
  // the same thing ids on every load, so a level always starts identical (demos)
  await db.exec('ALTER SEQUENCE thing_seq RESTART WITH 1');   // (from 1: origin 0 means the player's own sounds)
  // P_RANDOM's seed goes in first (G_InitNew's M_ClearRandom comes before the
  // level): a deathmatch's starts are drawn from it as the map loads
  if (seed != null) await db.exec(`UPDATE game SET rng = ${seed} WHERE id = 1`);
  await db.exec(`EXECUTE PROCEDURE init_map('${name}', ${skillBit}, ${newGame ? 1 : 0}, ${skill})`);
  return m;
}
