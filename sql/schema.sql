-- schema.sql – the whole of DOOM's world, as Firebird tables.
--
-- A WAD map is already a relational database in disguise: VERTEXES are
-- joined by LINEDEFS, which own one or two SIDEDEFS, which face SECTORS.
-- loader.js copies those lumps in verbatim; game.sql simulates them and
-- render.sql draws them.

-- ── session / configuration ─────────────────────────────────────────────
CREATE TABLE game (
  id            SMALLINT NOT NULL PRIMARY KEY,
  tic           INTEGER DEFAULT 0 NOT NULL,
  map_name      VARCHAR(8),
  exit_kind     SMALLINT DEFAULT 0 NOT NULL,   -- 0 playing, 1 exit, 2 secret exit, 3 restart
  noise_tic     INTEGER DEFAULT -1000 NOT NULL, -- last tic the player made noise (gunfire)
  root_node     INTEGER,                        -- BSP root (highest NODES id)
  sides_rev     INTEGER DEFAULT 0 NOT NULL,     -- bumped when a switch texture flips
  total_kills   INTEGER DEFAULT 0 NOT NULL,
  total_items   INTEGER DEFAULT 0 NOT NULL,
  total_secrets INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE viewcfg (
  id     SMALLINT NOT NULL PRIMARY KEY,
  w      INTEGER NOT NULL,
  h      INTEGER NOT NULL,
  proj   DOUBLE PRECISION NOT NULL,   -- horizontal projection distance in pixels
  projy  DOUBLE PRECISION NOT NULL,   -- vertical (differs in low detail mode)
  near_z DOUBLE PRECISION NOT NULL,   -- near clip plane in map units
  use_bsp SMALLINT DEFAULT 1 NOT NULL -- 1 = BSP front-to-back with solidsegs, 0 = every linedef
);

-- One row per screen column: the renderer's generate_series().
CREATE TABLE screen_cols (x INTEGER NOT NULL PRIMARY KEY);

-- ── resources (from the WAD directory) ──────────────────────────────────
CREATE TABLE textures (
  id   INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR(8) NOT NULL,
  w    INTEGER NOT NULL,
  h    INTEGER NOT NULL
);
CREATE INDEX textures_name ON textures (name);

CREATE TABLE flats (
  id     INTEGER NOT NULL PRIMARY KEY,
  name   VARCHAR(8) NOT NULL,
  is_sky SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX flats_name ON flats (name);

CREATE TABLE sprite_frames (
  sprite  CHAR(4) NOT NULL,
  frame   CHAR(1) NOT NULL,
  rot     SMALLINT NOT NULL,           -- 0 = same picture from every angle
  lump    INTEGER NOT NULL,            -- WAD directory index of the picture
  flip    SMALLINT NOT NULL,
  w       INTEGER NOT NULL,
  h       INTEGER NOT NULL,
  leftoff INTEGER NOT NULL,
  topoff  INTEGER NOT NULL,
  PRIMARY KEY (sprite, frame, rot)
);

CREATE TABLE thing_types (
  thing_type   INTEGER NOT NULL PRIMARY KEY,
  sprite       CHAR(4) NOT NULL,
  kind         VARCHAR(10) NOT NULL,   -- player monster barrel item decor missile fx
  radius       DOUBLE PRECISION NOT NULL,
  height       DOUBLE PRECISION NOT NULL,
  solid        SMALLINT NOT NULL,
  hp           INTEGER,
  speed        DOUBLE PRECISION,
  pain_chance  INTEGER,
  walk_fr      VARCHAR(16),
  atk_fr       VARCHAR(16),
  pain_fr      VARCHAR(16),
  death_fr     VARCHAR(16),
  death_sprite CHAR(4),
  bright       SMALLINT DEFAULT 0 NOT NULL,
  atk_kind     VARCHAR(10),            -- hitscan missile melee
  missile_type INTEGER,
  dmg_lo       INTEGER,
  dmg_hi       INTEGER,
  shots        INTEGER,
  drop_type    INTEGER,
  pickup       VARCHAR(10),
  amount       INTEGER,
  label        VARCHAR(40),
  -- sfx lump names (DS*) for A_Look / attack / A_Pain / A_Scream
  see_snd      VARCHAR(8),
  atk_snd      VARCHAR(8),
  pain_snd     VARCHAR(8),
  death_snd    VARCHAR(8),
  hang         SMALLINT DEFAULT 0 NOT NULL,  -- MF_SPAWNCEILING: hangs from the ceiling
  -- a separate close-range attack (the revenant's fist)
  melee_fr      VARCHAR(8),
  melee_snd     VARCHAR(8),
  melee_hit_snd VARCHAR(8),
  melee_dmg     INTEGER,                     -- damage is melee_dmg × 1d(melee_rolls)
  melee_rolls   INTEGER
);

-- ── the map ─────────────────────────────────────────────────────────────
CREATE TABLE vertexes (
  id INTEGER NOT NULL PRIMARY KEY,
  x  DOUBLE PRECISION NOT NULL,
  y  DOUBLE PRECISION NOT NULL
);

CREATE TABLE sectors (
  id         INTEGER NOT NULL PRIMARY KEY,
  floor_h    DOUBLE PRECISION NOT NULL,
  ceil_h     DOUBLE PRECISION NOT NULL,
  floor_flat INTEGER,
  ceil_flat  INTEGER,
  light      INTEGER NOT NULL,          -- current (animated) light level
  base_light INTEGER NOT NULL,          -- as authored
  min_light  INTEGER,                   -- darkest neighbour, for strobes/glows
  special    INTEGER NOT NULL,
  tag        INTEGER NOT NULL,
  sky        SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX sectors_tag ON sectors (tag);

CREATE TABLE sidedefs (
  id        INTEGER NOT NULL PRIMARY KEY,
  xoff      DOUBLE PRECISION NOT NULL,
  yoff      DOUBLE PRECISION NOT NULL,
  upper_tex INTEGER NOT NULL,           -- 0 = "-" (no texture)
  lower_tex INTEGER NOT NULL,
  mid_tex   INTEGER NOT NULL,
  sector_id INTEGER NOT NULL
);

CREATE TABLE linedefs (
  id           INTEGER NOT NULL PRIMARY KEY,
  v1           INTEGER NOT NULL,
  v2           INTEGER NOT NULL,
  flags        INTEGER NOT NULL,
  special      INTEGER NOT NULL,
  tag          INTEGER NOT NULL,
  front_side   INTEGER,
  back_side    INTEGER,
  -- denormalised by INIT_MAP so the hot paths never join VERTEXES/SIDEDEFS
  x1 DOUBLE PRECISION, y1 DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION,
  len DOUBLE PRECISION, len2 DOUBLE PRECISION,
  minx DOUBLE PRECISION, maxx DOUBLE PRECISION,
  miny DOUBLE PRECISION, maxy DOUBLE PRECISION,
  front_sector INTEGER,
  back_sector  INTEGER,
  light_delta  INTEGER DEFAULT 0 NOT NULL  -- DOOM's "fake contrast"
);
CREATE INDEX linedefs_tag ON linedefs (tag);
CREATE INDEX linedefs_minx ON linedefs (minx);
CREATE INDEX linedefs_fsec ON linedefs (front_sector);
CREATE INDEX linedefs_bsec ON linedefs (back_sector);

-- BLOCKMAP: which linedefs pass through each 128×128 map cell (P_BlockLinesIterator).
CREATE TABLE line_blocks (
  bx      INTEGER NOT NULL,
  by_     INTEGER NOT NULL,
  line_id INTEGER NOT NULL
);
CREATE INDEX line_blocks_cell ON line_blocks (bx, by_);

CREATE TABLE segs (
  id      INTEGER NOT NULL PRIMARY KEY,
  v1      INTEGER NOT NULL,
  v2      INTEGER NOT NULL,
  linedef INTEGER NOT NULL,
  side_   SMALLINT NOT NULL,
  xoff    INTEGER NOT NULL,              -- distance along the linedef side
  -- denormalised by INIT_MAP for the BSP renderer
  x1 DOUBLE PRECISION, y1 DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION,
  len DOUBLE PRECISION,
  front_sector INTEGER,
  back_sector  INTEGER
);

CREATE TABLE ssectors (
  id        INTEGER NOT NULL PRIMARY KEY,
  seg_count INTEGER NOT NULL,
  first_seg INTEGER NOT NULL,
  sector_id INTEGER
);

-- The BSP tree. A child >= 32768 is a subsector (DOOM's NF_SUBSECTOR bit).
CREATE TABLE nodes (
  id          INTEGER NOT NULL PRIMARY KEY,
  x           DOUBLE PRECISION NOT NULL,
  y           DOUBLE PRECISION NOT NULL,
  dx          DOUBLE PRECISION NOT NULL,
  dy          DOUBLE PRECISION NOT NULL,
  right_child INTEGER NOT NULL,
  left_child  INTEGER NOT NULL,
  -- bounding boxes of each child, for R_CheckBBox
  r_top DOUBLE PRECISION, r_bot DOUBLE PRECISION, r_left DOUBLE PRECISION, r_right DOUBLE PRECISION,
  l_top DOUBLE PRECISION, l_bot DOUBLE PRECISION, l_left DOUBLE PRECISION, l_right DOUBLE PRECISION
);

-- THINGS lump as authored; INIT_MAP spawns from it per skill level.
CREATE TABLE map_things (
  id     INTEGER NOT NULL PRIMARY KEY,
  x      DOUBLE PRECISION NOT NULL,
  y      DOUBLE PRECISION NOT NULL,
  angle  INTEGER NOT NULL,
  ttype  INTEGER NOT NULL,
  flags  INTEGER NOT NULL
);

-- ── live objects ────────────────────────────────────────────────────────
CREATE SEQUENCE thing_seq;

CREATE TABLE things (
  id         INTEGER NOT NULL PRIMARY KEY,
  thing_type INTEGER NOT NULL,
  kind       VARCHAR(10) NOT NULL,
  x          DOUBLE PRECISION NOT NULL,
  y          DOUBLE PRECISION NOT NULL,
  z          DOUBLE PRECISION DEFAULT 0 NOT NULL,
  angle      DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- radians
  flags      INTEGER DEFAULT 0 NOT NULL,
  sector_id  INTEGER,
  hp         INTEGER,
  st         VARCHAR(8) DEFAULT 'idle' NOT NULL,    -- idle chase attack pain dying dead
  st_tics    INTEGER DEFAULT 0 NOT NULL,
  st_len     INTEGER DEFAULT 0 NOT NULL,
  step       INTEGER DEFAULT 0 NOT NULL,
  frame      CHAR(1),                               -- NULL = animate walk_fr by tic
  sprite     CHAR(4),                               -- NULL = thing_types.sprite
  momx       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  momy       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  momz       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  reaction   INTEGER DEFAULT 0 NOT NULL,
  owner_id   INTEGER,
  radius     DOUBLE PRECISION NOT NULL,
  height     DOUBLE PRECISION NOT NULL,
  solid      SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX things_kind ON things (kind);
CREATE INDEX things_sector ON things (sector_id);
CREATE INDEX things_x ON things (x);

CREATE TABLE player (
  id           SMALLINT NOT NULL PRIMARY KEY,
  thing_id     INTEGER,
  health       INTEGER DEFAULT 100 NOT NULL,
  armor        INTEGER DEFAULT 0 NOT NULL,
  bullets      INTEGER DEFAULT 50 NOT NULL,
  shells       INTEGER DEFAULT 0 NOT NULL,
  max_bullets  INTEGER DEFAULT 200 NOT NULL,
  max_shells   INTEGER DEFAULT 50 NOT NULL,
  weapon       SMALLINT DEFAULT 2 NOT NULL,      -- 1 fist 2 pistol 3 shotgun 4 chaingun 5 rocket 6 plasma 7 BFG 8 chainsaw 9 super shotgun
  has_shotgun  SMALLINT DEFAULT 0 NOT NULL,
  has_chaingun SMALLINT DEFAULT 0 NOT NULL,
  has_launcher SMALLINT DEFAULT 0 NOT NULL,
  has_plasma   SMALLINT DEFAULT 0 NOT NULL,
  has_bfg      SMALLINT DEFAULT 0 NOT NULL,
  has_chainsaw SMALLINT DEFAULT 0 NOT NULL,
  has_ssg      SMALLINT DEFAULT 0 NOT NULL,
  rockets      INTEGER DEFAULT 0 NOT NULL,
  cells        INTEGER DEFAULT 0 NOT NULL,
  max_rockets  INTEGER DEFAULT 50 NOT NULL,
  max_cells    INTEGER DEFAULT 300 NOT NULL,
  keycards     INTEGER DEFAULT 0 NOT NULL,       -- 1 blue 2 yellow 4 red
  attack_tics  INTEGER DEFAULT 0 NOT NULL,
  attack_len   INTEGER DEFAULT 0 NOT NULL,
  damage_count INTEGER DEFAULT 0 NOT NULL,
  bonus_count  INTEGER DEFAULT 0 NOT NULL,
  kills        INTEGER DEFAULT 0 NOT NULL,
  items        INTEGER DEFAULT 0 NOT NULL,
  secrets      INTEGER DEFAULT 0 NOT NULL,
  msg          VARCHAR(80),
  msg_tics     INTEGER DEFAULT 0 NOT NULL,
  view_h       DOUBLE PRECISION DEFAULT 41 NOT NULL,
  view_z       DOUBLE PRECISION DEFAULT 41 NOT NULL,
  use_down     SMALLINT DEFAULT 0 NOT NULL,
  dead         SMALLINT DEFAULT 0 NOT NULL
);

-- S_StartSound: every sound the simulation makes, for the browser to play.
-- x/y NULL means "at the player" (full volume, centred).
CREATE SEQUENCE sound_seq;
CREATE TABLE sound_events (
  id     INTEGER NOT NULL PRIMARY KEY,
  tic    INTEGER NOT NULL,
  sound  VARCHAR(8) NOT NULL,
  origin INTEGER,                 -- thing or sector making it; a new sound cuts the old one
  x      DOUBLE PRECISION,
  y      DOUBLE PRECISION
);

-- Moving floors and ceilings: doors, lifts, platforms.
CREATE TABLE movers (
  sector_id INTEGER NOT NULL PRIMARY KEY,
  kind      VARCHAR(8) NOT NULL,        -- door lift floor crush
  dir       SMALLINT NOT NULL,          -- 1 up, -1 down, 0 waiting (or a stopped crusher)
  speed     DOUBLE PRECISION NOT NULL,
  top_h     DOUBLE PRECISION NOT NULL,
  bottom_h  DOUBLE PRECISION NOT NULL,
  wait_tics INTEGER NOT NULL,
  wait_left INTEGER DEFAULT 0 NOT NULL,
  stay      SMALLINT DEFAULT 0 NOT NULL, -- 1 = do not return after reaching target
  crush     SMALLINT DEFAULT 0 NOT NULL, -- damages what it squeezes
  silent    SMALLINT DEFAULT 0 NOT NULL  -- type 141: no grinding noise
);
