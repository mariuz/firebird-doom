// savegame.js – saving and loading (g_game.c's G_SaveGame / G_LoadGame).
//
// The whole game lives in Firebird, so a save is a snapshot of the rows that
// change while you play: game, player, things and movers entire, and the
// moving parts of the map – sector heights, lights, specials and the sound
// flag, switch textures on sidedefs, one-shot linedef specials. Loading
// reloads the map (loadMap) and writes the snapshot back over it, then moves
// thing_seq past the restored ids. The page adds what it keeps itself (the
// automap's seen lines, DOOM I's visited secret levels). Saves go to
// IndexedDB, six slots per WAD, as DOOM's six.

export const SAVE_VERSION = 1;
export const SLOTS = 6;

// tables saved whole, and the columns that change in the rest
const WHOLE = ['game', 'player', 'things', 'movers', 'frags', 'respawn_queue'];
const MOVING = {
  sectors: ['floor_h', 'ceil_h', 'light', 'special', 'sound_heard', 'floor_flat', 'base_light', 'min_light'],
  sidedefs: ['upper_tex', 'mid_tex', 'lower_tex'],
  linedefs: ['special'],
};

async function table(db, sql) {
  const { rows } = await db.query(sql, [], { rowMode: 'object' });
  const cols = rows.length ? Object.keys(rows[0]).map((c) => c.toLowerCase()) : [];
  return { cols, rows: rows.map((r) => Object.values(r)) };
}

/** G_SaveGame: everything the simulation can change, as plain JSON-able data. */
export async function captureGame(db, extra = {}) {
  const tables = {};
  // (ordered by each table's key, the first column, so a capture compares row for row)
  for (const t of WHOLE) tables[t] = await table(db, `SELECT * FROM ${t} ORDER BY 1`);
  for (const [t, cols] of Object.entries(MOVING)) tables[t] = await table(db, `SELECT id, ${cols.join(', ')} FROM ${t} ORDER BY id`);
  const g = (await db.query('SELECT map_name, skill FROM game WHERE id = 1')).rows[0];
  const seq = (await db.query('SELECT GEN_ID(thing_seq, 0) n FROM rdb$database')).rows[0].N;
  return { version: SAVE_VERSION, map: g.MAP_NAME.trim(), skill: g.SKILL, seq: Number(seq), tables, extra };
}

// A save must restore exactly. Its values go back as bound parameters, a
// statement prepared once per table and run for every row (execBatch), and
// firebird-wasm (0.4 on) binds a number in binary where the column is a
// double or an integer, so every double comes back bit for bit. (Before, a
// parameter travelled as text, Firebird's parser could land a fraction a bit
// off, and fractions were sent as m × 2^e.) A non-finite number goes in as NULL.
const bound = (row) => row.map((v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));

/**
 * G_LoadGame: write a capture back. The map must have just been loaded with
 * loadMap(save.map), which builds the static tables and the blockmap.
 */
export async function restoreGame(db, save) {
  if (save?.version !== SAVE_VERSION) throw new Error(`unknown save version ${save?.version}`);
  for (const t of WHOLE) {
    await db.exec(`DELETE FROM ${t}`);
    const { cols, rows } = save.tables[t] ?? { cols: [], rows: [] };   // (older saves: no frags, no respawn queue)
    if (rows.length) await db.execBatch(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, rows.map(bound));
  }
  for (const t of Object.keys(MOVING)) {
    const { cols, rows } = save.tables[t];
    const set = cols.slice(1);
    if (rows.length) await db.execBatch(`UPDATE ${t} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, rows.map((r) => bound([...r.slice(1), r[0]])));
  }
  // saves from before armour types: green's for up to 100 points, blue's above
  if (!save.tables.player.cols.some((c) => c.toLowerCase() === 'armor_type')) {
    await db.exec('UPDATE player SET armor_type = IIF(armor > 100, 2, IIF(armor > 0, 1, 0))');
  }
  // new things must not reuse the restored ids
  await db.exec(`ALTER SEQUENCE thing_seq RESTART WITH ${save.seq + 1}`);
}

/** Where saves live: IndexedDB, or memory when there's none (Node, private windows). */
export const SAVES_FILE = 'firebird-doom-saves';

/** A WAD's six slots as one file: { kind, version, wad, slots: [record | null × 6] }. */
export async function exportSaves(store, wad) {
  const slots = await Promise.all(Array.from({ length: SLOTS }, (_, i) => store.get(`${wad}|${i}`).catch(() => null)));
  return { kind: SAVES_FILE, version: SAVE_VERSION, wad, slots: slots.map((r) => r ?? null) };
}

/**
 * Write a file's filled slots back (the others are left alone). Refuses a file
 * of another kind, another save version, or another WAD (its map names and
 * thing ids wouldn't fit). Returns the slots written.
 */
export async function importSaves(store, wad, file) {
  if (file?.kind !== SAVES_FILE || !Array.isArray(file.slots)) throw new Error('not a Firebird DOOM saves file');
  if (file.version !== SAVE_VERSION) throw new Error(`saves of version ${file.version}; this game reads version ${SAVE_VERSION}`);
  if (file.wad !== wad) throw new Error(`these saves are for ${String(file.wad).split('|')[0]}, not this WAD`);
  const written = [];
  for (let i = 0; i < SLOTS; i++) {
    const r = file.slots[i];
    if (!r) continue;
    if (typeof r.name !== 'string' || !r.save?.tables || r.save.version !== SAVE_VERSION) throw new Error(`slot ${i + 1} isn't a save`);
    await store.put(`${wad}|${i}`, r);
    written.push(i);
  }
  return written;
}

/**
 * The PWADs and the patch loaded over a main WAD, remembered with it (keyed by
 * its name) so a reload puts them back: { pwads: [{ name, buffer }], deh: { name, text } | null }.
 * Nothing over it forgets the record.
 */
export async function rememberFiles(store, base, pwads, deh) {
  const keep = pwads.length || deh;
  await store.put(`files|${base}`, keep ? { pwads: pwads.map(({ name, buffer }) => ({ name, buffer })), deh: deh ? { name: deh.name, text: deh.text } : null } : null);
}

/** What rememberFiles kept for BASE: { pwads, deh }, or null. Anything malformed is ignored. */
export async function recallFiles(store, base) {
  const r = await store.get(`files|${base}`).catch(() => null);
  if (!r || !Array.isArray(r.pwads)) return null;
  const pwads = r.pwads.filter((p) => typeof p?.name === 'string' && p.buffer instanceof ArrayBuffer);
  const deh = typeof r.deh?.text === 'string' ? { name: String(r.deh.name ?? 'patch.deh'), text: r.deh.text } : null;
  return pwads.length || deh ? { pwads, deh } : null;
}

export function saveStore() {
  const memory = new Map();
  const fallback = { get: async (k) => memory.get(k) ?? null, put: async (k, v) => { memory.set(k, v); } };
  if (typeof indexedDB === 'undefined') return fallback;
  const opened = new Promise((resolve, reject) => {
    const req = indexedDB.open('firebird-doom', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('saves');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const idb = await opened;
    return new Promise((resolve, reject) => {
      const tx = idb.transaction('saves', mode);
      const req = fn(tx.objectStore('saves'));
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)).catch(() => fallback.get(k)),
    put: (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => fallback.put(k, v)),
  };
}
