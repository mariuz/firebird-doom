// rewind.js – stepping back in time: the game is all in tables, so a snapshot of what the
// simulation changes is a copy of rows, taken inside the engine (REWIND_TAKE, about once a
// second) and written back over the game (REWIND_BACK). Not vanilla: DOOM never did it.
//
// The snapshots live in tables of their own, SNAP_<table>, each with the columns of the table it
// copies and a SNAP number (REWIND_SNAPS lists them: the tic, the map), so a past tic can be
// looked at in the SQL console – SELECT * FROM snap_things WHERE snap = … . Their columns are
// read from the schema as it stands (RDB$RELATION_FIELDS), so they follow it without a hand-kept
// copy. What's copied is what a save holds (savegame.js: WHOLE tables, MOVING columns), and the
// switches counting down too (BUTTONS, which saves leave out as vanilla's do).
import { WHOLE, MOVING } from './savegame.js';

/** the snapshots kept: the last half a minute's */
export const REWIND_KEEP = 30;
/** a snapshot every this many tics */
export const REWIND_EVERY = 35;

const TABLES = [...WHOLE, 'buttons'];
// (MOVING tables whose rows mostly never change: copied only where they have)
const SPARSE = ['sidedefs', 'linedefs'];

/** Firebird's field types as DDL (the six the game's tables use) */
function typeOf(f) {
  switch (f.T) {
    case 7: return 'SMALLINT';
    case 8: return 'INTEGER';
    case 16: if (f.SC === 0) return 'BIGINT'; break;
    case 27: return 'DOUBLE PRECISION';
    case 37: return `VARCHAR(${f.CL})`;
    case 14: return `CHAR(${f.CL})`;
    default: break;
  }
  throw new Error(`rewind: no snapshot column for a field of type ${f.T}/${f.SC} (${f.R}.${f.C})`);
}

/**
 * The snapshot tables and REWIND_TAKE / REWIND_BACK, made from the schema's own columns.
 * Call once, after the schema and game.sql (createSchema does).
 */
