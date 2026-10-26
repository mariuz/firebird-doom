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
  noise_sector  INTEGER,                        -- …and where (re-flooding is throttled)
  root_node     INTEGER,                        -- BSP root (highest NODES id)
  sides_rev     INTEGER DEFAULT 0 NOT NULL,     -- bumped when a switch texture flips
  total_kills   INTEGER DEFAULT 0 NOT NULL,
  total_items   INTEGER DEFAULT 0 NOT NULL,
  total_secrets INTEGER DEFAULT 0 NOT NULL,
  rng           BIGINT DEFAULT 0 NOT NULL,      -- P_Random's prndindex (0–255): the same seed, the same game
  skill         SMALLINT DEFAULT 3 NOT NULL,    -- 1 (easiest) … 5 (nightmare: fast, respawning)
  players       SMALLINT DEFAULT 1 NOT NULL,    -- players in the game (netgame: more than 1); ids 1…players
  deathmatch    SMALLINT DEFAULT 0 NOT NULL,    -- 0 single player or co-op, 1 deathmatch, 2 -altdeath (items respawn)
  time_limit    INTEGER DEFAULT 0 NOT NULL,     -- -timer: minutes until the level ends on its own (0: never)
  -- the launch options of a netgame (any skill): -nomonsters, -respawn
  -- (monsters come back as on Nightmare), -fast (Nightmare's monster speed)
  nomonsters    SMALLINT DEFAULT 0 NOT NULL,
  respawn       SMALLINT DEFAULT 0 NOT NULL,
  fast          SMALLINT DEFAULT 0 NOT NULL,
  brain_on    INTEGER DEFAULT 0 NOT NULL,        -- braintargeton: the boss brain's next spawn spot (A_BrainSpit)
  brain_easy  SMALLINT DEFAULT 0 NOT NULL        -- A_BrainSpit's easy: on skills 1 and 2 it spits every other time
);

-- player->frags[]: who killed whom this level (a player's own row and column
-- is a suicide, counted against them)
CREATE TABLE frags (
  killer SMALLINT NOT NULL,
  victim SMALLINT NOT NULL,
  n      INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (killer, victim)
);

-- itemrespawnque: in -altdeath, what was picked up comes back 30 seconds later
CREATE TABLE respawn_queue (
  id    INTEGER NOT NULL PRIMARY KEY,
  ttype INTEGER NOT NULL,
  x     DOUBLE PRECISION NOT NULL,
  y     DOUBLE PRECISION NOT NULL,
  angle DOUBLE PRECISION NOT NULL,
  tic   INTEGER NOT NULL                        -- when it went
);

CREATE TABLE viewcfg (
  id     SMALLINT NOT NULL PRIMARY KEY,
  w      INTEGER NOT NULL,
  h      INTEGER NOT NULL,
  proj   DOUBLE PRECISION NOT NULL,   -- horizontal projection distance in pixels
  projy  DOUBLE PRECISION NOT NULL,   -- vertical (differs in low detail mode)
  near_z DOUBLE PRECISION NOT NULL,   -- near clip plane in map units
  use_bsp SMALLINT DEFAULT 1 NOT NULL, -- 1 = BSP front-to-back with solidsegs, 0 = every linedef
  player_id SMALLINT DEFAULT 1 NOT NULL -- whose eyes this browser sees through (consoleplayer)
);

