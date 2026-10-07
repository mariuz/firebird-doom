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
const WHOLE = ['game', 'player', 'things', 'movers'];
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

// A save must restore exactly, but a fractional double written as decimal
// (even as a bound parameter, which travels as text) comes back from
// Firebird's parser up to a bit off. So a non-integer goes back as m × 2^e:
// m a whole number of at most 53 bits and e an integer – both exact as text –
// and multiplying by a power of two is exact.
export function mantissaExponent(v) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let m = (hi & 0xfffff) * 2 ** 32 + lo;
  let e;
  if (biased === 0) e = -1074;              // subnormal
  else { m += 2 ** 52; e = biased - 1075; }
  while (m !== 0 && m % 2 === 0) { m /= 2; e += 1; }   // (keep m small)
  return [v < 0 ? -m : m, e];
}

/**
 * Run one statement per row, \`per\` rows to an EXECUTE BLOCK, each row's values
 * bound as parameters: whole numbers and strings as they are, fractions as m × 2^e.
 */
async function perRow(db, rows, per, statement) {
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const decl = [];
    const params = [];
    const body = chunk.map((row, r) => statement(row.map((v, k) => {
      const name = `p${r}_${k}`;
      if (typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v)) {
        const [m, e] = mantissaExponent(v);
        decl.push(`${name}m BIGINT = ?`, `${name}e INTEGER = ?`);
        params.push(m, e);
        return `(:${name}m * POWER(2e0, :${name}e))`;
      }
      decl.push(`${name} ${typeof v === 'number' ? 'BIGINT' : 'VARCHAR(8191)'} = ?`);
      params.push(typeof v === 'number' && !Number.isFinite(v) ? null : v);
      return `:${name}`;
    }))).join('\n');
    await db.query(`EXECUTE BLOCK (${decl.join(', ')}) AS BEGIN\n${body}\nEND`, params);
  }
}

/**
 * G_LoadGame: write a capture back. The map must have just been loaded with
 * loadMap(save.map), which builds the static tables and the blockmap.
 */
export async function restoreGame(db, save) {
  if (save?.version !== SAVE_VERSION) throw new Error(`unknown save version ${save?.version}`);
  for (const t of WHOLE) {
    await db.exec(`DELETE FROM ${t}`);
    const { cols, rows } = save.tables[t];
    await perRow(db, rows, 10, (p) => `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${p.join(', ')});`);
  }
  for (const t of Object.keys(MOVING)) {
    const { cols, rows } = save.tables[t];
    const set = cols.slice(1);
    // (a statement holds at most 256 contexts, and an UPDATE takes more than one)
    await perRow(db, rows, 50, (p) => `UPDATE ${t} SET ${set.map((c, k) => `${c} = ${p[k + 1]}`).join(', ')} WHERE id = ${p[0]};`);
  }
  // saves from before armour types: green's for up to 100 points, blue's above
  if (!save.tables.player.cols.some((c) => c.toLowerCase() === 'armor_type')) {
    await db.exec('UPDATE player SET armor_type = IIF(armor > 100, 2, IIF(armor > 0, 1, 0))');
  }
  // new things must not reuse the restored ids
  await db.exec(`ALTER SEQUENCE thing_seq RESTART WITH ${save.seq + 1}`);
}

/** Where saves live: IndexedDB, or memory when there's none (Node, private windows). */
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