export async function createRewind(db) {
  const names = [...TABLES, ...Object.keys(MOVING)].map((t) => `'${t.toUpperCase()}'`).join(', ');
  const { rows } = await db.query(`SELECT TRIM(rf.rdb$relation_name) r, TRIM(rf.rdb$field_name) c, f.rdb$field_type t,
         f.rdb$field_scale sc, f.rdb$character_length cl
      FROM rdb$relation_fields rf JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source
     WHERE rf.rdb$relation_name IN (${names}) ORDER BY rf.rdb$relation_name, rf.rdb$field_position`);
  const fields = new Map();
  for (const r of rows) {
    if (!fields.has(r.R)) fields.set(r.R, []);
    fields.get(r.R).push(r);
  }
  const cols = (t, only = null) => fields.get(t.toUpperCase()).filter((f) => !only || only.includes(f.C.toLowerCase()) || f.C === 'ID');
  const ddl = ['CREATE TABLE rewind_snaps (snap INTEGER NOT NULL PRIMARY KEY, tic INTEGER, map_name VARCHAR(8), seq BIGINT, link BIGINT)',
    'CREATE SEQUENCE rewind_seq'];
  const take = [];
  const back = [];
  const drop = [];
  const triggers = [];
  const orig = [];
  for (const t of TABLES) {
    const fs = cols(t);
    const list = fs.map((f) => f.C).join(', ');
    ddl.push(`CREATE TABLE snap_${t} (snap INTEGER NOT NULL, ${fs.map((f) => `${f.C} ${typeOf(f)}`).join(', ')})`,
      `CREATE INDEX snap_${t}_snap ON snap_${t} (snap)`);
    take.push(`INSERT INTO snap_${t} (snap, ${list}) SELECT :snap, ${list} FROM ${t};`);
    back.push(`DELETE FROM ${t};`, `INSERT INTO ${t} (${list}) SELECT ${list} FROM snap_${t} s WHERE s.snap = :target;`);
    drop.push(`snap_${t}`);
  }
  for (const [t, moving] of Object.entries(MOVING)) {
    const fs = cols(t, moving);
    const list = fs.map((f) => f.C).join(', ');
    const set = fs.filter((f) => f.C !== 'ID').map((f) => `${f.C} = s.${f.C}`).join(', ');
    ddl.push(`CREATE TABLE snap_${t} (snap INTEGER NOT NULL, ${fs.map((f) => `${f.C} ${typeOf(f)}`).join(', ')})`,
      `CREATE INDEX snap_${t}_snap ON snap_${t} (snap)`);
    drop.push(`snap_${t}`);
    if (SPARSE.includes(t)) {
      // (thousands of rows, a few of which ever change – a switch's texture, a line's special used:
      // a trigger keeps each one's value from the map's load the first time it changes, and a
      // snapshot copies only those; going back, they're all put back as they were, then the
      // snapshot's on top)
      const moved = fs.filter((f) => f.C !== 'ID').map((f) => `NEW.${f.C} IS DISTINCT FROM OLD.${f.C}`).join(' OR ');
      ddl.push(`CREATE TABLE rewind_orig_${t} (${fs.map((f) => `${f.C} ${typeOf(f)}${f.C === 'ID' ? ' NOT NULL PRIMARY KEY' : ''}`).join(', ')})`);
      triggers.push(`CREATE OR ALTER TRIGGER rewind_orig_${t} FOR ${t} AFTER UPDATE
AS
BEGIN
  IF ((${moved}) AND NOT EXISTS (SELECT 1 FROM rewind_orig_${t} o WHERE o.id = OLD.id)) THEN
    INSERT INTO rewind_orig_${t} (${list}) VALUES (${fs.map((f) => `OLD.${f.C}`).join(', ')});
END`);
      take.push(`INSERT INTO snap_${t} (snap, ${list}) SELECT :snap, ${fs.map((f) => `d.${f.C}`).join(', ')} FROM ${t} d JOIN rewind_orig_${t} o ON o.id = d.id;`);
      back.push(`MERGE INTO ${t} d USING rewind_orig_${t} s ON d.id = s.id WHEN MATCHED THEN UPDATE SET ${set};`);
      orig.push(`rewind_orig_${t}`);
    } else take.push(`INSERT INTO snap_${t} (snap, ${list}) SELECT :snap, ${list} FROM ${t};`);
    back.push(`MERGE INTO ${t} d USING (SELECT * FROM snap_${t} q WHERE q.snap = :target) s ON d.id = s.id WHEN MATCHED THEN UPDATE SET ${set};`);
  }
  for (const s of ddl) await db.exec(s);
  for (const s of triggers) await db.query(s);
  const forget = (cond) => drop.map((t) => `DELETE FROM ${t} x WHERE ${cond};`).join('\n  ');
  await db.query(`CREATE OR ALTER PROCEDURE rewind_take (keep INTEGER)
RETURNS (snap INTEGER)
AS
BEGIN
  -- (one snapshot: the tic, the map, thing_seq and link_seq as they stand, and the rows)
  snap = NEXT VALUE FOR rewind_seq;
  INSERT INTO rewind_snaps (snap, tic, map_name, seq, link)
  SELECT :snap, g.tic, g.map_name, GEN_ID(thing_seq, 0), GEN_ID(link_seq, 0) FROM game g WHERE g.id = 1;
  ${take.join('\n  ')}
  -- (the oldest beyond KEEP go)
  ${forget('x.snap <= :snap - :keep')}
  DELETE FROM rewind_snaps x WHERE x.snap <= :snap - :keep;
END`);
  await db.query(`CREATE OR ALTER PROCEDURE rewind_back (min_back INTEGER = ${REWIND_EVERY})
RETURNS (tic INTEGER)
AS
DECLARE target INTEGER;
DECLARE seq BIGINT;
DECLARE link BIGINT;
BEGIN
  -- (the newest snapshot at least MIN_BACK tics old – a second: so a rewind soon after another goes
  -- a step further back, not to the same one again – or, nearer the level's start than that, the
  -- level's first)
  tic = NULL;
  target = NULL;
  SELECT FIRST 1 r.snap, r.tic, r.seq, r.link FROM rewind_snaps r JOIN game g ON g.id = 1
   WHERE r.tic <= g.tic - :min_back AND r.map_name = g.map_name ORDER BY r.snap DESC INTO target, tic, seq, link;
  IF (target IS NULL) THEN
    SELECT FIRST 1 r.snap, r.tic, r.seq, r.link FROM rewind_snaps r JOIN game g ON g.id = 1
     WHERE r.tic < g.tic AND r.map_name = g.map_name ORDER BY r.snap INTO target, tic, seq, link;
  IF (target IS NULL) THEN EXIT;
  ${back.join('\n  ')}
  -- (new things after it take ids and block links from where they stood then: the same as then)
  seq = GEN_ID(thing_seq, seq - GEN_ID(thing_seq, 0));
  link = GEN_ID(link_seq, link - GEN_ID(link_seq, 0));
  -- (what came after it is gone: that future won't happen now)
  ${forget('x.snap > :target')}
  DELETE FROM rewind_snaps x WHERE x.snap > :target;
END`);
  // (a map's load: its snapshots go, and what's changed of it starts again from nothing)
  await db.query(`CREATE OR ALTER PROCEDURE rewind_clear
AS
BEGIN
  ${forget('1 = 1')}
  ${orig.map((t) => `DELETE FROM ${t};`).join('\n  ')}
  DELETE FROM rewind_snaps;
END`);
}