-- A netgame's tic: every player's ticcmd, written before NET_TIC runs it.
CREATE TABLE ticcmd (
  player_id SMALLINT NOT NULL PRIMARY KEY,
  fwd       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  side      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  turn      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  fire      SMALLINT DEFAULT 0 NOT NULL,
  use_key   SMALLINT DEFAULT 0 NOT NULL,
  weapon_sel SMALLINT DEFAULT 0 NOT NULL,
  run       SMALLINT DEFAULT 0 NOT NULL
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
  dmg_lo       INTEGER,                -- a projectile's damage: (P_Random() % 8 + 1) × this
  drop_type    INTEGER,
  pickup       VARCHAR(10),
  amount       INTEGER,
  label        VARCHAR(80),             -- the pickup message (GOTARMOR…)
  -- sfx lump names (DS*): mobjinfo's seesound (A_Look; a projectile's as it's fired), activesound,
  -- attacksound (A_Chase before a melee attack, A_SkullAttack), painsound and deathsound
  see_snd      VARCHAR(8),
  active_snd   VARCHAR(8),                     -- activesound: now and then while chasing
  atk_snd      VARCHAR(8),
  pain_snd     VARCHAR(8),
  death_snd    VARCHAR(8),
  hang         SMALLINT DEFAULT 0 NOT NULL,  -- MF_SPAWNCEILING: hangs from the ceiling
  mass         INTEGER DEFAULT 100 NOT NULL, -- how hard it is to toss (momz = 1000 / mass)
  floats       SMALLINT DEFAULT 0 NOT NULL,  -- MF_FLOAT | MF_NOGRAVITY: flies
  nogravity    SMALLINT DEFAULT 0 NOT NULL,  -- MF_NOGRAVITY: hangs in the air (a puff, fog, fire; a flier)
  reaction_time INTEGER DEFAULT 8 NOT NULL,   -- mobjinfo's reactiontime: 8, the player's 0 (DeHackEd's Reaction time)
  shadow       SMALLINT DEFAULT 0 NOT NULL,  -- MF_SHADOW: drawn as fuzz (the spectre)
  count_kill    SMALLINT DEFAULT 0 NOT NULL, -- MF_COUNTKILL: in the kill tally
  count_item    SMALLINT DEFAULT 0 NOT NULL, -- MF_COUNTITEM: in the item tally
  -- mobjinfo's states (STATES ids; 0 = none): the frame tables, filled from src/states.js
  spawn_state   INTEGER DEFAULT 0 NOT NULL,
  see_state     INTEGER DEFAULT 0 NOT NULL,
  pain_state    INTEGER DEFAULT 0 NOT NULL,
  melee_state   INTEGER DEFAULT 0 NOT NULL,
  missile_state INTEGER DEFAULT 0 NOT NULL,
  death_state   INTEGER DEFAULT 0 NOT NULL,
  xdeath_state  INTEGER DEFAULT 0 NOT NULL,
  raise_state   INTEGER DEFAULT 0 NOT NULL,
  on_states     SMALLINT DEFAULT 0 NOT NULL  -- 1: on the frame tables (thinginfo.js's ON_STATES: every type but the markers)
);

-- DOOM's state table, info.c's states[] (src/states.js, GPL-2, as a DEHACKED lump patched
-- it): a frame of a thing's or a weapon's animation, how long it lasts, the action called when
-- it's entered, and the state after it. The id is DOOM's statenum.
-- m_random.c's rndtable (src/states.js's RNDTABLE): P_Random's 256 numbers, I 0–255
CREATE TABLE rndtable (
  i SMALLINT NOT NULL PRIMARY KEY,
  v SMALLINT NOT NULL
);
-- tables.c's finesine (src/states.js's FINESINE): 16.16 sines of the 8192 fine angles, and a
-- quarter turn more, so finecosine[i] is finesine[i + 2048] (P_Thrust, P_HitSlideLine)
CREATE TABLE finesine (
  i SMALLINT NOT NULL PRIMARY KEY,
  v INTEGER NOT NULL
);
-- tables.c's tantoangle (TANTOANGLE): the BAM angle of each slope 0–2048 / 2048 (R_PointToAngle)
CREATE TABLE tantoangle (
  i SMALLINT NOT NULL PRIMARY KEY,
  v BIGINT NOT NULL
);

