// loader.js – copy a WAD into Firebird.
//
// Shared by the browser (src/main.js) and the Node smoke test
// (scripts/sql-smoke.mjs), so CI exercises exactly the SQL the page runs.

import { THING_TYPES } from './thinginfo.js';

const ITEM_LABELS = {
  STIM: 'a stimpack', MEDI: 'a medikit', BON1: 'a health bonus', SOUL: 'a supercharge',
  BON2: 'an armor bonus', ARM1: 'the armor', ARM2: 'the megaarmor', CLIP: 'a clip',
  AMMO: 'a box of bullets', SHEL: '4 shotgun shells', SBOX: 'a box of shotgun shells',
  SHOT: 'the shotgun!', MGUN: 'the chaingun!', BPAK: 'a backpack full of ammo!',
  BKEY: 'a blue keycard', YKEY: 'a yellow keycard', RKEY: 'a red keycard',
  BSKU: 'a blue skull key', YSKU: 'a yellow skull key', RSKU: 'a red skull key',
  PSTR: 'a berserk pack!', PMAP: 'a computer area map', PINV: 'an invulnerability sphere',
  PINS: 'a partial invisibility sphere', SUIT: 'a radiation suit', PVIS: 'light amplification goggles',
};

const lit = (v) =>
  v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
      : `'${String(v).replace(/'/g, "''")}'`;

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
export async function loadResources(db, wad, { width = 320, height = 168 } = {}) {
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

  await db.exec('DELETE FROM textures; DELETE FROM flats; DELETE FROM sprite_frames; DELETE FROM thing_types; DELETE FROM screen_cols; DELETE FROM game; DELETE FROM player; DELETE FROM viewcfg');
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
      'drop_type', 'pickup', 'amount', 'label'],
    THING_TYPES.map((t) => [
      t.type, t.sprite, t.kind, t.radius, t.height, t.solid ?? 0, t.hp ?? null, t.speed ?? null, t.painChance ?? null,
      t.walk ?? 'A', t.attack ?? null, t.pain ?? null, t.death ?? null, t.deathSprite ?? null, t.bright ?? 0,
      t.atk ?? null, t.missile ?? null, t.dmgLo ?? null, t.dmgHi ?? null, t.shots ?? null, t.drop ?? null,
      t.pickup ?? null, t.amount ?? null, ITEM_LABELS[t.sprite] ?? t.sprite,
    ]),
  );
  await db.exec(`SET TERM ^ ;
EXECUTE BLOCK AS DECLARE i INTEGER = 0;
BEGIN WHILE (i < 1280) DO BEGIN INSERT INTO screen_cols (x) VALUES (:i); i = i + 1; END END^
SET TERM ; ^`);
  await db.exec('INSERT INTO game (id) VALUES (1); INSERT INTO player (id) VALUES (1)');
  await setView(db, width, height);

  return { texDefs, texId, flats, flatId };
}

/**
 * The view: 90° wide like DOOM. Vertical scale is always that of a 320-wide
 * screen, so "low detail" (160 columns) just makes each column twice as wide.
 */
export async function setView(db, width, height) {
  await db.exec(
    `UPDATE OR INSERT INTO viewcfg (id, w, h, proj, projy, near_z) VALUES (1, ${width}, ${height}, ${width / 2}, 160, 4) MATCHING (id)`,
  );
}

/** true: BSP front-to-back with solidsegs (RENDER_SLICES_BSP); false: project every linedef. */
export async function setRenderer(db, useBsp) {
  await db.exec(`UPDATE viewcfg SET use_bsp = ${useBsp ? 1 : 0} WHERE id = 1`);
}

/** P_SetupLevel: replace the current map with `name` from the WAD. */
export async function loadMap(db, wad, res, name, { skill = 3, newGame = true } = {}) {
  const m = wad.map(name);
  const tex = (n) => (n && n !== '-' ? res.texId.get(n) ?? 0 : 0);
  const flat = (n) => res.flatId.get(n) ?? null;

  await db.exec(
    'DELETE FROM movers; DELETE FROM line_blocks; DELETE FROM things; DELETE FROM map_things; DELETE FROM nodes; DELETE FROM ssectors; ' +
      'DELETE FROM segs; DELETE FROM linedefs; DELETE FROM sidedefs; DELETE FROM sectors; DELETE FROM vertexes',
  );
  await insertRows(db, 'vertexes', ['id', 'x', 'y'], m.vertexes.map((v) => [v.id, v.x, v.y]));
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
  await db.exec(`EXECUTE PROCEDURE init_map('${name}', ${skillBit}, ${newGame ? 1 : 0})`);
  return m;
}