CREATE TABLE states (
  id         INTEGER NOT NULL PRIMARY KEY,
  name       VARCHAR(24) NOT NULL,          -- S_POSS_ATK1 …
  sprite     CHAR(4) NOT NULL,
  frame      CHAR(1) NOT NULL,
  bright     SMALLINT NOT NULL,             -- FF_FULLBRIGHT
  tics       INTEGER NOT NULL,              -- -1: for ever
  action     VARCHAR(24),                   -- A_Look …, NULL: none
  next_state INTEGER NOT NULL,
  misc1      INTEGER DEFAULT 0 NOT NULL,
  misc2      INTEGER DEFAULT 0 NOT NULL,
  -- the old rules' word for where in its life a thing in this state is (idle, chase, attack,
  -- pain, dying, dead, raise), kept in THINGS.ST so the code that asks it (what can be
  -- shot, what's a corpse) works for both; worked out by the loader from mobjinfo's states
  mode       VARCHAR(8),
  -- G_InitNew: with -fast (or on Nightmare) this state lasts half its tics (tics >>= 1):
  -- the demons' run, attack and pain frames, S_SARG_RUN1 to S_SARG_PAIN2
  fast       SMALLINT DEFAULT 0 NOT NULL
);

-- d_items.c's weaponinfo[]: each weapon's ammo and its states (src/states.js's WEAPONINFO),
-- by this port's weapon number (DOOM's weapontype_t + 1: 1 the fist … 9 the super shotgun)
CREATE TABLE weapon_info (
  weapon       SMALLINT NOT NULL PRIMARY KEY,
  ammo         VARCHAR(8) NOT NULL,          -- clip, shell, misl, cell, noammo
  up_state     INTEGER NOT NULL,             -- upstate: A_Raise
  down_state   INTEGER NOT NULL,             -- downstate: A_Lower
  ready_state  INTEGER NOT NULL,             -- readystate: A_WeaponReady
  atk_state    INTEGER NOT NULL,             -- atkstate: P_FireWeapon goes here
  flash_state  INTEGER NOT NULL              -- flashstate: the muzzle flash (0: none)
);

-- ── the map ─────────────────────────────────────────────────────────────
-- The map's REJECT lump, a row of bits per sector: the sectors that can't be
-- seen from it, as hex digits (digit k holds sectors 4k–4k+3, lowest bit
-- first). All-zero rows are left out.
CREATE TABLE reject (
  sector_id INTEGER NOT NULL PRIMARY KEY,
  bits      VARCHAR(8000) NOT NULL
);

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
  special    INTEGER NOT NULL,
  -- its light thinker, if it has one (p_lights.c, made by SPAWN_LIGHT): flash, strobe, glow or
  -- flicker; the tics until it next changes; its darkest and brightest levels; a strobe's dark
  -- time; a glow's direction (-1 down, 1 up)
  lfx        VARCHAR(8),
  lfx_count  INTEGER DEFAULT 0 NOT NULL,
  lfx_min    INTEGER,
  lfx_max    INTEGER,
  lfx_dark   INTEGER,
  lfx_dir    SMALLINT,
  tag        INTEGER NOT NULL,
  sky        SMALLINT DEFAULT 0 NOT NULL,
  sound_heard SMALLINT DEFAULT 0 NOT NULL     -- soundtarget: the player whose gunfire reached this sector (0: none)
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
  light_delta  INTEGER DEFAULT 0 NOT NULL,  -- DOOM's "fake contrast"
  -- in 16.16 fixed point, for the code that moves as DOOM does (INIT_MAP): v1, dx, dy, and
  -- the slopetype (0 ST_HORIZONTAL, 1 ST_VERTICAL, 2 ST_POSITIVE, 3 ST_NEGATIVE)
  fx BIGINT, fy BIGINT, fdx BIGINT, fdy BIGINT,
  slope SMALLINT
);
CREATE INDEX linedefs_tag ON linedefs (tag);
CREATE INDEX linedefs_special ON linedefs (special);   -- (the few lines a monster can set off)
CREATE INDEX linedefs_minx ON linedefs (minx);
CREATE INDEX linedefs_fsec ON linedefs (front_sector);
CREATE INDEX linedefs_bsec ON linedefs (back_sector);

-- BLOCKMAP: which linedefs pass through each 128×128 map cell (P_BlockLinesIterator).
CREATE TABLE line_blocks (
  bx      INTEGER NOT NULL,
  by_     INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  cell    INTEGER NOT NULL                -- by_ * 4096 + bx: one key per cell, for exact lookups
);
CREATE INDEX line_blocks_cell ON line_blocks (bx, by_);
CREATE INDEX line_blocks_key ON line_blocks (cell);

-- The map's own BLOCKMAP lump, as P_LoadBlockMap reads it: each block's linedefs in the lump's
-- order (SEQ), the 0 that starts every list included, for P_BlockLinesIterator's order in
-- P_CheckPosition and P_PathTraverse. Its origin and size are in BLOCKMAP_INFO.
CREATE TABLE blockmap (
  bx      SMALLINT NOT NULL,
  by_     SMALLINT NOT NULL,
  seq     SMALLINT NOT NULL,
  line_id INTEGER NOT NULL,
  PRIMARY KEY (bx, by_, seq)
);
CREATE TABLE blockmap_info (
  id    SMALLINT NOT NULL PRIMARY KEY,
  org_x INTEGER NOT NULL,                  -- bmaporgx, bmaporgy (map units)
  org_y INTEGER NOT NULL,
  w     INTEGER NOT NULL,                  -- bmapwidth, bmapheight (blocks)
  h     INTEGER NOT NULL
);

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
  spawn_x    DOUBLE PRECISION,                 -- where the map put it (P_NightmareRespawn)
  spawn_y    DOUBLE PRECISION,
  spawn_angle DOUBLE PRECISION,
  mthing      INTEGER,                          -- the map thing it was spawned from (MAP_THINGS.ID; P_LoadThings' order)
  movedir     SMALLINT DEFAULT 8 NOT NULL,      -- P_NewChaseDir's heading: 0 east … 7 south-east (45° steps), 8 none
  movecount   INTEGER DEFAULT 0 NOT NULL,       -- chase steps before it picks a new heading
  just_attacked SMALLINT DEFAULT 0 NOT NULL,    -- MF_JUSTATTACKED
  dead_tic   INTEGER,                          -- when it became a corpse
  sector_id  INTEGER,
  hp         INTEGER,
  -- its state's mode (STATES.MODE: idle chase attack melee pain dying dead raise fly), kept
  -- here by SET_STATE for the many queries that ask it (what can be shot, what's a corpse)
  st         VARCHAR(8) DEFAULT 'idle' NOT NULL,
  momx       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  momy       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  momz       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  reaction   INTEGER DEFAULT 0 NOT NULL,
  owner_id   INTEGER,
  radius     DOUBLE PRECISION NOT NULL,
  height     DOUBLE PRECISION NOT NULL,
  solid      SMALLINT DEFAULT 0 NOT NULL,
  target_id  INTEGER,                               -- who a monster is after (NULL = the player)
  threshold  INTEGER DEFAULT 0 NOT NULL,            -- chase steps before it may switch target again
  tplayer    SMALLINT DEFAULT 1 NOT NULL,           -- the player it's after when TARGET_ID is NULL
  translation SMALLINT DEFAULT 0 NOT NULL,          -- a player's colours: 0 green, 1 indigo, 2 brown, 3 red (MF_TRANSLATION)
  -- DOOM's frame tables: the thing's state (STATES id; NULL only for the markers DOOM never
  -- draws) and the tic that state ends (NULL: never, a -1 tics state). SET_STATE and
  -- STATES_THINK move it on.
  state       INTEGER,
  state_tic   INTEGER,
  just_hit    SMALLINT DEFAULT 0 NOT NULL,        -- MF_JUSTHIT: hurt into its pain state, it fights back next (P_CheckMissileRange)
  -- mobj->floorz, ceilingz: the floor and ceiling a player's box touches, as P_TryMove and
  -- P_ThingHeightClip found them (NULL: to be found where it stands, after a teleport), and
  -- where it was then (put anywhere else, it looks again)
  floorz      DOUBLE PRECISION,
  ceilz       DOUBLE PRECISION,
  fz_x        DOUBLE PRECISION,
  fz_y        DOUBLE PRECISION
);
CREATE INDEX things_kind ON things (kind);
CREATE INDEX things_sector ON things (sector_id);
CREATE INDEX things_x ON things (x);
CREATE INDEX things_state_tic ON things (state_tic);   -- (STATES_THINK: only the things whose state ends this tic)

CREATE TABLE player (
  id           SMALLINT NOT NULL PRIMARY KEY,
  thing_id     INTEGER,
  health       INTEGER DEFAULT 100 NOT NULL,
  armor        INTEGER DEFAULT 0 NOT NULL,
  armor_type   SMALLINT DEFAULT 0 NOT NULL,   -- 0 none, 1 green (absorbs 1/3), 2 blue (1/2)
  attacker_id  INTEGER,                        -- player->attacker: who hurt you last (none: the world)
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
  pending_weapon SMALLINT DEFAULT 0 NOT NULL,   -- pendingweapon: 0 none (wp_nochange), else the weapon to switch to
  -- the player's two psprites (pspdef_t): the weapon (ps_weapon) and its muzzle flash
  -- (ps_flash), each a state and the tics left in it (NULL: none); sx, sy where the weapon
  -- is drawn (WEAPONTOP 32 up, WEAPONBOTTOM 128 out of sight; the flash goes with it)
  psp_state    INTEGER,
  psp_tics     INTEGER DEFAULT 0 NOT NULL,
  psp_sx       DOUBLE PRECISION DEFAULT 1 NOT NULL,
  psp_sy       DOUBLE PRECISION DEFAULT 32 NOT NULL,
  flash_state  INTEGER,
  flash_tics   INTEGER DEFAULT 0 NOT NULL,
  refire       INTEGER DEFAULT 0 NOT NULL,      -- player->refire: shots in a row (the pistol's first is accurate)
  attack_down  SMALLINT DEFAULT 0 NOT NULL,     -- player->attackdown: the rocket launcher and BFG fire once a press
  buttons      SMALLINT DEFAULT 0 NOT NULL,     -- this tic's BT_ATTACK, for A_WeaponReady and A_ReFire
  extralight   SMALLINT DEFAULT 0 NOT NULL,     -- 0–2 while a muzzle flash lights the view (A_Light1, A_Light2)
  bob          DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- player->bob: P_CalcHeight's, for A_WeaponReady's sway
  delta_vh     DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- player->deltaviewheight: the view coming back up after a step or a landing
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
  dead         SMALLINT DEFAULT 0 NOT NULL,
  invis_tics   INTEGER DEFAULT 0 NOT NULL,   -- pw_invisibility: tics of partial invisibility left
  invuln_tics  INTEGER DEFAULT 0 NOT NULL,   -- pw_invulnerability: tics of invulnerability left
  iron_tics    INTEGER DEFAULT 0 NOT NULL,   -- pw_ironfeet: the radiation suit
  infra_tics   INTEGER DEFAULT 0 NOT NULL,   -- pw_infrared: light amplification goggles
  strength_tics INTEGER DEFAULT 0 NOT NULL,  -- pw_strength: berserk, counting up from 1 (0 = none)
  allmap       SMALLINT DEFAULT 0 NOT NULL,  -- pw_allmap: the computer area map, for this level
  god          SMALLINT DEFAULT 0 NOT NULL,  -- CF_GODMODE (IDDQD)
  noclip       SMALLINT DEFAULT 0 NOT NULL   -- CF_NOCLIP (IDCLIP / IDSPISPOPD)
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
  y      DOUBLE PRECISION,
  listener SMALLINT               -- only this player hears it (a pickup: S_StartSound for consoleplayer); NULL: everyone
);

-- The sound graph, built by INIT_MAP: sector A is next to sector B through
-- two-sided lines; BLOCK is 0 if any of those lines lets sound through freely.
CREATE TABLE sound_links (
  a     INTEGER NOT NULL,
  b     INTEGER NOT NULL,
  block SMALLINT NOT NULL,
  PRIMARY KEY (a, b)
);

-- P_RecursiveSound's working set: sectors reached by the current noise, with
-- the fewest sound-blocking lines crossed to get there.
CREATE TABLE sound_flood (
  sector_id INTEGER NOT NULL PRIMARY KEY,
  blocks    SMALLINT NOT NULL,
  frontier  SMALLINT NOT NULL          -- 1 = expand next pass, 2 = just reached
);

-- Moving floors and ceilings: doors, lifts, platforms.
-- The rules a DeHackEd patch's Misc and Ammo blocks can change (vanilla's by default; src/dehacked.js)
CREATE TABLE rules (
  id           INTEGER NOT NULL PRIMARY KEY,
  init_health  INTEGER DEFAULT 100 NOT NULL,
  init_bullets INTEGER DEFAULT 50 NOT NULL,
  max_health   INTEGER DEFAULT 200 NOT NULL,   -- what health bonuses go up to
  max_armor    INTEGER DEFAULT 200 NOT NULL,   -- …and armour bonuses
  green_class  INTEGER DEFAULT 1 NOT NULL,
  blue_class   INTEGER DEFAULT 2 NOT NULL,
  max_soul     INTEGER DEFAULT 200 NOT NULL,
  soul_health  INTEGER DEFAULT 100 NOT NULL,
  mega_health  INTEGER DEFAULT 200 NOT NULL,
  god_health   INTEGER DEFAULT 100 NOT NULL,
  idfa_armor   INTEGER DEFAULT 200 NOT NULL,
  idfa_class   INTEGER DEFAULT 2 NOT NULL,
  idkfa_armor  INTEGER DEFAULT 200 NOT NULL,
  idkfa_class  INTEGER DEFAULT 2 NOT NULL,
  bfg_cells    INTEGER DEFAULT 40 NOT NULL,
  max_bullets  INTEGER DEFAULT 200 NOT NULL,
  max_shells   INTEGER DEFAULT 50 NOT NULL,
  max_cells    INTEGER DEFAULT 300 NOT NULL,
  max_rockets  INTEGER DEFAULT 50 NOT NULL,
  clip_bullets INTEGER DEFAULT 10 NOT NULL,
  clip_shells  INTEGER DEFAULT 4 NOT NULL,
  clip_cells   INTEGER DEFAULT 20 NOT NULL,
  clip_rockets INTEGER DEFAULT 1 NOT NULL
);

CREATE TABLE movers (
  sector_id INTEGER NOT NULL PRIMARY KEY,
  kind      VARCHAR(8) NOT NULL,        -- door lift floor crush
  dir       SMALLINT NOT NULL,          -- 1 up, -1 down, 0 waiting (or a stopped crusher), 2 a door waiting to rise
  speed     DOUBLE PRECISION NOT NULL,
  top_h     DOUBLE PRECISION NOT NULL,
  bottom_h  DOUBLE PRECISION NOT NULL,
  wait_tics INTEGER NOT NULL,
  wait_left INTEGER DEFAULT 0 NOT NULL,
  stay      SMALLINT DEFAULT 0 NOT NULL, -- 1 = do not return after reaching target; 2 = a door that
                                         -- reopens 30 s after closing, or a perpetual lift
  crush     SMALLINT DEFAULT 0 NOT NULL, -- damages what it squeezes
  silent    SMALLINT DEFAULT 0 NOT NULL, -- type 141: no grinding noise
  new_flat  INTEGER,                     -- a floor's flat when it arrives (lowerAndChange, donut)
  new_special INTEGER                    -- …and its new sector special
);
