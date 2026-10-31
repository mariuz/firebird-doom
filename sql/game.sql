-- game.sql – DOOM's simulation as Firebird PSQL.
--
-- Everything that happens in a game tic – movement, collision, doors, lifts,
-- monster AI, hitscan, pickups, light effects – is a procedure in here. The
-- browser only reports which keys are held, calls DOOM_TIC, and draws what
-- render.sql returns.

SET TERM ^ ;

-- ── BSP: which sector contains a point? ───────────────────────────────────
-- R_PointInSubsector, verbatim: walk the node tree from the root, taking the
-- right child when the point is on the front side of the partition line.
CREATE OR ALTER FUNCTION sector_at (px DOUBLE PRECISION, py DOUBLE PRECISION)
RETURNS INTEGER
AS
DECLARE n INTEGER;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE ndx DOUBLE PRECISION;
DECLARE ndy DOUBLE PRECISION;
DECLARE rc INTEGER;
DECLARE lc INTEGER;
DECLARE s INTEGER;
BEGIN
  SELECT COALESCE(root_node, 32768) FROM game WHERE id = 1 INTO n;
  WHILE (n < 32768) DO
  BEGIN
    SELECT x, y, dx, dy, right_child, left_child FROM nodes WHERE id = :n
      INTO nx, ny, ndx, ndy, rc, lc;
    IF ((py - ny) * ndx < ndy * (px - nx)) THEN n = rc; ELSE n = lc;
  END
  SELECT sector_id FROM ssectors WHERE id = :n - 32768 INTO s;
  RETURN s;
END^

-- R_PointToAngle2's angle from a point to another, in radians: ATAN2, but two points in one
-- place give 0, as DOOM's does (Firebird's ATAN2 refuses 0, 0)
CREATE OR ALTER FUNCTION atan2_safe (dy DOUBLE PRECISION, dx DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
BEGIN
  IF (dy = 0 AND dx = 0) THEN RETURN 0;
  RETURN ATAN2(dy, dx);
END^

-- P_Random (m_random.c): the next of rndtable's 256 numbers (RNDTABLE, src/states.js), as
-- DOOM steps through them: GAME.RNG is prndindex, moved on before each draw and wrapping at
-- 256. M_ClearRandom (G_InitNew) sets it to 0: loadMap's seed.
CREATE OR ALTER FUNCTION p_rand256 RETURNS INTEGER
AS
DECLARE i INTEGER;
BEGIN
  UPDATE game g SET rng = MOD(g.rng + 1, 256) WHERE g.id = 1 RETURNING g.rng INTO i;
  RETURN (SELECT r.v FROM rndtable r WHERE r.i = :i);
END^

-- P_Random() & MASK, one draw. (Firebird's BIN_AND evaluates its argument twice, so
-- BIN_AND(p_rand256(), 64) would use up two of rndtable's numbers: the draw goes in a variable.)
CREATE OR ALTER FUNCTION p_rand_and (mask INTEGER) RETURNS INTEGER
AS
DECLARE r INTEGER;
BEGIN
  r = p_rand256();
  RETURN BIN_AND(r, mask);
END^

-- P_Random as a fraction, [0, 1): the same draw, divided by 256 (for the code that thinks
-- in fractions: p_random() * 256 < 5 is P_Random() < 5)
CREATE OR ALTER FUNCTION p_random RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN p_rand256() / 256e0;
END^

-- ── DOOM's fixed point ────────────────────────────────────────────────────
-- What moves as DOOM moves it (the player, P_MovePlayer and P_XYMovement) does its sums in
-- 16.16 fixed point, as BIGINTs that wrap as DOOM's 32-bit ints do (m_fixed.c, tables.c,
-- p_maputl.c, r_main.c). A position or a speed in a DOUBLE column is then a whole number of
-- 1/65536ths, so it goes to 16.16 and back exactly (FX_OF, / 65536); an angle in radians is a
-- whole BAM (BAM_OF, RAD_OF).

-- a 32-bit int's wrap-around
CREATE OR ALTER FUNCTION fx32 (a BIGINT) RETURNS BIGINT
AS
BEGIN
  RETURN BIN_AND(a + 2147483648, 4294967295) - 2147483648;
END^

-- FixedMul: (a × b) >> 16, rounding down
CREATE OR ALTER FUNCTION fx_mul (a BIGINT, b BIGINT) RETURNS BIGINT
AS
BEGIN
  RETURN fx32(BIN_SHR(a * b, 16));
END^

-- FixedDiv: (a << 16) / b, rounding towards 0, or the largest number of a's sign over b's
-- when the answer wouldn't fit
CREATE OR ALTER FUNCTION fx_div (a BIGINT, b BIGINT) RETURNS BIGINT
AS
BEGIN
  IF (BIN_SHR(ABS(a), 14) >= ABS(b)) THEN
    RETURN IIF((a < 0 AND b >= 0) OR (a >= 0 AND b < 0), -2147483648, 2147483647);
  RETURN fx32((a * 65536) / b);
END^

-- map units (a DOUBLE) to 16.16, and radians to a BAM (0 … 2^32 - 1) and back
CREATE OR ALTER FUNCTION fx_of (d DOUBLE PRECISION) RETURNS BIGINT
AS
BEGIN
  RETURN CAST(ROUND(d * 65536) AS BIGINT);
END^

CREATE OR ALTER FUNCTION bam_of (rad DOUBLE PRECISION) RETURNS BIGINT
AS
DECLARE r BIGINT;
BEGIN
  r = CAST(ROUND(rad * 4294967296e0 / (2 * PI())) AS BIGINT);
  RETURN BIN_AND(r, 4294967295);
END^

CREATE OR ALTER FUNCTION rad_of (b BIGINT) RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN b * (2 * PI()) / 4294967296e0;
END^

-- finesine[i], and finecosine[i] = finesine[i + FINEANGLES / 4]
CREATE OR ALTER FUNCTION fine_sine (i INTEGER) RETURNS BIGINT
AS
BEGIN
  RETURN (SELECT f.v FROM finesine f WHERE f.i = :i);
END^

CREATE OR ALTER FUNCTION fine_cosine (i INTEGER) RETURNS BIGINT
AS
BEGIN
  RETURN (SELECT f.v FROM finesine f WHERE f.i = :i + 2048);
END^

-- P_AproxDistance: the octagonal guess at a length
CREATE OR ALTER FUNCTION aprox_distance (dx BIGINT, dy BIGINT) RETURNS BIGINT
AS
BEGIN
  dx = ABS(dx);
  dy = ABS(dy);
  IF (dx < dy) THEN RETURN fx32(dx + dy - BIN_SHR(dx, 1));
  RETURN fx32(dx + dy - BIN_SHR(dy, 1));
END^

-- P_PointOnLineSide: 0 in front of the line from (LX, LY) along (LDX, LDY), 1 behind
-- (the line's own length in whole units: line->dy >> FRACBITS)
CREATE OR ALTER FUNCTION point_on_line_side (
  x BIGINT, y BIGINT, lx BIGINT, ly BIGINT, ldx BIGINT, ldy BIGINT) RETURNS SMALLINT
AS
DECLARE dx BIGINT;
DECLARE dy BIGINT;
BEGIN
  IF (ldx = 0) THEN RETURN IIF(x <= lx, IIF(ldy > 0, 1, 0), IIF(ldy < 0, 1, 0));
  IF (ldy = 0) THEN RETURN IIF(y <= ly, IIF(ldx < 0, 1, 0), IIF(ldx > 0, 1, 0));
  dx = fx32(x - lx);
  dy = fx32(y - ly);
  RETURN IIF(fx_mul(dy, BIN_SHR(ldx, 16)) < fx_mul(BIN_SHR(ldy, 16), dx), 0, 1);
END^

-- P_PointOnDivlineSide: the same against a trace, deciding by the signs where it can, and
-- else in 8.8 (both sides >> 8)
CREATE OR ALTER FUNCTION point_on_divline_side (
  x BIGINT, y BIGINT, lx BIGINT, ly BIGINT, ldx BIGINT, ldy BIGINT) RETURNS SMALLINT
AS
DECLARE dx BIGINT;
DECLARE dy BIGINT;
BEGIN
  IF (ldx = 0) THEN RETURN IIF(x <= lx, IIF(ldy > 0, 1, 0), IIF(ldy < 0, 1, 0));
  IF (ldy = 0) THEN RETURN IIF(y <= ly, IIF(ldx < 0, 1, 0), IIF(ldx > 0, 1, 0));
  dx = fx32(x - lx);
  dy = fx32(y - ly);
  -- ((line->dy ^ line->dx ^ dx ^ dy) & 0x80000000): an odd number of them negative
  IF (MOD(IIF(ldy < 0, 1, 0) + IIF(ldx < 0, 1, 0) + IIF(dx < 0, 1, 0) + IIF(dy < 0, 1, 0), 2) = 1) THEN
    RETURN IIF(IIF(ldy < 0, 1, 0) <> IIF(dx < 0, 1, 0), 1, 0);
  RETURN IIF(fx_mul(BIN_SHR(dy, 8), BIN_SHR(ldx, 8)) < fx_mul(BIN_SHR(ldy, 8), BIN_SHR(dx, 8)), 0, 1);
END^

-- R_PointOnSide, for R_PointInSubsector: P_PointOnLineSide's sums with the sign test first
CREATE OR ALTER FUNCTION point_on_node_side (
  x BIGINT, y BIGINT, nx BIGINT, ny BIGINT, ndx BIGINT, ndy BIGINT) RETURNS SMALLINT
AS
DECLARE dx BIGINT;
DECLARE dy BIGINT;
BEGIN
  IF (ndx = 0) THEN RETURN IIF(x <= nx, IIF(ndy > 0, 1, 0), IIF(ndy < 0, 1, 0));
  IF (ndy = 0) THEN RETURN IIF(y <= ny, IIF(ndx < 0, 1, 0), IIF(ndx > 0, 1, 0));
  dx = fx32(x - nx);
  dy = fx32(y - ny);
  IF (MOD(IIF(ndy < 0, 1, 0) + IIF(ndx < 0, 1, 0) + IIF(dx < 0, 1, 0) + IIF(dy < 0, 1, 0), 2) = 1) THEN
    RETURN IIF(IIF(ndy < 0, 1, 0) <> IIF(dx < 0, 1, 0), 1, 0);
  RETURN IIF(fx_mul(dy, BIN_SHR(ndx, 16)) < fx_mul(BIN_SHR(ndy, 16), dx), 0, 1);
END^

-- R_PointInSubsector in 16.16: the sector of the subsector a point is in
CREATE OR ALTER FUNCTION sector_at_fx (x BIGINT, y BIGINT) RETURNS INTEGER
AS
DECLARE n INTEGER;
DECLARE nx BIGINT;
DECLARE ny BIGINT;
DECLARE ndx BIGINT;
DECLARE ndy BIGINT;
DECLARE rc INTEGER;
DECLARE lc INTEGER;
DECLARE s INTEGER;
BEGIN
  SELECT COALESCE(root_node, 32768) FROM game WHERE id = 1 INTO n;
  WHILE (n < 32768) DO
  BEGIN
    SELECT fx, fy, fdx, fdy, right_child, left_child
      FROM nodes WHERE id = :n
      INTO nx, ny, ndx, ndy, rc, lc;
    IF (point_on_node_side(x, y, nx, ny, ndx, ndy) = 0) THEN n = rc; ELSE n = lc;
  END
  SELECT sector_id FROM ssectors WHERE id = :n - 32768 INTO s;
  RETURN s;
END^

-- P_InterceptVector: how far along the trace (TX, TY, TDX, TDY) it crosses the line, as a
-- fraction in 16.16 (0 if they're parallel)
CREATE OR ALTER FUNCTION intercept_vector (
  tx BIGINT, ty BIGINT, tdx BIGINT, tdy BIGINT, lx BIGINT, ly BIGINT, ldx BIGINT, ldy BIGINT) RETURNS BIGINT
AS
DECLARE den BIGINT;
DECLARE num BIGINT;
BEGIN
  den = fx32(fx_mul(BIN_SHR(ldy, 8), tdx) - fx_mul(BIN_SHR(ldx, 8), tdy));
  IF (den = 0) THEN RETURN 0;
  num = fx32(fx_mul(BIN_SHR(fx32(lx - tx), 8), ldy) + fx_mul(BIN_SHR(fx32(ty - ly), 8), ldx));
  RETURN fx_div(num, den);
END^

-- P_BoxOnLineSide: which side of the line a box (top, bottom, left, right) is on, or -1 if it
-- straddles it (SLOPE: the line's slopetype)
CREATE OR ALTER FUNCTION box_on_line_side (
  top BIGINT, bottom BIGINT, lft BIGINT, rgt BIGINT,
  lx BIGINT, ly BIGINT, ldx BIGINT, ldy BIGINT, slope SMALLINT) RETURNS SMALLINT
AS
DECLARE p1 SMALLINT;
DECLARE p2 SMALLINT;
BEGIN
  IF (slope = 0) THEN
  BEGIN
    p1 = IIF(top > ly, 1, 0);
    p2 = IIF(bottom > ly, 1, 0);
    IF (ldx < 0) THEN BEGIN p1 = 1 - p1; p2 = 1 - p2; END
  END
  ELSE IF (slope = 1) THEN
  BEGIN
    p1 = IIF(rgt < lx, 1, 0);
    p2 = IIF(lft < lx, 1, 0);
    IF (ldy < 0) THEN BEGIN p1 = 1 - p1; p2 = 1 - p2; END
  END
  ELSE IF (slope = 2) THEN
  BEGIN
    p1 = point_on_line_side(lft, top, lx, ly, ldx, ldy);
    p2 = point_on_line_side(rgt, bottom, lx, ly, ldx, ldy);
  END
  ELSE
  BEGIN
    p1 = point_on_line_side(rgt, top, lx, ly, ldx, ldy);
    p2 = point_on_line_side(lft, bottom, lx, ly, ldx, ldy);
  END
  RETURN IIF(p1 = p2, p1, -1);
END^

-- SlopeDiv: tantoangle's index for NUM / DEN (unsigned, as DOOM's: NUM << 3 wraps at 32 bits)
CREATE OR ALTER FUNCTION slope_div (num BIGINT, den BIGINT) RETURNS INTEGER
AS
DECLARE ans BIGINT;
BEGIN
  IF (den < 512) THEN RETURN 2048;
  ans = BIN_AND(num * 8, 4294967295) / BIN_SHR(den, 8);
  RETURN IIF(ans <= 2048, ans, 2048);
END^

-- R_PointToAngle2: the BAM angle from one point to another, by octant and tantoangle
CREATE OR ALTER FUNCTION point_to_angle2 (x1 BIGINT, y1 BIGINT, x2 BIGINT, y2 BIGINT) RETURNS BIGINT
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE oct SMALLINT;
DECLARE si INTEGER;
DECLARE t BIGINT;
DECLARE a BIGINT;
BEGIN
  x = fx32(x2 - x1);
  y = fx32(y2 - y1);
  IF (x = 0 AND y = 0) THEN RETURN 0;
  -- the octant (r_main.c's numbering), and |x|, |y|
  IF (x >= 0 AND y >= 0) THEN oct = IIF(x > y, 0, 1);
  ELSE IF (x >= 0) THEN BEGIN y = -y; oct = IIF(x > y, 8, 7); END
  ELSE IF (y >= 0) THEN BEGIN x = -x; oct = IIF(x > y, 3, 2); END
  ELSE BEGIN x = -x; y = -y; oct = IIF(x > y, 4, 5); END
  si = IIF(x > y, slope_div(y, x), slope_div(x, y));
  t = (SELECT ta.v FROM tantoangle ta WHERE ta.i = :si);
  a = CASE oct WHEN 0 THEN t
               WHEN 1 THEN 1073741824 - 1 - t     -- ANG90 - 1 - …
               WHEN 8 THEN -t
               WHEN 7 THEN 3221225472 + t         -- ANG270 + …
               WHEN 3 THEN 2147483648 - 1 - t     -- ANG180 - 1 - …
               WHEN 2 THEN 1073741824 + t
               WHEN 4 THEN 2147483648 + t
               ELSE 3221225472 - 1 - t END;
  RETURN BIN_AND(a, 4294967295);
END^

CREATE OR ALTER FUNCTION neighbor_h (sec INTEGER, what VARCHAR(12))
RETURNS DOUBLE PRECISION
AS
DECLARE r DOUBLE PRECISION;
BEGIN
  SELECT CASE :what
           WHEN 'min_ceil'  THEN MIN(s.ceil_h)
           WHEN 'min_floor' THEN MIN(s.floor_h)
           WHEN 'max_floor' THEN MAX(s.floor_h)
           WHEN 'max_ceil'  THEN MAX(s.ceil_h)
           WHEN 'max_light' THEN MAX(s.light)
           WHEN 'min_light' THEN MIN(s.light)
         END
    FROM linedefs l
    JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
   WHERE (l.front_sector = :sec OR l.back_sector = :sec)
     AND l.back_sector IS NOT NULL AND s.id <> :sec
    INTO r;
  RETURN r;
END^

-- p_lights.c's spawners, for sector special SPECIAL (or a line's EV_StartLightStrobing: 3):
-- P_SpawnLightFlash (1: between its light and the darkest of it and its neighbours,
-- P_FindMinSurroundingLight; the first change in (P_Random() & 64) + 1 tics), P_SpawnStrobeFlash
-- (2, 4, 13: FASTDARK 15 dark tics; 3, 12: SLOWDARK 35; 5 bright; black if no neighbour is
-- darker; in sync, 12 and 13, from the next tic, else in (P_Random() & 7) + 1), P_SpawnGlowingLight
-- (8: down and up 8 a tic between the darkest neighbour and its own) and P_SpawnFireFlicker (17:
-- 16 above the darkest neighbour, every 4 tics). Each zeroes the sector's special (but 4's, which
-- also hurts). The thinker lives in the sector's LFX columns.
CREATE OR ALTER PROCEDURE spawn_light (sec INTEGER, special INTEGER)
AS
DECLARE lt INTEGER;
DECLARE mn INTEGER;
BEGIN
  SELECT s.light FROM sectors s WHERE s.id = :sec INTO lt;
  mn = MINVALUE(lt, COALESCE(neighbor_h(sec, 'min_light'), lt));
  IF (special = 1) THEN
    UPDATE sectors s SET lfx = 'flash', lfx_max = :lt, lfx_min = :mn, lfx_count = p_rand_and(64) + 1, special = 0,
           lfx_key = 2 * NEXT VALUE FOR thing_seq
     WHERE s.id = :sec;
  ELSE IF (special IN (2, 3, 4, 12, 13)) THEN
    UPDATE sectors s
       SET lfx = 'strobe', lfx_max = :lt, lfx_min = IIF(:mn = :lt, 0, :mn), lfx_dark = IIF(:special IN (3, 12), 35, 15),
           lfx_count = IIF(:special IN (12, 13), 1, p_rand_and(7) + 1), special = IIF(:special = 4, 4, 0),
           lfx_key = 2 * NEXT VALUE FOR thing_seq
     WHERE s.id = :sec;
  ELSE IF (special = 8) THEN
    UPDATE sectors s SET lfx = 'glow', lfx_max = :lt, lfx_min = :mn, lfx_dir = -1, special = 0,
           lfx_key = 2 * NEXT VALUE FOR thing_seq WHERE s.id = :sec;
  ELSE IF (special = 17) THEN
    UPDATE sectors s SET lfx = 'flicker', lfx_max = :lt, lfx_min = :mn + 16, lfx_count = 4, special = 0,
           lfx_key = 2 * NEXT VALUE FOR thing_seq WHERE s.id = :sec;
END^

-- BLOCKMAP lookup: every linedef in the cells overlapping a box.
-- (This runs for every move a thing tries, so it's built for speed: the cell
-- bounds as integers – a FLOOR() of a double against the INTEGER columns keeps
-- the index out – and a thing-sized box, at most 2×2 cells, as exact lookups
-- of each cell's key. Bigger boxes, a shot's say, scan the cell range.)
CREATE OR ALTER PROCEDURE lines_in_box (
  ax DOUBLE PRECISION, ay DOUBLE PRECISION, bx DOUBLE PRECISION, bdy DOUBLE PRECISION)
RETURNS (line_id INTEGER)
AS
DECLARE x0 INTEGER;
DECLARE x1 INTEGER;
DECLARE y0 INTEGER;
DECLARE y1 INTEGER;
BEGIN
  x0 = FLOOR(ax / 128);
  x1 = FLOOR(bx / 128);
  y0 = FLOOR(ay / 128);
  y1 = FLOOR(bdy / 128);
  IF (x1 - x0 <= 1 AND y1 - y0 <= 1) THEN
    FOR SELECT DISTINCT lb.line_id
          FROM line_blocks lb
         WHERE lb.cell IN (:y0 * 4096 + :x0, :y0 * 4096 + :x1, :y1 * 4096 + :x0, :y1 * 4096 + :x1)
          INTO line_id
    DO SUSPEND;
  ELSE
    FOR SELECT DISTINCT lb.line_id
          FROM line_blocks lb
         WHERE lb.bx BETWEEN :x0 AND :x1 AND lb.by_ BETWEEN :y0 AND :y1
          INTO line_id
    DO SUSPEND;
END^

-- ── collision ─────────────────────────────────────────────────────────────
-- P_CheckPosition: can a thing of this radius/height stand at (px, py)?
-- Returns the floor and ceiling it would see, from every line it touches.
-- A thing's floorz and ceilingz: the highest floor and lowest ceiling of
-- every sector it overlaps, so one standing half over a step stays on it.
CREATE OR ALTER PROCEDURE z_range (px DOUBLE PRECISION, py DOUBLE PRECISION, rad DOUBLE PRECISION)
RETURNS (floor_z DOUBLE PRECISION, ceil_z DOUBLE PRECISION)
AS
BEGIN
  SELECT se.floor_h, se.ceil_h FROM sectors se WHERE se.id = sector_at(:px, :py) INTO floor_z, ceil_z;
  SELECT MAXVALUE(:floor_z, COALESCE(MAX(MAXVALUE(f.floor_h, b.floor_h)), :floor_z)),
         MINVALUE(:ceil_z, COALESCE(MIN(MINVALUE(f.ceil_h, b.ceil_h)), :ceil_z))
    FROM (SELECT l.*,
                 MINVALUE(1e0, MAXVALUE(0e0, ((:px - l.x1) * l.dx + (:py - l.y1) * l.dy) / NULLIF(l.len2, 0))) t
            FROM lines_in_box(:px - :rad, :py - :rad, :px + :rad, :py + :rad) lb
            LEFT JOIN linedefs l ON l.id = lb.line_id
           WHERE l.back_sector IS NOT NULL
             AND l.minx <= :px + :rad AND l.maxx >= :px - :rad
             AND l.miny <= :py + :rad AND l.maxy >= :py - :rad) q
    JOIN sectors f ON f.id = q.front_sector
    JOIN sectors b ON b.id = q.back_sector
   WHERE (q.x1 + q.t * q.dx - :px) * (q.x1 + q.t * q.dx - :px)
       + (q.y1 + q.t * q.dy - :py) * (q.y1 + q.t * q.dy - :py) < :rad * :rad
    INTO floor_z, ceil_z;
  SUSPEND;
END^

CREATE OR ALTER PROCEDURE check_position (
  self_id INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION,
  rad DOUBLE PRECISION, hgt DOUBLE PRECISION, is_monster SMALLINT)
RETURNS (ok SMALLINT, floor_z DOUBLE PRECISION, ceil_z DOUBLE PRECISION,
         drop_z DOUBLE PRECISION, sec INTEGER)
AS
DECLARE bsec INTEGER;
DECLARE fl INTEGER;
DECLARE ff DOUBLE PRECISION;
DECLARE fc DOUBLE PRECISION;
DECLARE bf DOUBLE PRECISION;
DECLARE bc DOUBLE PRECISION;
BEGIN
  ok = 1;
  sec = sector_at(px, py);
  SELECT floor_h, ceil_h FROM sectors WHERE id = :sec INTO floor_z, ceil_z;
  drop_z = floor_z;
  FOR SELECT q.back_sector, q.flags, f.floor_h, f.ceil_h, b.floor_h, b.ceil_h
        FROM (SELECT l.*,
                     MINVALUE(1e0, MAXVALUE(0e0, ((:px - l.x1) * l.dx + (:py - l.y1) * l.dy) / NULLIF(l.len2, 0))) t
                FROM lines_in_box(:px - :rad, :py - :rad, :px + :rad, :py + :rad) lb
                LEFT JOIN linedefs l ON l.id = lb.line_id
               WHERE l.minx <= :px + :rad AND l.maxx >= :px - :rad
                 AND l.miny <= :py + :rad AND l.maxy >= :py - :rad) q
        JOIN sectors f ON f.id = q.front_sector
        LEFT JOIN sectors b ON b.id = q.back_sector
       WHERE (q.x1 + q.t * q.dx - :px) * (q.x1 + q.t * q.dx - :px)
           + (q.y1 + q.t * q.dy - :py) * (q.y1 + q.t * q.dy - :py) < :rad * :rad
        INTO bsec, fl, ff, fc, bf, bc
  DO
  BEGIN
    IF (bsec IS NULL OR BIN_AND(fl, 1) = 1 OR (is_monster = 1 AND BIN_AND(fl, 2) = 2)) THEN
    BEGIN
      ok = 0;
      EXIT;
    END
    floor_z = MAXVALUE(floor_z, ff, bf);
    ceil_z  = MINVALUE(ceil_z, fc, bc);
    drop_z  = MINVALUE(drop_z, ff, bf);
  END
  IF (ceil_z - floor_z < hgt) THEN
  BEGIN
    ok = 0;
    EXIT;
  END
  -- P_TryMove's floatok: it would fit, but not at this height. A floating
  -- monster (IS_MONSTER 2) hears so as OK = 2, if no thing is in the way
  IF (ceil_z - pz < hgt OR floor_z - pz > 24) THEN
  BEGIN
    ok = IIF(is_monster = 2, 2, 0);
    IF (ok = 0) THEN EXIT;
  END
  -- (MF_FLOAT: fliers don't mind a drop-off)
  IF (is_monster = 1 AND floor_z - drop_z > 24) THEN
  BEGIN
    ok = 0;
    EXIT;
  END
  IF (EXISTS (SELECT 1 FROM things t
               WHERE t.x BETWEEN :px - :rad - 32 AND :px + :rad + 32   -- 32 = largest radius
                 AND t.solid = 1 AND t.id <> :self_id
                 AND ABS(t.x - :px) < t.radius + :rad
                 AND ABS(t.y - :py) < t.radius + :rad)) THEN
    ok = 0;
END^

-- P_CheckSight's first test: the map's REJECT table says nothing in sector S2
-- can be seen from sector S1 (so no sight line need be walked).
CREATE OR ALTER FUNCTION rejected (s1 INTEGER, s2 INTEGER)
RETURNS SMALLINT
AS
DECLARE hex VARCHAR(8000);
DECLARE nib INTEGER;
BEGIN
  IF (s1 IS NULL OR s2 IS NULL) THEN RETURN 0;
  SELECT r.bits FROM reject r WHERE r.sector_id = :s1 INTO hex;
  IF (hex IS NULL OR s2 / 4 >= CHAR_LENGTH(hex)) THEN RETURN 0;
  nib = POSITION(SUBSTRING(hex FROM s2 / 4 + 1 FOR 1) IN '0123456789abcdef') - 1;
  RETURN IIF(BIN_AND(nib, BIN_SHL(1, MOD(s2, 4))) <> 0, 1, 0);
END^

-- ── P_CheckSight (p_sight.c) in 16.16 ─────────────────────────────────────
-- P_DivlineSide: 0 in front of the line from (LX, LY) along (LDX, LDY), 1 behind, 2 on it, in
-- whole units – with DOOM's slip in the horizontal case, which tests x against the line's y
CREATE OR ALTER FUNCTION divline_side (x BIGINT, y BIGINT, lx BIGINT, ly BIGINT, ldx BIGINT, ldy BIGINT)
RETURNS SMALLINT
AS
DECLARE l BIGINT;
DECLARE r BIGINT;
BEGIN
  IF (ldx = 0) THEN
  BEGIN
    IF (x = lx) THEN RETURN 2;
    RETURN IIF(x <= lx, IIF(ldy > 0, 1, 0), IIF(ldy < 0, 1, 0));
  END
  IF (ldy = 0) THEN
  BEGIN
    IF (x = ly) THEN RETURN 2;
    RETURN IIF(y <= ly, IIF(ldx < 0, 1, 0), IIF(ldx > 0, 1, 0));
  END
  -- (the 32-bit wraps written out: this runs for every node and seg a sight line meets)
  l = BIN_AND(BIN_SHR(ldy, 16) * BIN_SHR(BIN_AND(x - lx + 2147483648, 4294967295) - 2147483648, 16) + 2147483648, 4294967295) - 2147483648;
  r = BIN_AND(BIN_SHR(BIN_AND(y - ly + 2147483648, 4294967295) - 2147483648, 16) * BIN_SHR(ldx, 16) + 2147483648, 4294967295) - 2147483648;
  IF (r < l) THEN RETURN 0;
  IF (l = r) THEN RETURN 2;
  RETURN 1;
END^

-- P_CrossSubsector: the sight line (from (SX, SY) along (SDX, SDY) to (TX, TY)) through
-- subsector NUM's segs' lines: a one-sided line it crosses blocks it, a two-sided one narrows
-- the slopes from the eyes (ZSTART) to the target's top and bottom by its opening
-- (P_InterceptVector2's fraction along the line of sight); closed, or the slopes crossed, and
-- it's blocked. → OK 0 blocked, and the slopes as they are now.
CREATE OR ALTER PROCEDURE cross_subsector (
  num INTEGER, sx BIGINT, sy BIGINT, sdx BIGINT, sdy BIGINT, tx BIGINT, ty BIGINT, zstart BIGINT,
  top_in BIGINT, bottom_in BIGINT)
RETURNS (ok SMALLINT, top BIGINT, bottom BIGINT)
AS
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lback INTEGER;
DECLARE lflags INTEGER;
DECLARE ff BIGINT;
DECLARE fc BIGINT;
DECLARE bf BIGINT;
DECLARE bc BIGINT;
DECLARE opentop BIGINT;
DECLARE openbottom BIGINT;
DECLARE frac BIGINT;
DECLARE slope BIGINT;
BEGIN
  ok = 1;
  top = top_in;
  bottom = bottom_in;
  FOR SELECT l.fx, l.fy, l.fdx, l.fdy, l.back_sector, l.flags,
             fx_of(fs.floor_h), fx_of(fs.ceil_h), fx_of(bs.floor_h), fx_of(bs.ceil_h)
        FROM ssectors ss
        JOIN segs sg ON sg.id >= ss.first_seg AND sg.id < ss.first_seg + ss.seg_count
        JOIN linedefs l ON l.id = sg.linedef
        LEFT JOIN sectors fs ON fs.id = sg.front_sector
        LEFT JOIN sectors bs ON bs.id = sg.back_sector
       WHERE ss.id = :num
         -- (a line whose box the sight line's box doesn't reach can't be crossed: skipped at once)
         -- (2 units wider: DOOM's side test is in whole units)
         AND l.maxx * 65536 + 131072 >= MINVALUE(:sx, :tx) AND l.minx * 65536 - 131072 <= MAXVALUE(:sx, :tx)
         AND l.maxy * 65536 + 131072 >= MINVALUE(:sy, :ty) AND l.miny * 65536 - 131072 <= MAXVALUE(:sy, :ty)
       ORDER BY sg.id
        INTO lx, ly, ldx, ldy, lback, lflags, ff, fc, bf, bc
  DO
  BEGIN
    -- (DOOM marks each line checked: checked again it gives the same answer, so here it's not)
    IF (divline_side(lx, ly, sx, sy, sdx, sdy) = divline_side(fx32(lx + ldx), fx32(ly + ldy), sx, sy, sdx, sdy)) THEN CONTINUE;
    IF (divline_side(sx, sy, lx, ly, ldx, ldy) = divline_side(tx, ty, lx, ly, ldx, ldy)) THEN CONTINUE;
    IF (lback IS NULL OR BIN_AND(lflags, 4) = 0) THEN
    BEGIN
      ok = 0;
      EXIT;
    END
    IF (ff = bf AND fc = bc) THEN CONTINUE;
    opentop = MINVALUE(fc, bc);
    openbottom = MAXVALUE(ff, bf);
    IF (openbottom >= opentop) THEN
    BEGIN
      ok = 0;
      EXIT;
    END
    frac = intercept_vector(sx, sy, sdx, sdy, lx, ly, ldx, ldy);
    IF (ff <> bf) THEN
    BEGIN
      slope = fx_div(fx32(openbottom - zstart), frac);
      IF (slope > bottom) THEN bottom = slope;
    END
    IF (fc <> bc) THEN
    BEGIN
      slope = fx_div(fx32(opentop - zstart), frac);
      IF (slope < top) THEN top = slope;
    END
    IF (top <= bottom) THEN
    BEGIN
      ok = 0;
      EXIT;
    END
  END
END^

-- P_CrossBSPNode: the sight line through the BSP from node BSPNUM: the start's side first
-- (on the line: the front), then, if the line reaches it, the other
CREATE OR ALTER PROCEDURE cross_bsp (
  bspnum INTEGER, sx BIGINT, sy BIGINT, sdx BIGINT, sdy BIGINT, tx BIGINT, ty BIGINT, zstart BIGINT,
  top_in BIGINT, bottom_in BIGINT)
RETURNS (ok SMALLINT, top BIGINT, bottom BIGINT)
AS
BEGIN
  ok = 1;
  top = top_in;
  bottom = bottom_in;
END^

CREATE OR ALTER PROCEDURE cross_bsp (
  bspnum INTEGER, sx BIGINT, sy BIGINT, sdx BIGINT, sdy BIGINT, tx BIGINT, ty BIGINT, zstart BIGINT,
  top_in BIGINT, bottom_in BIGINT)
RETURNS (ok SMALLINT, top BIGINT, bottom BIGINT)
AS
DECLARE nx BIGINT;
DECLARE ny BIGINT;
DECLARE ndx BIGINT;
DECLARE ndy BIGINT;
DECLARE rc INTEGER;
DECLARE lc INTEGER;
DECLARE side SMALLINT;
BEGIN
  top = top_in;
  bottom = bottom_in;
  IF (bspnum >= 32768) THEN
  BEGIN
    EXECUTE PROCEDURE cross_subsector(IIF(bspnum = 65535, 0, bspnum - 32768), sx, sy, sdx, sdy, tx, ty, zstart, top, bottom)
      RETURNING_VALUES ok, top, bottom;
    EXIT;
  END
  SELECT n.fx, n.fy, n.fdx, n.fdy, n.right_child, n.left_child
    FROM nodes n WHERE n.id = :bspnum INTO nx, ny, ndx, ndy, rc, lc;
  side = divline_side(sx, sy, nx, ny, ndx, ndy);
  IF (side = 2) THEN side = 0;
  EXECUTE PROCEDURE cross_bsp(IIF(side = 0, rc, lc), sx, sy, sdx, sdy, tx, ty, zstart, top, bottom)
    RETURNING_VALUES ok, top, bottom;
  IF (ok = 0) THEN EXIT;
  IF (side = divline_side(tx, ty, nx, ny, ndx, ndy)) THEN EXIT;
  EXECUTE PROCEDURE cross_bsp(IIF(side = 0, lc, rc), sx, sy, sdx, sdy, tx, ty, zstart, top, bottom)
    RETURNING_VALUES ok, top, bottom;
END^

-- P_CheckSight: can T1 see T2? Not if REJECT says their sectors can't; else from T1's eyes
-- (a quarter of its height below its top) to any part of T2's body, through the BSP
CREATE OR ALTER FUNCTION sight_fx (t1 INTEGER, t2 INTEGER) RETURNS SMALLINT
AS
DECLARE x1 BIGINT;
DECLARE y1 BIGINT;
DECLARE z1 BIGINT;
DECLARE h1 BIGINT;
DECLARE s1 INTEGER;
DECLARE x2 BIGINT;
DECLARE y2 BIGINT;
DECLARE z2 BIGINT;
DECLARE h2 BIGINT;
DECLARE s2 INTEGER;
DECLARE zstart BIGINT;
DECLARE top BIGINT;
DECLARE bottom BIGINT;
DECLARE ok SMALLINT;
DECLARE root INTEGER;
BEGIN
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.height), t.sector_id FROM things t WHERE t.id = :t1 INTO x1, y1, z1, h1, s1;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.height), t.sector_id FROM things t WHERE t.id = :t2 INTO x2, y2, z2, h2, s2;
  IF (x1 IS NULL OR x2 IS NULL) THEN RETURN 0;
  IF (rejected(s1, s2) = 1) THEN RETURN 0;
  zstart = z1 + h1 - BIN_SHR(h1, 2);
  top = z2 + h2 - zstart;
  bottom = z2 - zstart;
  SELECT g.root_node FROM game g WHERE g.id = 1 INTO root;
  EXECUTE PROCEDURE cross_bsp(root, x1, y1, fx32(x2 - x1), fx32(y2 - y1), x2, y2, zstart, top, bottom)
    RETURNING_VALUES ok, top, bottom;
  RETURN ok;
END^

-- P_CheckSight: is there an unobstructed line from A to B at these heights?
-- Walks the BLOCKMAP cells the sight line crosses (Amanatides–Woo) and stops
-- at the first cell holding a blocking line.
CREATE OR ALTER FUNCTION check_sight (
  ax DOUBLE PRECISION, ay DOUBLE PRECISION, az DOUBLE PRECISION,
  bx DOUBLE PRECISION, bdy DOUBLE PRECISION, bz DOUBLE PRECISION)
RETURNS SMALLINT
AS
DECLARE ddx DOUBLE PRECISION;
DECLARE ddy DOUBLE PRECISION;
DECLARE cx INTEGER;
DECLARE cy INTEGER;
DECLARE ex INTEGER;
DECLARE ey INTEGER;
DECLARE stepx INTEGER;
DECLARE stepy INTEGER;
DECLARE tmx DOUBLE PRECISION;
DECLARE tmy DOUBLE PRECISION;
DECLARE tdx DOUBLE PRECISION;
DECLARE tdy DOUBLE PRECISION;
DECLARE guard INTEGER = 0;
BEGIN
  ddx = bx - ax;
  ddy = bdy - ay;
  cx = FLOOR(ax / 128);
  cy = FLOOR(ay / 128);
  ex = FLOOR(bx / 128);
  ey = FLOOR(bdy / 128);
  stepx = SIGN(ddx);
  stepy = SIGN(ddy);
  tdx = 1e9;
  tmx = 1e9;
  tdy = 1e9;
  tmy = 1e9;
  IF (ddx <> 0) THEN
  BEGIN
    tdx = 128 / ABS(ddx);
    tmx = (IIF(ddx > 0, (cx + 1) * 128e0, cx * 128e0) - ax) / ddx;
  END
  IF (ddy <> 0) THEN
  BEGIN
    tdy = 128 / ABS(ddy);
    tmy = (IIF(ddy > 0, (cy + 1) * 128e0, cy * 128e0) - ay) / ddy;
  END
  WHILE (guard < 1024) DO
  BEGIN
    IF (EXISTS (
          SELECT 1
            FROM (SELECT l.back_sector, l.front_sector,
                         ((l.x1 - :ax) * l.dy - (l.y1 - :ay) * l.dx) / (:ddx * l.dy - :ddy * l.dx) s,
                         ((l.x1 - :ax) * :ddy - (l.y1 - :ay) * :ddx) / (:ddx * l.dy - :ddy * l.dx) u
                    FROM line_blocks lb
                    LEFT JOIN linedefs l ON l.id = lb.line_id
                   WHERE lb.cell = :cy * 4096 + :cx AND :ddx * l.dy - :ddy * l.dx <> 0) i
            LEFT JOIN sectors f ON f.id = i.front_sector
            LEFT JOIN sectors b ON b.id = i.back_sector
           WHERE i.s > 0 AND i.s < 1 AND i.u >= 0 AND i.u <= 1
             AND (i.back_sector IS NULL
                  OR MINVALUE(f.ceil_h, b.ceil_h) <= MAXVALUE(f.floor_h, b.floor_h)
                  OR MAXVALUE(f.floor_h, b.floor_h) > :az + (:bz - :az) * i.s
                  OR MINVALUE(f.ceil_h, b.ceil_h) < :az + (:bz - :az) * i.s))) THEN
      RETURN 0;
    IF (cx = ex AND cy = ey) THEN LEAVE;
    IF (tmx < tmy) THEN
    BEGIN
      tmx = tmx + tdx;
      cx = cx + stepx;
    END
    ELSE
    BEGIN
      tmy = tmy + tdy;
      cy = cy + stepy;
    END
    guard = guard + 1;
  END
  RETURN 1;
END^

-- ── sound ─────────────────────────────────────────────────────────────────
-- S_StartSound: queue a sound for the browser. ORIGIN lets a new sound from
-- the same source cut off its previous one, as DOOM's channels do.
CREATE OR ALTER PROCEDURE play_sound (snd VARCHAR(8), origin INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION,
  only_for SMALLINT = NULL)
AS
BEGIN
  IF (snd IS NULL) THEN EXIT;
  INSERT INTO sound_events (id, tic, sound, origin, x, y, listener)
  SELECT NEXT VALUE FOR sound_seq, g.tic, :snd, :origin, :px, :py, :only_for FROM game g WHERE g.id = 1;
END^

-- A sound from a sector (doors, lifts): played from the middle of its lines.
CREATE OR ALTER PROCEDURE sector_sound (snd VARCHAR(8), sec INTEGER)
AS
DECLARE cx DOUBLE PRECISION;
DECLARE cy DOUBLE PRECISION;
BEGIN
  SELECT AVG((l.x1 + l.x2) / 2), AVG((l.y1 + l.y2) / 2) FROM linedefs l
   WHERE l.front_sector = :sec OR l.back_sector = :sec
    INTO cx, cy;
  EXECUTE PROCEDURE play_sound(snd, -sec - 1, cx, cy);
END^

-- ── spawning and damage ───────────────────────────────────────────────────
-- P_RunThinkers' place in the list (THINK_KEY, a transaction's context variable): -1 while the
-- players think (P_PlayerThink, before the list), a thinker's own key while it runs (a thing's,
-- less one while it moves: its countdown comes after), none outside a tic. A thing whose turn
-- is still to come this tic (its key past it) counts its state's tics down this tic too, so a
-- state set on it – or a thing spawned – ends a tic sooner (THINK_AHEAD 1).
CREATE OR ALTER FUNCTION think_ahead (k BIGINT) RETURNS SMALLINT
AS
DECLARE v VARCHAR(255);
BEGIN
  v = RDB$GET_CONTEXT('USER_TRANSACTION', 'THINK_KEY');
  IF (v IS NULL) THEN RETURN 0;
  RETURN IIF(k > CAST(v AS BIGINT), 1, 0);
END^


-- (SET_STATE, P_SetMobjState, declared here for DAMAGE_THING and the others that call
-- it; its body comes with the frame tables' machine, before WORLD_TIC)
CREATE OR ALTER PROCEDURE set_state (tid INTEGER, st INTEGER, tic INTEGER)
RETURNS (alive SMALLINT)
AS
BEGIN
  alive = 1;
END^

-- (SET_PSPRITE, P_SetPsprite, declared here for DAMAGE_PLAYER's P_DropWeapon; its body comes
-- with the weapons, before PLAYER_THINK)
CREATE OR ALTER PROCEDURE set_psprite (pid SMALLINT, pos SMALLINT, st INTEGER, tic INTEGER)
AS
BEGIN
END^

-- (HEIGHT_CLIP_FX, P_ThingHeightClip for a player, declared here for MOVERS_THINK; its body
-- comes with the player's movement, before PLAYER_THINK)
CREATE OR ALTER PROCEDURE height_clip_fx (tid INTEGER, force SMALLINT = 0)
AS
BEGIN
END^

CREATE OR ALTER PROCEDURE spawn_thing (
  ttype INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION, ang DOUBLE PRECISION)
RETURNS (new_id INTEGER)
AS
DECLARE sec INTEGER;
DECLARE lastlook INTEGER;
BEGIN
  -- P_SpawnMobj: mobj->lastlook = P_Random () % MAXPLAYERS (P_LookForPlayers' first player to try)
  lastlook = MOD(p_rand256(), 4);
  new_id = NEXT VALUE FOR thing_seq;
  sec = sector_at_fx(fx_of(px), fx_of(py));
  -- (its floorz and ceilingz, its subsector's)
  INSERT INTO things (id, thing_type, kind, x, y, z, angle, hp, radius, height, solid, sector_id,
                      st, state, state_tic, reaction, lastlook, floorz, ceilz, fz_x, fz_y)
  SELECT :new_id, tt.thing_type, tt.kind, :px, :py,
         COALESCE(:pz, (SELECT floor_h FROM sectors WHERE id = :sec)), :ang,
         tt.hp, tt.radius, tt.height, tt.solid, :sec,
         -- (ST: a missile flies; anything else starts 'idle' – a dead-body decoration's spawn
         -- state is a corpse's last frame, but it's scenery, not a corpse)
         IIF(tt.kind = 'missile', 'fly', 'idle'),
         -- on the frame tables: its spawn state, as P_SpawnMobj sets it (no action), and
         -- its reaction time (mobjinfo's: 8, the player's 0; none on Nightmare)
         IIF(tt.on_states = 1, tt.spawn_state, NULL),
         -- (spawned during a tic, it's at the end of the list: it counts down this tic, THINK_AHEAD)
         IIF(tt.on_states = 1, (SELECT IIF(s.tics < 0, NULL, g.tic + s.tics - think_ahead(2 * :new_id)) FROM states s CROSS JOIN game g
                                 WHERE s.id = tt.spawn_state AND g.id = 1), NULL),
         IIF(tt.on_states = 1, (SELECT IIF(g.skill = 5, 0, tt.reaction_time) FROM game g WHERE g.id = 1), 0), :lastlook,
         (SELECT floor_h FROM sectors WHERE id = :sec), (SELECT ceil_h FROM sectors WHERE id = :sec), :px, :py
    FROM thing_types tt WHERE tt.thing_type = :ttype;
END^

-- P_DamageMobj's thrust, in 16.16: TID is pushed away from INFLICTOR (what hit it: the shooter,
-- the missile, the barrel) by DMG × (FRACUNIT >> 3) × 100 / its mass, in C's 32-bit int sums
-- (a telefrag's 10000 wraps). None with no inflictor (a crusher, a floor), for a player with
-- no clipping, or from a player holding the chainsaw. HP is its health before the hit: a blow
-- under 40 that kills it, from more than 64 below it, throws it forwards half the time
-- (P_Random() & 1), four times as hard.
CREATE OR ALTER PROCEDURE damage_thrust (tid INTEGER, inflictor INTEGER, src INTEGER, dmg INTEGER, hp INTEGER)
AS
DECLARE ix BIGINT;
DECLARE iy BIGINT;
DECLARE iz BIGINT;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE tz BIGINT;
DECLARE mass INTEGER;
DECLARE noclip SMALLINT;
DECLARE ang BIGINT;
DECLARE thrust BIGINT;
DECLARE fa INTEGER;
DECLARE still SMALLINT;
DECLARE k BIGINT;
BEGIN
  IF (inflictor IS NULL) THEN EXIT;
  ix = NULL;
  SELECT fx_of(i.x), fx_of(i.y), fx_of(i.z) FROM things i WHERE i.id = :inflictor INTO ix, iy, iz;
  IF (ix IS NULL) THEN EXIT;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), tt.mass, COALESCE((SELECT p.noclip FROM player p WHERE p.thing_id = t.id), 0),
         IIF(t.momx = 0 AND t.momy = 0 AND BIN_AND(t.flags, 262144) = 0 AND t.kind NOT IN ('player', 'missile', 'cube'), 1, 0),
         COALESCE(t.think_key, 2 * t.id)
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO tx, ty, tz, mass, noclip, still, k;
  IF (noclip = 1 OR COALESCE(mass, 0) = 0) THEN EXIT;
  IF (EXISTS (SELECT 1 FROM player p WHERE p.thing_id = :src AND p.weapon = 8)) THEN EXIT;   -- (wp_chainsaw)
  ang = point_to_angle2(ix, iy, tx, ty);
  thrust = fx32(fx32(dmg * 8192) * 100) / mass;
  IF (dmg < 40 AND dmg > hp) THEN
    IF (tz - iz > 4194304) THEN
      IF (p_rand_and(1) = 1) THEN
      BEGIN
        ang = BIN_AND(ang + 2147483648, 4294967295);                                   -- (ANG180)
        thrust = fx32(thrust * 4);
      END
  fa = BIN_SHR(ang, 19);
  UPDATE things t SET momx = (fx_of(t.momx) + fx_mul(:thrust, fine_cosine(:fa))) / 65536e0,
                      momy = (fx_of(t.momy) + fx_mul(:thrust, fine_sine(:fa))) / 65536e0
   WHERE t.id = :tid;
  -- (set moving by a thinker before its turn: it moves in its turn, this tic)
  IF (still = 1 AND think_ahead(k) = 1 AND EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND (t.momx <> 0 OR t.momy <> 0))) THEN
  BEGIN
    INSERT INTO late_movers (k, id) VALUES (:k, :tid);
    RDB$SET_CONTEXT('USER_TRANSACTION', 'LATE', '1');
  END
END^

-- P_DamageMobj for a player: DMG from SRC (who did it; NULL: the world – crushers, slime),
-- by INFLICTOR (what hit: the shooter, a missile; NULL: nothing to be thrown back from)
CREATE OR ALTER PROCEDURE damage_player (dmg INTEGER, src INTEGER = NULL, pid SMALLINT = 1, inflictor INTEGER = NULL)
AS
DECLARE god SMALLINT;
DECLARE hp INTEGER;
DECLARE tic INTEGER;
DECLARE alive SMALLINT;
DECLARE nst INTEGER;
DECLARE ptid INTEGER;
DECLARE invuln INTEGER;
DECLARE arm INTEGER;
DECLARE arm_type SMALLINT;
DECLARE saved INTEGER = 0;
DECLARE is_dead SMALLINT;
DECLARE sspec INTEGER;
DECLARE thr INTEGER;
DECLARE fkiller SMALLINT;
BEGIN
  SELECT p.armor, p.armor_type, p.dead, p.invuln_tics, p.god, p.thing_id, p.health,
         (SELECT s.special FROM sectors s WHERE s.id = t.sector_id), t.threshold
    FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = :pid
    INTO arm, arm_type, is_dead, invuln, god, ptid, hp, sspec, thr;
  IF (ptid IS NULL) THEN EXIT;
  IF (is_dead = 1 OR hp <= 0 OR COALESCE(dmg, 0) <= 0) THEN EXIT;
  -- on the easiest skill you take half (damage >>= 1)
  IF ((SELECT g.skill FROM game g WHERE g.id = 1) = 1) THEN dmg = BIN_SHR(dmg, 1);
  -- thrown back – god mode or not
  EXECUTE PROCEDURE damage_thrust(ptid, inflictor, src, dmg, hp);
  -- the end of game hell hack: on E1M8's exit floor (11) nothing kills you
  IF (sspec = 11 AND dmg >= hp) THEN dmg = hp - 1;
  -- invulnerable (pw_invulnerability) or in god mode (CF_GODMODE), nothing under 1000 gets
  -- through – a telefrag (10000) does
  IF ((invuln > 0 OR god = 1) AND dmg < 1000) THEN EXIT;
  -- green armour (type 1) takes a third, blue (type 2) half; when it's used up, the type goes too
  IF (arm_type > 0) THEN
  BEGIN
    saved = IIF(arm_type = 1, dmg / 3, dmg / 2);
    IF (arm <= saved) THEN
    BEGIN
      saved = arm;
      arm_type = 0;
    END
    dmg = dmg - saved;
  END
  -- (player->damagecount: the damage after armour, at most 100)
  UPDATE player
     SET armor = armor - :saved, armor_type = :arm_type, attacker_id = :src,   -- (player->attacker = source)
         health = MAXVALUE(health - :dmg, 0),
         damage_count = MINVALUE(damage_count + :dmg, 100)
   WHERE id = :pid;
  hp = hp - dmg;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  IF (hp <= 0) THEN
  BEGIN
    -- P_KillMobj: no longer solid (a player's corpse can be walked over), a quarter as tall
    -- (MF_CORPSE), sliding on as it was thrown; into the xdeathstate below -spawnhealth, else the
    -- deathstate, its first frame 0–3 tics shorter (at least 1). The body keeps the health it
    -- died with: A_PlayerScream screams louder below -50. (The cry comes with the second frame:
    -- A_PlayerScream, or A_XScream when gibbed.)
    -- source->player->frags[target->player]++ – a player's kill of a player, their own self
    -- included, and the world's kills count against the one killed (the status bar takes them off)
    fkiller = NULL;
    IF (src IS NULL) THEN fkiller = pid;
    ELSE SELECT p.id FROM player p WHERE p.thing_id = :src INTO fkiller;
    IF (fkiller IS NOT NULL) THEN UPDATE frags f SET f.n = f.n + 1 WHERE f.victim = :pid AND f.killer = :fkiller;
    UPDATE player SET dead = 1, health = 0, msg = 'You died. Press USE to ' || IIF((SELECT g.players FROM game g WHERE g.id = 1) > 1, 'respawn.', 'restart.'), msg_tics = 100000
     WHERE id = :pid;
    -- P_DropWeapon, the weapon goes down (A_Lower keeps it out of sight)
    EXECUTE PROCEDURE set_psprite(pid, 0, (SELECT wi.down_state FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon
                                            WHERE p.id = :pid), tic);
    SELECT IIF(:hp < -100, tt.xdeath_state, tt.death_state) FROM thing_types tt WHERE tt.thing_type = 1 INTO nst;
    UPDATE things t SET solid = 0, hp = :hp, height = t.height / 4 WHERE t.id = :ptid;
    EXECUTE PROCEDURE set_state(ptid, nst, tic) RETURNING_VALUES alive;
    UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1)
     WHERE t.id = :ptid AND t.state_tic IS NOT NULL;
    EXIT;
  END
  UPDATE things t SET hp = :hp WHERE t.id = :ptid;
  -- a player's painchance is 255 (P_Random() < 255: all but one roll in 256); A_Pain cries in
  -- S_PLAY_PAIN2
  IF (p_rand256() < 255) THEN
    EXECUTE PROCEDURE set_state(ptid, (SELECT tt.pain_state FROM thing_types tt WHERE tt.thing_type = 1), tic)
      RETURNING_VALUES alive;
  -- the pain ends a teleport's freeze (reactiontime = 0)
  UPDATE things t SET reaction = 0 WHERE t.id = :ptid;
  -- then, as for a monster: hurt by someone else (not an arch-vile) with no threshold – the
  -- first time only, for nothing counts a player's down – it's after them (BASETHRESHOLD), and
  -- standing in its spawn state, it goes to its see state, S_PLAY_RUN1
  IF (thr = 0 AND src IS NOT NULL AND src <> ptid
      AND NOT EXISTS (SELECT 1 FROM things v WHERE v.id = :src AND v.thing_type = 64)) THEN
  BEGIN
    UPDATE things t SET threshold = 100 WHERE t.id = :ptid;
    IF (EXISTS (SELECT 1 FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                 WHERE t.id = :ptid AND t.state = tt.spawn_state)) THEN
      EXECUTE PROCEDURE set_state(ptid, (SELECT tt.see_state FROM thing_types tt WHERE tt.thing_type = 1), tic)
        RETURNING_VALUES alive;
  END
END^

-- P_DamageMobj for anything else shootable. SRC is who did it (NULL: the world – crushers),
-- INFLICTOR what hit it (thrown back from it; NULL: not thrown).
CREATE OR ALTER PROCEDURE damage_thing (tid INTEGER, dmg INTEGER, src INTEGER = NULL, inflictor INTEGER = NULL)
AS
DECLARE k VARCHAR(10);
DECLARE hp INTEGER;
DECLARE st VARCHAR(8);
DECLARE pain_chance INTEGER;
DECLARE drop_type INTEGER;
DECLARE tx DOUBLE PRECISION;
DECLARE ty DOUBLE PRECISION;
DECLARE dummy INTEGER;
DECLARE thr INTEGER;
DECLARE skind VARCHAR(10);
DECLARE stype INTEGER;
DECLARE count_kill SMALLINT;
DECLARE ttype INTEGER;
DECLARE spawn_hp INTEGER;
DECLARE state INTEGER;
DECLARE spawn_state INTEGER;
DECLARE see_state INTEGER;
DECLARE pain_state INTEGER;
DECLARE death_state INTEGER;
DECLARE xdeath_state INTEGER;
DECLARE tic INTEGER;
DECLARE alive SMALLINT;
DECLARE spid SMALLINT;
DECLARE skullfly INTEGER;
DECLARE painroll INTEGER;
BEGIN
  SELECT t.kind, t.hp, t.st, tt.pain_chance, tt.drop_type, tt.count_kill, t.thing_type,
         tt.hp, t.state, tt.spawn_state, tt.see_state, tt.pain_state, tt.death_state, tt.xdeath_state,
         BIN_AND(t.flags, 262144), t.threshold
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :tid
    INTO k, hp, st, pain_chance, drop_type, count_kill, ttype,
         spawn_hp, state, spawn_state, see_state, pain_state, death_state, xdeath_state, skullfly, thr;
  -- (only what's shootable: a living monster, barrel, Keen or boss brain on the frame tables)
  IF (k IS NULL OR k NOT IN ('monster', 'barrel', 'keen', 'brain') OR st IN ('dying', 'dead') OR state IS NULL
      OR hp <= 0 OR COALESCE(dmg, 0) <= 0) THEN EXIT;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  -- MF_SKULLFLY (262144 in THINGS.FLAGS): a charging lost soul hit in flight stops dead
  -- (P_XYMovement then puts it back in its spawn state) – before the hit's thrust
  IF (skullfly <> 0) THEN UPDATE things t SET momx = 0, momy = 0, momz = 0 WHERE t.id = :tid;
  EXECUTE PROCEDURE damage_thrust(tid, inflictor, src, dmg, hp);
  hp = hp - dmg;
  IF (hp <= 0) THEN
  BEGIN
    -- P_KillMobj: no longer shootable (its state's mode, 'dying', says so) nor charging; solid
    -- until A_Fall; a quarter as tall (MF_CORPSE), and it slides on as it was thrown
    UPDATE things t SET hp = :hp, height = t.height / 4, flags = BIN_AND(t.flags, BIN_NOT(262144)) WHERE id = :tid;
    IF (count_kill = 1) THEN
      UPDATE player p SET kills = kills + 1
       WHERE p.id = COALESCE((SELECT pk.id FROM player pk WHERE pk.thing_id = :src),
                             IIF((SELECT g.players FROM game g WHERE g.id = 1) = 1, 1, 0));
    -- gibbed below minus its spawn health (if it has the frames), else its death; the
    -- first frame 0–3 tics shorter (at least 1). The cry is A_Scream's, in those frames.
    EXECUTE PROCEDURE set_state(tid, IIF(hp < -spawn_hp AND xdeath_state > 0, xdeath_state, death_state), tic)
      RETURNING_VALUES alive;
    UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1)
     WHERE t.id = :tid AND t.state_tic IS NOT NULL;
    -- what it drops (a clip, a shotgun, a chaingun), on the floor where it died (MF_DROPPED)
    IF (drop_type IS NOT NULL) THEN
    BEGIN
      SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO tx, ty;
      EXECUTE PROCEDURE spawn_thing(drop_type, tx, ty, NULL, 0) RETURNING_VALUES dummy;
      UPDATE things t SET flags = BIN_OR(t.flags, 65536) WHERE t.id = :dummy;
    END
    EXIT;
  END
  UPDATE things t SET hp = :hp WHERE t.id = :tid;
  -- the pain chance: into its pain state, and it'll fight back (MF_JUSTHIT)
  -- (P_Random() is drawn first, flying or not)
  painroll = p_rand256();
  IF (pain_state > 0 AND painroll < pain_chance AND skullfly = 0) THEN
  BEGIN
    UPDATE things t SET just_hit = 1 WHERE t.id = :tid;
    EXECUTE PROCEDURE set_state(tid, pain_state, tic) RETURNING_VALUES alive;
  END
  UPDATE things t SET reaction = 0 WHERE t.id = :tid;
  -- whoever hurt it becomes its target – unless it's still bound to another (its threshold;
  -- an arch-vile never is), or the source is an arch-vile (MT_VILE, 64: its attacks provoke
  -- nobody) – for BASETHRESHOLD, and still in its spawn state, it wakes. A barrel's target
  -- (the first to hurt it: nothing counts its threshold down) is credited with its blast
  -- (A_Explode); burst at one go, it has none (P_KillMobj sets no target).
  IF (src IS NOT NULL AND src <> tid AND (thr = 0 OR ttype = 64) AND k IN ('monster', 'barrel')) THEN
  BEGIN
    SELECT s.kind, s.thing_type FROM things s WHERE s.id = :src INTO skind, stype;
    IF (stype IS DISTINCT FROM 64) THEN
    BEGIN
      IF (k = 'barrel') THEN UPDATE things t SET owner_id = :src, threshold = 100 WHERE t.id = :tid;
      ELSE
      BEGIN
        spid = NULL;
        IF (skind = 'player') THEN SELECT p.id FROM player p WHERE p.thing_id = :src INTO spid;
        UPDATE things t SET target_id = IIF(:skind = 'player', NULL, :src), tplayer = COALESCE(:spid, t.tplayer), threshold = 100
         WHERE t.id = :tid;
        IF ((SELECT t.state FROM things t WHERE t.id = :tid) = spawn_state AND see_state > 0) THEN
          EXECUTE PROCEDURE set_state(tid, see_state, tic) RETURNING_VALUES alive;
      END
    END
  END
END^

-- ── sector movers ─────────────────────────────────────────────────────────
-- EV_DoDoor (EV_VerticalDoor, MANUAL 1: a door used, whose sound always plays): sector SEC's door
-- of DOOM's type MT – VDOORSPEED (2), four times that blazing, VDOORWAIT (150) at the top, up
-- to 4 below the lowest ceiling around; a close30ThenOpen comes back up to where it was
CREATE OR ALTER PROCEDURE door_start (sec INTEGER, mt VARCHAR(24), manual SMALLINT = 0)
AS
DECLARE fh DOUBLE PRECISION;
DECLARE ch DOUBLE PRECISION;
DECLARE top DOUBLE PRECISION;
DECLARE dir SMALLINT;
BEGIN
  IF (EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN EXIT;
  SELECT floor_h, ceil_h FROM sectors WHERE id = :sec INTO fh, ch;
  top = COALESCE(neighbor_h(:sec, 'min_ceil'), ch + 64) - 4;
  dir = 1;
  IF (mt IN ('close', 'blazeClose')) THEN dir = -1;
  ELSE IF (mt = 'close30ThenOpen') THEN
  BEGIN
    dir = -1;
    top = ch;
  END
  INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay)
  VALUES (:sec, 'door', :mt, :dir, IIF(:mt STARTING WITH 'blaze', 8, 2), :top, :fh, 150,
          CASE WHEN :mt IN ('normal', 'blazeRaise') THEN 0 WHEN :mt = 'close30ThenOpen' THEN 2 ELSE 1 END);
  IF (manual = 1) THEN EXECUTE PROCEDURE sector_sound(IIF(mt STARTING WITH 'blaze', 'DSBDOPN', 'DSDOROPN'), sec);
  ELSE IF (mt = 'blazeClose') THEN EXECUTE PROCEDURE sector_sound('DSBDCLS', sec);
  ELSE IF (mt IN ('close', 'close30ThenOpen')) THEN EXECUTE PROCEDURE sector_sound('DSDORCLS', sec);
  ELSE IF (top <> ch) THEN EXECUTE PROCEDURE sector_sound(IIF(mt STARTING WITH 'blaze', 'DSBDOPN', 'DSDOROPN'), sec);
END^

-- EV_DoFloor: sector SEC's floor towards TARGET at SPD in DIR (DOOM's type MT fixes the direction,
-- not where the target is: past it at once, it stops there), crushing or not
CREATE OR ALTER PROCEDURE floor_start (sec INTEGER, target DOUBLE PRECISION, spd DOUBLE PRECISION, dir SMALLINT = 1,
                                       mt VARCHAR(24) = 'raiseFloor', crush SMALLINT = 0)
AS
BEGIN
  IF (target IS NULL OR EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN EXIT;
  INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay, crush)
  VALUES (:sec, 'floor', :mt, :dir, :spd, :target, :target, 0, 1, :crush);
END^

-- EV_Teleport: TID to the teleport destination (thing 14) in the first sector
-- tagged TG that has one. Missiles never teleport. P_TeleportMove / PIT_StompThing:
-- whatever shootable thing stands there is telefragged (10000 damage) – when
-- the player arrives; a monster is blocked by it instead, except on MAP30. Fog
-- and DSTELEPT where it left and 20 units ahead of where it lands; it faces the
-- destination's way, stopped dead, and the player can't move for 18 tics
-- (reactiontime).
CREATE OR ALTER PROCEDURE teleport_thing (tid INTEGER, tg INTEGER)
RETURNS (ok SMALLINT)
AS
DECLARE k VARCHAR(10);
DECLARE rad DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION;
DECLARE oy DOUBLE PRECISION;
DECLARE oz DOUBLE PRECISION;
DECLARE dx DOUBLE PRECISION;
DECLARE dy DOUBLE PRECISION;
DECLARE da DOUBLE PRECISION;
DECLARE fz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE vid INTEGER;
DECLARE vk VARCHAR(10);
DECLARE fog INTEGER;
DECLARE mname VARCHAR(8);
BEGIN
  ok = 0;
  SELECT t.kind, t.radius, t.x, t.y, t.z FROM things t WHERE t.id = :tid INTO k, rad, ox, oy, oz;
  IF (k IS NULL OR k = 'missile') THEN EXIT;
  SELECT FIRST 1 t.x, t.y, t.angle
    FROM things t JOIN sectors s ON s.id = t.sector_id
   WHERE t.thing_type = 14 AND s.tag = :tg
   ORDER BY s.id, t.id
    INTO dx, dy, da;
  IF (dx IS NULL) THEN EXIT;
  SELECT g.map_name FROM game g WHERE g.id = 1 INTO mname;
  IF (k <> 'player' AND mname IS DISTINCT FROM 'MAP30'
      AND EXISTS (SELECT 1 FROM things t
                   WHERE t.id <> :tid AND t.kind IN ('monster', 'player', 'barrel', 'keen', 'brain')
                     AND t.st NOT IN ('dying', 'dead')
                     AND ABS(t.x - :dx) < t.radius + :rad AND ABS(t.y - :dy) < t.radius + :rad)) THEN EXIT;
  FOR SELECT t.id, t.kind FROM things t
       WHERE t.id <> :tid AND t.kind IN ('monster', 'player', 'barrel', 'keen', 'brain')
         AND t.st NOT IN ('dying', 'dead')
         AND ABS(t.x - :dx) < t.radius + :rad AND ABS(t.y - :dy) < t.radius + :rad
       ORDER BY t.id
        INTO vid, vk
  DO
    IF (vk = 'player') THEN EXECUTE PROCEDURE damage_player(10000, tid, (SELECT p.id FROM player p WHERE p.thing_id = :vid), tid);
    ELSE EXECUTE PROCEDURE damage_thing(vid, 10000, IIF(:k = 'player', NULL, :tid), tid);
  sec = sector_at_fx(fx_of(dx), fx_of(dy));
  SELECT floor_h FROM sectors WHERE id = :sec INTO fz;
  UPDATE things t
     SET x = :dx, y = :dy, z = :fz, angle = :da, momx = 0, momy = 0, momz = 0, sector_id = :sec,
         reaction = IIF(t.kind = 'player', 18, t.reaction),
         -- (P_TeleportMove's floorz and ceilingz: the sector it lands in, no lines asked)
         floorz = :fz, ceilz = (SELECT s.ceil_h FROM sectors s WHERE s.id = :sec), fz_x = :dx, fz_y = :dy
   WHERE t.id = :tid;
  EXECUTE PROCEDURE spawn_thing(9016, ox, oy, oz, 0) RETURNING_VALUES fog;
  EXECUTE PROCEDURE play_sound('DSTELEPT', fog, ox, oy);
  EXECUTE PROCEDURE spawn_thing(9016, dx + 20 * COS(da), dy + 20 * SIN(da), fz, 0) RETURNING_VALUES fog;
  EXECUTE PROCEDURE play_sound('DSTELEPT', fog, dx + 20 * COS(da), dy + 20 * SIN(da));
  ok = 1;
END^

-- EV_DoDoor / EV_DoPlat / EV_DoFloor / G_ExitLevel, dispatched on line special.
-- WHO is the monster that set it off (NULL: the player).
CREATE OR ALTER PROCEDURE activate_line (line_id INTEGER, how VARCHAR(5), who INTEGER = NULL, pid SMALLINT = 1)
AS
DECLARE sp INTEGER;
DECLARE tg INTEGER;
DECLARE bsec INTEGER;
DECLARE fside INTEGER;
DECLARE act VARCHAR(10);
DECLARE trig VARCHAR(5);
DECLARE repeatable SMALLINT;
DECLARE need INTEGER;
DECLARE keys INTEGER;
DECLARE spd DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE fh DOUBLE PRECISION;
DECLARE ch DOUBLE PRECISION;
DECLARE flat INTEGER;
DECLARE nxt INTEGER;
DECLARE h DOUBLE PRECISION;
DECLARE did SMALLINT = 0;
DECLARE fsec INTEGER;
DECLARE s2 INTEGER;
DECLARE s3 INTEGER;
DECLARE step_h DOUBLE PRECISION;
DECLARE step_spd DOUBLE PRECISION;
DECLARE nflat INTEGER;
DECLARE nspecial INTEGER;
DECLARE lflags INTEGER;
BEGIN
  SELECT special, tag, back_sector, front_side, front_sector, flags FROM linedefs WHERE id = :line_id
    INTO sp, tg, bsec, fside, fsec, lflags;
  IF (sp IS NULL OR sp = 0) THEN EXIT;
  -- P_CrossSpecialLine / P_UseSpecialLine: a monster walking over a line only
  -- sets off teleporters, door 4 and lifts 10/88; bumping into one, only a plain
  -- door (1, not on a secret line – the keyed ones are the player's). 125 and
  -- 126 are the monsters' own teleporters.
  IF (who IS NOT NULL) THEN
  BEGIN
    IF (how = 'walk' AND sp NOT IN (39, 97, 125, 126, 4, 10, 88)) THEN EXIT;
    IF (how = 'use' AND (sp <> 1 OR BIN_AND(lflags, 32) <> 0)) THEN EXIT;
    IF (how = 'shoot') THEN EXIT;
  END
  ELSE IF (sp IN (125, 126)) THEN EXIT;

  need = CASE WHEN sp IN (26, 32, 99, 133) THEN 1
              WHEN sp IN (27, 34, 136, 137) THEN 2
              WHEN sp IN (28, 33, 134, 135) THEN 4 ELSE 0 END;
  act = CASE
          WHEN sp IN (1, 26, 27, 28, 117) THEN 'door_man'
          WHEN sp IN (31, 32, 33, 34, 118) THEN 'door_man1'
          WHEN sp IN (4, 90, 29, 63, 108, 105, 111, 114) THEN 'door_ow'
          WHEN sp IN (2, 86, 103, 61, 46, 109, 106, 112, 115, 133, 135, 137, 99, 134, 136) THEN 'door_o'
          WHEN sp IN (3, 75, 50, 42, 110, 107, 113, 116) THEN 'door_c'
          WHEN sp IN (16, 76) THEN 'door_c30'
          WHEN sp IN (10, 88, 21, 62, 121, 120, 122, 123) THEN 'lift'
          WHEN sp IN (53, 87) THEN 'plat_perp'
          WHEN sp IN (54, 89) THEN 'plat_stop'
          WHEN sp IN (22, 95, 20, 68, 47) THEN 'plat_near'
          WHEN sp IN (15, 66) THEN 'plat_24'
          WHEN sp IN (59, 93) THEN 'fl_24chg'
          WHEN sp IN (14, 67) THEN 'plat_32'
          WHEN sp IN (38, 82, 23, 60) THEN 'fl_low'
          WHEN sp IN (37, 84) THEN 'fl_low_chg'
          WHEN sp IN (19, 83, 102, 45) THEN 'fl_hi'
          WHEN sp IN (36, 98, 71, 70) THEN 'fl_hi8'
          WHEN sp IN (5, 91, 101, 64, 24) THEN 'fl_ceil'
          WHEN sp IN (119, 128, 18, 69) THEN 'fl_next'
          WHEN sp IN (130, 129, 131, 132) THEN 'fl_next4'
          WHEN sp IN (58, 92) THEN 'fl_24'
          WHEN sp IN (30, 96) THEN 'fl_tex'
          WHEN sp = 140 THEN 'fl_512'
          WHEN sp = 9 THEN 'donut'
          WHEN sp = 40 THEN 'ceil_hi'
          WHEN sp IN (41, 43) THEN 'ceil_floor'
          WHEN sp IN (12, 80) THEN 'light_max'
          WHEN sp IN (13, 81, 138) THEN 'light_255'
          WHEN sp IN (35, 79, 139) THEN 'light_35'
          WHEN sp = 104 THEN 'light_min'
          WHEN sp = 17 THEN 'strobe'
          WHEN sp IN (7, 8) THEN 'stairs'
          WHEN sp IN (100, 127) THEN 'stairs16'
          WHEN sp IN (11, 52) THEN 'exit'
          WHEN sp IN (51, 124) THEN 'secret'
          WHEN sp IN (39, 97, 125, 126) THEN 'teleport'
          WHEN sp IN (6, 25, 49, 73, 77, 141) THEN 'crush'
          WHEN sp IN (57, 74) THEN 'crushstop'
          WHEN sp IN (55, 56, 65, 94) THEN 'fl_crush'
          WHEN sp IN (44, 72) THEN 'ceilcrush'
        END;
  trig = CASE
           WHEN sp IN (6, 25, 44, 56, 57, 73, 74, 77, 94, 141) THEN 'walk'
           WHEN sp IN (2, 3, 4, 5, 8, 10, 19, 36, 38, 39, 52, 58, 75, 82, 83, 86, 88, 90, 91, 92, 97, 98,
                       105, 106, 107, 108, 109, 110, 119, 120, 121, 124, 128) THEN 'walk'
           WHEN sp IN (12, 13, 16, 17, 22, 30, 35, 37, 40, 53, 54, 59, 72, 76, 79, 80, 81, 84, 87, 89, 93, 95, 96,
                       100, 104, 125, 126, 129, 130) THEN 'walk'
           WHEN sp IN (24, 46, 47) THEN 'shoot'
           ELSE 'use'
         END;
  repeatable = IIF(sp IN (65, 73, 74, 77, 94, 1, 26, 27, 28, 117, 42, 45, 46, 60, 61, 62, 63, 64, 69, 70, 75, 82, 83, 86, 88,
                          90, 91, 92, 97, 98, 99, 105, 106, 107, 114, 115, 116, 120, 123, 128, 134, 136,
                          72, 76, 79, 80, 81, 84, 87, 89, 93, 95, 96, 126, 129,
                          43, 66, 67, 68, 132, 138, 139), 1, 0);
  IF (act IS NULL OR trig <> how) THEN EXIT;

  IF (need > 0 AND who IS NULL) THEN
  BEGIN
    SELECT keycards FROM player WHERE id = :pid INTO keys;
    IF (BIN_AND(keys, need) = 0) THEN
    BEGIN
      UPDATE player SET msg_tics = 70,
             msg = 'You need a ' || CASE :need WHEN 1 THEN 'blue' WHEN 2 THEN 'yellow' ELSE 'red' END
                   || ' key to activate this'
       WHERE id = :pid;
      EXIT;
    END
  END

  spd = IIF(sp IN (105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 120, 121, 122, 123), 8, 2);

  IF (act IN ('door_man', 'door_man1')) THEN
  BEGIN
    IF (bsec IS NULL) THEN EXIT;
    IF (EXISTS (SELECT 1 FROM movers WHERE sector_id = :bsec)) THEN
    BEGIN
      -- EV_VerticalDoor: a monster only sends a closing door back up ("bad guys never close doors")
      IF (who IS NOT NULL) THEN
      BEGIN
        IF (EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = :bsec AND m.kind = 'door' AND m.dir = -1)) THEN
          UPDATE movers SET dir = 1 WHERE sector_id = :bsec;
      END
      -- (a raise door used again: one going down goes back up; else it starts down at once)
      ELSE IF (act = 'door_man') THEN
        UPDATE movers SET dir = IIF(dir = -1, 1, -1) WHERE sector_id = :bsec AND kind = 'door';
      EXIT;
    END
    EXECUTE PROCEDURE door_start(bsec, CASE sp WHEN 117 THEN 'blazeRaise' WHEN 118 THEN 'blazeOpen'
                                       ELSE IIF(act = 'door_man1', 'open', 'normal') END, 1);
    did = 1;
  END
  ELSE IF (act = 'teleport') THEN
    EXECUTE PROCEDURE teleport_thing(COALESCE(who, (SELECT p.thing_id FROM player p WHERE p.id = :pid)), tg)
      RETURNING_VALUES did;
  ELSE IF (act IN ('exit', 'secret')) THEN
  BEGIN
    UPDATE game SET exit_kind = IIF(:act = 'exit', 1, 2) WHERE id = 1;
    did = 1;
  END
  ELSE IF (tg > 0) THEN
  BEGIN
    FOR SELECT id, floor_h, ceil_h, floor_flat FROM sectors WHERE tag = :tg ORDER BY id INTO sec, fh, ch, flat DO
    BEGIN
      -- EV_LightTurnOn / EV_TurnTagLightsOff: straight to a level (the
      -- brightest neighbour's, 255, 35, or the darkest of it and its neighbours)
      IF (act IN ('light_max', 'light_255', 'light_35', 'light_min')) THEN
      BEGIN
        UPDATE sectors s
           SET light = CASE :act WHEN 'light_255' THEN 255 WHEN 'light_35' THEN 35
                                 WHEN 'light_max' THEN MAXVALUE(0, COALESCE(neighbor_h(s.id, 'max_light'), 0))
                                 ELSE MINVALUE(s.light, COALESCE(neighbor_h(s.id, 'min_light'), s.light)) END
         WHERE s.id = :sec;
        did = 1;
      END
      -- EV_StartLightStrobing: P_SpawnStrobeFlash(SLOWDARK), between its light
      -- and its darkest neighbour's (or black) – here, light type 3
      ELSE IF (act = 'strobe') THEN
      BEGIN
        IF (NOT EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN
          EXECUTE PROCEDURE spawn_light(sec, 3);
        did = 1;
      END
      -- EV_StopPlat: a perpetual lift stops where it is (in stasis)…
      ELSE IF (act = 'plat_stop') THEN
      BEGIN
        UPDATE movers SET kind = 'lifts' WHERE sector_id = :sec AND kind = 'lift';
        did = 1;
      END
      -- …and P_ActivateInStasis starts it again
      ELSE IF (act = 'plat_perp' AND EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = :sec AND m.kind = 'lifts')) THEN
      BEGIN
        UPDATE movers SET kind = 'lift' WHERE sector_id = :sec;
        did = 1;
      END
      ELSE IF (act = 'crushstop') THEN
      BEGIN
        -- EV_CeilingCrushStop: remember which way it was going
        UPDATE movers SET wait_left = dir, dir = 0 WHERE sector_id = :sec AND kind = 'crush' AND dir <> 0;
        did = 1;
      END
      ELSE IF (act = 'crush' AND EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = :sec AND m.kind = 'crush' AND m.dir = 0)) THEN
      BEGIN
        -- P_ActivateInStasisCeiling: a stopped crusher starts again
        UPDATE movers SET dir = IIF(wait_left = 0, -1, wait_left) WHERE sector_id = :sec;
        did = 1;
      END
      ELSE IF (NOT EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN
      BEGIN
        did = 1;
        -- EV_DoDoor: VDOORSPEED (2), four times that blazing; up to 4 below the lowest ceiling around
        IF (act IN ('door_ow', 'door_o', 'door_c')) THEN
          EXECUTE PROCEDURE door_start(sec, CASE
            WHEN sp IN (105, 108, 111, 114) THEN 'blazeRaise' WHEN act = 'door_ow' THEN 'normal'
            WHEN sp IN (106, 109, 112, 115, 99, 133, 134, 135, 136, 137) THEN 'blazeOpen' WHEN act = 'door_o' THEN 'open'
            WHEN sp IN (107, 110, 113, 116) THEN 'blazeClose' ELSE 'close' END);
        ELSE IF (act = 'door_c30') THEN EXECUTE PROCEDURE door_start(sec, 'close30ThenOpen');
        -- EV_DoPlat
        ELSE IF (act = 'plat_perp') THEN
        BEGIN
          -- perpetualRaise: PLATSPEED, between the lowest and highest floors around (and its own),
          -- for ever, starting up or down at random (P_Random() & 1)
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay)
          VALUES (:sec, 'lift', 'perpetualRaise', 0, 1,
                  MAXVALUE(:fh, COALESCE(neighbor_h(:sec, 'max_floor'), :fh)),
                  MINVALUE(:fh, COALESCE(neighbor_h(:sec, 'min_floor'), :fh)), 105, 2);
          UPDATE movers m SET dir = IIF(p_rand_and(1) = 0, 1, -1) WHERE m.sector_id = :sec;
          EXECUTE PROCEDURE sector_sound('DSPSTART', sec);
        END
        ELSE IF (act IN ('plat_near', 'plat_24', 'plat_32')) THEN
        BEGIN
          -- raiseToNearestAndChange / raiseAndChange: the floor takes the flat of the line's front
          -- sector at once (the first also loses its special), then rises at PLATSPEED / 2, no wait
          UPDATE sectors s SET floor_flat = (SELECT f.floor_flat FROM sectors f WHERE f.id = :fsec),
                               special = IIF(:act = 'plat_near', 0, s.special)
           WHERE s.id = :sec;
          h = NULL;
          IF (act = 'plat_near') THEN
            SELECT MIN(s.floor_h)
              FROM linedefs l
              JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
             WHERE (l.front_sector = :sec OR l.back_sector = :sec) AND l.back_sector IS NOT NULL
               AND s.floor_h > :fh
              INTO h;
          ELSE h = fh + IIF(act = 'plat_24', 24, 32);
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay)
          VALUES (:sec, 'lift', IIF(:act = 'plat_near', 'raiseToNearestAndChange', 'raiseAndChange'), 1, 0.5,
                  COALESCE(:h, :fh), :fh, 0, 1);
          EXECUTE PROCEDURE sector_sound('DSSTNMOV', sec);
        END
        ELSE IF (act = 'lift') THEN
        BEGIN
          -- downWaitUpStay (PLATSPEED × 4) / blazeDWUS (× 8): down to the lowest floor around, three
          -- seconds (PLATWAIT), back up
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay)
          VALUES (:sec, 'lift', IIF(:sp IN (120, 121, 122, 123), 'blazeDWUS', 'downWaitUpStay'), -1,
                  IIF(:sp IN (120, 121, 122, 123), 8, 4), :fh,
                  MINVALUE(:fh, COALESCE(neighbor_h(:sec, 'min_floor'), :fh)), 105, 0);
          EXECUTE PROCEDURE sector_sound('DSPSTART', sec);
        END
        -- EV_DoFloor: FLOORSPEED (1) unless said
        ELSE IF (act = 'fl_low_chg') THEN
        BEGIN
          -- lowerAndChange: down to the lowest floor around; on arrival it takes the flat and
          -- special of a neighbour at that height (the first, in line order)
          h = MINVALUE(fh, COALESCE(neighbor_h(sec, 'min_floor'), fh));
          nflat = flat;
          nspecial = 0;
          SELECT FIRST 1 s.floor_flat, s.special
            FROM linedefs l
            JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
           WHERE (l.front_sector = :sec OR l.back_sector = :sec) AND l.back_sector IS NOT NULL
             AND s.id <> :sec AND s.floor_h = :h
           ORDER BY l.id
            INTO nflat, nspecial;
          EXECUTE PROCEDURE floor_start(sec, h, 1, -1, 'lowerAndChange', 0);
          UPDATE movers SET new_flat = :nflat, new_special = :nspecial WHERE sector_id = :sec;
        END
        ELSE IF (act = 'fl_tex') THEN
        BEGIN
          -- raiseToTexture: up by the shortest lower texture on its two-sided lines
          SELECT MIN(t.h)
            FROM linedefs l
            JOIN sidedefs sd ON sd.id = l.front_side OR sd.id = l.back_side
            JOIN textures t ON t.id = sd.lower_tex
           WHERE (l.front_sector = :sec OR l.back_sector = :sec) AND l.back_sector IS NOT NULL AND sd.lower_tex > 0
            INTO h;
          EXECUTE PROCEDURE floor_start(sec, fh + COALESCE(h, 32000), 1, 1, 'raiseToTexture', 0);
        END
        ELSE IF (act = 'fl_512') THEN EXECUTE PROCEDURE floor_start(sec, fh + 512, 1, 1, 'raiseFloor512', 0);
        ELSE IF (act = 'donut') THEN
        BEGIN
          -- EV_DoDonut: the ring (across the hole's first line) rises to the floor beyond it – the
          -- back of the ring's first line that isn't the hole's – taking that flat; the hole sinks
          -- to the same height. Both at FLOORSPEED / 2.
          s2 = NULL;
          s3 = NULL;
          SELECT FIRST 1 IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
            FROM linedefs l
           WHERE l.front_sector = :sec OR l.back_sector = :sec
           ORDER BY l.id
            INTO s2;
          IF (s2 IS NOT NULL) THEN
            SELECT FIRST 1 l.back_sector
              FROM linedefs l
             WHERE (l.front_sector = :s2 OR l.back_sector = :s2) AND l.back_sector IS NOT NULL AND l.back_sector <> :sec
             ORDER BY l.id
              INTO s3;
          IF (s3 IS NOT NULL) THEN
          BEGIN
            SELECT floor_h, floor_flat FROM sectors WHERE id = :s3 INTO h, nflat;
            IF (NOT EXISTS (SELECT 1 FROM movers WHERE sector_id = :s2)) THEN
            BEGIN
              EXECUTE PROCEDURE floor_start(s2, h, 0.5, 1, 'donutRaise', 0);
              UPDATE movers SET new_flat = :nflat, new_special = 0 WHERE sector_id = :s2;
            END
            EXECUTE PROCEDURE floor_start(sec, h, 0.5, -1, 'lowerFloor', 0);
          END
        END
        -- EV_DoCeiling: CEILSPEED (1)
        ELSE IF (act = 'ceil_hi') THEN
          -- raiseToHighest: the ceiling up to the highest ceiling around (from 0)
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay, crush, silent)
          VALUES (:sec, 'crush', 'raiseToHighest', 1, 1, MAXVALUE(0, COALESCE(neighbor_h(:sec, 'max_ceil'), 0)), :ch, 0, 1, 0, 0);
        ELSE IF (act = 'ceil_floor') THEN
          -- lowerToFloor: the ceiling down to the floor, crushing nothing
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay, crush, silent)
          VALUES (:sec, 'crush', 'lowerToFloor', -1, 1, :ch, :fh, 0, 1, 0, 0);
        ELSE IF (act = 'fl_low') THEN
          EXECUTE PROCEDURE floor_start(sec, MINVALUE(fh, COALESCE(neighbor_h(sec, 'min_floor'), fh)), 1, -1, 'lowerFloorToLowest', 0);
        ELSE IF (act = 'fl_hi') THEN
          -- lowerFloor: to the highest floor around (from -500)
          EXECUTE PROCEDURE floor_start(sec, MAXVALUE(-500, COALESCE(neighbor_h(sec, 'max_floor'), -500)), 1, -1, 'lowerFloor', 0);
        ELSE IF (act = 'fl_hi8') THEN
        BEGIN
          -- turboLower: to 8 above the highest floor around, unless that's where it is
          h = MAXVALUE(-500, COALESCE(neighbor_h(sec, 'max_floor'), -500));
          EXECUTE PROCEDURE floor_start(sec, h + IIF(h <> fh, 8, 0), 4, -1, 'turboLower', 0);
        END
        ELSE IF (act IN ('fl_ceil', 'fl_crush')) THEN
        BEGIN
          -- raiseFloor: to the lowest ceiling around (but not past its own); raiseFloorCrush 8 short,
          -- crushing
          h = MINVALUE(ch, COALESCE(neighbor_h(sec, 'min_ceil'), ch));
          IF (act = 'fl_crush') THEN EXECUTE PROCEDURE floor_start(sec, h - 8, 1, 1, 'raiseFloorCrush', 1);
          ELSE EXECUTE PROCEDURE floor_start(sec, h, 1, 1, 'raiseFloor', 0);
        END
        ELSE IF (act = 'fl_24') THEN EXECUTE PROCEDURE floor_start(sec, fh + 24, 1, 1, 'raiseFloor24', 0);
        ELSE IF (act = 'fl_24chg') THEN
        BEGIN
          -- raiseFloor24AndChange: the flat and special of the line's front sector at once
          UPDATE sectors s SET floor_flat = (SELECT f.floor_flat FROM sectors f WHERE f.id = :fsec),
                               special = (SELECT f.special FROM sectors f WHERE f.id = :fsec)
           WHERE s.id = :sec;
          EXECUTE PROCEDURE floor_start(sec, fh + 24, 1, 1, 'raiseFloor24AndChange', 0);
        END
        ELSE IF (act IN ('fl_next', 'fl_next4')) THEN
        BEGIN
          -- raiseFloorToNearest / raiseFloorTurbo (four times as fast): the next floor up around
          SELECT MIN(s.floor_h)
            FROM linedefs l
            JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
           WHERE (l.front_sector = :sec OR l.back_sector = :sec) AND l.back_sector IS NOT NULL
             AND s.floor_h > :fh
            INTO h;
          EXECUTE PROCEDURE floor_start(sec, COALESCE(h, fh), IIF(act = 'fl_next4', 4, 1), 1,
                                        IIF(act = 'fl_next4', 'raiseFloorTurbo', 'raiseFloorToNearest'), 0);
        END
        ELSE IF (act = 'crush') THEN
          -- crushAndRaise (CEILSPEED), fastCrushAndRaise (× 2), silentCrushAndRaise: down to 8
          -- above the floor and back
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay, crush, silent)
          VALUES (:sec, 'crush', CASE WHEN :sp IN (6, 77) THEN 'fastCrushAndRaise' WHEN :sp = 141 THEN 'silentCrushAndRaise'
                                      ELSE 'crushAndRaise' END,
                  -1, IIF(:sp IN (6, 77), 2, 1), :ch, :fh + 8, 0, 0, 1, IIF(:sp = 141, 1, 0));
        ELSE IF (act = 'ceilcrush') THEN
          -- lowerAndCrush: down to 8 above the floor – crushing nothing (id never set its crush)
          INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, stay, crush, silent)
          VALUES (:sec, 'crush', 'lowerAndCrush', -1, 1, :ch, :fh + 8, 0, 1, 0, 0);
        ELSE IF (act IN ('stairs', 'stairs16')) THEN
        BEGIN
          -- EV_BuildStairs: build8 (steps of 8 at FLOORSPEED / 4) or turbo16 (16, × 4): this
          -- sector up a step, then, from each, the sector behind its first two-sided front-facing
          -- line (line order) with the same floor flat, a step higher – the height counted on even
          -- past one already moving, which is skipped for the next line. (Their crush is the
          -- uninitialised field's: true.)
          step_h = IIF(act = 'stairs16', 16, 8);
          step_spd = IIF(act = 'stairs16', 4, 0.25);
          h = fh + step_h;
          EXECUTE PROCEDURE floor_start(sec, h, step_spd, 1, 'buildStair', 1);
          nxt = sec;
          WHILE (nxt IS NOT NULL) DO
          BEGIN
            sec = nxt;
            nxt = NULL;
            FOR SELECT l.back_sector FROM linedefs l JOIN sectors s ON s.id = l.back_sector
                 WHERE l.front_sector = :sec AND BIN_AND(l.flags, 4) <> 0 AND s.floor_flat = :flat
                 ORDER BY l.id
                  INTO s2
            DO
            BEGIN
              h = h + step_h;
              IF (EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = :s2)) THEN CONTINUE;
              nxt = s2;
              EXECUTE PROCEDURE floor_start(nxt, h, step_spd, 1, 'buildStair', 1);
              LEAVE;
            END
          END
        END
      END
    END
  END

  IF (did = 1 AND how = 'use' AND who IS NULL) THEN
    -- flip SW1xxxx <-> SW2xxxx on the switch the player pressed
    UPDATE sidedefs sd
       SET mid_tex = COALESCE((SELECT FIRST 1 t2.id FROM textures t1
                                 JOIN textures t2 ON t2.name = IIF(t1.name STARTING WITH 'SW1', 'SW2', 'SW1') || SUBSTRING(t1.name FROM 4)
                                WHERE t1.id = sd.mid_tex AND t1.name SIMILAR TO 'SW[12]%'), mid_tex),
           upper_tex = COALESCE((SELECT FIRST 1 t2.id FROM textures t1
                                 JOIN textures t2 ON t2.name = IIF(t1.name STARTING WITH 'SW1', 'SW2', 'SW1') || SUBSTRING(t1.name FROM 4)
                                WHERE t1.id = sd.upper_tex AND t1.name SIMILAR TO 'SW[12]%'), upper_tex),
           lower_tex = COALESCE((SELECT FIRST 1 t2.id FROM textures t1
                                 JOIN textures t2 ON t2.name = IIF(t1.name STARTING WITH 'SW1', 'SW2', 'SW1') || SUBSTRING(t1.name FROM 4)
                                WHERE t1.id = sd.lower_tex AND t1.name SIMILAR TO 'SW[12]%'), lower_tex)
     WHERE sd.id = :fside;
  IF (did = 1 AND how = 'use') THEN
    UPDATE game g SET sides_rev = g.sides_rev + 1 WHERE g.id = 1;
  IF (did = 1 AND how = 'use' AND act NOT IN ('door_man', 'door_man1')) THEN
    EXECUTE PROCEDURE play_sound(IIF(act IN ('exit', 'secret'), 'DSSWTCHX', 'DSSWTCHN'), -1000000 - line_id,
      (SELECT (l.x1 + l.x2) / 2 FROM linedefs l WHERE l.id = :line_id),
      (SELECT (l.y1 + l.y2) / 2 FROM linedefs l WHERE l.id = :line_id));
  IF (did = 1 AND repeatable = 0) THEN
    UPDATE linedefs SET special = 0 WHERE id = :line_id;
END^

-- (MOVER_STEP, one mover's tic, declared here for MOVERS_THINK; its body – with T_MovePlane and
-- P_ChangeSector – comes after P_CheckPosition)
CREATE OR ALTER PROCEDURE mover_step (sid INTEGER)
AS
BEGIN
END^

CREATE OR ALTER PROCEDURE movers_think
AS
DECLARE sid INTEGER;
DECLARE k VARCHAR(8);
DECLARE dir SMALLINT;
DECLARE spd DOUBLE PRECISION;
DECLARE top_h DOUBLE PRECISION;
DECLARE bottom_h DOUBLE PRECISION;
DECLARE wait_tics INTEGER;
DECLARE wait_left INTEGER;
DECLARE stay SMALLINT;
DECLARE fh DOUBLE PRECISION;
DECLARE ch DOUBLE PRECISION;
DECLARE nh DOUBLE PRECISION;
DECLARE del SMALLINT;
DECLARE crush SMALLINT;
DECLARE silent SMALLINT;
DECLARE crushed SMALLINT;
DECLARE tic INTEGER;
DECLARE new_flat INTEGER;
DECLARE new_special INTEGER;
DECLARE pt INTEGER;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  FOR SELECT m.sector_id, m.kind, m.dir, m.speed, m.top_h, m.bottom_h, m.wait_tics, m.wait_left, m.stay,
             s.floor_h, s.ceil_h, m.crush, m.silent, m.new_flat, m.new_special
        FROM movers m JOIN sectors s ON s.id = m.sector_id
        ORDER BY m.sector_id
        INTO sid, k, dir, spd, top_h, bottom_h, wait_tics, wait_left, stay, fh, ch, crush, silent, new_flat, new_special
  DO
    EXECUTE PROCEDURE mover_step(sid);
END^

-- ── weapons ───────────────────────────────────────────────────────────────
-- P_LineAttack for the player: nearest blocking wall vs nearest shootable
-- thing, along a ray that climbs or dips by SLOPE (height per unit of
-- distance). A two-sided line stops the shot only if the shot's height where
-- it crosses falls outside the opening; a thing is hit only if the shot's
-- height at its distance lies within its body.
-- P_SpawnPuff: a bullet puff, a little up or down (the difference of two P_Random()s, ×1/64),
-- rising a unit a tic, its first frame 0–3 tics short; a melee hit's has no spark (S_PUFF3)
CREATE OR ALTER PROCEDURE spawn_puff (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, melee SMALLINT = 0)
RETURNS (mid INTEGER)
AS
DECLARE tic INTEGER;
DECLARE alive SMALLINT;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  z = z + (p_rand256() - p_rand256()) / 64e0;
  EXECUTE PROCEDURE spawn_thing(9010, x, y, z, 0) RETURNING_VALUES mid;
  UPDATE things t SET momz = 1 WHERE t.id = :mid;
  UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1) WHERE t.id = :mid;
  IF (melee = 1) THEN
    EXECUTE PROCEDURE set_state(mid, (SELECT s.id FROM states s WHERE s.name = 'S_PUFF3'), tic) RETURNING_VALUES alive;
END^

-- P_SpawnBlood: blood, a little up or down, thrown 2 up, its first frame 0–3 tics short; 9 to 12
-- damage starts it at S_BLOOD2, less at S_BLOOD3
CREATE OR ALTER PROCEDURE spawn_blood (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, dmg INTEGER)
RETURNS (mid INTEGER)
AS
DECLARE tic INTEGER;
DECLARE alive SMALLINT;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  z = z + (p_rand256() - p_rand256()) / 64e0;
  EXECUTE PROCEDURE spawn_thing(9011, x, y, z, 0) RETURNING_VALUES mid;
  UPDATE things t SET momz = 2 WHERE t.id = :mid;
  UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1) WHERE t.id = :mid;
  IF (dmg <= 12 AND dmg >= 9) THEN
    EXECUTE PROCEDURE set_state(mid, (SELECT s.id FROM states s WHERE s.name = 'S_BLOOD2'), tic) RETURNING_VALUES alive;
  ELSE IF (dmg < 9) THEN
    EXECUTE PROCEDURE set_state(mid, (SELECT s.id FROM states s WHERE s.name = 'S_BLOOD3'), tic) RETURNING_VALUES alive;
END^

-- ── DOOM's hitscan (p_map.c, p_maputl.c), in 16.16 ──────────────────────
-- P_PathTraverse with PT_ADDLINES | PT_ADDTHINGS, for P_AimLineAttack and P_LineAttack: the blocks
-- from (X1, Y1) to (X2, Y2) as DOOM steps through them; in each, its lines (each once,
-- PIT_AddLineIntercepts) and then the things linked in it – those whose middle is in it, so one
-- standing in a block the trace misses isn't met, however wide – that its corner-to-corner
-- diagonal crosses (PIT_AddThingIntercepts). Only shootable things are listed (the shots pass
-- the rest by), the most recently placed first in a block. → each intercept: FRAC along the
-- trace (16.16), ORD the order it was met in (P_TraverseIntercepts takes the nearest, the
-- first met of equal ones), KIND L or T, ID; and TX, TY, TDX, TDY, the trace itself (its start
-- moved a unit off a block's edge).
CREATE OR ALTER PROCEDURE path_intercepts (x1 BIGINT, y1 BIGINT, x2 BIGINT, y2 BIGINT)
RETURNS (frac BIGINT, ord INTEGER, kind CHAR(1), id INTEGER, tx BIGINT, ty BIGINT, tdx BIGINT, tdy BIGINT)
AS
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE xt1 BIGINT;
DECLARE yt1 BIGINT;
DECLARE xt2 BIGINT;
DECLARE yt2 BIGINT;
DECLARE mapxstep INTEGER;
DECLARE mapystep INTEGER;
DECLARE partial BIGINT;
DECLARE xstep BIGINT;
DECLARE ystep BIGINT;
DECLARE xintercept BIGINT;
DECLARE yintercept BIGINT;
DECLARE mapx BIGINT;
DECLARE mapy BIGINT;
DECLARE cnt INTEGER;
DECLARE seen VARCHAR(8000);
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE s1 SMALLINT;
DECLARE s2 SMALLINT;
DECLARE f BIGINT;
DECLARE positive SMALLINT;
DECLARE mx BIGINT;
DECLARE my BIGINT;
DECLARE mr BIGINT;
DECLARE cx1 BIGINT;
DECLARE cy1 BIGINT;
DECLARE cx2 BIGINT;
DECLARE cy2 BIGINT;
DECLARE tid INTEGER;
BEGIN
  ord = 0;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  IF (BIN_AND(x1 - orgx, 8388607) = 0) THEN x1 = x1 + 65536;
  IF (BIN_AND(y1 - orgy, 8388607) = 0) THEN y1 = y1 + 65536;
  tx = x1;
  ty = y1;
  tdx = fx32(x2 - x1);
  tdy = fx32(y2 - y1);
  -- (tracepositive: (trace.dx ^ trace.dy) > 0, as 32-bit ints)
  positive = IIF(BIN_XOR(BIN_AND(tdx, 4294967295), BIN_AND(tdy, 4294967295)) BETWEEN 1 AND 2147483647, 1, 0);
  x1 = x1 - orgx;
  y1 = y1 - orgy;
  xt1 = BIN_SHR(x1, 23);
  yt1 = BIN_SHR(y1, 23);
  x2 = x2 - orgx;
  y2 = y2 - orgy;
  xt2 = BIN_SHR(x2, 23);
  yt2 = BIN_SHR(y2, 23);
  IF (xt2 > xt1) THEN
  BEGIN
    mapxstep = 1;
    partial = 65536 - BIN_AND(BIN_SHR(x1, 7), 65535);
    ystep = fx_div(fx32(y2 - y1), ABS(fx32(x2 - x1)));
  END
  ELSE IF (xt2 < xt1) THEN
  BEGIN
    mapxstep = -1;
    partial = BIN_AND(BIN_SHR(x1, 7), 65535);
    ystep = fx_div(fx32(y2 - y1), ABS(fx32(x2 - x1)));
  END
  ELSE
  BEGIN
    mapxstep = 0;
    partial = 65536;
    ystep = 16777216;
  END
  yintercept = fx32(BIN_SHR(y1, 7) + fx_mul(partial, ystep));
  IF (yt2 > yt1) THEN
  BEGIN
    mapystep = 1;
    partial = 65536 - BIN_AND(BIN_SHR(y1, 7), 65535);
    xstep = fx_div(fx32(x2 - x1), ABS(fx32(y2 - y1)));
  END
  ELSE IF (yt2 < yt1) THEN
  BEGIN
    mapystep = -1;
    partial = BIN_AND(BIN_SHR(y1, 7), 65535);
    xstep = fx_div(fx32(x2 - x1), ABS(fx32(y2 - y1)));
  END
  ELSE
  BEGIN
    mapystep = 0;
    partial = 65536;
    xstep = 16777216;
  END
  xintercept = fx32(BIN_SHR(x1, 7) + fx_mul(partial, xstep));
  mapx = xt1;
  mapy = yt1;
  cnt = 0;
  seen = ',';
  WHILE (cnt < 64) DO
  BEGIN
    IF (mapx >= 0 AND mapy >= 0 AND mapx < bw AND mapy < bh) THEN
    BEGIN
      -- P_BlockLinesIterator (mapx, mapy, PIT_AddLineIntercepts)
      FOR SELECT l.id, l.fx, l.fy, l.fdx, l.fdy
            FROM blockmap b JOIN linedefs l ON l.id = b.line_id
           WHERE b.bx = :mapx AND b.by_ = :mapy
           ORDER BY b.seq
            INTO lid, lx, ly, ldx, ldy
      DO
      BEGIN
        IF (POSITION(',' || lid || ',' IN seen) > 0) THEN CONTINUE;
        seen = seen || lid || ',';
        IF (tdx > 1048576 OR tdy > 1048576 OR tdx < -1048576 OR tdy < -1048576) THEN
        BEGIN
          s1 = point_on_divline_side(lx, ly, tx, ty, tdx, tdy);
          s2 = point_on_divline_side(fx32(lx + ldx), fx32(ly + ldy), tx, ty, tdx, tdy);
        END
        ELSE
        BEGIN
          s1 = point_on_line_side(tx, ty, lx, ly, ldx, ldy);
          s2 = point_on_line_side(fx32(tx + tdx), fx32(ty + tdy), lx, ly, ldx, ldy);
        END
        IF (s1 = s2) THEN CONTINUE;
        f = intercept_vector(tx, ty, tdx, tdy, lx, ly, ldx, ldy);
        IF (f < 0) THEN CONTINUE;
        frac = f;
        ord = ord + 1;
        kind = 'L';
        id = lid;
        SUSPEND;
      END
      -- P_BlockThingsIterator (mapx, mapy, PIT_AddThingIntercepts): the shootable things whose
      -- middle is in this block
      FOR SELECT t.id, fx_of(t.x), fx_of(t.y), fx_of(t.radius)
            FROM things t
           WHERE t.kind IN ('monster', 'barrel', 'keen', 'brain', 'player') AND t.st NOT IN ('dying', 'dead')
             AND t.x >= (:mapx * 8388608 + :orgx) / 65536e0 AND t.x < ((:mapx + 1) * 8388608 + :orgx) / 65536e0
             AND t.y >= (:mapy * 8388608 + :orgy) / 65536e0 AND t.y < ((:mapy + 1) * 8388608 + :orgy) / 65536e0
           ORDER BY t.link_seq DESC
            INTO tid, mx, my, mr
      DO
      BEGIN
        IF (BIN_SHR(mx - orgx, 23) <> mapx OR BIN_SHR(my - orgy, 23) <> mapy) THEN CONTINUE;
        cx1 = mx - mr;
        cx2 = mx + mr;
        IF (positive = 1) THEN
        BEGIN
          cy1 = my + mr;
          cy2 = my - mr;
        END
        ELSE
        BEGIN
          cy1 = my - mr;
          cy2 = my + mr;
        END
        IF (point_on_divline_side(cx1, cy1, tx, ty, tdx, tdy) = point_on_divline_side(cx2, cy2, tx, ty, tdx, tdy)) THEN CONTINUE;
        f = intercept_vector(tx, ty, tdx, tdy, cx1, cy1, fx32(cx2 - cx1), fx32(cy2 - cy1));
        IF (f < 0) THEN CONTINUE;
        frac = f;
        ord = ord + 1;
        kind = 'T';
        id = tid;
        SUSPEND;
      END
    END
    IF (mapx = xt2 AND mapy = yt2) THEN LEAVE;
    IF (BIN_SHR(yintercept, 16) = mapy) THEN
    BEGIN
      yintercept = fx32(yintercept + ystep);
      mapx = mapx + mapxstep;
    END
    ELSE IF (BIN_SHR(xintercept, 16) = mapx) THEN
    BEGIN
      xintercept = fx32(xintercept + xstep);
      mapy = mapy + mapystep;
    END
    cnt = cnt + 1;
  END
END^

-- P_AimLineAttack: from SHOOTER's middle plus 8 (shootz) along ANG (a BAM) for DIST (16.16),
-- the first shootable thing in the window between DOOM's slopes (±100/160), narrowed by every
-- opening the line of fire passes (PTR_AimTraverse; a one-sided line, or a closed one, ends it).
-- → SLOPE to its middle part in view (0 if none), TARGET (linetarget, NULL if none).
CREATE OR ALTER PROCEDURE aim_line_attack (shooter INTEGER, ang BIGINT, dist BIGINT)
RETURNS (slope BIGINT, target INTEGER)
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE shootz BIGINT;
DECLARE topslope BIGINT = 40960;
DECLARE bottomslope BIGINT = -40960;
DECLARE frac BIGINT;
DECLARE ord INTEGER;
DECLARE kind CHAR(1);
DECLARE id INTEGER;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE tdx BIGINT;
DECLARE tdy BIGINT;
DECLARE lflags INTEGER;
DECLARE lback INTEGER;
DECLARE ff BIGINT;
DECLARE fc BIGINT;
DECLARE bf BIGINT;
DECLARE bc BIGINT;
DECLARE opentop BIGINT;
DECLARE openbottom BIGINT;
DECLARE d BIGINT;
DECLARE s BIGINT;
DECLARE thz BIGINT;
DECLARE thh BIGINT;
DECLARE tt BIGINT;
DECLARE tb BIGINT;
BEGIN
  slope = 0;
  target = NULL;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z) + BIN_SHR(fx_of(t.height), 1) + 524288 FROM things t WHERE t.id = :shooter
    INTO x, y, shootz;
  FOR SELECT p.frac, p.ord, p.kind, p.id
        FROM path_intercepts(:x, :y, :x + BIN_SHR(:dist, 16) * fine_cosine(BIN_SHR(:ang, 19)),
                             :y + BIN_SHR(:dist, 16) * fine_sine(BIN_SHR(:ang, 19))) p
       WHERE p.frac <= 65536
       ORDER BY p.frac, p.ord
        INTO frac, ord, kind, id
  DO
  BEGIN
    d = fx_mul(dist, frac);
    IF (kind = 'L') THEN
    BEGIN
      SELECT l.flags, l.back_sector, fx_of(fs.floor_h), fx_of(fs.ceil_h), fx_of(bs.floor_h), fx_of(bs.ceil_h)
        FROM linedefs l JOIN sectors fs ON fs.id = l.front_sector LEFT JOIN sectors bs ON bs.id = l.back_sector
       WHERE l.id = :id INTO lflags, lback, ff, fc, bf, bc;
      IF (BIN_AND(lflags, 4) = 0 OR lback IS NULL) THEN EXIT;    -- (not ML_TWOSIDED: the shot stops)
      opentop = MINVALUE(fc, bc);
      openbottom = MAXVALUE(ff, bf);
      IF (openbottom >= opentop) THEN EXIT;
      IF (ff <> bf) THEN
      BEGIN
        s = fx_div(fx32(openbottom - shootz), d);
        IF (s > bottomslope) THEN bottomslope = s;
      END
      IF (fc <> bc) THEN
      BEGIN
        s = fx_div(fx32(opentop - shootz), d);
        IF (s < topslope) THEN topslope = s;
      END
      IF (topslope <= bottomslope) THEN EXIT;
      CONTINUE;
    END
    IF (id = shooter) THEN CONTINUE;
    SELECT fx_of(t.z), fx_of(t.height) FROM things t WHERE t.id = :id INTO thz, thh;
    tt = fx_div(fx32(thz + thh - shootz), d);
    IF (tt < bottomslope) THEN CONTINUE;       -- (over it)
    tb = fx_div(fx32(thz - shootz), d);
    IF (tb > topslope) THEN CONTINUE;          -- (under it)
    IF (tt > topslope) THEN tt = topslope;
    IF (tb < bottomslope) THEN tb = bottomslope;
    slope = (tt + tb) / 2;                     -- (C's division: towards 0)
    target = id;
    EXIT;
  END
END^

-- P_LineAttack: SHOOTER's shot along ANG for DIST at SLOPE, doing DMG (PTR_ShootTraverse): a special
-- line it passes is shot (P_ShootSpecialLine: 24, 46, 47; a monster's only 46); the first wall
-- in its way – a one-sided line, or an opening it passes over or under – takes a puff 4 units
-- short (none into a sky); the first shootable thing it meets at its height bleeds 10 units short
-- (a barrel puffs: MF_NOBLOOD) and is hurt (P_DamageMobj).
CREATE OR ALTER PROCEDURE line_attack (shooter INTEGER, ang BIGINT, dist BIGINT, slope BIGINT, dmg INTEGER)
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE shootz BIGINT;
DECLARE frac BIGINT;
DECLARE ord INTEGER;
DECLARE kind CHAR(1);
DECLARE id INTEGER;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE tdx BIGINT;
DECLARE tdy BIGINT;
DECLARE lsp INTEGER;
DECLARE lflags INTEGER;
DECLARE lback INTEGER;
DECLARE ff BIGINT;
DECLARE fc BIGINT;
DECLARE bf BIGINT;
DECLARE bc BIGINT;
DECLARE fsky SMALLINT;
DECLARE bsky SMALLINT;
DECLARE d BIGINT;
DECLARE s BIGINT;
DECLARE hit SMALLINT;
DECLARE f BIGINT;
DECLARE px BIGINT;
DECLARE py BIGINT;
DECLARE pz BIGINT;
DECLARE thz BIGINT;
DECLARE thh BIGINT;
DECLARE tk VARCHAR(10);
DECLARE pid SMALLINT;
DECLARE dummy INTEGER;
DECLARE is_player SMALLINT;
BEGIN
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z) + BIN_SHR(fx_of(t.height), 1) + 524288,
         IIF(EXISTS (SELECT 1 FROM player p WHERE p.thing_id = t.id), 1, 0)
    FROM things t WHERE t.id = :shooter INTO x, y, shootz, is_player;
  FOR SELECT p.frac, p.ord, p.kind, p.id, p.tx, p.ty, p.tdx, p.tdy
        FROM path_intercepts(:x, :y, :x + BIN_SHR(:dist, 16) * fine_cosine(BIN_SHR(:ang, 19)),
                             :y + BIN_SHR(:dist, 16) * fine_sine(BIN_SHR(:ang, 19))) p
       WHERE p.frac <= 65536
       ORDER BY p.frac, p.ord
        INTO frac, ord, kind, id, tx, ty, tdx, tdy
  DO
  BEGIN
    d = fx_mul(dist, frac);
    IF (kind = 'L') THEN
    BEGIN
      SELECT l.special, l.flags, l.back_sector, fx_of(fs.floor_h), fx_of(fs.ceil_h), fx_of(bs.floor_h), fx_of(bs.ceil_h), fs.sky, bs.sky
        FROM linedefs l JOIN sectors fs ON fs.id = l.front_sector LEFT JOIN sectors bs ON bs.id = l.back_sector
       WHERE l.id = :id INTO lsp, lflags, lback, ff, fc, bf, bc, fsky, bsky;
      IF (lsp IN (24, 46, 47) AND (is_player = 1 OR lsp = 46)) THEN EXECUTE PROCEDURE activate_line(id, 'shoot');
      hit = 0;
      IF (BIN_AND(lflags, 4) = 0 OR lback IS NULL) THEN hit = 1;
      ELSE
      BEGIN
        IF (ff <> bf AND fx_div(fx32(MAXVALUE(ff, bf) - shootz), d) > slope) THEN hit = 1;
        IF (fc <> bc AND fx_div(fx32(MINVALUE(fc, bc) - shootz), d) < slope) THEN hit = 1;
      END
      IF (hit = 0) THEN CONTINUE;
      f = fx32(frac - fx_div(262144, dist));
      px = fx32(tx + fx_mul(tdx, f));
      py = fx32(ty + fx_mul(tdy, f));
      pz = fx32(shootz + fx_mul(slope, fx_mul(f, dist)));
      -- (into the sky: no puff)
      IF (fsky = 1) THEN
      BEGIN
        IF (pz > fc) THEN EXIT;
        IF (bsky = 1) THEN EXIT;
      END
      EXECUTE PROCEDURE spawn_puff(px / 65536e0, py / 65536e0, pz / 65536e0, IIF(dist = 4194304, 1, 0)) RETURNING_VALUES dummy;
      EXIT;
    END
    IF (id = shooter) THEN CONTINUE;
    SELECT fx_of(t.z), fx_of(t.height), t.kind FROM things t WHERE t.id = :id INTO thz, thh, tk;
    IF (fx_div(fx32(thz + thh - shootz), d) < slope) THEN CONTINUE;   -- (over it)
    IF (fx_div(fx32(thz - shootz), d) > slope) THEN CONTINUE;         -- (under it)
    f = fx32(frac - fx_div(655360, dist));
    px = fx32(tx + fx_mul(tdx, f));
    py = fx32(ty + fx_mul(tdy, f));
    pz = fx32(shootz + fx_mul(slope, fx_mul(f, dist)));
    IF (tk = 'barrel') THEN
      EXECUTE PROCEDURE spawn_puff(px / 65536e0, py / 65536e0, pz / 65536e0, IIF(dist = 4194304, 1, 0)) RETURNING_VALUES dummy;
    ELSE EXECUTE PROCEDURE spawn_blood(px / 65536e0, py / 65536e0, pz / 65536e0, dmg) RETURNING_VALUES dummy;
    IF (dmg <> 0) THEN
    BEGIN
      pid = NULL;
      SELECT p.id FROM player p WHERE p.thing_id = :id INTO pid;
      IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(dmg, shooter, pid, shooter);
      ELSE EXECUTE PROCEDURE damage_thing(id, dmg, shooter, shooter);
    END
    EXIT;
  END
END^

-- P_ExplodeMissile: it stops, goes into its death state with that state's first tics cut by
-- P_Random() & 3 (at least 1), no longer a missile, and plays its death sound
CREATE OR ALTER PROCEDURE explode_missile (tid INTEGER, tic INTEGER)
AS
DECLARE dstate INTEGER;
DECLARE snd VARCHAR(8);
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE alive SMALLINT;
BEGIN
  SELECT tt.death_state, tt.death_snd, t.x, t.y FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :tid INTO dstate, snd, x, y;
  IF (dstate IS NULL) THEN EXIT;
  UPDATE things t SET momx = 0, momy = 0, momz = 0 WHERE t.id = :tid;
  EXECUTE PROCEDURE set_state(tid, dstate, tic) RETURNING_VALUES alive;
  IF (alive = 0) THEN EXIT;
  UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1)
   WHERE t.id = :tid AND t.state_tic IS NOT NULL;
  IF (snd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(snd, tid, x, y);
END^

-- (CHECK_MISSILE_SPAWN, FIRE_MISSILE and SPAWN_MISSILE_FX – P_CheckMissileSpawn,
-- P_SpawnPlayerMissile and P_SpawnMissile – declared here for the weapons and the monsters;
-- their bodies come with the missiles' flight, after P_TryMove)
CREATE OR ALTER PROCEDURE check_missile_spawn (mid INTEGER)
AS
BEGIN
END^

CREATE OR ALTER PROCEDURE fire_missile (
  mtype INTEGER, owner INTEGER, sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION, ang DOUBLE PRECISION)
AS
BEGIN
END^

CREATE OR ALTER PROCEDURE spawn_missile_fx (owner INTEGER, mtype INTEGER, zoff BIGINT = 0, turn BIGINT = 0)
RETURNS (mid INTEGER)
AS
BEGIN
  mid = NULL;
END^

-- P_RadiusAttack in 16.16: BOMB (the barrel, the rocket, the arch-vile's fire) blasts what's
-- shootable in the blocks DMG + MAXRADIUS around it, row by row and in a block the newest
-- first (PIT_RadiusAttack): the box distance from it less the victim's radius, in whole units
-- (>> 16, at least 0); under DMG and in sight of it (P_CheckSight from the victim), DMG minus
-- that, from SRC (who fired it; NULL: nobody), thrown back from it. The Cyberdemon and the
-- Spider Mastermind (MT_CYBORG, MT_SPIDER) don't feel it. (BX, BDY, BZ: unused, kept for the
-- callers; the bomb's own position counts.)
CREATE OR ALTER PROCEDURE radius_attack (
  bx DOUBLE PRECISION, bdy DOUBLE PRECISION, bz DOUBLE PRECISION, dmg INTEGER, src INTEGER, bomb INTEGER = NULL)
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE dist BIGINT;
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE xl INTEGER;
DECLARE xh INTEGER;
DECLARE yl INTEGER;
DECLARE yh INTEGER;
DECLARE oid INTEGER;
DECLARE ottype INTEGER;
DECLARE ox BIGINT;
DECLARE oy BIGINT;
DECLARE orad BIGINT;
DECLARE d BIGINT;
DECLARE pid SMALLINT;
BEGIN
  x = NULL;
  SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :bomb INTO x, y;
  IF (x IS NULL) THEN EXIT;
  dist = CAST(dmg + 32 AS BIGINT) * 65536;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  xl = MAXVALUE(BIN_SHR(x - dist - orgx, 23), 0);
  xh = MINVALUE(BIN_SHR(x + dist - orgx, 23), bw - 1);
  yl = MAXVALUE(BIN_SHR(y - dist - orgy, 23), 0);
  yh = MINVALUE(BIN_SHR(y + dist - orgy, 23), bh - 1);
  FOR SELECT t.id, t.thing_type, fx_of(t.x), fx_of(t.y), fx_of(t.radius)
        FROM things t
       WHERE t.x BETWEEN (:x - :dist) / 65536e0 - 128 AND (:x + :dist) / 65536e0 + 128
         AND ((t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.state IS NOT NULL)
              OR (t.kind = 'player' AND t.solid = 1))
         AND BIN_SHR(fx_of(t.x) - :orgx, 23) BETWEEN :xl AND :xh
         AND BIN_SHR(fx_of(t.y) - :orgy, 23) BETWEEN :yl AND :yh
       ORDER BY BIN_SHR(fx_of(t.y) - :orgy, 23), BIN_SHR(fx_of(t.x) - :orgx, 23), t.link_seq DESC
        INTO oid, ottype, ox, oy, orad
  DO
  BEGIN
    IF (ottype IN (16, 7)) THEN CONTINUE;
    d = BIN_SHR(MAXVALUE(ABS(ox - x), ABS(oy - y)) - orad, 16);
    IF (d < 0) THEN d = 0;
    IF (d >= dmg) THEN CONTINUE;
    IF (sight_fx(oid, bomb) = 0) THEN CONTINUE;
    pid = NULL;
    SELECT p.id FROM player p WHERE p.thing_id = :oid INTO pid;
    IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(dmg - d, src, pid, bomb);
    ELSE EXECUTE PROCEDURE damage_thing(oid, dmg - d, src, bomb);
  END
END^

-- A_BFGSpray: 40 tracers fanned over 90° from the player who fired (SRC), along the ball's
-- heading (ANG), each P_AimLineAttack 1024 out; what one finds gets an MT_EXTRABFG a quarter
-- up it and 15 rolls of (P_Random() & 7) + 1, from the player.
CREATE OR ALTER PROCEDURE bfg_spray (ang DOUBLE PRECISION, src INTEGER)
AS
DECLARE base BIGINT;
DECLARE an BIGINT;
DECLARE i INTEGER = 0;
DECLARE j INTEGER;
DECLARE dmg INTEGER;
DECLARE slope BIGINT;
DECLARE tgt INTEGER;
DECLARE hitp SMALLINT;
DECLARE dummy INTEGER;
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :src)) THEN EXIT;
  base = bam_of(ang);
  WHILE (i < 40) DO
  BEGIN
    -- (mo->angle - ANG90/2 + ANG90/40 × i, from the player, 1024 out)
    an = BIN_AND(base - 536870912 + 26843545 * i, 4294967295);
    EXECUTE PROCEDURE aim_line_attack(src, an, 67108864) RETURNING_VALUES slope, tgt;
    IF (tgt IS NOT NULL) THEN
    BEGIN
      EXECUTE PROCEDURE spawn_thing(9012, (SELECT t.x FROM things t WHERE t.id = :tgt), (SELECT t.y FROM things t WHERE t.id = :tgt),
                                    (SELECT (fx_of(t.z) + BIN_SHR(fx_of(t.height), 2)) / 65536e0 FROM things t WHERE t.id = :tgt), 0)
        RETURNING_VALUES dummy;
      dmg = 0;
      j = 0;
      WHILE (j < 15) DO
      BEGIN
        dmg = dmg + p_rand_and(7) + 1;
        j = j + 1;
      END
      hitp = NULL;
      SELECT p.id FROM player p WHERE p.thing_id = :tgt INTO hitp;
      IF (hitp IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(dmg, src, hitp, src);
      ELSE EXECUTE PROCEDURE damage_thing(tgt, dmg, src, src);
    END
    i = i + 1;
  END
END^

-- P_NoiseAlert / P_RecursiveSound: gunfire floods out from the shooter's
-- sector through every open two-sided line (a closed door stops it). A line
-- flagged ML_SOUNDBLOCK (64) lets it through once, never twice. Every
-- sector reached remembers it heard the player, for the rest of the level.
-- Breadth first and set based: each pass is one MERGE that pushes the
-- frontier across the open lines, keeping the fewest blocks per sector.
CREATE OR ALTER PROCEDURE noise_alert (src INTEGER, tic INTEGER, pid SMALLINT = 1)
AS
DECLARE added INTEGER = 1;
DECLARE passes INTEGER = 0;
DECLARE last_sec INTEGER;
DECLARE last_tic INTEGER;
BEGIN
  IF (src IS NULL) THEN EXIT;
  SELECT g.noise_sector, g.noise_tic FROM game g WHERE g.id = 1 INTO last_sec, last_tic;
  UPDATE game g SET noise_tic = :tic WHERE g.id = 1;
  -- the same spot within a second: those sectors already know (doors may
  -- have moved since, so flood again after that)
  IF (last_sec = src AND tic - last_tic < 35 AND (SELECT g.players FROM game g WHERE g.id = 1) = 1) THEN EXIT;
  UPDATE game g SET noise_sector = :src WHERE g.id = 1;

  DELETE FROM sound_flood;
  INSERT INTO sound_flood (sector_id, blocks, frontier) VALUES (:src, 0, 1);
  WHILE (added > 0 AND passes < 500) DO
  BEGIN
    MERGE INTO sound_flood d
    USING (SELECT n.nb, MIN(n.nblocks) nblocks
             FROM (SELECT k.b nb, f.blocks + k.block nblocks
                     FROM sound_flood f
                     LEFT JOIN sound_links k ON k.a = f.sector_id
                     LEFT JOIN sectors sa ON sa.id = k.a
                     LEFT JOIN sectors sb ON sb.id = k.b
                    WHERE f.frontier = 1
                      AND MINVALUE(sa.ceil_h, sb.ceil_h) > MAXVALUE(sa.floor_h, sb.floor_h)) n   -- openrange > 0
            WHERE n.nblocks < 2
            GROUP BY n.nb) s
       ON d.sector_id = s.nb
     WHEN MATCHED AND s.nblocks < d.blocks THEN UPDATE SET blocks = s.nblocks, frontier = 2
     WHEN NOT MATCHED THEN INSERT (sector_id, blocks, frontier) VALUES (s.nb, s.nblocks, 2);
    added = ROW_COUNT;
    UPDATE sound_flood SET frontier = frontier - 1 WHERE frontier > 0;
    passes = passes + 1;
  END
  UPDATE sectors s SET sound_heard = :pid
   WHERE s.sound_heard <> :pid AND EXISTS (SELECT 1 FROM sound_flood f WHERE f.sector_id = s.id);
END^

-- ── the player ────────────────────────────────────────────────────────────
-- G_DoReborn in a netgame (P_SpawnPlayer, G_PlayerReborn): a dead player
-- G_DeathMatchSpawnPlayer: one of the deathmatch starts (type 11) at random,
-- up to twenty tries for one nobody stands on (G_CheckSpot); failing that, the
-- player's own start. DOOM refuses a map with fewer than four deathmatch
-- starts; here one without any falls back to the player starts instead.
-- ── the weapons on DOOM's frame tables (docs/ROADMAP.md, phase 4) ──────────
-- p_pspr.c: each player's two psprites, the weapon (POS 0, ps_weapon) and its muzzle flash
-- (POS 1, ps_flash), go through info.c's weapon states as a thing goes through its own: a
-- state's tics count down in PLAYER_THINK (P_MovePsprites) and its action is called as it's
-- entered (P_SetPsprite). weapon_info is d_items.c's weaponinfo[]. The actions run in
-- P_PlayerThink, before the body's own thinker: the body states they set start at TIC - 1.

-- P_SubRandom × 2^SHIFT in BAM, as radians: (P_Random() - P_Random()) << SHIFT
CREATE OR ALTER FUNCTION sub_random_angle (shift INTEGER) RETURNS DOUBLE PRECISION
AS
DECLARE r1 INTEGER;
DECLARE r2 INTEGER;
BEGIN
  r1 = p_rand256();
  r2 = p_rand256();
  RETURN (r1 - r2) * POWER(2, shift) * 2 * PI() / 4294967296e0;
END^

-- DecreaseAmmo: N of the weapon in hand's ammo
CREATE OR ALTER PROCEDURE decrease_ammo (pid SMALLINT, n INTEGER)
AS
DECLARE ammo VARCHAR(8);
BEGIN
  SELECT wi.ammo FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon WHERE p.id = :pid INTO ammo;
  UPDATE player p
     SET bullets = p.bullets - IIF(:ammo = 'clip', :n, 0), shells = p.shells - IIF(:ammo = 'shell', :n, 0),
         rockets = p.rockets - IIF(:ammo = 'misl', :n, 0), cells = p.cells - IIF(:ammo = 'cell', :n, 0)
   WHERE p.id = :pid;
END^

-- P_CheckAmmo: enough for a shot of the weapon in hand (the BFG's deh_bfg_cells_per_shot, the
-- super shotgun's 2, else 1; the fist and the chainsaw need none)? If not, the best weapon that
-- has some is pending, in DOOM's order (the super shotgun only with more than 2 shells, the BFG
-- more than 40 cells), and the weapon in hand goes down.
CREATE OR ALTER PROCEDURE check_ammo (pid SMALLINT, tic INTEGER)
RETURNS (ok SMALLINT)
AS
DECLARE weapon SMALLINT;
DECLARE ammo VARCHAR(8);
DECLARE have INTEGER;
DECLARE need INTEGER;
DECLARE down INTEGER;
DECLARE pending SMALLINT;
BEGIN
  SELECT p.weapon, wi.ammo, wi.down_state,
         CASE wi.ammo WHEN 'clip' THEN p.bullets WHEN 'shell' THEN p.shells WHEN 'misl' THEN p.rockets
                      WHEN 'cell' THEN p.cells END,
         CASE p.weapon WHEN 7 THEN (SELECT r.bfg_cells FROM rules r WHERE r.id = 1) WHEN 9 THEN 2 ELSE 1 END,
         CASE WHEN p.has_plasma = 1 AND p.cells > 0 THEN 6
              WHEN p.has_ssg = 1 AND p.shells > 2 THEN 9
              WHEN p.has_chaingun = 1 AND p.bullets > 0 THEN 4
              WHEN p.has_shotgun = 1 AND p.shells > 0 THEN 3
              WHEN p.bullets > 0 THEN 2
              WHEN p.has_chainsaw = 1 THEN 8
              WHEN p.has_launcher = 1 AND p.rockets > 0 THEN 5
              WHEN p.has_bfg = 1 AND p.cells > 40 THEN 7
              ELSE 1 END
    FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon WHERE p.id = :pid
    INTO weapon, ammo, down, have, need, pending;
  ok = 1;
  IF (ammo = 'noammo' OR have >= need) THEN EXIT;
  ok = 0;
  UPDATE player p SET pending_weapon = :pending WHERE p.id = :pid;
  EXECUTE PROCEDURE set_psprite(pid, 0, down, tic);
END^

-- P_FireWeapon: with the ammo for it, the body shoots (S_PLAY_ATK1), the weapon goes to its
-- attack state, and the noise wakes whatever hears it (P_NoiseAlert)
CREATE OR ALTER PROCEDURE fire_weapon (pid SMALLINT, tic INTEGER)
AS
DECLARE ok SMALLINT;
DECLARE tid INTEGER;
DECLARE sec INTEGER;
DECLARE alive SMALLINT;
BEGIN
  EXECUTE PROCEDURE check_ammo(pid, tic) RETURNING_VALUES ok;
  IF (ok = 0) THEN EXIT;
  SELECT p.thing_id, t.sector_id FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = :pid INTO tid, sec;
  EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_PLAY_ATK1'), tic) RETURNING_VALUES alive;
  EXECUTE PROCEDURE set_psprite(pid, 0, (SELECT wi.atk_state FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon
                                          WHERE p.id = :pid), tic);
  EXECUTE PROCEDURE noise_alert(sec, tic, pid);
END^

-- P_BringUpWeapon: the pending weapon (else the one in hand) starts up from WEAPONBOTTOM in its
-- up state; the chainsaw revs as it comes (DSSAWUP)
CREATE OR ALTER PROCEDURE bring_up_weapon (pid SMALLINT, tic INTEGER)
AS
DECLARE pending SMALLINT;
DECLARE tid INTEGER;
BEGIN
  SELECT IIF(p.pending_weapon = 0, p.weapon, p.pending_weapon), p.thing_id FROM player p WHERE p.id = :pid INTO pending, tid;
  IF (pending = 8) THEN
    EXECUTE PROCEDURE play_sound('DSSAWUP', tid, (SELECT t.x FROM things t WHERE t.id = :tid), (SELECT t.y FROM things t WHERE t.id = :tid));
  UPDATE player p SET pending_weapon = 0, psp_sy = 128 WHERE p.id = :pid;
  EXECUTE PROCEDURE set_psprite(pid, 0, (SELECT wi.up_state FROM weapon_info wi WHERE wi.weapon = :pending), tic);
END^

-- P_SetupPsprites (P_SpawnPlayer): no psprites, then the weapon in hand comes up; and the
-- view's flash light off
CREATE OR ALTER PROCEDURE setup_psprites (pid SMALLINT, tic INTEGER)
AS
BEGIN
  UPDATE player p SET psp_state = NULL, flash_state = NULL, pending_weapon = p.weapon, extralight = 0 WHERE p.id = :pid;
  EXECUTE PROCEDURE bring_up_weapon(pid, tic);
END^

-- P_BulletSlope: the slope to a target straight ahead, else 5.625° (1 << 26) to the left, else
-- as far to the right; 0 if none of the three finds one
CREATE OR ALTER PROCEDURE bullet_slope (tid INTEGER)
RETURNS (slope BIGINT)
AS
DECLARE an BIGINT;
DECLARE tgt INTEGER;
BEGIN
  SELECT bam_of(t.angle) FROM things t WHERE t.id = :tid INTO an;
  EXECUTE PROCEDURE aim_line_attack(tid, an, 67108864) RETURNING_VALUES slope, tgt;      -- (16 × 64 units)
  IF (tgt IS NULL) THEN
  BEGIN
    an = BIN_AND(an + 67108864, 4294967295);                                            -- (1 << 26)
    EXECUTE PROCEDURE aim_line_attack(tid, an, 67108864) RETURNING_VALUES slope, tgt;
    IF (tgt IS NULL) THEN
    BEGIN
      an = BIN_AND(an - 134217728, 4294967295);                                         -- (2 << 26)
      EXECUTE PROCEDURE aim_line_attack(tid, an, 67108864) RETURNING_VALUES slope, tgt;
    END
  END
END^

-- P_GunShot: 5 × (P_Random() % 3 + 1) along SLOPE, MISSILERANGE away; a little off line
-- (P_SubRandom() << 18) unless ACCURATE
CREATE OR ALTER PROCEDURE gun_shot (tid INTEGER, slope BIGINT, accurate SMALLINT)
AS
DECLARE dmg INTEGER;
DECLARE ang BIGINT;
DECLARE r INTEGER;
BEGIN
  dmg = 5 * (MOD(p_rand256(), 3) + 1);
  SELECT bam_of(t.angle) FROM things t WHERE t.id = :tid INTO ang;
  IF (accurate = 0) THEN
  BEGIN
    r = p_rand256();
    r = r - p_rand256();   -- (a variable: BIN_AND would draw twice)
    ang = BIN_AND(ang + r * 262144, 4294967295);                         -- (P_SubRandom() << 18)
  END
  EXECUTE PROCEDURE line_attack(tid, ang, 134217728, slope, dmg);                         -- (MISSILERANGE: 2048)
END^

-- A_Punch: (P_Random() % 10 + 1) × 2, ten times that when berserk, a little off line, at
-- MELEERANGE; a hit thuds (DSPUNCH) and turns the player to what was hit.
-- A_Saw: 2 × (P_Random() % 10 + 1) at MELEERANGE + 1; a miss whirs (DSSAWFUL); a hit bites
-- (DSSAWHIT) and pulls the player round towards it: from more than 4.5° (ANG90/20) off, to
-- within ANG90/21 of it, else 4.5° past.
CREATE OR ALTER PROCEDURE a_melee_weapon (pid SMALLINT, saw SMALLINT)
AS
DECLARE tid INTEGER;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE ang BIGINT;
DECLARE aim BIGINT;
DECLARE dmg INTEGER;
DECLARE slope BIGINT;
DECLARE tgt INTEGER;
DECLARE rng BIGINT;
DECLARE r INTEGER;
DECLARE a BIGINT;
DECLARE d BIGINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
BEGIN
  SELECT p.thing_id, fx_of(t.x), fx_of(t.y), bam_of(t.angle), t.x, t.y,
         2 * (MOD(p_rand256(), 10) + 1) * IIF(:saw = 0 AND p.strength_tics > 0, 10, 1)
    FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = :pid
    INTO tid, x, y, ang, px, py, dmg;
  rng = IIF(saw = 1, 4259840, 4194304);                -- (MELEERANGE + 1, MELEERANGE)
  r = p_rand256();
  r = r - p_rand256();   -- (a variable: BIN_AND would draw twice)
  aim = BIN_AND(ang + r * 262144, 4294967295);
  EXECUTE PROCEDURE aim_line_attack(tid, aim, rng) RETURNING_VALUES slope, tgt;
  EXECUTE PROCEDURE line_attack(tid, aim, rng, slope, dmg);
  IF (tgt IS NULL) THEN
  BEGIN
    IF (saw = 1) THEN EXECUTE PROCEDURE play_sound('DSSAWFUL', tid, px, py);
    EXIT;
  END
  EXECUTE PROCEDURE play_sound(IIF(saw = 1, 'DSSAWHIT', 'DSPUNCH'), tid, px, py);
  SELECT point_to_angle2(:x, :y, fx_of(t.x), fx_of(t.y)) FROM things t WHERE t.id = :tgt INTO a;
  IF (saw = 0) THEN ang = a;
  ELSE
  BEGIN
    -- (ANG90 is an int: -ANG90/20 compares signed)
    d = BIN_AND(a - ang, 4294967295);
    IF (d > 2147483648) THEN
    BEGIN
      IF (fx32(d) < -53687091) THEN ang = a + 51130563; ELSE ang = ang - 53687091;
    END
    ELSE
    BEGIN
      IF (d > 53687091) THEN ang = a - 51130563; ELSE ang = ang + 53687091;
    END
  END
  -- (the saw also pulls the player on: MF_JUSTATTACKED, P_PlayerThink's lunge)
  UPDATE things t SET angle = rad_of(BIN_AND(:ang, 4294967295)), just_attacked = IIF(:saw = 1, 1, t.just_attacked) WHERE t.id = :tid;
END^

-- A_FirePistol, A_FireShotgun, A_FireShotgun2, A_FireCGun: the shot's sound, the body's flash
-- (S_PLAY_ATK2), the ammo, the muzzle flash (the chaingun's matching the frame it fires in),
-- P_BulletSlope, then the shots: the pistol's and the chaingun's one, dead on if it's the
-- first of a burst (!refire); the shotgun's 7; the super shotgun's 20, each a little off in
-- both directions (P_SubRandom() << 19 across, << 5 in the slope). The chaingun with no
-- bullets left only clicks (its sound comes before the check).
CREATE OR ALTER PROCEDURE a_fire_gun (pid SMALLINT, kind VARCHAR(8), tic INTEGER)
AS
DECLARE tid INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE slope BIGINT;
DECLARE refire INTEGER;
DECLARE flash INTEGER;
DECLARE i INTEGER;
DECLARE dmg INTEGER;
DECLARE a BIGINT;
DECLARE sl BIGINT;
DECLARE r1 INTEGER;
DECLARE hit SMALLINT;
DECLARE alive SMALLINT;
BEGIN
  SELECT p.thing_id, t.x, t.y, t.z, t.angle, p.refire,
         wi.flash_state + IIF(:kind = 'cgun', p.psp_state - (SELECT s.id FROM states s WHERE s.name = 'S_CHAIN1'), 0)
    FROM player p JOIN things t ON t.id = p.thing_id JOIN weapon_info wi ON wi.weapon = p.weapon WHERE p.id = :pid
    INTO tid, x, y, z, ang, refire, flash;
  EXECUTE PROCEDURE play_sound(CASE kind WHEN 'shotgun' THEN 'DSSHOTGN' WHEN 'shotgun2' THEN 'DSDSHTGN' ELSE 'DSPISTOL' END, tid, x, y);
  IF (kind = 'cgun' AND (SELECT p.bullets FROM player p WHERE p.id = :pid) = 0) THEN EXIT;
  EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_PLAY_ATK2'), tic) RETURNING_VALUES alive;
  EXECUTE PROCEDURE decrease_ammo(pid, IIF(kind = 'shotgun2', 2, 1));
  EXECUTE PROCEDURE set_psprite(pid, 1, flash, tic);
  EXECUTE PROCEDURE bullet_slope(tid) RETURNING_VALUES slope;
  IF (kind = 'shotgun2') THEN
  BEGIN
    i = 0;
    WHILE (i < 20) DO
    BEGIN
      dmg = 5 * (MOD(p_rand256(), 3) + 1);
      r1 = p_rand256();
      r1 = r1 - p_rand256();   -- (a variable: BIN_AND would draw twice)
      a = BIN_AND(bam_of(ang) + r1 * 524288, 4294967295);             -- (P_SubRandom() << ANGLETOFINESHIFT)
      r1 = p_rand256();
      sl = slope + (r1 - p_rand256()) * 32;                                            -- (P_SubRandom() << 5)
      EXECUTE PROCEDURE line_attack(tid, a, 134217728, sl, dmg);
      i = i + 1;
    END
  END
  ELSE
  BEGIN
    i = 0;
    WHILE (i < IIF(kind = 'shotgun', 7, 1)) DO
    BEGIN
      EXECUTE PROCEDURE gun_shot(tid, slope, IIF(kind <> 'shotgun' AND refire = 0, 1, 0));
      i = i + 1;
    END
  END
END^

-- A_FireMissile, A_FirePlasma, A_FireBFG: the ammo (the BFG's deh_bfg_cells_per_shot), the
-- plasma rifle's flash (one of its two, P_Random() & 1), then P_SpawnPlayerMissile and the
-- missile's own sound (the rocket's DSRLAUNC, the plasma's DSPLASMA; the BFG's ball has none:
-- its sound came with A_BFGsound)
CREATE OR ALTER PROCEDURE a_fire_projectile (pid SMALLINT, mtype INTEGER, tic INTEGER)
AS
DECLARE tid INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE decrease_ammo(pid, IIF(mtype = 9005, (SELECT r.bfg_cells FROM rules r WHERE r.id = 1), 1));
  IF (mtype = 9004) THEN
    EXECUTE PROCEDURE set_psprite(pid, 1, (SELECT wi.flash_state FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon
                                            WHERE p.id = :pid) + p_rand_and(1), tic);
  SELECT p.thing_id, t.x, t.y, t.z, t.angle FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = :pid
    INTO tid, x, y, z, ang;
  EXECUTE PROCEDURE fire_missile(mtype, tid, x, y, z, ang);
  EXECUTE PROCEDURE play_sound((SELECT mt.see_snd FROM thing_types mt WHERE mt.thing_type = :mtype), tid, x, y);
END^

-- A_WeaponReady: out of the shooting frames the body stands (S_PLAY); the chainsaw idles
-- (DSSAWIDL, in S_SAW); a pending weapon, or no health, puts this one down; the trigger fires
-- (P_FireWeapon) – the rocket launcher and the BFG once a press (attackdown); else the weapon
-- sways with the player's bob: sx = 1 + bob·cos, sy = WEAPONTOP + bob·sin of (128 × leveltime)
-- in DOOM's 8192 fine angles, the sine's taken over the first half only
CREATE OR ALTER PROCEDURE a_weapon_ready (pid SMALLINT, tic INTEGER)
AS
DECLARE tid INTEGER;
DECLARE weapon SMALLINT;
DECLARE pending SMALLINT;
DECLARE health INTEGER;
DECLARE fire SMALLINT;
DECLARE down SMALLINT;
DECLARE bob DOUBLE PRECISION;
DECLARE psp INTEGER;
DECLARE body INTEGER;
DECLARE down_st INTEGER;
DECLARE alive SMALLINT;
DECLARE a INTEGER;
BEGIN
  SELECT p.thing_id, p.weapon, p.pending_weapon, p.health, p.buttons, p.attack_down, p.bob, p.psp_state, t.state, wi.down_state
    FROM player p JOIN things t ON t.id = p.thing_id JOIN weapon_info wi ON wi.weapon = p.weapon WHERE p.id = :pid
    INTO tid, weapon, pending, health, fire, down, bob, psp, body, down_st;
  IF (EXISTS (SELECT 1 FROM states s WHERE s.id = :body AND s.name IN ('S_PLAY_ATK1', 'S_PLAY_ATK2'))) THEN
    EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_PLAY'), tic) RETURNING_VALUES alive;
  IF (weapon = 8 AND EXISTS (SELECT 1 FROM states s WHERE s.id = :psp AND s.name = 'S_SAW')) THEN
    EXECUTE PROCEDURE play_sound('DSSAWIDL', tid, (SELECT t.x FROM things t WHERE t.id = :tid), (SELECT t.y FROM things t WHERE t.id = :tid));
  IF (pending <> 0 OR health <= 0) THEN
  BEGIN
    EXECUTE PROCEDURE set_psprite(pid, 0, down_st, tic);
    EXIT;
  END
  IF (fire = 1) THEN
  BEGIN
    IF (down = 0 OR weapon NOT IN (5, 7)) THEN
    BEGIN
      UPDATE player p SET attack_down = 1 WHERE p.id = :pid;
      EXECUTE PROCEDURE fire_weapon(pid, tic);
      EXIT;
    END
  END
  ELSE UPDATE player p SET attack_down = 0 WHERE p.id = :pid;
  a = MOD(128 * tic, 8192);
  UPDATE player p SET psp_sx = 1 + :bob * COS(:a * PI() / 4096), psp_sy = 32 + :bob * SIN(MOD(:a, 4096) * PI() / 4096)
   WHERE p.id = :pid;
END^

-- A_ReFire: the trigger still held (and no weapon pending, and alive), another shot, counted
-- (refire); let go, the count starts over and P_CheckAmmo looks at what's left
CREATE OR ALTER PROCEDURE a_refire (pid SMALLINT, tic INTEGER)
AS
DECLARE ok SMALLINT;
BEGIN
  IF (EXISTS (SELECT 1 FROM player p WHERE p.id = :pid AND p.buttons = 1 AND p.pending_weapon = 0 AND p.health > 0)) THEN
  BEGIN
    UPDATE player p SET refire = p.refire + 1 WHERE p.id = :pid;
    EXECUTE PROCEDURE fire_weapon(pid, tic);
  END
  ELSE
  BEGIN
    UPDATE player p SET refire = 0 WHERE p.id = :pid;
    EXECUTE PROCEDURE check_ammo(pid, tic) RETURNING_VALUES ok;
  END
END^

-- A_Lower: down LOWERSPEED (6) a tic; at WEAPONBOTTOM (128) a dead player's stays there, and
-- otherwise the pending weapon is taken in hand and comes up (P_BringUpWeapon)
CREATE OR ALTER PROCEDURE a_lower (pid SMALLINT, tic INTEGER)
AS
DECLARE sy DOUBLE PRECISION;
DECLARE dead SMALLINT;
DECLARE health INTEGER;
BEGIN
  UPDATE player p SET psp_sy = p.psp_sy + 6 WHERE p.id = :pid RETURNING p.psp_sy, p.dead, p.health INTO sy, dead, health;
  IF (sy < 128) THEN EXIT;
  IF (dead = 1) THEN
  BEGIN
    UPDATE player p SET psp_sy = 128 WHERE p.id = :pid;
    EXIT;
  END
  IF (health <= 0) THEN
  BEGIN
    EXECUTE PROCEDURE set_psprite(pid, 0, 0, tic);
    EXIT;
  END
  UPDATE player p SET weapon = p.pending_weapon WHERE p.id = :pid;
  EXECUTE PROCEDURE bring_up_weapon(pid, tic);
END^

-- A_Raise: up RAISESPEED (6) a tic; at WEAPONTOP (32), ready (the weapon's ready state)
CREATE OR ALTER PROCEDURE a_raise (pid SMALLINT, tic INTEGER)
AS
DECLARE sy DOUBLE PRECISION;
BEGIN
  UPDATE player p SET psp_sy = p.psp_sy - 6 WHERE p.id = :pid RETURNING p.psp_sy INTO sy;
  IF (sy > 32) THEN EXIT;
  UPDATE player p SET psp_sy = 32 WHERE p.id = :pid;
  EXECUTE PROCEDURE set_psprite(pid, 0, (SELECT wi.ready_state FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon
                                          WHERE p.id = :pid), tic);
END^

-- The weapons' actions, by name (a psprite's state's action, P_SetPsprite calls it)
CREATE OR ALTER PROCEDURE psprite_action (pid SMALLINT, pos SMALLINT, act VARCHAR(24), tic INTEGER)
AS
DECLARE ok SMALLINT;
DECLARE tid INTEGER;
DECLARE alive SMALLINT;
BEGIN
  IF (act = 'A_WeaponReady') THEN EXECUTE PROCEDURE a_weapon_ready(pid, tic);
  ELSE IF (act = 'A_ReFire') THEN EXECUTE PROCEDURE a_refire(pid, tic);
  ELSE IF (act = 'A_CheckReload') THEN EXECUTE PROCEDURE check_ammo(pid, tic) RETURNING_VALUES ok;
  ELSE IF (act = 'A_Lower') THEN EXECUTE PROCEDURE a_lower(pid, tic);
  ELSE IF (act = 'A_Raise') THEN EXECUTE PROCEDURE a_raise(pid, tic);
  ELSE IF (act = 'A_GunFlash') THEN
  BEGIN
    -- A_GunFlash: the body's flash (S_PLAY_ATK2) and the weapon's muzzle flash
    SELECT p.thing_id FROM player p WHERE p.id = :pid INTO tid;
    EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_PLAY_ATK2'), tic) RETURNING_VALUES alive;
    EXECUTE PROCEDURE set_psprite(pid, 1, (SELECT wi.flash_state FROM player p JOIN weapon_info wi ON wi.weapon = p.weapon
                                            WHERE p.id = :pid), tic);
  END
  ELSE IF (act = 'A_Punch') THEN EXECUTE PROCEDURE a_melee_weapon(pid, 0);
  ELSE IF (act = 'A_Saw') THEN EXECUTE PROCEDURE a_melee_weapon(pid, 1);
  ELSE IF (act = 'A_FirePistol') THEN EXECUTE PROCEDURE a_fire_gun(pid, 'pistol', tic);
  ELSE IF (act = 'A_FireShotgun') THEN EXECUTE PROCEDURE a_fire_gun(pid, 'shotgun', tic);
  ELSE IF (act = 'A_FireShotgun2') THEN EXECUTE PROCEDURE a_fire_gun(pid, 'shotgun2', tic);
  ELSE IF (act = 'A_FireCGun') THEN EXECUTE PROCEDURE a_fire_gun(pid, 'cgun', tic);
  ELSE IF (act = 'A_FireMissile') THEN EXECUTE PROCEDURE a_fire_projectile(pid, 9003, tic);
  ELSE IF (act = 'A_FirePlasma') THEN EXECUTE PROCEDURE a_fire_projectile(pid, 9004, tic);
  ELSE IF (act = 'A_FireBFG') THEN EXECUTE PROCEDURE a_fire_projectile(pid, 9005, tic);
  -- A_Light0, A_Light1, A_Light2: the muzzle flash lights the view (player->extralight)
  ELSE IF (act IN ('A_Light0', 'A_Light1', 'A_Light2')) THEN
    UPDATE player p SET extralight = CAST(SUBSTRING(:act FROM 8 FOR 1) AS SMALLINT) WHERE p.id = :pid;
  -- A_BFGsound, A_OpenShotgun2, A_LoadShotgun2; A_CloseShotgun2's sound, then A_ReFire
  ELSE IF (act IN ('A_BFGsound', 'A_OpenShotgun2', 'A_LoadShotgun2', 'A_CloseShotgun2')) THEN
  BEGIN
    SELECT p.thing_id FROM player p WHERE p.id = :pid INTO tid;
    EXECUTE PROCEDURE play_sound(TRIM(CASE act WHEN 'A_BFGsound' THEN 'DSBFG' WHEN 'A_OpenShotgun2' THEN 'DSDBOPN'
                                               WHEN 'A_LoadShotgun2' THEN 'DSDBLOAD' ELSE 'DSDBCLS' END),
                                 tid, (SELECT t.x FROM things t WHERE t.id = :tid), (SELECT t.y FROM things t WHERE t.id = :tid));
    IF (act = 'A_CloseShotgun2') THEN EXECUTE PROCEDURE a_refire(pid, tic);
  END
END^

-- P_SetPsprite: psprite POS into state ST – its tics start, a state with misc1 places the weapon
-- (sx, sy = misc1, misc2), then its action is called; a 0-tic state goes straight on to the
-- next, and S_NULL (0) takes the psprite away
CREATE OR ALTER PROCEDURE set_psprite (pid SMALLINT, pos SMALLINT, st INTEGER, tic INTEGER)
AS
DECLARE tics INTEGER;
DECLARE act VARCHAR(24);
DECLARE m1 INTEGER;
DECLARE m2 INTEGER;
DECLARE cur INTEGER;
DECLARE n INTEGER = 0;
BEGIN
  WHILE (n < 100) DO   -- (a ring of 0-tic states would hang DOOM; here it stops)
  BEGIN
    n = n + 1;
    IF (st IS NULL OR st = 0) THEN
    BEGIN
      IF (pos = 0) THEN UPDATE player p SET psp_state = NULL WHERE p.id = :pid;
      ELSE UPDATE player p SET flash_state = NULL WHERE p.id = :pid;
      EXIT;
    END
    SELECT s.tics, s.action, s.misc1, s.misc2 FROM states s WHERE s.id = :st INTO tics, act, m1, m2;
    IF (pos = 0) THEN
      UPDATE player p SET psp_state = :st, psp_tics = :tics,
                          psp_sx = IIF(:m1 <> 0, :m1, p.psp_sx), psp_sy = IIF(:m1 <> 0, :m2, p.psp_sy)
       WHERE p.id = :pid;
    ELSE UPDATE player p SET flash_state = :st, flash_tics = :tics WHERE p.id = :pid;
    IF (act IS NOT NULL) THEN EXECUTE PROCEDURE psprite_action(pid, pos, act, tic);
    -- (the action may have set another state, or none)
    SELECT IIF(:pos = 0, p.psp_state, p.flash_state), IIF(:pos = 0, p.psp_tics, p.flash_tics)
      FROM player p WHERE p.id = :pid INTO cur, tics;
    IF (cur IS NULL OR tics <> 0) THEN EXIT;
    SELECT s.next_state FROM states s WHERE s.id = :cur INTO st;
  END
END^

-- P_MovePsprites: each psprite's tics count down (a state of -1 tics lasts), and at 0 it goes
-- on to its next state; the weapon first, then the flash (which the weapon may just have lit)
CREATE OR ALTER PROCEDURE move_psprites (pid SMALLINT, tic INTEGER)
AS
DECLARE st INTEGER;
DECLARE tics INTEGER;
BEGIN
  SELECT p.psp_state, p.psp_tics FROM player p WHERE p.id = :pid INTO st, tics;
  IF (st IS NOT NULL AND tics <> -1) THEN
  BEGIN
    UPDATE player p SET psp_tics = :tics - 1 WHERE p.id = :pid;
    IF (tics - 1 = 0) THEN
      EXECUTE PROCEDURE set_psprite(pid, 0, (SELECT s.next_state FROM states s WHERE s.id = :st), tic);
  END
  SELECT p.flash_state, p.flash_tics FROM player p WHERE p.id = :pid INTO st, tics;
  IF (st IS NOT NULL AND tics <> -1) THEN
  BEGIN
    UPDATE player p SET flash_tics = :tics - 1 WHERE p.id = :pid;
    IF (tics - 1 = 0) THEN
      EXECUTE PROCEDURE set_psprite(pid, 1, (SELECT s.next_state FROM states s WHERE s.id = :st), tic);
  END
END^

CREATE OR ALTER PROCEDURE deathmatch_spot (pid SMALLINT, old INTEGER)
RETURNS (sx DOUBLE PRECISION, sy DOUBLE PRECISION, sa DOUBLE PRECISION)
AS
DECLARE n INTEGER;
DECLARE k INTEGER;
DECLARE tries INTEGER;
BEGIN
  SELECT COUNT(*) FROM map_things m WHERE m.ttype = 11 INTO n;
  tries = 0;
  WHILE (n > 0 AND tries < 20) DO
  BEGIN
    k = FLOOR(p_random() * 256);
    k = MOD(k, n);
    SELECT FIRST 1 SKIP (:k) m.x, m.y, TRUNC(m.angle / 45) * PI() / 4 FROM map_things m WHERE m.ttype = 11 ORDER BY m.id
      INTO sx, sy, sa;
    IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.solid = 1 AND t.id <> COALESCE(:old, -1)
                     AND ABS(t.x - :sx) < t.radius + 16 AND ABS(t.y - :sy) < t.radius + 16)) THEN
    BEGIN
      SUSPEND;
      EXIT;
    END
    tries = tries + 1;
  END
  sx = NULL;
  SELECT FIRST 1 m.x, m.y, TRUNC(m.angle / 45) * PI() / 4 FROM map_things m WHERE m.ttype BETWEEN 1 AND 4
   ORDER BY IIF(m.ttype = :pid, 0, 1), m.ttype INTO sx, sy, sa;
  SUSPEND;
END^

-- comes back at their own start (another player's if theirs is taken, as
-- G_CheckSpot has it), in a flash of teleport fog, with the pistol, 50 bullets
-- and nothing else; kills, items and secrets stay. The body stays behind.
CREATE OR ALTER PROCEDURE reborn_player (pid SMALLINT)
AS
DECLARE old INTEGER;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sa DOUBLE PRECISION;
DECLARE nid INTEGER;
DECLARE fog INTEGER;
BEGIN
  SELECT p.thing_id FROM player p WHERE p.id = :pid INTO old;
  IF ((SELECT g.deathmatch FROM game g WHERE g.id = 1) > 0) THEN
    SELECT d.sx, d.sy, d.sa FROM deathmatch_spot(:pid, :old) d INTO sx, sy, sa;
  ELSE
  FOR SELECT m.x, m.y, TRUNC(m.angle / 45) * PI() / 4 FROM map_things m
       WHERE m.ttype BETWEEN 1 AND 4
       ORDER BY IIF(m.ttype = :pid, 0, 1), m.ttype
        INTO sx, sy, sa
  DO
  BEGIN
    IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.solid = 1 AND t.id <> :old
                     AND ABS(t.x - :sx) < t.radius + 16 AND ABS(t.y - :sy) < t.radius + 16)) THEN LEAVE;
  END
  IF (sx IS NULL) THEN EXIT;
  -- the old body: a corpse like any other
  -- (its death states play on to the last: ST follows them, 'dying' then 'dead')
  UPDATE things t SET kind = 'decor', solid = 0 WHERE t.id = :old;
  EXECUTE PROCEDURE spawn_thing(1, sx, sy, NULL, sa) RETURNING_VALUES nid;
  UPDATE things t SET flags = 0, translation = :pid - 1, hp = (SELECT r.init_health FROM rules r WHERE r.id = 1) WHERE t.id = :nid;
  EXECUTE PROCEDURE spawn_thing(9016, sx + 20 * COS(sa), sy + 20 * SIN(sa), NULL, 0) RETURNING_VALUES fog;
  EXECUTE PROCEDURE play_sound('DSTELEPT', fog, sx + 20 * COS(sa), sy + 20 * SIN(sa));
  UPDATE player p
     SET thing_id = :nid, health = (SELECT r.init_health FROM rules r WHERE r.id = 1), armor = 0, armor_type = 0,
         dead = 0, weapon = 2, pending_weapon = 0, refire = 0, attack_down = 1, attacker_id = NULL,
         bullets = (SELECT r.init_bullets FROM rules r WHERE r.id = 1), shells = 0, rockets = 0, cells = 0,
         has_shotgun = 0, has_chaingun = 0, has_launcher = 0, has_plasma = 0, has_bfg = 0, has_chainsaw = 0, has_ssg = 0,
         max_bullets = (SELECT r.max_bullets FROM rules r WHERE r.id = 1), max_shells = (SELECT r.max_shells FROM rules r WHERE r.id = 1),
         max_rockets = (SELECT r.max_rockets FROM rules r WHERE r.id = 1), max_cells = (SELECT r.max_cells FROM rules r WHERE r.id = 1),
         keycards = IIF((SELECT g.deathmatch FROM game g WHERE g.id = 1) > 0, 7, 0),   -- (P_SpawnPlayer: every card in deathmatch)
         damage_count = 0, bonus_count = 0, msg = NULL, msg_tics = 0, view_h = 41, delta_vh = 0,
         view_z = (SELECT t.z FROM things t WHERE t.id = :nid) + 41, use_down = 1,
         invis_tics = 0, invuln_tics = 0, iron_tics = 0, infra_tics = 0, strength_tics = 0, allmap = 0
   WHERE p.id = :pid;
  -- (G_PlayerReborn: attackdown, so the trigger held from before doesn't fire; P_SetupPsprites)
  EXECUTE PROCEDURE setup_psprites(pid, (SELECT g.tic FROM game g WHERE g.id = 1));
END^

-- ── the player's movement, as DOOM's ─────────────────────────────────────
-- P_MovePlayer's thrust and P_MobjThinker's P_XYMovement / P_ZMovement for a player, in 16.16
-- (the sums above), through the map's own BLOCKMAP in its order: P_TryMove, P_CheckPosition,
-- P_SlideMove's traced slide. A player is 16 units round and 56 tall, and steps up 24.

-- (TOUCH_SPECIALS, P_TouchSpecialThing, declared here for CHECK_POSITION_FX; its body comes with
-- the player's other steps)
CREATE OR ALTER PROCEDURE touch_specials (pid SMALLINT, tic INTEGER, at_x DOUBLE PRECISION = NULL, at_y DOUBLE PRECISION = NULL,
                                           only_item INTEGER = NULL)
AS
BEGIN
END^

-- P_CheckPosition for a player at (X, Y): the floor and ceiling of the subsector it's in, then
-- the things in the blocks around (a solid one closer than both radii stops it; PIT_CheckThing,
-- in the blocks MAXRADIUS around, so a thing wider than that can be walked into), then the
-- lines in the blocks its box touches, each once, in the BLOCKMAP's order (PIT_CheckLine): a
-- one-sided or blocking line its box straddles stops it; any other narrows the floor and
-- ceiling to the opening (P_LineOpening), and one with a special goes on SPECHIT – the list is
-- kept last first, the order P_TryMove takes them in. NOCLIP: the subsector's floor and ceiling,
-- and yes. THINGS 0: the lines alone (P_ThingHeightClip, a teleport's landing). MONSTER 1: a
-- line with ML_BLOCKMONSTERS stops it too. MISSILE 1: only a one-sided line stops it, and the
-- line that brought the ceiling lowest is CEILINGLINE (a context variable, DOOM's global).
CREATE OR ALTER PROCEDURE check_position_fx (
  tid INTEGER, x BIGINT, y BIGINT, rad BIGINT, noclip SMALLINT, things SMALLINT = 1, monster SMALLINT = 0, missile SMALLINT = 0)
RETURNS (ok SMALLINT, floorz BIGINT, ceilz BIGINT, dropoffz BIGINT, spechit VARCHAR(4000))
AS
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE xl INTEGER;
DECLARE xh INTEGER;
DECLARE yl INTEGER;
DECLARE yh INTEGER;
DECLARE sec INTEGER;
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lslope SMALLINT;
DECLARE lflags INTEGER;
DECLARE lspecial INTEGER;
DECLARE lback INTEGER;
DECLARE lminx DOUBLE PRECISION;
DECLARE lmaxx DOUBLE PRECISION;
DECLARE lminy DOUBLE PRECISION;
DECLARE lmaxy DOUBLE PRECISION;
DECLARE ff DOUBLE PRECISION;
DECLARE fc DOUBLE PRECISION;
DECLARE bf DOUBLE PRECISION;
DECLARE bc DOUBLE PRECISION;
DECLARE opentop BIGINT;
DECLARE openbottom BIGINT;
DECLARE lowfloor BIGINT;
DECLARE pid SMALLINT;
DECLARE tk_id INTEGER;
DECLARE tk_kind VARCHAR(10);
DECLARE tk_solid SMALLINT;
BEGIN
  ok = 1;
  spechit = '';
  sec = sector_at_fx(x, y);
  SELECT fx_of(s.floor_h), fx_of(s.ceil_h) FROM sectors s WHERE s.id = :sec INTO floorz, ceilz;
  dropoffz = floorz;
  IF (noclip = 1) THEN EXIT;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  IF (things = 1) THEN
  BEGIN
    xl = BIN_SHR(x - rad - orgx - 2097152, 23);    -- (MAXRADIUS: 32 units)
    xh = BIN_SHR(x + rad - orgx + 2097152, 23);
    yl = BIN_SHR(y - rad - orgy - 2097152, 23);
    yh = BIN_SHR(y + rad - orgy + 2097152, 23);
    -- PIT_CheckThing over the blocks, column by column, each block's things newest-linked first:
    -- a pickup (MF_SPECIAL) a player's body touches (MF_PICKUP) – wherever a move tries, the move
    -- may yet fail; the first solid thing stops it, and what comes after isn't touched
    pid = NULL;
    SELECT p.id FROM player p WHERE p.thing_id = :tid INTO pid;
    FOR SELECT t.id, t.kind, t.solid FROM things t
         WHERE t.x BETWEEN (:x - :rad) / 65536e0 - 160 AND (:x + :rad) / 65536e0 + 160
           AND (t.solid = 1 OR (t.kind = 'item' AND :pid IS NOT NULL)) AND t.id <> :tid
           AND ABS(fx_of(t.x) - :x) < fx_of(t.radius) + :rad
           AND ABS(fx_of(t.y) - :y) < fx_of(t.radius) + :rad
           AND BIN_SHR(fx_of(t.x) - :orgx, 23) BETWEEN MAXVALUE(:xl, 0) AND MINVALUE(:xh, :bw - 1)
           AND BIN_SHR(fx_of(t.y) - :orgy, 23) BETWEEN MAXVALUE(:yl, 0) AND MINVALUE(:yh, :bh - 1)
         ORDER BY BIN_SHR(fx_of(t.x) - :orgx, 23), BIN_SHR(fx_of(t.y) - :orgy, 23), t.link_seq DESC
          INTO tk_id, tk_kind, tk_solid
    DO
    BEGIN
      IF (tk_kind = 'item' AND pid IS NOT NULL) THEN
        EXECUTE PROCEDURE touch_specials(pid, (SELECT g.tic FROM game g WHERE g.id = 1), :x / 65536e0, :y / 65536e0, tk_id);
      IF (tk_solid = 1) THEN
      BEGIN
        ok = 0;
        EXIT;
      END
    END
  END
  xl = BIN_SHR(x - rad - orgx, 23);
  xh = BIN_SHR(x + rad - orgx, 23);
  yl = BIN_SHR(y - rad - orgy, 23);
  yh = BIN_SHR(y + rad - orgy, 23);
  FOR SELECT l.id, l.fx, l.fy, l.fdx, l.fdy, l.slope, l.flags, l.special, l.back_sector,
             l.minx, l.maxx, l.miny, l.maxy, fs.floor_h, fs.ceil_h, bs.floor_h, bs.ceil_h
        FROM (SELECT b.line_id, b.bx, b.by_, b.seq,
                     ROW_NUMBER() OVER (PARTITION BY b.line_id ORDER BY b.bx, b.by_, b.seq) rn
                FROM blockmap b
               WHERE b.bx BETWEEN :xl AND :xh AND b.by_ BETWEEN :yl AND :yh) q
        JOIN linedefs l ON l.id = q.line_id
        LEFT JOIN sectors fs ON fs.id = l.front_sector
        LEFT JOIN sectors bs ON bs.id = l.back_sector
       WHERE q.rn = 1
       ORDER BY q.bx, q.by_, q.seq
        INTO lid, lx, ly, ldx, ldy, lslope, lflags, lspecial, lback, lminx, lmaxx, lminy, lmaxy, ff, fc, bf, bc
  DO
  BEGIN
    IF (x + rad <= fx_of(lminx) OR x - rad >= fx_of(lmaxx) OR y + rad <= fx_of(lminy) OR y - rad >= fx_of(lmaxy)) THEN CONTINUE;
    IF (box_on_line_side(y + rad, y - rad, x - rad, x + rad, lx, ly, ldx, ldy, lslope) <> -1) THEN CONTINUE;
    -- one-sided, or ML_BLOCKING; for a monster, ML_BLOCKMONSTERS; a missile, only one-sided
    IF (lback IS NULL OR (missile = 0 AND (BIN_AND(lflags, 1) = 1 OR (monster = 1 AND BIN_AND(lflags, 2) = 2)))) THEN
    BEGIN
      ok = 0;
      EXIT;
    END
    opentop = MINVALUE(fx_of(fc), fx_of(bc));
    openbottom = MAXVALUE(fx_of(ff), fx_of(bf));
    lowfloor = MINVALUE(fx_of(ff), fx_of(bf));
    IF (opentop < ceilz) THEN
    BEGIN
      ceilz = opentop;
      -- (ceilingline: for a missile's sky hack, P_XYMovement)
      IF (missile = 1) THEN RDB$SET_CONTEXT('USER_TRANSACTION', 'CEILINGLINE', lid);
    END
    IF (openbottom > floorz) THEN floorz = openbottom;
    IF (lowfloor < dropoffz) THEN dropoffz = lowfloor;
    IF (lspecial <> 0) THEN spechit = lid || ',' || spechit;
  END
END^

-- P_ThingHeightClip: TID's floor and ceiling found again where it stands (P_CheckPosition: the
-- lines its box touches, as far as they go – a solid thing in the way leaves them its
-- subsector's; a player touches the pickups there), kept as its own; on its floor before, it
-- rides it; else the ceiling may push it down. → FITS 0: the gap is now lower than it is tall.
CREATE OR ALTER PROCEDURE thing_height_clip (tid INTEGER)
RETURNS (fits SMALLINT)
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE h BIGINT;
DECLARE rad BIGINT;
DECLARE fz0 BIGINT;
DECLARE noclip SMALLINT;
DECLARE isp SMALLINT;
DECLARE ok SMALLINT;
DECLARE fz BIGINT;
DECLARE cz BIGINT;
DECLARE dz BIGINT;
DECLARE spec VARCHAR(4000);
BEGIN
  fits = 1;
  x = NULL;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.height), fx_of(t.radius), fx_of(t.floorz),
         COALESCE((SELECT p.noclip FROM player p WHERE p.thing_id = t.id), 0), IIF(t.kind = 'player', 1, 0)
    FROM things t WHERE t.id = :tid INTO x, y, z, h, rad, fz0, noclip, isp;
  IF (x IS NULL) THEN EXIT;
  EXECUTE PROCEDURE check_position_fx(tid, x, y, rad, noclip, 1, 1 - isp) RETURNING_VALUES ok, fz, cz, dz, spec;
  -- (onfloor: z == floorz, the floor it had; walking monsters rise and fall with it)
  IF (z = COALESCE(fz0, z)) THEN z = fz;
  ELSE IF (z + h > cz) THEN z = cz - h;
  UPDATE things t SET z = :z / 65536e0, floorz = :fz / 65536e0, ceilz = :cz / 65536e0, fz_x = t.x, fz_y = t.y
   WHERE t.id = :tid;
  IF (cz - fz < h) THEN fits = 0;
END^

-- P_ChangeSector: every thing in the blocks around sector SID (its block box, MAXRADIUS wider:
-- SECTORS.BB_*), column by column, each block's newest-linked first, looks again at its floor and
-- ceiling (PIT_ChangeSector, P_ThingHeightClip). One that no longer fits: a corpse is crunched
-- to gibs (S_GIBS, not solid, no height or radius), a dropped item is gone, a shootable thing
-- doesn't fit (NOFIT) – and with CRUNCH, every fourth tic, it takes 10 (P_DamageMobj, from
-- nothing) and bleeds: MT_BLOOD half way up it, thrown P_SubRandom() << 12 each way.
-- (Missiles, puffs, blood, fire and fog aren't in the blockmap: MF_NOBLOCKMAP.)
CREATE OR ALTER PROCEDURE change_sector (sid INTEGER, crunch SMALLINT)
RETURNS (nofit SMALLINT)
AS
DECLARE xl INTEGER;
DECLARE xh INTEGER;
DECLARE yl INTEGER;
DECLARE yh INTEGER;
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE tic INTEGER;
DECLARE tid INTEGER;
DECLARE fits SMALLINT;
DECLARE hp INTEGER;
DECLARE flags INTEGER;
DECLARE shoot SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE bz BIGINT;
DECLARE pid SMALLINT;
DECLARE mid INTEGER;
DECLARE r INTEGER;
DECLARE alive SMALLINT;
BEGIN
  nofit = 0;
  SELECT s.bb_xl, s.bb_xh, s.bb_yl, s.bb_yh FROM sectors s WHERE s.id = :sid INTO xl, xh, yl, yh;
  IF (xl IS NULL) THEN EXIT;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536 FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  FOR SELECT t.id FROM things t
       WHERE t.x >= (:orgx + :xl * 8388608) / 65536e0 AND t.x < (:orgx + (:xh + 1) * 8388608) / 65536e0
         AND t.y >= (:orgy + :yl * 8388608) / 65536e0 AND t.y < (:orgy + (:yh + 1) * 8388608) / 65536e0
         AND t.kind NOT IN ('missile', 'fx', 'flame', 'marker', 'cube')
       ORDER BY BIN_SHR(fx_of(t.x) - :orgx, 23), BIN_SHR(fx_of(t.y) - :orgy, 23), t.link_seq DESC
        INTO tid
  DO
  BEGIN
    IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid)) THEN CONTINUE;
    EXECUTE PROCEDURE thing_height_clip(tid) RETURNING_VALUES fits;
    IF (fits = 1) THEN CONTINUE;
    SELECT COALESCE(t.hp, 1000), t.flags,
           IIF((t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.state IS NOT NULL)
               OR (t.kind = 'player' AND t.solid = 1), 1, 0),
           t.x, t.y, fx_of(t.z) + fx_of(t.height) / 2
      FROM things t WHERE t.id = :tid INTO hp, flags, shoot, x, y, bz;
    IF (hp <= 0) THEN
    BEGIN
      -- (crunch bodies to giblets)
      EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_GIBS'), tic) RETURNING_VALUES alive;
      UPDATE things t SET solid = 0, height = 0, radius = 0 WHERE t.id = :tid;
      CONTINUE;
    END
    IF (BIN_AND(flags, 65536) <> 0) THEN
    BEGIN
      DELETE FROM things t WHERE t.id = :tid;   -- (crunch dropped items)
      CONTINUE;
    END
    IF (shoot = 0) THEN CONTINUE;
    nofit = 1;
    IF (crunch = 1 AND MOD(tic, 4) = 0) THEN
    BEGIN
      pid = NULL;
      SELECT p.id FROM player p WHERE p.thing_id = :tid INTO pid;
      IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(10, NULL, pid, NULL);
      ELSE EXECUTE PROCEDURE damage_thing(tid, 10, NULL, NULL);
      EXECUTE PROCEDURE spawn_thing(9011, x, y, bz / 65536e0, 0) RETURNING_VALUES mid;
      r = p_rand256();
      r = r - p_rand256();
      UPDATE things t SET momx = :r * 4096 / 65536e0 WHERE t.id = :mid;
      r = p_rand256();
      r = r - p_rand256();
      UPDATE things t SET momy = :r * 4096 / 65536e0 WHERE t.id = :mid;
    END
  END
END^

-- T_MovePlane: sector SID's floor (CEILING 0) or ceiling (1) a step of SPEED towards DEST in
-- DIR, then P_ChangeSector with CRUSH. Arriving (past DEST) it stops there – unless something
-- no longer fits, when it stays where it was; on the way, something that doesn't fit puts it
-- back too (CRUSHED), except under a crushing floor going up or ceiling coming down, which
-- carry on squeezing; a ceiling going up never stops. → RES 0 ok, 1 crushed, 2 pastdest.
CREATE OR ALTER PROCEDURE move_plane (sid INTEGER, speed DOUBLE PRECISION, dest DOUBLE PRECISION, crush SMALLINT,
                                      ceiling SMALLINT, dir SMALLINT)
RETURNS (res SMALLINT)
AS
DECLARE h DOUBLE PRECISION;
DECLARE lastpos DOUBLE PRECISION;
DECLARE nofit SMALLINT;
BEGIN
  res = 0;
  SELECT IIF(:ceiling = 1, s.ceil_h, s.floor_h) FROM sectors s WHERE s.id = :sid INTO h;
  lastpos = h;
  IF ((dir = -1 AND h - speed < dest) OR (dir = 1 AND h + speed > dest)) THEN
  BEGIN
    IF (ceiling = 1) THEN UPDATE sectors s SET ceil_h = :dest WHERE s.id = :sid;
    ELSE UPDATE sectors s SET floor_h = :dest WHERE s.id = :sid;
    EXECUTE PROCEDURE change_sector(sid, crush) RETURNING_VALUES nofit;
    IF (nofit = 1) THEN
    BEGIN
      IF (ceiling = 1) THEN UPDATE sectors s SET ceil_h = :lastpos WHERE s.id = :sid;
      ELSE UPDATE sectors s SET floor_h = :lastpos WHERE s.id = :sid;
      EXECUTE PROCEDURE change_sector(sid, crush) RETURNING_VALUES nofit;
    END
    res = 2;
    EXIT;
  END
  IF (ceiling = 1) THEN UPDATE sectors s SET ceil_h = :h + :dir * :speed WHERE s.id = :sid;
  ELSE UPDATE sectors s SET floor_h = :h + :dir * :speed WHERE s.id = :sid;
  EXECUTE PROCEDURE change_sector(sid, crush) RETURNING_VALUES nofit;
  -- (a ceiling going up: never put back)
  IF (nofit = 1 AND NOT (ceiling = 1 AND dir = 1)) THEN
  BEGIN
    res = 1;
    -- (going down a floor, it can't crush: put back; up, or a ceiling down, crushing goes on)
    IF (crush = 1 AND NOT (ceiling = 0 AND dir = -1)) THEN EXIT;
    IF (ceiling = 1) THEN UPDATE sectors s SET ceil_h = :lastpos WHERE s.id = :sid;
    ELSE UPDATE sectors s SET floor_h = :lastpos WHERE s.id = :sid;
    EXECUTE PROCEDURE change_sector(sid, crush) RETURNING_VALUES nofit;
  END
END^

-- (a mover from an old save, made before movers carried DOOM's own types: its type worked out
-- from what it is)
CREATE OR ALTER FUNCTION mover_type (kind VARCHAR(8), dir SMALLINT, speed DOUBLE PRECISION, stay SMALLINT, crush SMALLINT,
                                     silent SMALLINT, top_h DOUBLE PRECISION, bottom_h DOUBLE PRECISION)
RETURNS VARCHAR(24)
AS
BEGIN
  IF (kind = 'door') THEN
    RETURN CASE WHEN stay = 2 THEN 'close30ThenOpen' WHEN dir = 2 THEN 'raiseIn5Mins'
                WHEN stay = 1 AND speed > 2 THEN 'blazeOpen' WHEN stay = 1 THEN 'open'
                WHEN speed > 2 THEN 'blazeRaise' ELSE 'normal' END;
  IF (kind IN ('lift', 'lifts')) THEN
    RETURN CASE WHEN stay = 2 THEN 'perpetualRaise' WHEN speed > 4 THEN 'blazeDWUS' ELSE 'downWaitUpStay' END;
  IF (kind = 'crush') THEN
    RETURN CASE WHEN crush = 0 AND dir = 1 THEN 'raiseToHighest' WHEN crush = 0 THEN 'lowerToFloor'
                WHEN stay = 1 THEN 'lowerAndCrush' WHEN silent = 1 THEN 'silentCrushAndRaise'
                WHEN speed > 1 THEN 'fastCrushAndRaise' ELSE 'crushAndRaise' END;
  RETURN IIF(crush = 1, 'raiseFloorCrush', 'lowerFloor');
END^

-- One mover's tic, by DOOM's own thinkers and types (MOVERS.MTYPE): T_VerticalDoor (a door,
-- KIND 'door'), T_PlatRaise ('lift'; 'lifts' in stasis), T_MoveFloor ('floor'), T_MoveCeiling
-- ('crush'), each moving its plane by MOVE_PLANE. RUN_THINKERS calls it in its turn.
CREATE OR ALTER PROCEDURE mover_step (sid INTEGER)
AS
DECLARE k VARCHAR(8);
DECLARE mt VARCHAR(24);
DECLARE dir SMALLINT;
DECLARE spd DOUBLE PRECISION;
DECLARE top_h DOUBLE PRECISION;
DECLARE bottom_h DOUBLE PRECISION;
DECLARE wait_tics INTEGER;
DECLARE wait_left INTEGER;
DECLARE stay SMALLINT;
DECLARE fh DOUBLE PRECISION;
DECLARE del SMALLINT;
DECLARE crush SMALLINT;
DECLARE silent SMALLINT;
DECLARE tic INTEGER;
DECLARE new_flat INTEGER;
DECLARE new_special INTEGER;
DECLARE res SMALLINT;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  k = NULL;
  SELECT m.kind, m.dir, m.speed, m.top_h, m.bottom_h, m.wait_tics, m.wait_left, m.stay,
         m.crush, m.silent, m.new_flat, m.new_special,
         COALESCE(m.mtype, mover_type(m.kind, m.dir, m.speed, m.stay, m.crush, m.silent, m.top_h, m.bottom_h))
    FROM movers m WHERE m.sector_id = :sid
    INTO k, dir, spd, top_h, bottom_h, wait_tics, wait_left, stay, crush, silent, new_flat, new_special, mt;
  IF (k IS NULL) THEN EXIT;
  del = 0;
  IF (k = 'door') THEN
  BEGIN
    -- T_VerticalDoor
    IF (dir = 0) THEN
    BEGIN
      -- (waiting: !--topcountdown)
      wait_left = wait_left - 1;
      IF (wait_left = 0) THEN
      BEGIN
        IF (mt = 'blazeRaise') THEN
        BEGIN
          dir = -1;
          EXECUTE PROCEDURE sector_sound('DSBDCLS', sid);
        END
        ELSE IF (mt = 'normal') THEN
        BEGIN
          dir = -1;
          EXECUTE PROCEDURE sector_sound('DSDORCLS', sid);
        END
        ELSE IF (mt = 'close30ThenOpen') THEN
        BEGIN
          dir = 1;
          EXECUTE PROCEDURE sector_sound('DSDOROPN', sid);
        END
      END
    END
    ELSE IF (dir = 2) THEN
    BEGIN
      -- (the initial wait: raiseIn5Mins, then a normal door)
      wait_left = wait_left - 1;
      IF (wait_left = 0 AND mt = 'raiseIn5Mins') THEN
      BEGIN
        dir = 1;
        mt = 'normal';
        EXECUTE PROCEDURE sector_sound('DSDOROPN', sid);
      END
    END
    ELSE IF (dir = -1) THEN
    BEGIN
      SELECT s.floor_h FROM sectors s WHERE s.id = :sid INTO fh;
      EXECUTE PROCEDURE move_plane(sid, spd, fh, 0, 1, -1) RETURNING_VALUES res;
      IF (res = 2) THEN
      BEGIN
        IF (mt IN ('blazeRaise', 'blazeClose')) THEN
        BEGIN
          del = 1;
          EXECUTE PROCEDURE sector_sound('DSBDCLS', sid);
        END
        ELSE IF (mt IN ('normal', 'close')) THEN del = 1;
        ELSE IF (mt = 'close30ThenOpen') THEN
        BEGIN
          dir = 0;
          wait_left = 35 * 30;
        END
      END
      ELSE IF (res = 1 AND mt NOT IN ('blazeClose', 'close')) THEN
      BEGIN
        -- (something in the way: back up – but a closing door doesn't)
        dir = 1;
        EXECUTE PROCEDURE sector_sound('DSDOROPN', sid);
      END
    END
    ELSE IF (dir = 1) THEN
    BEGIN
      EXECUTE PROCEDURE move_plane(sid, spd, top_h, 0, 1, 1) RETURNING_VALUES res;
      IF (res = 2) THEN
      BEGIN
        IF (mt IN ('blazeRaise', 'normal')) THEN
        BEGIN
          dir = 0;
          wait_left = wait_tics;
        END
        ELSE IF (mt IN ('close30ThenOpen', 'blazeOpen', 'open')) THEN del = 1;
      END
    END
  END
  ELSE IF (k = 'lifts') THEN
    dir = dir;                           -- (a perpetual lift stopped: in stasis)
  ELSE IF (k = 'lift') THEN
  BEGIN
    -- T_PlatRaise: DIR 1 up, -1 down, 0 waiting
    IF (dir = 1) THEN
    BEGIN
      EXECUTE PROCEDURE move_plane(sid, spd, top_h, crush, 0, 1) RETURNING_VALUES res;
      IF (mt IN ('raiseAndChange', 'raiseToNearestAndChange') AND BIN_AND(tic, 7) = 0) THEN
        EXECUTE PROCEDURE sector_sound('DSSTNMOV', sid);
      IF (res = 1 AND crush = 0) THEN
      BEGIN
        wait_left = wait_tics;
        dir = -1;
        EXECUTE PROCEDURE sector_sound('DSPSTART', sid);
      END
      ELSE IF (res = 2) THEN
      BEGIN
        wait_left = wait_tics;
        dir = 0;
        EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
        IF (mt IN ('blazeDWUS', 'downWaitUpStay', 'raiseAndChange', 'raiseToNearestAndChange')) THEN del = 1;
      END
    END
    ELSE IF (dir = -1) THEN
    BEGIN
      EXECUTE PROCEDURE move_plane(sid, spd, bottom_h, 0, 0, -1) RETURNING_VALUES res;
      IF (res = 2) THEN
      BEGIN
        wait_left = wait_tics;
        dir = 0;
        EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
      END
    END
    ELSE
    BEGIN
      wait_left = wait_left - 1;
      IF (wait_left = 0) THEN
      BEGIN
        SELECT s.floor_h FROM sectors s WHERE s.id = :sid INTO fh;
        dir = IIF(fh = bottom_h, 1, -1);
        EXECUTE PROCEDURE sector_sound('DSPSTART', sid);
      END
    END
  END
  ELSE IF (k = 'crush') THEN
  BEGIN
    -- T_MoveCeiling: DIR 0 in stasis
    IF (dir = 1) THEN
    BEGIN
      EXECUTE PROCEDURE move_plane(sid, spd, top_h, 0, 1, 1) RETURNING_VALUES res;
      IF (BIN_AND(tic, 7) = 0 AND mt <> 'silentCrushAndRaise') THEN EXECUTE PROCEDURE sector_sound('DSSTNMOV', sid);
      IF (res = 2) THEN
      BEGIN
        IF (mt = 'raiseToHighest') THEN del = 1;
        ELSE IF (mt IN ('silentCrushAndRaise', 'fastCrushAndRaise', 'crushAndRaise')) THEN
        BEGIN
          IF (mt = 'silentCrushAndRaise') THEN EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
          dir = -1;
        END
      END
    END
    ELSE IF (dir = -1) THEN
    BEGIN
      EXECUTE PROCEDURE move_plane(sid, spd, bottom_h, crush, 1, -1) RETURNING_VALUES res;
      IF (BIN_AND(tic, 7) = 0 AND mt <> 'silentCrushAndRaise') THEN EXECUTE PROCEDURE sector_sound('DSSTNMOV', sid);
      IF (res = 2) THEN
      BEGIN
        IF (mt = 'silentCrushAndRaise') THEN EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
        IF (mt IN ('silentCrushAndRaise', 'crushAndRaise')) THEN spd = 1;   -- (CEILSPEED again)
        IF (mt IN ('silentCrushAndRaise', 'crushAndRaise', 'fastCrushAndRaise')) THEN dir = 1;
        ELSE IF (mt IN ('lowerAndCrush', 'lowerToFloor')) THEN del = 1;
      END
      ELSE IF (res = 1 AND mt IN ('silentCrushAndRaise', 'crushAndRaise', 'lowerAndCrush')) THEN
        spd = 0.125;                     -- (CEILSPEED / 8 while it crushes)
    END
  END
  ELSE
  BEGIN
    -- T_MoveFloor: TOP_H is floordestheight; it grinds every 8 tics and stops with DSPSTOP,
    -- where a lowerAndChange or a donut's ring takes its new flat and special
    EXECUTE PROCEDURE move_plane(sid, spd, top_h, crush, 0, dir) RETURNING_VALUES res;
    IF (BIN_AND(tic, 7) = 0) THEN EXECUTE PROCEDURE sector_sound('DSSTNMOV', sid);
    IF (res = 2) THEN
    BEGIN
      IF ((dir = 1 AND mt = 'donutRaise') OR (dir = -1 AND mt = 'lowerAndChange')) THEN
        UPDATE sectors s SET floor_flat = COALESCE(:new_flat, s.floor_flat), special = COALESCE(:new_special, 0) WHERE s.id = :sid;
      del = 1;
      EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
    END
  END

  IF (del = 1) THEN
    DELETE FROM movers WHERE sector_id = :sid;
  ELSE
    UPDATE movers SET dir = :dir, wait_left = :wait_left, speed = :spd, mtype = :mt WHERE sector_id = :sid;
END^

-- P_TryMove for a player: to (X, Y), if P_CheckPosition lets it and it fits there (the gap as
-- tall as it, the ceiling above its head, a step up of 24 at most; with no clipping, anywhere).
-- The floor and ceiling found are its own from then on, and the special lines met that it
-- crossed – its side of the line changed, P_PointOnLineSide – go off, last met first
-- (P_CrossSpecialLine; a teleporter only from the front). Each line looks at where it is now:
-- a teleporter may have moved it.
CREATE OR ALTER PROCEDURE try_move_fx (tid INTEGER, pid SMALLINT, x BIGINT, y BIGINT)
RETURNS (ok SMALLINT)
AS
DECLARE ox BIGINT;
DECLARE oy BIGINT;
DECLARE z BIGINT;
DECLARE noclip SMALLINT;
DECLARE fz BIGINT;
DECLARE cz BIGINT;
DECLARE dz BIGINT;
DECLARE spec VARCHAR(4000);
DECLARE k INTEGER;
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lsp INTEGER;
DECLARE nx BIGINT;
DECLARE ny BIGINT;
DECLARE side SMALLINT;
DECLARE oldside SMALLINT;
BEGIN
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z) FROM things t WHERE t.id = :tid INTO ox, oy, z;
  SELECT p.noclip FROM player p WHERE p.id = :pid INTO noclip;
  EXECUTE PROCEDURE check_position_fx(tid, x, y, 1048576, noclip) RETURNING_VALUES ok, fz, cz, dz, spec;
  IF (ok = 0) THEN EXIT;
  IF (noclip = 0 AND (cz - fz < 3670016 OR cz - z < 3670016 OR fz - z > 1572864)) THEN
  BEGIN
    ok = 0;
    EXIT;
  END
  UPDATE things t
     SET x = :x / 65536e0, y = :y / 65536e0, floorz = :fz / 65536e0, ceilz = :cz / 65536e0,
         fz_x = :x / 65536e0, fz_y = :y / 65536e0, sector_id = sector_at_fx(:x, :y)
   WHERE t.id = :tid;
  IF (noclip = 1) THEN EXIT;
  WHILE (spec <> '') DO
  BEGIN
    k = POSITION(',' IN spec);
    lid = CAST(SUBSTRING(spec FROM 1 FOR k - 1) AS INTEGER);
    spec = SUBSTRING(spec FROM k + 1);
    SELECT l.fx, l.fy, l.fdx, l.fdy, l.special FROM linedefs l WHERE l.id = :lid INTO lx, ly, ldx, ldy, lsp;
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO nx, ny;
    side = point_on_line_side(nx, ny, lx, ly, ldx, ldy);
    oldside = point_on_line_side(ox, oy, lx, ly, ldx, ldy);
    IF (side <> oldside AND lsp <> 0 AND NOT (lsp IN (39, 97, 125, 126) AND oldside = 1)) THEN
      EXECUTE PROCEDURE activate_line(lid, 'walk', NULL, pid);
  END
END^

-- P_PathTraverse along (X1, Y1) → (X2, Y2) with PT_ADDLINES and PTR_SlideTraverse, for
-- P_SlideMove: through the blocks the trace passes, as DOOM steps through them, each line once
-- (PIT_AddLineIntercepts: crossed – by the line's own side test for a short trace, the
-- trace's for a long one – and not behind the start); nearest first (the first met of equal
-- ones), up to the trace's end, the first one that would stop the player (one-sided and in
-- front of it, or an opening too low, under its head, or a step over 24) is where it hits.
-- It goes in as the new best if it's nearer than BEST_IN (bestslidefrac).
CREATE OR ALTER PROCEDURE slide_traverse (
  x1 BIGINT, y1 BIGINT, x2 BIGINT, y2 BIGINT, mx BIGINT, my BIGINT, mz BIGINT,
  best_in BIGINT, line_in INTEGER)
RETURNS (best BIGINT, best_line INTEGER)
AS
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE tdx BIGINT;
DECLARE tdy BIGINT;
DECLARE xt1 BIGINT;
DECLARE yt1 BIGINT;
DECLARE xt2 BIGINT;
DECLARE yt2 BIGINT;
DECLARE mapxstep INTEGER;
DECLARE mapystep INTEGER;
DECLARE partial BIGINT;
DECLARE xstep BIGINT;
DECLARE ystep BIGINT;
DECLARE xintercept BIGINT;
DECLARE yintercept BIGINT;
DECLARE mapx BIGINT;
DECLARE mapy BIGINT;
DECLARE cnt INTEGER;
DECLARE seen VARCHAR(8000);
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lflags INTEGER;
DECLARE lback INTEGER;
DECLARE ff DOUBLE PRECISION;
DECLARE fc DOUBLE PRECISION;
DECLARE bf DOUBLE PRECISION;
DECLARE bc DOUBLE PRECISION;
DECLARE s1 SMALLINT;
DECLARE s2 SMALLINT;
DECLARE frac BIGINT;
DECLARE near_frac BIGINT;
DECLARE near_line INTEGER;
DECLARE blocks SMALLINT;
DECLARE opentop BIGINT;
DECLARE openbottom BIGINT;
BEGIN
  best = best_in;
  best_line = line_in;
  near_frac = 2147483647;
  near_line = NULL;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  -- (don't start exactly on a block's edge)
  IF (BIN_AND(x1 - orgx, 8388607) = 0) THEN x1 = x1 + 65536;
  IF (BIN_AND(y1 - orgy, 8388607) = 0) THEN y1 = y1 + 65536;
  tx = x1;
  ty = y1;
  tdx = fx32(x2 - x1);
  tdy = fx32(y2 - y1);
  x1 = x1 - orgx;
  y1 = y1 - orgy;
  xt1 = BIN_SHR(x1, 23);
  yt1 = BIN_SHR(y1, 23);
  x2 = x2 - orgx;
  y2 = y2 - orgy;
  xt2 = BIN_SHR(x2, 23);
  yt2 = BIN_SHR(y2, 23);
  IF (xt2 > xt1) THEN
  BEGIN
    mapxstep = 1;
    partial = 65536 - BIN_AND(BIN_SHR(x1, 7), 65535);
    ystep = fx_div(fx32(y2 - y1), ABS(fx32(x2 - x1)));
  END
  ELSE IF (xt2 < xt1) THEN
  BEGIN
    mapxstep = -1;
    partial = BIN_AND(BIN_SHR(x1, 7), 65535);
    ystep = fx_div(fx32(y2 - y1), ABS(fx32(x2 - x1)));
  END
  ELSE
  BEGIN
    mapxstep = 0;
    partial = 65536;
    ystep = 16777216;
  END
  yintercept = fx32(BIN_SHR(y1, 7) + fx_mul(partial, ystep));
  IF (yt2 > yt1) THEN
  BEGIN
    mapystep = 1;
    partial = 65536 - BIN_AND(BIN_SHR(y1, 7), 65535);
    xstep = fx_div(fx32(x2 - x1), ABS(fx32(y2 - y1)));
  END
  ELSE IF (yt2 < yt1) THEN
  BEGIN
    mapystep = -1;
    partial = BIN_AND(BIN_SHR(y1, 7), 65535);
    xstep = fx_div(fx32(x2 - x1), ABS(fx32(y2 - y1)));
  END
  ELSE
  BEGIN
    mapystep = 0;
    partial = 65536;
    xstep = 16777216;
  END
  xintercept = fx32(BIN_SHR(x1, 7) + fx_mul(partial, xstep));
  mapx = xt1;
  mapy = yt1;
  cnt = 0;
  seen = ',';
  WHILE (cnt < 64) DO
  BEGIN
    -- P_BlockLinesIterator (mapx, mapy, PIT_AddLineIntercepts)
    IF (mapx >= 0 AND mapy >= 0 AND mapx < bw AND mapy < bh) THEN
      FOR SELECT l.id, l.fx, l.fy, l.fdx, l.fdy, l.flags, l.back_sector, fs.floor_h, fs.ceil_h, bs.floor_h, bs.ceil_h
            FROM blockmap b
            JOIN linedefs l ON l.id = b.line_id
            LEFT JOIN sectors fs ON fs.id = l.front_sector
            LEFT JOIN sectors bs ON bs.id = l.back_sector
           WHERE b.bx = :mapx AND b.by_ = :mapy
           ORDER BY b.seq
            INTO lid, lx, ly, ldx, ldy, lflags, lback, ff, fc, bf, bc
      DO
      BEGIN
        IF (POSITION(',' || lid || ',' IN seen) > 0) THEN CONTINUE;
        seen = seen || lid || ',';
        IF (tdx > 1048576 OR tdy > 1048576 OR tdx < -1048576 OR tdy < -1048576) THEN
        BEGIN
          s1 = point_on_divline_side(lx, ly, tx, ty, tdx, tdy);
          s2 = point_on_divline_side(fx32(lx + ldx), fx32(ly + ldy), tx, ty, tdx, tdy);
        END
        ELSE
        BEGIN
          s1 = point_on_line_side(tx, ty, lx, ly, ldx, ldy);
          s2 = point_on_line_side(fx32(tx + tdx), fx32(ty + tdy), lx, ly, ldx, ldy);
        END
        IF (s1 = s2) THEN CONTINUE;
        frac = intercept_vector(tx, ty, tdx, tdy, lx, ly, ldx, ldy);
        IF (frac < 0 OR frac > 65536 OR frac >= near_frac) THEN CONTINUE;
        -- PTR_SlideTraverse: would it stop the player?
        blocks = 0;
        IF (BIN_AND(lflags, 4) = 0) THEN          -- (not ML_TWOSIDED: only from in front)
          blocks = IIF(point_on_line_side(mx, my, lx, ly, ldx, ldy) = 1, 0, 1);
        ELSE IF (lback IS NULL) THEN
          blocks = 1;                             -- (P_LineOpening: no back, no opening)
        ELSE
        BEGIN
          opentop = MINVALUE(fx_of(fc), fx_of(bc));
          openbottom = MAXVALUE(fx_of(ff), fx_of(bf));
          IF (opentop - openbottom < 3670016 OR opentop - mz < 3670016 OR openbottom - mz > 1572864) THEN blocks = 1;
        END
        IF (blocks = 1) THEN
        BEGIN
          near_frac = frac;
          near_line = lid;
        END
      END
    IF (mapx = xt2 AND mapy = yt2) THEN LEAVE;
    IF (BIN_SHR(yintercept, 16) = mapy) THEN
    BEGIN
      yintercept = fx32(yintercept + ystep);
      mapx = mapx + mapxstep;
    END
    ELSE IF (BIN_SHR(xintercept, 16) = mapx) THEN
    BEGIN
      xintercept = fx32(xintercept + xstep);
      mapy = mapy + mapystep;
    END
    cnt = cnt + 1;
  END
  IF (near_line IS NOT NULL AND near_frac < best) THEN
  BEGIN
    best = near_frac;
    best_line = near_line;
  END
END^

-- P_HitSlideLine: the move (XM, YM) turned along the line it hit – straight along a
-- horizontal or vertical one; else as long as its part along the line (P_AproxDistance, the
-- angle between them in fine angles), in the line's direction (from the player's side)
CREATE OR ALTER PROCEDURE hit_slide_line (lid INTEGER, xm BIGINT, ym BIGINT, mx BIGINT, my BIGINT)
RETURNS (oxm BIGINT, oym BIGINT)
AS
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lslope SMALLINT;
DECLARE lineangle BIGINT;
DECLARE moveangle BIGINT;
DECLARE deltaangle BIGINT;
DECLARE movelen BIGINT;
DECLARE newlen BIGINT;
BEGIN
  oxm = xm;
  oym = ym;
  SELECT l.fx, l.fy, l.fdx, l.fdy, l.slope FROM linedefs l WHERE l.id = :lid INTO lx, ly, ldx, ldy, lslope;
  IF (lslope = 0) THEN
  BEGIN
    oym = 0;
    EXIT;
  END
  IF (lslope = 1) THEN
  BEGIN
    oxm = 0;
    EXIT;
  END
  lineangle = point_to_angle2(0, 0, ldx, ldy);
  IF (point_on_line_side(mx, my, lx, ly, ldx, ldy) = 1) THEN lineangle = BIN_AND(lineangle + 2147483648, 4294967295);
  moveangle = point_to_angle2(0, 0, xm, ym);
  deltaangle = BIN_AND(moveangle - lineangle, 4294967295);
  IF (deltaangle > 2147483648) THEN deltaangle = BIN_AND(deltaangle + 2147483648, 4294967295);
  lineangle = BIN_SHR(lineangle, 19);
  deltaangle = BIN_SHR(deltaangle, 19);
  movelen = aprox_distance(xm, ym);
  newlen = fx_mul(movelen, fine_cosine(deltaangle));
  oxm = fx_mul(newlen, fine_cosine(lineangle));
  oym = fx_mul(newlen, fine_sine(lineangle));
END^

-- P_SlideMove: blocked, the player slides along what stopped it. Traces from its three leading
-- corners find the nearest line it would hit; it moves up to just short of that (a 0x800
-- fudge), then the rest of the move, turned along the line, becomes its momentum and it tries
-- that – up to three times. When nothing's found, or a move fails, it "stairsteps": the y move
-- alone, else the x move alone.
CREATE OR ALTER PROCEDURE slide_move_fx (tid INTEGER, pid SMALLINT)
AS
DECLARE hitcount INTEGER;
DECLARE stair SMALLINT;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE momx BIGINT;
DECLARE momy BIGINT;
DECLARE leadx BIGINT;
DECLARE leady BIGINT;
DECLARE trailx BIGINT;
DECLARE traily BIGINT;
DECLARE best BIGINT;
DECLARE bline INTEGER;
DECLARE tmx BIGINT;
DECLARE tmy BIGINT;
DECLARE ok SMALLINT;
BEGIN
  hitcount = 0;
  stair = 0;
  WHILE (1 = 1) DO
  BEGIN
    hitcount = hitcount + 1;
    IF (hitcount = 3) THEN
    BEGIN
      stair = 1;
      LEAVE;
    END
    SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.momx), fx_of(t.momy) FROM things t WHERE t.id = :tid
      INTO x, y, z, momx, momy;
    IF (momx > 0) THEN BEGIN leadx = x + 1048576; trailx = x - 1048576; END
    ELSE BEGIN leadx = x - 1048576; trailx = x + 1048576; END
    IF (momy > 0) THEN BEGIN leady = y + 1048576; traily = y - 1048576; END
    ELSE BEGIN leady = y - 1048576; traily = y + 1048576; END
    best = 65537;
    bline = NULL;
    EXECUTE PROCEDURE slide_traverse(leadx, leady, leadx + momx, leady + momy, x, y, z, best, bline) RETURNING_VALUES best, bline;
    EXECUTE PROCEDURE slide_traverse(trailx, leady, trailx + momx, leady + momy, x, y, z, best, bline) RETURNING_VALUES best, bline;
    EXECUTE PROCEDURE slide_traverse(leadx, traily, leadx + momx, traily + momy, x, y, z, best, bline) RETURNING_VALUES best, bline;
    IF (best = 65537) THEN
    BEGIN
      stair = 1;
      LEAVE;
    END
    best = best - 2048;
    IF (best > 0) THEN
    BEGIN
      EXECUTE PROCEDURE try_move_fx(tid, pid, x + fx_mul(momx, best), y + fx_mul(momy, best)) RETURNING_VALUES ok;
      IF (ok = 0) THEN
      BEGIN
        stair = 1;
        LEAVE;
      END
    END
    best = 65536 - (best + 2048);
    IF (best > 65536) THEN best = 65536;
    IF (best <= 0) THEN LEAVE;
    tmx = fx_mul(momx, best);
    tmy = fx_mul(momy, best);
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE hit_slide_line(bline, tmx, tmy, x, y) RETURNING_VALUES tmx, tmy;
    UPDATE things t SET momx = :tmx / 65536e0, momy = :tmy / 65536e0 WHERE t.id = :tid;
    EXECUTE PROCEDURE try_move_fx(tid, pid, x + tmx, y + tmy) RETURNING_VALUES ok;
    IF (ok = 1) THEN LEAVE;
  END
  IF (stair = 1) THEN
  BEGIN
    SELECT fx_of(t.x), fx_of(t.y), fx_of(t.momx), fx_of(t.momy) FROM things t WHERE t.id = :tid INTO x, y, momx, momy;
    EXECUTE PROCEDURE try_move_fx(tid, pid, x, y + momy) RETURNING_VALUES ok;
    IF (ok = 0) THEN EXECUTE PROCEDURE try_move_fx(tid, pid, x + momx, y) RETURNING_VALUES ok;
  END
END^

-- P_XYMovement for a player: its momentum, at most MAXMOVE (30) each way, in steps of at most
-- half of that (DOOM halves a step only when it's positive), each a P_TryMove, sliding when
-- one fails; then, on the ground, friction (FRICTION, 0xe800) – or a stop, once both
-- momentums are under STOPSPEED (0x1000) and no move is told (CMD_FWD, CMD_SIDE: the
-- ticcmd's), when a running body stands
CREATE OR ALTER PROCEDURE xy_movement_fx (tid INTEGER, pid SMALLINT, cmd_fwd INTEGER, cmd_side INTEGER, tic INTEGER)
AS
DECLARE sfz BIGINT;
DECLARE dead SMALLINT;
DECLARE momx BIGINT;
DECLARE momy BIGINT;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE fz BIGINT;
DECLARE xmove BIGINT;
DECLARE ymove BIGINT;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE ok SMALLINT;
DECLARE alive SMALLINT;
BEGIN
  SELECT fx_of(t.momx), fx_of(t.momy) FROM things t WHERE t.id = :tid INTO momx, momy;
  IF (momx = 0 AND momy = 0) THEN EXIT;
  momx = MAXVALUE(-1966080, MINVALUE(1966080, momx));
  momy = MAXVALUE(-1966080, MINVALUE(1966080, momy));
  UPDATE things t SET momx = :momx / 65536e0, momy = :momy / 65536e0 WHERE t.id = :tid;
  xmove = momx;
  ymove = momy;
  WHILE (1 = 1) DO
  BEGIN
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO x, y;
    IF (xmove > 983040 OR ymove > 983040) THEN
    BEGIN
      tx = x + xmove / 2;                        -- (C's division: towards 0)
      ty = y + ymove / 2;
      xmove = BIN_SHR(xmove, 1);
      ymove = BIN_SHR(ymove, 1);
    END
    ELSE
    BEGIN
      tx = x + xmove;
      ty = y + ymove;
      xmove = 0;
      ymove = 0;
    END
    EXECUTE PROCEDURE try_move_fx(tid, pid, tx, ty) RETURNING_VALUES ok;
    IF (ok = 0) THEN EXECUTE PROCEDURE slide_move_fx(tid, pid);
    IF (xmove = 0 AND ymove = 0) THEN LEAVE;
  END
  SELECT fx_of(t.momx), fx_of(t.momy), fx_of(t.z), fx_of(t.floorz),
         (SELECT fx_of(s.floor_h) FROM sectors s WHERE s.id = t.sector_id), (SELECT p.dead FROM player p WHERE p.id = :pid)
    FROM things t WHERE t.id = :tid INTO momx, momy, z, fz, sfz, dead;
  IF (z > fz) THEN EXIT;                         -- (no friction in the air)
  -- (a dead player's body is a corpse (MF_CORPSE): with some speed left, it doesn't stop while
  -- it's halfway off a step)
  IF (dead = 1 AND (momx > 16384 OR momx < -16384 OR momy > 16384 OR momy < -16384) AND fz <> sfz) THEN EXIT;
  IF (momx > -4096 AND momx < 4096 AND momy > -4096 AND momy < 4096 AND cmd_fwd = 0 AND cmd_side = 0) THEN
  BEGIN
    IF (EXISTS (SELECT 1 FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                 WHERE t.id = :tid AND t.state BETWEEN tt.see_state AND tt.see_state + 3)) THEN
      EXECUTE PROCEDURE set_state(tid, (SELECT tt.spawn_state FROM thing_types tt WHERE tt.thing_type = 1), tic)
        RETURNING_VALUES alive;
    momx = 0;
    momy = 0;
  END
  ELSE
  BEGIN
    momx = fx_mul(momx, 59392);
    momy = fx_mul(momy, 59392);
  END
  UPDATE things t SET momx = :momx / 65536e0, momy = :momy / 65536e0 WHERE t.id = :tid;
END^

-- P_ZMovement for a player (when it's off its floor or moving up or down): below its floor (a
-- step up), the view drops by the step and comes back up over the next tics; momz moves it,
-- the floor stops it – a landing faster than 8 squats the view and says "oof" – and gravity
-- pulls it down, 2 the first tic, 1 more each tic after; the ceiling stops its head.
CREATE OR ALTER PROCEDURE z_movement_fx (tid INTEGER, pid SMALLINT)
AS
DECLARE z BIGINT;
DECLARE momz BIGINT;
DECLARE fz BIGINT;
DECLARE cz BIGINT;
DECLARE vh BIGINT;
DECLARE dvh BIGINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
BEGIN
  SELECT fx_of(t.z), fx_of(t.momz), fx_of(t.floorz), fx_of(t.ceilz), fx_of(p.view_h), fx_of(p.delta_vh), t.x, t.y
    FROM things t JOIN player p ON p.thing_id = t.id
   WHERE t.id = :tid AND p.id = :pid
    INTO z, momz, fz, cz, vh, dvh, px, py;
  IF (z = fz AND momz = 0) THEN EXIT;
  IF (z < fz) THEN
  BEGIN
    vh = vh - (fz - z);
    dvh = BIN_SHR(2686976 - vh, 3);              -- (VIEWHEIGHT: 41)
  END
  z = z + momz;
  IF (z <= fz) THEN
  BEGIN
    IF (momz < 0) THEN
    BEGIN
      IF (momz < -524288) THEN
      BEGIN
        dvh = BIN_SHR(momz, 3);
        EXECUTE PROCEDURE play_sound('DSOOF', tid, px, py);
      END
      momz = 0;
    END
    z = fz;
  END
  ELSE IF (momz = 0) THEN momz = -131072;
  ELSE momz = momz - 65536;
  IF (z + 3670016 > cz) THEN
  BEGIN
    IF (momz > 0) THEN momz = 0;
    z = cz - 3670016;
  END
  UPDATE things t SET z = :z / 65536e0, momz = :momz / 65536e0 WHERE t.id = :tid;
  UPDATE player p SET view_h = :vh / 65536e0, delta_vh = :dvh / 65536e0 WHERE p.id = :pid;
END^

-- A player's floor and ceiling where it stands, found again (P_CheckPosition's, the lines its
-- box touches): when a sector moved (FORCE, P_ChangeSector's P_ThingHeightClip: on the floor,
-- it stays on it; else the ceiling may push it down), where it has just landed (FLOORZ NULL:
-- a teleport, P_TeleportMove – it stands on it), or when something put it elsewhere than
-- where they were found (FZ_X, FZ_Y: a test, the console – it stays at its height)
CREATE OR ALTER PROCEDURE height_clip_fx (tid INTEGER, force SMALLINT = 0)
AS
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE oldfz BIGINT;
DECLARE moved SMALLINT;
DECLARE ok SMALLINT;
DECLARE fz BIGINT;
DECLARE cz BIGINT;
DECLARE dz BIGINT;
DECLARE spec VARCHAR(4000);
BEGIN
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.floorz), IIF(t.fz_x = t.x AND t.fz_y = t.y, 0, 1)
    FROM things t WHERE t.id = :tid
    INTO x, y, z, oldfz, moved;
  IF (oldfz IS NOT NULL AND force = 0 AND moved = 0) THEN EXIT;
  EXECUTE PROCEDURE check_position_fx(tid, x, y, 1048576, 0, 0) RETURNING_VALUES ok, fz, cz, dz, spec;
  IF (oldfz IS NULL OR (z = oldfz AND moved = 0)) THEN z = fz;
  ELSE IF (z + 3670016 > cz) THEN z = cz - 3670016;
  UPDATE things t SET z = :z / 65536e0, floorz = :fz / 65536e0, ceilz = :cz / 65536e0, fz_x = t.x, fz_y = t.y
   WHERE t.id = :tid;
END^

CREATE OR ALTER PROCEDURE player_think (
  pid SMALLINT, fwd DOUBLE PRECISION, side DOUBLE PRECISION, turn DOUBLE PRECISION,
  fire SMALLINT, use_key SMALLINT, weapon_sel SMALLINT, run SMALLINT, tic INTEGER)
AS
DECLARE hurt SMALLINT;
DECLARE alive SMALLINT;
DECLARE iron INTEGER;
DECLARE tid INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION;
DECLARE oy DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION;
DECLARE thrust DOUBLE PRECISION;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE sspec INTEGER;
DECLARE is_dead SMALLINT;
DECLARE weapon SMALLINT;
DECLARE bullets INTEGER;
DECLARE shells INTEGER;
DECLARE has_sg SMALLINT;
DECLARE has_cg SMALLINT;
DECLARE use_down SMALLINT;
DECLARE view_h DOUBLE PRECISION;
DECLARE view_z DOUBLE PRECISION;
DECLARE bob DOUBLE PRECISION;
DECLARE lid INTEGER;
DECLARE lsp INTEGER;
DECLARE pellets INTEGER;
DECLARE spread DOUBLE PRECISION;
DECLARE i INTEGER;
DECLARE iid INTEGER;
DECLARE pk VARCHAR(10);
DECLARE amt INTEGER;
DECLARE lbl VARCHAR(80);
DECLARE took SMALLINT;
DECLARE dropped SMALLINT;
DECLARE count_item SMALLINT;
DECLARE health INTEGER;
DECLARE armor INTEGER;
DECLARE armor_type SMALLINT;
DECLARE maxb INTEGER;
DECLARE maxs INTEGER;
DECLARE rockets INTEGER;
DECLARE cells INTEGER;
DECLARE maxr INTEGER;
DECLARE maxc INTEGER;
DECLARE has_rl SMALLINT;
DECLARE has_pl SMALLINT;
DECLARE has_bfg SMALLINT;
DECLARE has_saw SMALLINT;
DECLARE has_ssg SMALLINT;
DECLARE shot_hit SMALLINT;
DECLARE old_weapon SMALLINT;
DECLARE pending SMALLINT;
DECLARE neww SMALLINT;
DECLARE preact INTEGER;
DECLARE kbam BIGINT;
DECLARE dbam BIGINT;
DECLARE killer_ang DOUBLE PRECISION;
DECLARE bslope DOUBLE PRECISION;
DECLARE mult INTEGER;
DECLARE np SMALLINT;
DECLARE dm SMALLINT;
DECLARE gave SMALLINT;
DECLARE qn INTEGER;
DECLARE tries INTEGER;
DECLARE noclip SMALLINT;
DECLARE cmd_fwd INTEGER;
DECLARE cmd_side INTEGER;
DECLARE cmd_turn BIGINT;
DECLARE onground SMALLINT;
DECLARE fz_z BIGINT;
DECLARE ffz BIGINT;
DECLARE fcz BIGINT;
DECLARE fmx BIGINT;
DECLARE fmy BIGINT;
DECLARE fang BIGINT;
DECLARE sang BIGINT;
DECLARE vh BIGINT;
DECLARE dvh BIGINT;
DECLARE fbob BIGINT;
DECLARE bobv BIGINT;
DECLARE fvz BIGINT;
BEGIN
  SELECT p.thing_id, t.x, t.y, t.z, t.angle, t.momx, t.momy, t.momz, p.dead, p.weapon,
         p.bullets, p.shells, p.has_shotgun, p.has_chaingun, p.use_down, p.view_h,
         p.rockets, p.cells, p.has_launcher, p.has_plasma, p.has_bfg, p.has_chainsaw, p.has_ssg, p.noclip,
         p.pending_weapon
    FROM player p JOIN things t ON t.id = p.thing_id
   WHERE p.id = :pid
    INTO tid, x, y, z, ang, momx, momy, momz, is_dead, weapon,
         bullets, shells, has_sg, has_cg, use_down, view_h,
         rockets, cells, has_rl, has_pl, has_bfg, has_saw, has_ssg, noclip,
         pending;
  -- (this tic's trigger, for the weapon's actions: player->cmd.buttons & BT_ATTACK)
  UPDATE player p SET buttons = :fire WHERE p.id = :pid;
  -- the ticcmd in DOOM's units (G_BuildTiccmd): forwardmove and sidemove, 25 a walk and 50 a
  -- run, and angleturn, a BAM >> 16 (a short)
  cmd_fwd = MAXVALUE(-127, MINVALUE(127, ROUND(fwd * IIF(run = 1, 50, 25))));
  cmd_side = MAXVALUE(-127, MINVALUE(127, ROUND(side * IIF(run = 1, 50, 25))));
  cmd_turn = BIN_AND(CAST(ROUND(turn * 32768 / PI()) AS BIGINT) + 32768, 65535) - 32768;
  -- P_PlayerThink: the chainsaw's bite (MF_JUSTATTACKED) runs it on: no turn, forwardmove 0xc800 / 512
  IF (EXISTS (SELECT 1 FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = :pid AND t.just_attacked = 1)) THEN
  BEGIN
    cmd_turn = 0;
    cmd_fwd = 100;
    cmd_side = 0;
    UPDATE things t SET just_attacked = 0 WHERE t.id = (SELECT p.thing_id FROM player p WHERE p.id = :pid);
  END
  -- (P_XYMovement, in the body's own thinker, looks at the ticcmd's moves)
  UPDATE player p SET cmd_fwd = :cmd_fwd, cmd_side = :cmd_side WHERE p.id = :pid;

  IF (is_dead = 1) THEN
  BEGIN
    -- P_DeathThink: the weapon goes on going down (P_MovePsprites); sink to the floor, wait for
    -- USE – and turn to face your killer, 5° a tic; until you do, the red of the damage stays
    EXECUTE PROCEDURE move_psprites(pid, tic);
    view_h = MAXVALUE(6, view_h - 1);
    -- (in BAMs: R_PointToAngle2 to the attacker; within ANG5 either way it snaps to it, else
    -- turns ANG5 the shorter way)
    kbam = NULL;
    SELECT point_to_angle2(fx_of(t.x), fx_of(t.y), fx_of(a.x), fx_of(a.y)), bam_of(t.angle)
      FROM player p JOIN things a ON a.id = p.attacker_id JOIN things t ON t.id = :tid
     WHERE p.id = :pid AND a.id <> :tid INTO kbam, dbam;
    IF (kbam IS NOT NULL) THEN
    BEGIN
      dbam = BIN_AND(kbam - dbam, 4294967295);
      IF (dbam < 59652323 OR dbam > 4294967296 - 59652323) THEN
        UPDATE things SET angle = rad_of(:kbam) WHERE id = :tid;
      ELSE
      BEGIN
        UPDATE things t SET angle = rad_of(BIN_AND(bam_of(t.angle) + IIF(:dbam < 2147483648, 59652323, -59652323), 4294967295))
         WHERE id = :tid;
        UPDATE player SET damage_count = damage_count + 1 WHERE id = :pid AND damage_count > 0;   -- (DOOM_TIC's countdown waits)
      END
    END
    -- G_DoReborn: alone, the level starts over; in a netgame you come back at your start (P_DeathThink:
    -- BT_USE in the ticcmd, held from before or not)
    IF (use_key = 1) THEN
    BEGIN
      IF ((SELECT g.players FROM game g WHERE g.id = 1) > 1) THEN
      BEGIN
        EXECUTE PROCEDURE reborn_player(pid);
        EXIT;
      END
      UPDATE game SET exit_kind = 3 WHERE id = 1;
    END
    UPDATE player SET view_h = :view_h, view_z = :z + :view_h, use_down = :use_key WHERE id = :pid;
    EXIT;
  END

  -- the floor and ceiling where it stands, if it has just landed somewhere (P_TeleportMove)
  EXECUTE PROCEDURE height_clip_fx(tid);
  SELECT fx_of(t.z), fx_of(t.floorz), fx_of(t.ceilz), fx_of(t.momx), fx_of(t.momy), bam_of(t.angle), COALESCE(t.reaction, 0)
    FROM things t WHERE t.id = :tid
    INTO fz_z, ffz, fcz, fmx, fmy, fang, preact;
  onground = IIF(fz_z <= ffz, 1, 0);
  -- P_PlayerThink: just teleported (reactiontime), it can't turn or move
  IF (preact > 0) THEN
    UPDATE things SET reaction = :preact - 1 WHERE id = :tid;
  ELSE
  BEGIN
    -- P_MovePlayer: turn (angleturn << 16), and only on the ground, thrust: forwardmove × 2048
    -- the way it faces, sidemove × 2048 a quarter turn to the right (P_Thrust)
    fang = BIN_AND(fang + cmd_turn * 65536, 4294967295);
    IF (cmd_fwd <> 0 AND onground = 1) THEN
    BEGIN
      fmx = fx32(fmx + fx_mul(cmd_fwd * 2048, fine_cosine(BIN_SHR(fang, 19))));
      fmy = fx32(fmy + fx_mul(cmd_fwd * 2048, fine_sine(BIN_SHR(fang, 19))));
    END
    IF (cmd_side <> 0 AND onground = 1) THEN
    BEGIN
      sang = BIN_SHR(BIN_AND(fang - 1073741824, 4294967295), 19);
      fmx = fx32(fmx + fx_mul(cmd_side * 2048, fine_cosine(sang)));
      fmy = fx32(fmy + fx_mul(cmd_side * 2048, fine_sine(sang)));
    END
    -- standing (S_PLAY) and told to move, the body starts running (S_PLAY_RUN1). (P_PlayerThink
    -- comes before the body's own thinker, which counts this tic off its new state: set at
    -- TIC - 1 it ends when DOOM's does)
    IF ((cmd_fwd <> 0 OR cmd_side <> 0)
        AND EXISTS (SELECT 1 FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                     WHERE t.id = :tid AND t.state = tt.spawn_state)) THEN
      EXECUTE PROCEDURE set_state(tid, (SELECT tt.see_state FROM thing_types tt WHERE tt.thing_type = 1), tic)
        RETURNING_VALUES alive;
    UPDATE things t SET angle = rad_of(:fang), momx = :fmx / 65536e0, momy = :fmy / 65536e0 WHERE t.id = :tid;
  END
  ang = rad_of(fang);

  -- P_CalcHeight: the bob, a quarter of the speed squared (at most 16); on the ground the view
  -- comes back to 41 over a step or a landing (deltaviewheight) and bobs with leveltime, short
  -- of the ceiling by 4; in the air it's the view height alone
  fbob = BIN_SHR(fx32(fx_mul(fmx, fmx) + fx_mul(fmy, fmy)), 2);
  IF (fbob > 1048576) THEN fbob = 1048576;
  SELECT fx_of(p.view_h), fx_of(p.delta_vh) FROM player p WHERE p.id = :pid INTO vh, dvh;
  IF (onground = 0) THEN fvz = fz_z + vh;
  ELSE
  BEGIN
    bobv = fx_mul(fbob / 2, fine_sine(BIN_AND(409 * (tic - 1), 8191)));
    vh = vh + dvh;
    IF (vh > 2686976) THEN
    BEGIN
      vh = 2686976;
      dvh = 0;
    END
    IF (vh < 1343488) THEN
    BEGIN
      vh = 1343488;
      IF (dvh <= 0) THEN dvh = 1;
    END
    IF (dvh <> 0) THEN
    BEGIN
      dvh = dvh + 16384;
      IF (dvh = 0) THEN dvh = 1;
    END
    fvz = fz_z + vh + bobv;
    IF (fvz > fcz - 262144) THEN fvz = fcz - 262144;
  END
  UPDATE player p
     SET view_h = :vh / 65536e0, delta_vh = :dvh / 65536e0, view_z = :fvz / 65536e0, bob = :fbob / 65536e0
   WHERE p.id = :pid;

  -- the sector it's in (its subsector's), for its specials
  z = fz_z / 65536e0;
  SELECT sector_at_fx(fx_of(t.x), fx_of(t.y)) FROM things t WHERE t.id = :tid INTO sec;
  SELECT floor_h, ceil_h, special FROM sectors WHERE id = :sec INTO fz, cz, sspec;

  -- P_PlayerInSpecialSector: only standing on the floor (z == its sector's floorheight; falling,
  -- not yet), every tic: the damage every 32nd (leveltime & 0x1f), from nothing
  IF (sspec > 0 AND z = fz) THEN
  BEGIN
    SELECT p.iron_tics FROM player p WHERE p.id = :pid INTO iron;
    -- hellslime (10) and nukage (5): none in the radiation suit (pw_ironfeet)
    IF (sspec IN (5, 7)) THEN
    BEGIN
      IF (iron = 0 AND BIN_AND(tic, 31) = 0) THEN
        EXECUTE PROCEDURE damage_player(IIF(sspec = 5, 10, 5), NULL, pid);
    END
    -- super hellslime and the strobe hurt (20): through the suit when P_Random() < 5 – drawn every
    -- tic the suit is worn here
    ELSE IF (sspec IN (4, 16)) THEN
    BEGIN
      hurt = 1;
      IF (iron > 0) THEN hurt = IIF(p_rand256() < 5, 1, 0);
      IF (hurt = 1 AND BIN_AND(tic, 31) = 0) THEN EXECUTE PROCEDURE damage_player(20, NULL, pid);
    END
    ELSE IF (sspec = 9) THEN
    BEGIN
      UPDATE sectors SET special = 0 WHERE id = :sec;
      UPDATE player SET secrets = secrets + 1, msg = 'A secret is revealed!', msg_tics = 70 WHERE id = :pid;
    END
    -- E1M8's exit floor (11): IDDQD off, 20 every 32nd tic, and at 10 or less (even if that hit
    -- killed you) G_ExitLevel
    ELSE IF (sspec = 11) THEN
    BEGIN
      UPDATE player SET god = 0 WHERE id = :pid;
      IF (BIN_AND(tic, 31) = 0) THEN EXECUTE PROCEDURE damage_player(20, NULL, pid);
      IF ((SELECT p.health FROM player p WHERE p.id = :pid) <= 10) THEN
        UPDATE game SET exit_kind = 1 WHERE id = 1 AND exit_kind = 0;
    END
  END

  -- P_UseLines: the nearest line within 64 units straight ahead
  IF (use_key = 1 AND use_down = 0) THEN
  BEGIN
    lid = NULL;
    nx = COS(ang) * 64;
    ny = SIN(ang) * 64;
    SELECT FIRST 1 i.id, i.special
      FROM (SELECT q.id, q.special, q.back_sector, q.front_sector, q.side_,
                   ((q.x1 - :x) * q.dy - (q.y1 - :y) * q.dx) / q.den s,
                   ((q.x1 - :x) * :ny - (q.y1 - :y) * :nx) / q.den u
              FROM (SELECT l.*, (:nx * l.dy - :ny * l.dx) den,
                           SIGN(l.dx * (:y - l.y1) - l.dy * (:x - l.x1)) side_
                      FROM lines_in_box(:x - 64, :y - 64, :x + 64, :y + 64) lb
                      LEFT JOIN linedefs l ON l.id = lb.line_id
                     WHERE l.minx <= :x + 64 AND l.maxx >= :x - 64
                       AND l.miny <= :y + 64 AND l.maxy >= :y - 64) q
             WHERE q.den <> 0) i
      LEFT JOIN sectors f ON f.id = i.front_sector
      LEFT JOIN sectors b ON b.id = i.back_sector
     WHERE i.s > 0 AND i.s <= 1 AND i.u >= 0 AND i.u <= 1
       AND (i.special > 0 OR i.back_sector IS NULL
            OR MINVALUE(f.ceil_h, b.ceil_h) <= MAXVALUE(f.floor_h, b.floor_h))
       AND (i.special = 0 OR i.side_ <= 0)
     ORDER BY i.s
      INTO lid, lsp;
    IF (lid IS NOT NULL AND lsp > 0) THEN EXECUTE PROCEDURE activate_line(lid, 'use', NULL, pid);
    ELSE IF (lid IS NOT NULL) THEN EXECUTE PROCEDURE play_sound('DSNOWAY', tid, x, y);
  END

  -- P_PlayerThink: BT_CHANGE only picks the pending weapon (WEAPON_SEL: DOOM's wp_ number + 1, the
  -- port's own numbering – 1 the fist … 7 the BFG, 8 the chainsaw), any time; the one in hand
  -- changes once it has been lowered. The fist's key gives the chainsaw if you have one – unless
  -- it's in hand and you're berserk; in DOOM II the shotgun's gives the super shotgun if you have
  -- one and it isn't in hand. Only a weapon you own, and not the one in hand.
  old_weapon = weapon;
  neww = weapon_sel;
  IF (neww = 1 AND has_saw = 1 AND NOT (weapon = 8 AND (SELECT p.strength_tics FROM player p WHERE p.id = :pid) > 0)) THEN
    neww = 8;
  IF (neww = 3 AND has_ssg = 1 AND weapon <> 9
      AND EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.map_name STARTING WITH 'MAP')) THEN neww = 9;
  IF (neww > 0 AND neww <> weapon
      AND CASE neww WHEN 1 THEN 1 WHEN 2 THEN 1 WHEN 3 THEN has_sg WHEN 4 THEN has_cg WHEN 5 THEN has_rl
                    WHEN 6 THEN has_pl WHEN 7 THEN has_bfg WHEN 8 THEN has_saw WHEN 9 THEN has_ssg ELSE 0 END = 1) THEN
    pending = neww;


  UPDATE player SET pending_weapon = :pending, use_down = :use_key WHERE id = :pid;
  -- P_MovePsprites: the weapon and its flash, a tic on (firing, lowering, raising)
  EXECUTE PROCEDURE move_psprites(pid, tic);
  SELECT p.weapon, p.pending_weapon FROM player p WHERE p.id = :pid INTO weapon, pending;



END^

-- P_TouchSpecialThing for a player at (AT_X, AT_Y) (PIT_CheckThing, as a move tries it; NULL:
-- where it stands): whatever it overlaps there (ONLY_ITEM: that one), within its reach in
-- height, it picks up
CREATE OR ALTER PROCEDURE touch_specials (pid SMALLINT, tic INTEGER, at_x DOUBLE PRECISION = NULL, at_y DOUBLE PRECISION = NULL,
                                          only_item INTEGER = NULL)
AS
DECLARE alive SMALLINT;
DECLARE iron INTEGER;
DECLARE tid INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION;
DECLARE oy DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION;
DECLARE thrust DOUBLE PRECISION;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE sspec INTEGER;
DECLARE is_dead SMALLINT;
DECLARE weapon SMALLINT;
DECLARE bullets INTEGER;
DECLARE shells INTEGER;
DECLARE has_sg SMALLINT;
DECLARE has_cg SMALLINT;
DECLARE use_down SMALLINT;
DECLARE view_h DOUBLE PRECISION;
DECLARE view_z DOUBLE PRECISION;
DECLARE bob DOUBLE PRECISION;
DECLARE lid INTEGER;
DECLARE lsp INTEGER;
DECLARE pellets INTEGER;
DECLARE spread DOUBLE PRECISION;
DECLARE i INTEGER;
DECLARE iid INTEGER;
DECLARE pk VARCHAR(10);
DECLARE amt INTEGER;
DECLARE lbl VARCHAR(80);
DECLARE took SMALLINT;
DECLARE dropped SMALLINT;
DECLARE count_item SMALLINT;
DECLARE health INTEGER;
DECLARE armor INTEGER;
DECLARE armor_type SMALLINT;
DECLARE maxb INTEGER;
DECLARE maxs INTEGER;
DECLARE rockets INTEGER;
DECLARE cells INTEGER;
DECLARE maxr INTEGER;
DECLARE maxc INTEGER;
DECLARE has_rl SMALLINT;
DECLARE has_pl SMALLINT;
DECLARE has_bfg SMALLINT;
DECLARE has_saw SMALLINT;
DECLARE has_ssg SMALLINT;
DECLARE shot_hit SMALLINT;
DECLARE old_weapon SMALLINT;
DECLARE pending SMALLINT;
DECLARE neww SMALLINT;
DECLARE preact INTEGER;
DECLARE killer_ang DOUBLE PRECISION;
DECLARE bslope DOUBLE PRECISION;
DECLARE mult INTEGER;
DECLARE np SMALLINT;
DECLARE dm SMALLINT;
DECLARE gave SMALLINT;
DECLARE qn INTEGER;
DECLARE tries INTEGER;
DECLARE noclip SMALLINT;
DECLARE cmd_fwd INTEGER;
DECLARE cmd_side INTEGER;
DECLARE cmd_turn BIGINT;
DECLARE onground SMALLINT;
DECLARE fz_z BIGINT;
DECLARE ffz BIGINT;
DECLARE fcz BIGINT;
DECLARE fmx BIGINT;
DECLARE fmy BIGINT;
DECLARE fang BIGINT;
DECLARE sang BIGINT;
DECLARE vh BIGINT;
DECLARE dvh BIGINT;
DECLARE fbob BIGINT;
DECLARE bobv BIGINT;
DECLARE fvz BIGINT;
BEGIN
  SELECT p.thing_id, t.x, t.y, t.z, p.weapon, p.pending_weapon, p.dead
    FROM player p JOIN things t ON t.id = p.thing_id
   WHERE p.id = :pid
    INTO tid, x, y, z, weapon, pending, is_dead;
  IF (tid IS NULL OR is_dead = 1) THEN EXIT;     -- (the dead pick nothing up)
  IF (at_x IS NOT NULL) THEN
  BEGIN
    x = at_x;
    y = at_y;
  END
  -- P_GiveAmmo: twice the ammo on the easiest skill and on Nightmare
  SELECT IIF(g.skill IN (1, 5), 2, 1), g.players, g.deathmatch FROM game g WHERE g.id = 1 INTO mult, np, dm;
  -- P_TouchSpecialThing: pick up anything we overlap
  FOR SELECT t.id, tt.pickup, tt.amount, tt.label, IIF(BIN_AND(t.flags, 65536) <> 0, 1, 0), tt.count_item
        FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
       WHERE t.kind = 'item' AND ABS(t.x - :x) < t.radius + 16 AND ABS(t.y - :y) < t.radius + 16
         AND (:only_item IS NULL OR t.id = :only_item)
         AND t.z - :z <= 56 AND t.z - :z >= -8   -- (P_TouchSpecialThing: not above its head, nor 8 below its feet)
        ORDER BY t.id
        INTO iid, pk, amt, lbl, dropped, count_item
  DO
  BEGIN
    SELECT p.health, p.armor, p.armor_type, p.bullets, p.shells, p.max_bullets, p.max_shells, p.has_shotgun, p.has_chaingun,
           p.rockets, p.cells, p.max_rockets, p.max_cells, p.has_launcher, p.has_plasma, p.has_bfg
      FROM player p WHERE p.id = :pid
      INTO health, armor, armor_type, bullets, shells, maxb, maxs, has_sg, has_cg,
           rockets, cells, maxr, maxc, has_rl, has_pl, has_bfg;
    SELECT p.has_chainsaw, p.has_ssg FROM player p WHERE p.id = :pid INTO has_saw, has_ssg;
    took = 1;
    -- P_GiveWeapon: "leave placed weapons forever on net games" (not in
    -- -altdeath, where they respawn instead): the first time you get the
    -- weapon, and every time five clips of its ammo, with the sound for you
    -- alone and no message; a weapon you have with full ammo does nothing
    IF (np > 1 AND dm <> 2 AND dropped = 0 AND pk IN ('shotgun', 'chaingun', 'launcher', 'plasma', 'bfg', 'chainsaw', 'ssg')) THEN
    BEGIN
      gave = 0;
      IF (pk = 'shotgun' AND has_sg = 0) THEN BEGIN has_sg = 1; pending = 3; gave = 1; END
      IF (pk = 'chaingun' AND has_cg = 0) THEN BEGIN has_cg = 1; pending = 4; gave = 1; END
      IF (pk = 'launcher' AND has_rl = 0) THEN BEGIN has_rl = 1; pending = 5; gave = 1; END
      IF (pk = 'plasma' AND has_pl = 0) THEN BEGIN has_pl = 1; pending = 6; gave = 1; END
      IF (pk = 'bfg' AND has_bfg = 0) THEN BEGIN has_bfg = 1; pending = 7; gave = 1; END
      IF (pk = 'chainsaw' AND has_saw = 0) THEN BEGIN has_saw = 1; pending = 8; gave = 1; END
      IF (pk = 'ssg' AND has_ssg = 0) THEN BEGIN has_ssg = 1; pending = 9; gave = 1; END
      IF (pk IN ('shotgun', 'ssg') AND shells < maxs) THEN
      BEGIN
        shells = MINVALUE(maxs, shells + 5 * (SELECT r.clip_shells FROM rules r WHERE r.id = 1) * mult);
        gave = 1;
      END
      IF (pk = 'chaingun' AND bullets < maxb) THEN
      BEGIN
        bullets = MINVALUE(maxb, bullets + 5 * (SELECT r.clip_bullets FROM rules r WHERE r.id = 1) * mult);
        gave = 1;
      END
      IF (pk = 'launcher' AND rockets < maxr) THEN
      BEGIN
        rockets = MINVALUE(maxr, rockets + 5 * (SELECT r.clip_rockets FROM rules r WHERE r.id = 1) * mult);
        gave = 1;
      END
      IF (pk IN ('plasma', 'bfg') AND cells < maxc) THEN
      BEGIN
        cells = MINVALUE(maxc, cells + 5 * (SELECT r.clip_cells FROM rules r WHERE r.id = 1) * mult);
        gave = 1;
      END
      IF (gave = 1) THEN
      BEGIN
        UPDATE player
           SET bullets = :bullets, shells = :shells, rockets = :rockets, cells = :cells,
               has_shotgun = :has_sg, has_chaingun = :has_cg, has_launcher = :has_rl, has_plasma = :has_pl,
               has_bfg = :has_bfg, has_chainsaw = :has_saw, has_ssg = :has_ssg, pending_weapon = :pending
         WHERE id = :pid;
        EXECUTE PROCEDURE play_sound('DSWPNUP', NULL, NULL, NULL, pid);
      END
      CONTINUE;
    END
    -- MF_DROPPED: a clip a zombie dropped is half a clip (P_GiveAmmo(…, 0)),
    -- a dropped weapon one clip instead of two (P_GiveWeapon's dropped)
    IF (dropped = 1 AND pk IN ('bullets', 'shotgun', 'chaingun', 'launcher', 'plasma', 'bfg', 'ssg')) THEN
      amt = amt / 2;
    IF (pk IN ('bullets', 'shells', 'rockets', 'cells', 'shotgun', 'chaingun', 'launcher', 'plasma', 'bfg', 'ssg', 'backpack')) THEN
      amt = amt * mult;
    -- P_GiveWeapon: a weapon you have stays where it is if there's no room
    -- for its ammo (P_GiveAmmo gives nothing at the maximum); the chainsaw
    -- has no ammo, so you only take the first
    IF ((pk = 'shotgun' AND has_sg = 1 AND shells >= maxs) OR (pk = 'ssg' AND has_ssg = 1 AND shells >= maxs)
        OR (pk = 'chaingun' AND has_cg = 1 AND bullets >= maxb) OR (pk = 'launcher' AND has_rl = 1 AND rockets >= maxr)
        OR (pk = 'plasma' AND has_pl = 1 AND cells >= maxc) OR (pk = 'bfg' AND has_bfg = 1 AND cells >= maxc)
        OR (pk = 'chainsaw' AND has_saw = 1)) THEN
      took = 0;
    IF (pk = 'health') THEN
      IF (health >= 100) THEN took = 0; ELSE health = MINVALUE(100, health + amt);
    ELSE IF (pk = 'health+') THEN health = MINVALUE((SELECT r.max_health FROM rules r WHERE r.id = 1), health + amt);
    -- the soulsphere: its own cap (deh_max_soulsphere)
    ELSE IF (pk = 'soul') THEN health = MINVALUE((SELECT r.max_soul FROM rules r WHERE r.id = 1), health + amt);
    -- P_GiveArmor: the green armour is type 1 (100 points), the blue type 2
    -- (200); taken only if it's more than you have
    ELSE IF (pk = 'armor') THEN
    BEGIN
      IF (armor >= amt) THEN took = 0;
      ELSE
      BEGIN
        armor = amt;
        armor_type = amt / 100;
      END
    END
    -- an armour bonus: a point, and green armour's type if you had none
    ELSE IF (pk = 'armor+') THEN
    BEGIN
      armor = MINVALUE((SELECT r.max_armor FROM rules r WHERE r.id = 1), armor + amt);
      IF (armor_type = 0) THEN armor_type = 1;
    END
    ELSE IF (pk = 'bullets') THEN
      IF (bullets >= maxb) THEN took = 0; ELSE bullets = MINVALUE(maxb, bullets + amt);
    ELSE IF (pk = 'shells') THEN
      IF (shells >= maxs) THEN took = 0; ELSE shells = MINVALUE(maxs, shells + amt);
    ELSE IF (pk = 'shotgun') THEN
    BEGIN
      IF (has_sg = 0) THEN pending = 3;
      has_sg = 1;
      shells = MINVALUE(maxs, shells + amt);
    END
    ELSE IF (pk = 'chaingun') THEN
    BEGIN
      IF (has_cg = 0) THEN pending = 4;
      has_cg = 1;
      bullets = MINVALUE(maxb, bullets + amt);
    END
    ELSE IF (pk = 'rockets') THEN
      IF (rockets >= maxr) THEN took = 0; ELSE rockets = MINVALUE(maxr, rockets + amt);
    ELSE IF (pk = 'cells') THEN
      IF (cells >= maxc) THEN took = 0; ELSE cells = MINVALUE(maxc, cells + amt);
    ELSE IF (pk = 'launcher') THEN
    BEGIN
      IF (has_rl = 0) THEN pending = 5;
      has_rl = 1;
      rockets = MINVALUE(maxr, rockets + amt);
    END
    ELSE IF (pk = 'plasma') THEN
    BEGIN
      IF (has_pl = 0) THEN pending = 6;
      has_pl = 1;
      cells = MINVALUE(maxc, cells + amt);
    END
    ELSE IF (pk = 'bfg') THEN
    BEGIN
      IF (has_bfg = 0) THEN pending = 7;
      has_bfg = 1;
      cells = MINVALUE(maxc, cells + amt);
    END
    ELSE IF (pk = 'chainsaw') THEN
    BEGIN
      IF (has_saw = 0) THEN pending = 8;
      has_saw = 1;
    END
    ELSE IF (pk = 'ssg') THEN
    BEGIN
      IF (has_ssg = 0) THEN pending = 9;
      has_ssg = 1;
      shells = MINVALUE(maxs, shells + amt);
    END
    ELSE IF (pk = 'allmap') THEN
    BEGIN
      -- P_GivePower: you can only carry one
      IF ((SELECT p.allmap FROM player p WHERE p.id = :pid) = 1) THEN took = 0;
    END
    ELSE IF (pk = 'berserk') THEN
    BEGIN
      health = MAXVALUE(health, amt);      -- P_GiveBody: up to 100, always taken
      IF (weapon <> 1) THEN pending = 1;   -- and the fist comes up
    END
    ELSE IF (pk = 'mega') THEN
    BEGIN
      health = amt;                         -- deh_megasphere_health
      armor_type = (SELECT r.blue_class FROM rules r WHERE r.id = 1);      -- P_GiveArmor(player, deh_blue_armor_class)
      armor = 100 * armor_type;
    END
    ELSE IF (pk = 'backpack') THEN
    BEGIN
      -- the first one doubles every maximum; each gives a clip of everything
      maxb = 2 * (SELECT r.max_bullets FROM rules r WHERE r.id = 1);
      maxs = 2 * (SELECT r.max_shells FROM rules r WHERE r.id = 1);
      maxr = 2 * (SELECT r.max_rockets FROM rules r WHERE r.id = 1);
      maxc = 2 * (SELECT r.max_cells FROM rules r WHERE r.id = 1);
      bullets = MINVALUE(maxb, bullets + amt);
      shells = MINVALUE(maxs, shells + (SELECT r.clip_shells FROM rules r WHERE r.id = 1) * mult);
      rockets = MINVALUE(maxr, rockets + (SELECT r.clip_rockets FROM rules r WHERE r.id = 1) * mult);
      cells = MINVALUE(maxc, cells + (SELECT r.clip_cells FROM rules r WHERE r.id = 1) * mult);
    END
    IF (took = 1) THEN
    BEGIN
      -- P_RemoveMobj: in -altdeath what you took goes on the respawn queue
      -- (not what a monster dropped, nor the two spheres)
      IF (dm = 2 AND dropped = 0 AND pk NOT IN ('invuln', 'invis')) THEN
      BEGIN
        SELECT COALESCE(MAX(q.id), 0) + 1 FROM respawn_queue q INTO qn;
        INSERT INTO respawn_queue (id, ttype, x, y, angle, tic)
        SELECT :qn, t.thing_type, t.x, t.y, t.angle, :tic FROM things t WHERE t.id = :iid;
      END
      DELETE FROM things WHERE id = :iid;
      UPDATE player
         SET health = :health, armor = :armor, armor_type = :armor_type, bullets = :bullets, shells = :shells,
             max_bullets = :maxb, max_shells = :maxs, has_shotgun = :has_sg, has_chaingun = :has_cg,
             rockets = :rockets, cells = :cells, max_rockets = :maxr, max_cells = :maxc,
             has_launcher = :has_rl, has_plasma = :has_pl, has_bfg = :has_bfg,
             has_chainsaw = :has_saw, has_ssg = :has_ssg,
             pending_weapon = :pending, items = items + :count_item, bonus_count = 6,
             keycards = IIF(:pk = 'key', BIN_OR(keycards, :amt), keycards),
             invis_tics = IIF(:pk = 'invis', :amt, invis_tics),
             invuln_tics = IIF(:pk = 'invuln', :amt, invuln_tics),
             iron_tics = IIF(:pk = 'suit', :amt, iron_tics),
             strength_tics = IIF(:pk = 'berserk', 1, strength_tics),
             allmap = IIF(:pk = 'allmap', 1, allmap),
             infra_tics = IIF(:pk = 'goggles', :amt, infra_tics),
             -- the item's message (GOTARMOR…); a key only says so the first time
             msg = IIF(:pk = 'key' AND BIN_AND(keycards, :amt) <> 0, msg, :lbl),
             msg_tics = IIF(:pk = 'key' AND BIN_AND(keycards, :amt) <> 0, msg_tics, 70)
       WHERE id = :pid;
      -- (P_GiveBody and the spheres: player->mo->health = player->health, the body's own)
      UPDATE things t SET hp = (SELECT p.health FROM player p WHERE p.id = :pid)
       WHERE t.id = (SELECT p.thing_id FROM player p WHERE p.id = :pid);
      EXECUTE PROCEDURE play_sound(CASE WHEN pk IN ('shotgun', 'chaingun', 'launcher', 'plasma', 'bfg', 'chainsaw', 'ssg') THEN 'DSWPNUP'
                                        WHEN pk IN ('none', 'soul', 'mega', 'invis', 'invuln', 'suit', 'goggles', 'berserk', 'allmap') THEN 'DSGETPOW' ELSE 'DSITEMUP' END, NULL, NULL, NULL, pid);
    END
  END
END^

-- A player's body, its own thinker in its turn (P_MobjThinker): the floor where it stands if it
-- has just landed somewhere, P_XYMovement (slides, crosses lines, and picks up what it touches
-- on the way: P_TryMove's PIT_CheckThing, in CHECK_POSITION_FX) and P_ZMovement in 16.16
CREATE OR ALTER PROCEDURE player_body (pid SMALLINT, tic INTEGER)
AS
DECLARE tid INTEGER;
DECLARE cf INTEGER;
DECLARE cs INTEGER;
BEGIN
  SELECT p.thing_id, p.cmd_fwd, p.cmd_side FROM player p WHERE p.id = :pid INTO tid, cf, cs;
  IF (tid IS NULL) THEN EXIT;
  EXECUTE PROCEDURE height_clip_fx(tid);
  EXECUTE PROCEDURE xy_movement_fx(tid, pid, cf, cs, tic);
  EXECUTE PROCEDURE z_movement_fx(tid, pid);
END^


-- (A_SkullAttack, declared here for A_PainShootSkull; its body comes with the frame tables)
CREATE OR ALTER PROCEDURE a_skull_attack (tid INTEGER)
AS
BEGIN
END^

-- (TRY_MOVE_MOBJ, P_TryMove for a monster, declared here for A_PainShootSkull; its body comes
-- with the monsters' walk)
CREATE OR ALTER PROCEDURE try_move_mobj (tid INTEGER, x BIGINT, y BIGINT, things SMALLINT = 1)
RETURNS (ok SMALLINT, floatok SMALLINT, tmfloorz BIGINT, spechit VARCHAR(4000))
AS
BEGIN
  ok = 0;
END^

-- A_PainShootSkull, in 16.16: unless more than 20 lost souls are about (dying ones too), one
-- spawned in front of ACTOR along AN (BAMs), 4 + 3/2 × the two radii (mobjinfo's) out and 8 up;
-- if P_TryMove won't have it there, it's killed at once (10000, from the pain elemental); else
-- it's after the pain elemental's target and charges (A_SkullAttack).
CREATE OR ALTER PROCEDURE pain_shoot_skull (actor INTEGER, an BIGINT)
AS
DECLARE sx BIGINT;
DECLARE sy BIGINT;
DECLARE sz BIGINT;
DECLARE arad BIGINT;
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE prestep BIGINT;
DECLARE fa INTEGER;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE mid INTEGER;
DECLARE ok SMALLINT;
DECLARE floatok SMALLINT;
DECLARE tmfz BIGINT;
DECLARE spec VARCHAR(4000);
BEGIN
  IF ((SELECT COUNT(*) FROM things s WHERE s.thing_type = 3006 AND s.state IS NOT NULL) > 20) THEN EXIT;
  sx = NULL;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(tt.radius), t.target_id, t.tplayer
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :actor
    INTO sx, sy, sz, arad, tgt, tp;
  IF (sx IS NULL) THEN EXIT;
  prestep = 262144 + (3 * (arad + (SELECT fx_of(tt.radius) FROM thing_types tt WHERE tt.thing_type = 3006))) / 2;
  fa = BIN_SHR(an, 19);
  x = sx + fx_mul(prestep, fine_cosine(fa));
  y = sy + fx_mul(prestep, fine_sine(fa));
  EXECUTE PROCEDURE spawn_thing(3006, x / 65536e0, y / 65536e0, (sz + 524288) / 65536e0, 0) RETURNING_VALUES mid;
  EXECUTE PROCEDURE try_move_mobj(mid, x, y) RETURNING_VALUES ok, floatok, tmfz, spec;
  IF (ok = 0) THEN
  BEGIN
    EXECUTE PROCEDURE damage_thing(mid, 10000, actor, actor);
    EXIT;
  END
  -- newmobj->target = actor->target, and A_SkullAttack: it launches itself at once
  UPDATE things t SET target_id = :tgt, tplayer = COALESCE(:tp, t.tplayer) WHERE t.id = :mid;
  EXECUTE PROCEDURE a_skull_attack(mid);
END^

-- A monster's attack lands on its target: the player (TGT NULL) or a monster.
CREATE OR ALTER PROCEDURE hurt_target (tgt INTEGER, dmg INTEGER, src INTEGER, tp SMALLINT = 1)
AS
BEGIN
  IF (tgt IS NULL) THEN EXECUTE PROCEDURE damage_player(dmg, src, tp, src);
  ELSE EXECUTE PROCEDURE damage_thing(tgt, dmg, src, src);
END^

-- A_BossDeath: when the last of a boss type dies, some maps open up or end.
CREATE OR ALTER PROCEDURE boss_death (ttype INTEGER)
AS
DECLARE mn VARCHAR(8);
DECLARE sec INTEGER;
DECLARE fh DOUBLE PRECISION;
DECLARE h DOUBLE PRECISION;
BEGIN
  IF (EXISTS (SELECT 1 FROM things t WHERE t.thing_type = :ttype AND t.st NOT IN ('dying', 'dead'))) THEN EXIT;
  SELECT g.map_name FROM game g WHERE g.id = 1 INTO mn;
  IF ((mn = 'E2M8' AND ttype = 16) OR (mn = 'E3M8' AND ttype = 7)) THEN
    UPDATE game SET exit_kind = 1 WHERE id = 1;
  ELSE IF ((mn = 'E1M8' AND ttype = 3003) OR (mn = 'E4M8' AND ttype = 7) OR (mn = 'MAP07' AND ttype = 67)) THEN
    -- lowerFloorToLowest, tag 666
    FOR SELECT id, floor_h FROM sectors WHERE tag = 666 ORDER BY id INTO sec, fh DO
      EXECUTE PROCEDURE floor_start(sec, MINVALUE(fh, COALESCE(neighbor_h(sec, 'min_floor'), fh)), 1, -1, 'lowerFloorToLowest', 0);
  ELSE IF (mn = 'E4M6' AND ttype = 16) THEN
    -- blazeOpen, tag 666
    FOR SELECT id FROM sectors WHERE tag = 666 ORDER BY id INTO sec DO
      EXECUTE PROCEDURE door_start(sec, 'blazeOpen');
  ELSE IF (mn = 'MAP07' AND ttype = 68) THEN
    -- raiseToTexture, tag 667: by the height of the shortest lower texture around it
    FOR SELECT id, floor_h FROM sectors WHERE tag = 667 ORDER BY id INTO sec, fh DO
    BEGIN
      SELECT MIN(tx.h) FROM linedefs l
        JOIN sidedefs sd ON sd.id IN (l.front_side, l.back_side)
        JOIN textures tx ON tx.id = sd.lower_tex
       WHERE l.front_sector = :sec OR l.back_sector = :sec
        INTO h;
      EXECUTE PROCEDURE floor_start(sec, fh + COALESCE(h, 24), 1, 1, 'raiseToTexture', 0);
    END
END^

-- A_KeenDie: the last Keen opens the doors tagged 666.
CREATE OR ALTER PROCEDURE keen_die
AS
DECLARE sec INTEGER;
BEGIN
  IF (EXISTS (SELECT 1 FROM things t WHERE t.kind = 'keen' AND t.st NOT IN ('dying', 'dead'))) THEN EXIT;
  FOR SELECT id FROM sectors WHERE tag = 666 ORDER BY id INTO sec DO
    EXECUTE PROCEDURE door_start(sec, 'open');
END^

-- A_Look / A_Chase / A_FaceTarget / A_PosAttack / A_TroopAttack / A_SargAttack,
-- collapsed into one state machine per thing.
-- P_LookForPlayers: the first player, counting on from FIRST_PID, that is alive
-- and in sight (REJECT, then the line of sight) – and, unless ALLAROUND, in
-- the 180° ahead or within MELEERANGE (64) behind. 0: nobody.
-- P_LookForPlayers: from the player after LASTLOOK on (THINGS.LASTLOOK, each in the game in
-- turn), the first that is alive and in sight (P_CheckSight) – and, unless ALLAROUND, in the
-- 180° ahead (R_PointToAngle2) or within MELEERANGE (64) behind. DOOM gives up after two
-- rounds, or on reaching the player before LASTLOOK – so, alone in the game, a monster whose
-- LASTLOOK is 1 doesn't look at all the first time. LASTLOOK stays where the search ended.
-- → FOUND: the player, 0 nobody.
CREATE OR ALTER PROCEDURE look_for_players (tid INTEGER, allaround SMALLINT)
RETURNS (found SMALLINT)
AS
DECLARE ll SMALLINT;
DECLARE stp SMALLINT;
DECLARE c INTEGER = 0;
DECLARE n INTEGER = 0;
DECLARE pthing INTEGER;
DECLARE hp INTEGER;
DECLARE ax BIGINT;
DECLARE ay BIGINT;
DECLARE aang BIGINT;
DECLARE qx BIGINT;
DECLARE qy BIGINT;
DECLARE an BIGINT;
DECLARE ok SMALLINT;
DECLARE seen VARCHAR(64) = ',';
BEGIN
  found = 0;
  SELECT t.lastlook, fx_of(t.x), fx_of(t.y), bam_of(t.angle) FROM things t WHERE t.id = :tid INTO ll, ax, ay, aang;
  stp = BIN_AND(ll + 3, 3);
  WHILE (n < 16) DO
  BEGIN
    n = n + 1;
    pthing = NULL;
    SELECT p.thing_id, IIF(p.dead = 1, 0, p.health) FROM player p WHERE p.id = :ll + 1 INTO pthing, hp;
    IF (pthing IS NOT NULL) THEN                -- (playeringame)
    BEGIN
      IF (c = 2 OR ll = stp) THEN LEAVE;        -- (c++ == 2 || lastlook == stop: done looking)
      c = c + 1;
      -- (P_CheckSight again for a player already looked at gives the same answer: kept)
      IF (POSITION(',' || ll || ':' IN seen) = 0) THEN seen = seen || ll || ':' || IIF(hp > 0, sight_fx(tid, pthing), 0) || ',';
      IF (POSITION(',' || ll || ':1,' IN seen) > 0) THEN
      BEGIN
        ok = 1;
        IF (allaround = 0) THEN
        BEGIN
          SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :pthing INTO qx, qy;
          an = BIN_AND(point_to_angle2(ax, ay, qx, qy) - aang, 4294967295);
          IF (an > 1073741824 AND an < 3221225472 AND aprox_distance(fx32(qx - ax), fx32(qy - ay)) > 4194304) THEN ok = 0;
        END
        IF (ok = 1) THEN
        BEGIN
          found = ll + 1;
          LEAVE;
        END
      END
    END
    ll = BIN_AND(ll + 1, 3);
  END
  UPDATE things t SET lastlook = :ll WHERE t.id = :tid;
END^

CREATE OR ALTER PROCEDURE look_for_player (
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, hgt DOUBLE PRECISION, ang DOUBLE PRECISION,
  sec INTEGER, first_pid SMALLINT, allaround SMALLINT)
RETURNS (found SMALLINT)
AS
DECLARE pid SMALLINT;
DECLARE qx DOUBLE PRECISION;
DECLARE qy DOUBLE PRECISION;
DECLARE qz DOUBLE PRECISION;
DECLARE qsec INTEGER;
DECLARE d DOUBLE PRECISION;
BEGIN
  found = 0;
  FOR SELECT p.id, t.x, t.y, t.z, t.sector_id
        FROM player p JOIN things t ON t.id = p.thing_id
       WHERE p.dead = 0
       ORDER BY MOD(p.id - :first_pid + 4, 4), p.id
        INTO pid, qx, qy, qz, qsec
  DO
  BEGIN
    IF (rejected(sec, qsec) = 1) THEN CONTINUE;
    IF (check_sight(x, y, z + hgt * 0.75e0, qx, qy, qz + 41) = 0) THEN CONTINUE;
    IF (allaround = 0) THEN
    BEGIN
      d = atan2_safe(qy - y, qx - x) - ang;
      d = d - 2 * PI() * FLOOR(d / (2 * PI()));
      IF (d > PI() / 2 AND d < 3 * PI() / 2 AND SQRT((qx - x) * (qx - x) + (qy - y) * (qy - y)) > 64) THEN CONTINUE;
    END
    found = pid;
    EXIT;
  END
END^

-- P_NightmareRespawn: on Nightmare a monster's corpse that has lain 12 seconds
-- may get back up – every 32 tics each one tries, 4 times in 256 – at the
-- spot the map put it, in a flash of teleport fog, if there's room. Lost
-- souls don't count as kills and don't come back.
-- One corpse's chance to rise (P_MobjThinker's check, every 32 tics, P_NightmareRespawn)
CREATE OR ALTER PROCEDURE nightmare_step (id INTEGER, tic INTEGER)
AS
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sa DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE mid INTEGER;
BEGIN
  x = NULL;
  SELECT t.x, t.y, t.spawn_x, t.spawn_y, t.spawn_angle, tt.radius, tt.height
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :id AND t.kind = 'monster' AND t.st = 'dead' AND t.thing_type <> 3006
     AND t.spawn_x IS NOT NULL AND t.dead_tic IS NOT NULL AND :tic - t.dead_tic >= 12 * 35
    INTO x, y, sx, sy, sa, rad, hgt;
  IF (x IS NULL) THEN EXIT;
  IF (p_random() * 256 > 4) THEN EXIT;
  EXECUTE PROCEDURE check_position(id, sx, sy, (SELECT se.floor_h FROM sectors se WHERE se.id = sector_at(:sx, :sy)),
                                   rad, hgt, 1)
    RETURNING_VALUES ok, fz, cz, dz, sec;
  IF (ok = 0) THEN EXIT;
  -- fog where the corpse lay, and where it rises
  EXECUTE PROCEDURE spawn_thing(9016, x, y, NULL, 0) RETURNING_VALUES mid;
  EXECUTE PROCEDURE spawn_thing(9016, sx, sy, NULL, 0) RETURNING_VALUES mid;
  EXECUTE PROCEDURE play_sound('DSTELEPT', mid, sx, sy);
  mid = MOD(p_rand256(), 4);   -- (P_SpawnMobj for the new body: its lastlook)
  UPDATE things t SET lastlook = :mid WHERE t.id = :id;
  UPDATE things t
     SET x = :sx, y = :sy, angle = :sa, z = :fz, sector_id = :sec, momx = 0, momy = 0, momz = 0,
         hp = (SELECT tt.hp FROM thing_types tt WHERE tt.thing_type = t.thing_type),
         st = 'idle', solid = 1,
         -- (P_NightmareRespawn: the new body's reactiontime is 18)
         reaction = 18,
         target_id = NULL, threshold = 0, dead_tic = NULL, movedir = 0, movecount = 0, just_attacked = 0,
         -- (its spawn state, as a new P_SpawnMobj)
         state = (SELECT tt.spawn_state FROM thing_types tt WHERE tt.thing_type = t.thing_type),
         state_tic = (SELECT IIF(s.tics >= 0, :tic + s.tics, NULL)
                        FROM thing_types tt JOIN states s ON s.id = tt.spawn_state WHERE tt.thing_type = t.thing_type),
         just_hit = 0
   WHERE t.id = :id;
END^

CREATE OR ALTER PROCEDURE nightmare_respawn (tic INTEGER)
AS
DECLARE id INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sa DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE mid INTEGER;
BEGIN
  FOR SELECT t.id, t.x, t.y, t.spawn_x, t.spawn_y, t.spawn_angle, tt.radius, tt.height
        FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
       WHERE t.kind = 'monster' AND t.st = 'dead' AND t.thing_type <> 3006
         AND t.spawn_x IS NOT NULL AND t.dead_tic IS NOT NULL AND :tic - t.dead_tic >= 12 * 35
        ORDER BY t.id
        INTO id, x, y, sx, sy, sa, rad, hgt
  DO
    EXECUTE PROCEDURE nightmare_step(id, tic);
END^

-- The light thinkers, every tic: T_LightFlash, T_StrobeFlash and T_FireFlicker count down
-- (if (--count) return) and, at 0, change – the flash to its other level for (P_Random() & 7) + 1
-- tics dark or (P_Random() & 64) + 1 bright, the strobe for its dark or bright time, the flicker
-- 0–3 × 16 below its brightest (P_Random() & 3; no lower than its floor) for 4 more; T_Glow
-- steps 8 a tic, turning at either end. Those that draw do so one at a time, in their
-- thinkers' order (RUN_THINKERS; LIGHTS_THINK alone, in sector order).

-- The light thinkers' countdowns, all at once (if (--count) return), and T_Glow's steps: no
-- draw in them, so no order. Those at 0 change in their turn (LIGHT_STEP, RUN_THINKERS).
CREATE OR ALTER PROCEDURE lights_count (tic INTEGER)
AS
BEGIN
  UPDATE sectors s
     SET light = IIF(s.lfx_dir = -1, IIF(s.light - 8 <= s.lfx_min, s.light, s.light - 8),
                                     IIF(s.light + 8 >= s.lfx_max, s.light, s.light + 8)),
         lfx_dir = IIF(s.lfx_dir = -1, IIF(s.light - 8 <= s.lfx_min, 1, -1), IIF(s.light + 8 >= s.lfx_max, -1, 1))
   WHERE s.lfx = 'glow';
  UPDATE sectors s SET lfx_count = s.lfx_count - 1 WHERE s.lfx IN ('flash', 'strobe', 'flicker');
END^

-- A light thinker at the end of its count changes (T_LightFlash, T_StrobeFlash, T_FireFlicker)
CREATE OR ALTER PROCEDURE light_step (sec INTEGER)
AS
DECLARE k VARCHAR(8);
DECLARE lt INTEGER;
DECLARE mn INTEGER;
DECLARE mx INTEGER;
DECLARE dark INTEGER;
DECLARE amount INTEGER;
BEGIN
  k = NULL;
  SELECT s.lfx, s.light, s.lfx_min, s.lfx_max, s.lfx_dark FROM sectors s
   WHERE s.id = :sec AND s.lfx IN ('flash', 'strobe', 'flicker') INTO k, lt, mn, mx, dark;
  IF (k IS NULL) THEN EXIT;
  IF (k = 'flash') THEN
  BEGIN
    IF (lt = mx) THEN UPDATE sectors s SET light = :mn, lfx_count = p_rand_and(7) + 1 WHERE s.id = :sec;
    ELSE UPDATE sectors s SET light = :mx, lfx_count = p_rand_and(64) + 1 WHERE s.id = :sec;
  END
  ELSE IF (k = 'strobe') THEN
    UPDATE sectors s SET light = IIF(:lt = :mn, :mx, :mn), lfx_count = IIF(:lt = :mn, 5, :dark) WHERE s.id = :sec;
  ELSE
  BEGIN
    amount = p_rand_and(3) * 16;
    UPDATE sectors s SET light = IIF(:lt - :amount < :mn, :mn, :mx - :amount), lfx_count = 4 WHERE s.id = :sec;
  END
END^

CREATE OR ALTER PROCEDURE lights_think (tic INTEGER)
AS
DECLARE sec INTEGER;
DECLARE k VARCHAR(8);
DECLARE lt INTEGER;
DECLARE mn INTEGER;
DECLARE mx INTEGER;
DECLARE dark INTEGER;
DECLARE amount INTEGER;
BEGIN
  EXECUTE PROCEDURE lights_count(tic);
  FOR SELECT s.id, s.lfx, s.light, s.lfx_min, s.lfx_max, s.lfx_dark FROM sectors s
       WHERE s.lfx IN ('flash', 'strobe', 'flicker') AND s.lfx_count = 0
       ORDER BY s.id
        INTO sec, k, lt, mn, mx, dark
  DO
    EXECUTE PROCEDURE light_step(sec);
END^

-- ── the tic ───────────────────────────────────────────────────────────────
-- G_Ticker: called by the browser with the input held since the last frame;
-- runs `tics` 35 Hz game tics and returns the status bar.
-- printf's %x for a 32-bit value: two's complement, lower case, no padding.
CREATE OR ALTER FUNCTION hex32 (v BIGINT) RETURNS VARCHAR(8)
AS
DECLARE s VARCHAR(8) = '';
BEGIN
  v = MOD(MOD(v, 4294967296) + 4294967296, 4294967296);
  IF (v = 0) THEN RETURN '0';
  WHILE (v > 0) DO
  BEGIN
    s = SUBSTRING('0123456789abcdef' FROM MOD(v, 16) + 1 FOR 1) || s;
    v = v / 16;
  END
  RETURN s;
END^

-- ST_Responder's cheats, typed during play (the browser spots the letters).
-- IDDQD toggles god mode (and heals you to 100); IDKFA (IDFA: no keys) hands over every
-- weapon (the super shotgun only in DOOM II), full ammo, 200 armour and every
-- key. IDCLIP (or DOOM I's IDSPISPOPD) toggles walking through walls. A dead
-- player can't cheat. IDBEHOLD alone lists the power-ups; with v/s/i/r/a/l
-- after it, it toggles one. IDCHOPPERS hands over the chainsaw. (IDCLEV is
-- the browser's: it loads another map; so is IDMUS, which changes the music.)
-- IDMYPOS shows where you are, the way DOOM printed it.
CREATE OR ALTER PROCEDURE cheat (code VARCHAR(16))
AS
BEGIN
  code = LOWER(code);
  -- ST_Responder: none of these work on Nightmare
  IF ((SELECT g.skill FROM game g WHERE g.id = 1) = 5) THEN EXIT;
  IF (code = 'iddqd') THEN
  BEGIN
    UPDATE player p SET god = 1 - p.god WHERE p.id = 1 AND p.dead = 0;
    UPDATE player p
       SET health = IIF(p.god = 1, (SELECT r.god_health FROM rules r WHERE r.id = 1), p.health),
           msg = TRIM(IIF(p.god = 1, 'Degreelessness Mode On', 'Degreelessness Mode Off')), msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
    UPDATE things t SET hp = (SELECT p.health FROM player p WHERE p.id = 1)   -- (and the body's: plyr->mo->health)
     WHERE t.id = (SELECT p.thing_id FROM player p WHERE p.id = 1 AND p.dead = 0 AND p.god = 1);
  END
  ELSE IF (code IN ('idclip', 'idspispopd')) THEN
  BEGIN
    UPDATE player p SET noclip = 1 - p.noclip WHERE p.id = 1 AND p.dead = 0;
    UPDATE player p
       SET msg = TRIM(IIF(p.noclip = 1, 'No Clipping Mode ON', 'No Clipping Mode OFF')), msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
  END
  ELSE IF (code = 'idmypos') THEN
    -- "ang=0x%x;x,y=(0x%x,0x%x)": the angle in BAMs, x and y in 16.16 fixed point
    UPDATE player p
       SET msg = (SELECT 'ang=0x' || hex32(FLOOR(t.angle / (2 * PI()) * 4294967296))
                         || ';x,y=(0x' || hex32(FLOOR(t.x * 65536)) || ',0x' || hex32(FLOOR(t.y * 65536)) || ')'
                    FROM things t WHERE t.id = p.thing_id),
           msg_tics = 70
     WHERE p.id = 1;
  ELSE IF (code = 'idchoppers') THEN
    -- (vanilla also sets pw_invulnerability to "true": 1 tic, which cancels a sphere)
    UPDATE player p SET has_chainsaw = 1, invuln_tics = 1, msg = '... doesn''t suck - GM', msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
  ELSE IF (code = 'idbehold') THEN
    UPDATE player p SET msg = 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp', msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
  ELSE IF (code IN ('idbeholdv', 'idbeholds', 'idbeholdi', 'idbeholdr', 'idbeholda', 'idbeholdl')) THEN
    -- off: P_GivePower's tics; on: 1 tic left (berserk straight to 0); the
    -- computer map can't be taken back
    UPDATE player p
       SET invuln_tics = IIF(:code = 'idbeholdv', IIF(p.invuln_tics > 0, 1, 1050), p.invuln_tics),
           strength_tics = IIF(:code = 'idbeholds', IIF(p.strength_tics > 0, 0, 1), p.strength_tics),
           health = IIF(:code = 'idbeholds' AND p.strength_tics = 0, MAXVALUE(p.health, 100), p.health),
           invis_tics = IIF(:code = 'idbeholdi', IIF(p.invis_tics > 0, 1, 2100), p.invis_tics),
           iron_tics = IIF(:code = 'idbeholdr', IIF(p.iron_tics > 0, 1, 2100), p.iron_tics),
           allmap = IIF(:code = 'idbeholda', 1, p.allmap),
           infra_tics = IIF(:code = 'idbeholdl', IIF(p.infra_tics > 0, 1, 4200), p.infra_tics),
           msg = 'Power-up Toggled', msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
  ELSE IF (code IN ('idkfa', 'idfa')) THEN
    -- IDFA is IDKFA without the keys
    UPDATE player p
       SET has_shotgun = 1, has_chaingun = 1, has_launcher = 1, has_plasma = 1, has_bfg = 1, has_chainsaw = 1,
           has_ssg = IIF((SELECT g.map_name FROM game g WHERE g.id = 1) STARTING WITH 'MAP', 1, p.has_ssg),
           bullets = p.max_bullets, shells = p.max_shells, rockets = p.max_rockets, cells = p.max_cells,
           armor = IIF(:code = 'idkfa', (SELECT r.idkfa_armor FROM rules r WHERE r.id = 1), (SELECT r.idfa_armor FROM rules r WHERE r.id = 1)),
           armor_type = IIF(:code = 'idkfa', (SELECT r.idkfa_class FROM rules r WHERE r.id = 1), (SELECT r.idfa_class FROM rules r WHERE r.id = 1)),
           keycards = IIF(:code = 'idkfa', 7, p.keycards),
           msg = TRIM(IIF(:code = 'idkfa', 'Very Happy Ammo Added', 'Ammo (no keys) Added')), msg_tics = 70
     WHERE p.id = 1 AND p.dead = 0;
END^

-- The HUD row of player PID: what DOOM_TIC and NET_TIC return.
CREATE OR ALTER PROCEDURE hud_row (pid SMALLINT)
RETURNS (
  tic INTEGER, health INTEGER, armor INTEGER, bullets INTEGER, shells INTEGER, weapon SMALLINT,
  has_shotgun SMALLINT, has_chaingun SMALLINT, keycards INTEGER,
  rockets INTEGER, cells INTEGER, has_launcher SMALLINT, has_plasma SMALLINT, has_bfg SMALLINT,
  has_chainsaw SMALLINT, has_ssg SMALLINT,
  max_bullets INTEGER, max_shells INTEGER, max_rockets INTEGER, max_cells INTEGER,
  psp_pic VARCHAR(8), flash_pic VARCHAR(8), damage_count INTEGER, bonus_count INTEGER,
  msg VARCHAR(80), dead SMALLINT, exit_kind SMALLINT,
  kills INTEGER, total_kills INTEGER, items INTEGER, total_items INTEGER,
  secrets INTEGER, total_secrets INTEGER,
  px DOUBLE PRECISION, py DOUBLE PRECISION, pangle DOUBLE PRECISION, view_z DOUBLE PRECISION,
  sides_rev INTEGER, map_name VARCHAR(8), invis_tics INTEGER, invuln_tics INTEGER,
  iron_tics INTEGER, infra_tics INTEGER, strength_tics INTEGER, allmap SMALLINT, god SMALLINT, psp_sx DOUBLE PRECISION, psp_sy DOUBLE PRECISION, extralight SMALLINT,
  attacker_angle DOUBLE PRECISION, frags INTEGER, deathmatch SMALLINT)
AS
BEGIN
  SELECT g.tic, p.health, p.armor, p.bullets, p.shells, p.weapon, p.has_shotgun, p.has_chaingun, p.keycards,
         p.rockets, p.cells, p.has_launcher, p.has_plasma, p.has_bfg, p.has_chainsaw, p.has_ssg,
         p.max_bullets, p.max_shells, p.max_rockets, p.max_cells,
         -- (R_DrawPSprite's lumps: the state's sprite and frame, rotation 0)
         (SELECT TRIM(s.sprite) || s.frame || '0' FROM states s WHERE s.id = p.psp_state),
         (SELECT TRIM(s.sprite) || s.frame || '0' FROM states s WHERE s.id = p.flash_state), p.damage_count, p.bonus_count, IIF(p.msg_tics > 0, p.msg, NULL),
         p.dead, g.exit_kind, p.kills, g.total_kills, p.items, g.total_items, p.secrets, g.total_secrets,
         t.x, t.y, t.angle, p.view_z, g.sides_rev, g.map_name, p.invis_tics, p.invuln_tics, p.iron_tics, p.infra_tics, p.strength_tics, p.allmap, p.god, p.psp_sx, p.psp_sy, p.extralight,
         (SELECT atan2_safe(a.y - t.y, a.x - t.x) FROM things a WHERE a.id = p.attacker_id AND a.id <> t.id),
         -- ST_updateWidgets' st_fragscount: the others you killed, less the times you killed yourself
         COALESCE((SELECT SUM(IIF(f.victim = :pid, -f.n, f.n)) FROM frags f WHERE f.killer = :pid), 0), g.deathmatch
    FROM player p JOIN things t ON t.id = p.thing_id CROSS JOIN game g
   WHERE p.id = :pid AND g.id = 1
    INTO tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards,
         rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg,
         max_bullets, max_shells, max_rockets, max_cells,
         psp_pic, flash_pic, damage_count, bonus_count, msg, dead, exit_kind,
         kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z,
         sides_rev, map_name, invis_tics, invuln_tics, iron_tics, infra_tics, strength_tics, allmap, god, psp_sx, psp_sy, extralight,
         attacker_angle, frags, deathmatch;
  SUSPEND;
END^

-- P_RespawnSpecials: in -altdeath the oldest thing picked up comes back where
-- it was once 30 seconds have passed, in a puff of fog (IFOG) with its sound –
-- one a tic at most.
CREATE OR ALTER PROCEDURE respawn_specials (tic INTEGER)
AS
DECLARE qid INTEGER;
DECLARE ttype INTEGER;
DECLARE qx DOUBLE PRECISION;
DECLARE qy DOUBLE PRECISION;
DECLARE qa DOUBLE PRECISION;
DECLARE went INTEGER;
DECLARE fog INTEGER;
DECLARE nid INTEGER;
BEGIN
  SELECT FIRST 1 q.id, q.ttype, q.x, q.y, q.angle, q.tic FROM respawn_queue q ORDER BY q.id
    INTO qid, ttype, qx, qy, qa, went;
  IF (qid IS NULL OR tic - went < 30 * 35) THEN EXIT;
  EXECUTE PROCEDURE spawn_thing(9017, qx, qy, NULL, 0) RETURNING_VALUES fog;
  EXECUTE PROCEDURE play_sound('DSITMBK', fog, qx, qy);
  EXECUTE PROCEDURE spawn_thing(ttype, qx, qy, NULL, qa) RETURNING_VALUES nid;
  DELETE FROM respawn_queue q WHERE q.id = :qid;
END^

-- The world's half of a tic (P_Ticker after the players): movers, monsters,
-- Nightmare's respawns, lights, and every player's counters.
-- ── DOOM's frame tables (docs/ROADMAP.md: phase 1, the machine) ─────────────
-- A thing with a STATE runs on info.c's states (the STATES table, src/states.js):
-- each state shows a frame for its tics, calls its action as it's entered, and
-- hands on to the next. Nothing is put on it yet; the phases after this move the
-- monsters, then everything else, onto it.

-- P_CheckSight for a monster on the tables: REJECT, then the line of sight from its eyes.
CREATE OR ALTER FUNCTION mobj_sees (tid INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION, psec INTEGER)
RETURNS SMALLINT
AS
DECLARE tgt INTEGER;
BEGIN
  -- (P_CheckSight (actor, actor->target): PX NULL is no target; the rest are its, so the
  -- target itself is looked at: its target_id, or its player's body)
  IF (px IS NULL) THEN RETURN 0;
  SELECT COALESCE(t.target_id, (SELECT p.thing_id FROM player p WHERE p.id = t.tplayer)) FROM things t WHERE t.id = :tid INTO tgt;
  RETURN sight_fx(tid, tgt);
END^

-- actor->target, for a monster on the tables: the monster it's fighting (TARGET_ID)
-- or else its player (TPLAYER). PX NULL: there is none; ALIVE 0: it's dead (no longer
-- MF_SHOOTABLE). SHADOW: MF_SHADOW (a spectre, a partly invisible player).
CREATE OR ALTER PROCEDURE chase_target (tid INTEGER)
RETURNS (tgt INTEGER, tp SMALLINT, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION,
         psec INTEGER, prad DOUBLE PRECISION, alive SMALLINT, shadow SMALLINT)
AS
BEGIN
  alive = 0;
  shadow = 0;
  SELECT t.target_id, t.tplayer FROM things t WHERE t.id = :tid INTO tgt, tp;
  IF (tgt IS NOT NULL) THEN
    SELECT o.x, o.y, o.z, o.sector_id, o.radius, IIF(o.st IN ('dying', 'dead'), 0, 1), COALESCE(ot.shadow, 0)
      FROM things o JOIN thing_types ot ON ot.thing_type = o.thing_type
     WHERE o.id = :tgt
      INTO px, py, pz, psec, prad, alive, shadow;
  ELSE
    SELECT t.x, t.y, t.z, t.sector_id, t.radius, IIF(p.dead = 0, 1, 0), IIF(p.invis_tics > 0, 1, 0)
      FROM player p JOIN things t ON t.id = p.thing_id
     WHERE p.id = :tp
      INTO px, py, pz, psec, prad, alive, shadow;
END^

-- A_FaceTarget: turn to the target (no longer in ambush); at a shadow, up to 45° astray
CREATE OR ALTER PROCEDURE a_face_target (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE ang DOUBLE PRECISION;
DECLARE bam BIGINT;
DECLARE r INTEGER;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  -- R_PointToAngle2, and at a shadow P_SubRandom() << 21
  SELECT point_to_angle2(fx_of(t.x), fx_of(t.y), fx_of(:px), fx_of(:py)) FROM things t WHERE t.id = :tid INTO bam;
  IF (shadow = 1) THEN
  BEGIN
    r = p_rand256();
    r = r - p_rand256();   -- (a variable: BIN_AND would draw twice)
    bam = BIN_AND(bam + r * 2097152, 4294967295);
  END
  UPDATE things t SET angle = rad_of(:bam), flags = BIN_AND(t.flags, BIN_NOT(8)) WHERE t.id = :tid;
END^

-- A_PosAttack, A_SPosAttack, A_CPosAttack: face the target, aim (P_AimLineAttack from
-- the middle of the body plus 8), and fire N bullets down MISSILERANGE (2048), each
-- spread up to 22.5°/8 and doing (P_Random()%5 + 1) × 3
CREATE OR ALTER PROCEDURE a_bullets (tid INTEGER, n INTEGER, snd VARCHAR(8))
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE ang BIGINT;
DECLARE a BIGINT;
DECLARE slope BIGINT;
DECLARE dmg INTEGER;
DECLARE i INTEGER = 0;
DECLARE r INTEGER;
DECLARE linetarget INTEGER;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  SELECT t.x, t.y, bam_of(t.angle) FROM things t WHERE t.id = :tid INTO x, y, ang;
  EXECUTE PROCEDURE aim_line_attack(tid, ang, 134217728) RETURNING_VALUES slope, linetarget;
  EXECUTE PROCEDURE play_sound(snd, tid, x, y);
  WHILE (i < n) DO
  BEGIN
    r = p_rand256();
    r = r - p_rand256();   -- (a variable: BIN_AND would draw twice)
    a = BIN_AND(ang + r * 1048576, 4294967295);                       -- (P_SubRandom() << 20)
    dmg = (MOD(p_rand256(), 5) + 1) * 3;
    EXECUTE PROCEDURE line_attack(tid, a, 134217728, slope, dmg);
    i = i + 1;
  END
END^

-- A_TroopAttack, and its kin: face the target; within melee reach (P_CheckMeleeRange) a
-- blow of (P_Random() % SIDES + 1) × MULT with SND, else P_SpawnMissile: the action's own
-- missile, MTYPE (A_TroopAttack's MT_TROOPSHOT whoever calls it, as a DeHackEd Pointer may
-- have it), from 32 up, towards the target (at a shadow up to 22.5° astray), with the
-- missile's sound (its seesound)
CREATE OR ALTER PROCEDURE a_melee_missile (tid INTEGER, sides INTEGER, mult INTEGER, snd VARCHAR(8), melee_only SMALLINT = 0,
                                           mtype INTEGER = NULL)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE msnd VARCHAR(8);
DECLARE mid INTEGER;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  SELECT t.x, t.y, t.z, t.radius, (SELECT mt.see_snd FROM thing_types mt WHERE mt.thing_type = :mtype)
    FROM things t WHERE t.id = :tid INTO x, y, z, rad, msnd;
  -- (SIDES NULL: A_CyberAttack, a missile and nothing else. P_CheckMeleeRange: P_AproxDistance
  -- under MELEERANGE - 20 + the target's radius, in 16.16, and in sight)
  IF (sides IS NOT NULL AND palive = 1 AND aprox_distance(fx_of(px) - fx_of(x), fx_of(py) - fx_of(y)) < fx_of(64 - 20 + prad)
      AND mobj_sees(tid, px, py, pz, psec) = 1) THEN
  BEGIN
    IF (snd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(snd, tid, x, y);
    EXECUTE PROCEDURE hurt_target(tgt, (MOD(p_rand256(), sides) + 1) * mult, tid, tp);
    EXIT;
  END
  IF (mtype IS NULL OR melee_only = 1) THEN EXIT;   -- (A_SargAttack, A_SkelFist: a blow or nothing)
  IF (msnd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(msnd, tid, x, y);
  EXECUTE PROCEDURE spawn_missile_fx(tid, mtype) RETURNING_VALUES mid;
END^

-- A_SkullAttack: MF_SKULLFLY, its attack sound, face the target and fly at its middle at
-- SKULLSPEED (20), climbing or sinking to arrive there (P_MobjThinker's XY_MOVEMENT_MOBJ
-- flies it)
CREATE OR ALTER PROCEDURE a_skull_attack (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE phgt DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE snd VARCHAR(8);
DECLARE fa INTEGER;
DECLARE fdist BIGINT;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  UPDATE things t SET flags = BIN_OR(t.flags, 262144) WHERE t.id = :tid;
  SELECT t.x, t.y, tt.atk_snd FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid INTO x, y, snd;
  IF (snd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(snd, tid, x, y);
  EXECUTE PROCEDURE a_face_target(tid);
  SELECT t.z, t.angle FROM things t WHERE t.id = :tid INTO z, ang;
  IF (tgt IS NOT NULL) THEN SELECT o.height FROM things o WHERE o.id = :tgt INTO phgt;
  ELSE SELECT o.height FROM player p JOIN things o ON o.id = p.thing_id WHERE p.id = :tp INTO phgt;
  -- (in 16.16: SKULLSPEED along its angle; momz to arrive at the target's middle, over
  -- P_AproxDistance / SKULLSPEED tics, at least 1, C's division)
  fa = BIN_SHR(bam_of(ang), 19);
  fdist = aprox_distance(fx_of(px) - fx_of(x), fx_of(py) - fx_of(y)) / 1310720;
  IF (fdist < 1) THEN fdist = 1;
  UPDATE things t SET momx = fx_mul(1310720, fine_cosine(:fa)) / 65536e0, momy = fx_mul(1310720, fine_sine(:fa)) / 65536e0,
                      momz = ((fx_of(:pz) + BIN_SHR(fx_of(COALESCE(:phgt, 56)), 1) - fx_of(:z)) / :fdist) / 65536e0
   WHERE t.id = :tid;
END^

-- A_FatAttack1/2/3: the mancubus faces its target and turns by TURN × FATSPREAD (11.25°),
-- then throws two fireballs, each aimed at the target (P_SpawnMissile) and then turned by
-- its own offset: 0 and +1 spreads, 0 and −2, then −½ and +½
CREATE OR ALTER PROCEDURE a_fat_attack (tid INTEGER, turn DOUBLE PRECISION, off1 DOUBLE PRECISION, off2 DOUBLE PRECISION)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE mtype INTEGER;
DECLARE aim DOUBLE PRECISION;
DECLARE fs DOUBLE PRECISION;
DECLARE i INTEGER = 0;
DECLARE off DOUBLE PRECISION;
DECLARE mid INTEGER;
BEGIN
  EXECUTE PROCEDURE a_face_target(tid);
  -- (FATSPREAD, ANG90/8, in BAMs)
  UPDATE things t SET angle = rad_of(BIN_AND(bam_of(t.angle) + CAST(:turn * 134217728 AS BIGINT), 4294967295)) WHERE t.id = :tid;
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  -- (MT_FATSHOT, whoever fires it; its seesound as it goes)
  mtype = 9007;
  SELECT t.x, t.y, t.z, t.radius FROM things t WHERE t.id = :tid INTO x, y, z, rad;
  WHILE (i < 2) DO
  BEGIN
    off = IIF(i = 0, off1, off2);
    EXECUTE PROCEDURE play_sound((SELECT mt.see_snd FROM thing_types mt WHERE mt.thing_type = :mtype), tid, x, y);
    EXECUTE PROCEDURE spawn_missile_fx(tid, mtype, 0, CAST(off * 134217728 AS BIGINT)) RETURNING_VALUES mid;
    i = i + 1;
  END
END^

-- A_PainAttack: face the target and spit a lost soul at it (A_PainShootSkull)
CREATE OR ALTER PROCEDURE a_pain_attack (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  SELECT t.angle FROM things t WHERE t.id = :tid INTO ang;
  EXECUTE PROCEDURE pain_shoot_skull(tid, bam_of(ang));
END^

-- A_PainDie: A_Fall, and three lost souls, at 90°, 180° and 270° from its facing
CREATE OR ALTER PROCEDURE a_pain_die (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
BEGIN
  UPDATE things SET solid = 0 WHERE id = :tid;
  SELECT t.angle FROM things t WHERE t.id = :tid INTO ang;
  EXECUTE PROCEDURE pain_shoot_skull(tid, BIN_AND(bam_of(ang) + 1073741824, 4294967295));   -- (ANG90)
  EXECUTE PROCEDURE pain_shoot_skull(tid, BIN_AND(bam_of(ang) + 2147483648, 4294967295));   -- (ANG180)
  EXECUTE PROCEDURE pain_shoot_skull(tid, BIN_AND(bam_of(ang) + 3221225472, 4294967295));   -- (ANG270)
END^

-- A_SkelMissile: face the target and fire a homing missile (MT_TRACER) from 16 units
-- higher, its sound DSSKEATK, starting one step ahead of where P_SpawnMissile puts it
CREATE OR ALTER PROCEDURE a_skel_missile (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE aim DOUBLE PRECISION;
DECLARE mtype INTEGER;
DECLARE msnd VARCHAR(8);
DECLARE before INTEGER;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  -- (MT_TRACER, whoever fires it; its seesound as it goes)
  mtype = 9006;
  SELECT t.x, t.y, t.z, t.radius, (SELECT mt.see_snd FROM thing_types mt WHERE mt.thing_type = 9006)
    FROM things t WHERE t.id = :tid INTO x, y, z, rad, msnd;
  IF (msnd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(msnd, tid, x, y);
  EXECUTE PROCEDURE spawn_missile_fx(tid, mtype, 1048576) RETURNING_VALUES before;   -- (actor->z += 16)
  UPDATE things m SET x = m.x + m.momx, y = m.y + m.momy WHERE m.id = :before AND m.st NOT IN ('dying', 'dead');
END^

-- A_Fire: the arch-vile's fire keeps 24 in front of its tracer (the arch-vile's target), at its
-- feet, while the arch-vile (its target) can see it. (The boss brain's spawn fire has none.)
CREATE OR ALTER PROCEDURE a_fire (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE vile INTEGER;
DECLARE an DOUBLE PRECISION;
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND t.thing_type = 9015)) THEN EXIT;
  SELECT t.owner_id FROM things t WHERE t.id = :tid INTO vile;
  IF (NOT EXISTS (SELECT 1 FROM things v WHERE v.id = :vile)) THEN EXIT;
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  IF (mobj_sees(vile, px, py, pz, psec) = 0) THEN EXIT;
  IF (tgt IS NOT NULL) THEN SELECT o.angle FROM things o WHERE o.id = :tgt INTO an;
  ELSE SELECT o.angle FROM player p JOIN things o ON o.id = p.thing_id WHERE p.id = :tp INTO an;
  UPDATE things t SET x = :px + COS(:an) * 24, y = :py + SIN(:an) * 24, z = :pz,
                      sector_id = sector_at(:px + COS(:an) * 24, :py + SIN(:an) * 24)
   WHERE t.id = :tid;
END^

-- A_VileTarget: face the target and light the fire on it (MT_FIRE), dancing in front of it (A_Fire)
CREATE OR ALTER PROCEDURE a_vile_target (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE gang DOUBLE PRECISION;
DECLARE mid INTEGER;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  IF (tgt IS NOT NULL) THEN SELECT o.angle FROM things o WHERE o.id = :tgt INTO gang;
  ELSE SELECT o.angle FROM player p JOIN things o ON o.id = p.thing_id WHERE p.id = :tp INTO gang;
  EXECUTE PROCEDURE spawn_thing(9015, px + COS(gang) * 24, py + SIN(gang) * 24, pz, 0) RETURNING_VALUES mid;
  -- fog->target = actor, fog->tracer = actor->target; then A_Fire. (Spawned in S_FIRE1, it never
  -- calls that state's A_StartFire, so DOOM's DSFLAMST is never heard: the crackle is)
  UPDATE things t SET owner_id = :tid, target_id = :tgt, tplayer = :tp WHERE t.id = :mid;
  EXECUTE PROCEDURE a_fire(mid);
END^

-- A_VileAttack: face the target; if it can still see it, DSBAREXP, 20 damage and a toss into
-- the air (1000 / mass), and the fire, moved between them (24 in front of the target), blasts
-- 70 around (an arch-vile's blast provokes nobody)
CREATE OR ALTER PROCEDURE a_vile_attack (tid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE fx DOUBLE PRECISION;
DECLARE fy DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  EXECUTE PROCEDURE a_face_target(tid);
  IF (mobj_sees(tid, px, py, pz, psec) = 0) THEN EXIT;
  SELECT t.x, t.y, t.angle FROM things t WHERE t.id = :tid INTO x, y, ang;
  EXECUTE PROCEDURE play_sound('DSBAREXP', tid, x, y);
  EXECUTE PROCEDURE hurt_target(tgt, 20, tid, tp);
  IF (tgt IS NULL) THEN UPDATE things t SET momz = 10 WHERE t.id = (SELECT p.thing_id FROM player p WHERE p.id = :tp);
  ELSE UPDATE things t SET momz = 1000e0 / (SELECT tt.mass FROM thing_types tt WHERE tt.thing_type = t.thing_type) WHERE t.id = :tgt;
  -- (the fire between the arch-vile and its target, 24 short of the target, in 16.16)
  fx = (fx_of(px) - fx_mul(1572864, fine_cosine(BIN_SHR(bam_of(ang), 19)))) / 65536e0;
  fy = (fx_of(py) - fx_mul(1572864, fine_sine(BIN_SHR(bam_of(ang), 19)))) / 65536e0;
  UPDATE things t SET x = :fx, y = :fy WHERE t.kind = 'flame' AND t.owner_id = :tid;
  IF (EXISTS (SELECT 1 FROM things t WHERE t.kind = 'flame' AND t.owner_id = :tid)) THEN
    EXECUTE PROCEDURE radius_attack(fx, fy, pz, 70, tid,
                                    (SELECT FIRST 1 t.id FROM things t WHERE t.kind = 'flame' AND t.owner_id = :tid ORDER BY t.id));
END^

-- A_CPosRefire: keep firing, unless (40 times in 256 it doesn't ask) the target is
-- dead or out of sight: then back to the chase
CREATE OR ALTER PROCEDURE a_cpos_refire (tid INTEGER, tic INTEGER, chance INTEGER = 40)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE alive SMALLINT;
BEGIN
  EXECUTE PROCEDURE a_face_target(tid);
  IF (p_rand256() < chance) THEN EXIT;   -- (A_SpidRefire: 10)
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL OR palive = 0 OR mobj_sees(tid, px, py, pz, psec) = 0) THEN
    EXECUTE PROCEDURE set_state(tid, (SELECT tt.see_state FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                                       WHERE t.id = :tid), tic)
      RETURNING_VALUES alive;
END^

-- A monster's sight and death cries: DOOM picks one of the zombies' three (or the
-- imps' two) at random
CREATE OR ALTER FUNCTION cry_variant (snd VARCHAR(8))
RETURNS VARCHAR(8)
AS
BEGIN
  IF (snd IN ('DSPOSIT1', 'DSPOSIT2', 'DSPOSIT3')) THEN RETURN 'DSPOSIT' || (1 + MOD(p_rand256(), 3));
  IF (snd IN ('DSBGSIT1', 'DSBGSIT2')) THEN RETURN 'DSBGSIT' || (1 + MOD(p_rand256(), 2));
  IF (snd IN ('DSPODTH1', 'DSPODTH2', 'DSPODTH3')) THEN RETURN 'DSPODTH' || (1 + MOD(p_rand256(), 3));
  IF (snd IN ('DSBGDTH1', 'DSBGDTH2')) THEN RETURN 'DSBGDTH' || (1 + MOD(p_rand256(), 2));
  RETURN snd;
END^

-- A_Look: the sector's soundtarget (the player whose gunfire reached it) wakes it – an
-- ambusher only once it can see them – or it sees a player for itself
-- (P_LookForPlayers, the 180° ahead); then the see sound and the see state
CREATE OR ALTER PROCEDURE a_look (tid INTEGER, tic INTEGER)
AS
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE flags INTEGER;
DECLARE tp SMALLINT;
DECLARE see_state INTEGER;
DECLARE see_snd VARCHAR(8);
DECLARE ttype INTEGER;
DECLARE heard SMALLINT;
DECLARE found SMALLINT = 0;
DECLARE qx DOUBLE PRECISION;
DECLARE qy DOUBLE PRECISION;
DECLARE qz DOUBLE PRECISION;
DECLARE qsec INTEGER;
DECLARE alive SMALLINT;
BEGIN
  SELECT t.x, t.y, t.z, t.height, t.angle, t.sector_id, t.flags, t.tplayer, tt.see_state, tt.see_snd, t.thing_type
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO x, y, z, hgt, ang, sec, flags, tp, see_state, see_snd, ttype;
  UPDATE things t SET threshold = 0 WHERE t.id = :tid;
  heard = COALESCE((SELECT se.sound_heard FROM sectors se WHERE se.id = :sec), 0);
  qx = NULL;
  IF (heard > 0) THEN
    SELECT t.x, t.y, t.z, t.sector_id FROM player p JOIN things t ON t.id = p.thing_id
     WHERE p.id = :heard AND p.dead = 0 INTO qx, qy, qz, qsec;
  IF (qx IS NOT NULL) THEN
  BEGIN
    UPDATE things t SET target_id = NULL, tplayer = :heard WHERE t.id = :tid;
    tp = heard;
    IF (BIN_AND(flags, 8) = 0) THEN found = heard;
    ELSE IF (mobj_sees(tid, qx, qy, qz, qsec) = 1) THEN found = heard;
  END
  IF (found = 0) THEN
    EXECUTE PROCEDURE look_for_players(tid, 0) RETURNING_VALUES found;
  IF (found = 0) THEN EXIT;
  UPDATE things t SET target_id = NULL, tplayer = :found WHERE t.id = :tid;
  IF (see_snd IS NOT NULL) THEN
  BEGIN
    see_snd = cry_variant(see_snd);
    -- the Spider Mastermind and the Cyberdemon are heard at full volume
    IF (ttype IN (7, 16)) THEN EXECUTE PROCEDURE play_sound(see_snd, NULL, NULL, NULL);
    ELSE EXECUTE PROCEDURE play_sound(see_snd, tid, x, y);
  END
  EXECUTE PROCEDURE set_state(tid, see_state, tic) RETURNING_VALUES alive;
END^

-- P_TryMove for a missile to (X, Y), in 16.16. P_CheckPosition: first PIT_CheckThing over the
-- things in the blocks MAXRADIUS around (column by column, the newest first in a block) whose
-- box its own touches: one overhead or underneath it passes; its shooter it passes, and one
-- of the shooter's species (the knight and the baron are one) stops it harmlessly unless
-- that's a player; a solid thing that can't be shot stops it; anything shootable takes
-- (P_Random() % 8 + 1) × its damage, from the shooter, thrown back from the missile, and stops
-- it. Then the lines (CHECK_POSITION_FX for a missile: only one-sided lines block; the line
-- that lowered the ceiling is CEILINGLINE, a context variable, for the sky hack); it must fit
-- the gap, under the ceiling and at most 24 below the floor. Moved, it keeps the floor and
-- ceiling found, and the lines it crossed go off – only for those a monster's missile may
-- (P_CrossSpecialLine: not the rocket, plasma, BFG ball or the imp's, cacodemon's and baron's
-- fireballs). → OK: 1 it's there; 0 it's stopped (the caller bursts it, P_ExplodeMissile).
CREATE OR ALTER PROCEDURE try_move_missile (tid INTEGER, x BIGINT, y BIGINT)
RETURNS (ok SMALLINT)
AS
DECLARE ox BIGINT;
DECLARE oy BIGINT;
DECLARE z BIGINT;
DECLARE rad BIGINT;
DECLARE hgt BIGINT;
DECLARE owner INTEGER;
DECLARE otype INTEGER;
DECLARE mdmg INTEGER;
DECLARE mtype INTEGER;
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE xl INTEGER;
DECLARE xh INTEGER;
DECLARE yl INTEGER;
DECLARE yh INTEGER;
DECLARE hid INTEGER;
DECLARE htype INTEGER;
DECLARE hkind VARCHAR(10);
DECLARE hz BIGINT;
DECLARE hh BIGINT;
DECLARE shoot SMALLINT;
DECLARE hsolid SMALLINT;
DECLARE dmg INTEGER;
DECLARE hitp SMALLINT;
DECLARE lok SMALLINT;
DECLARE fz BIGINT;
DECLARE cz BIGINT;
DECLARE dz BIGINT;
DECLARE spec VARCHAR(4000);
DECLARE k INTEGER;
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lsp INTEGER;
DECLARE nx BIGINT;
DECLARE ny BIGINT;
DECLARE oldside SMALLINT;
BEGIN
  ok = 0;
  RDB$SET_CONTEXT('USER_TRANSACTION', 'CEILINGLINE', NULL);
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.radius), fx_of(t.height), t.owner_id, tt.dmg_lo, t.thing_type
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO ox, oy, z, rad, hgt, owner, mdmg, mtype;
  otype = NULL;
  SELECT o.thing_type FROM things o WHERE o.id = :owner INTO otype;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  xl = MAXVALUE(BIN_SHR(x - rad - orgx - 2097152, 23), 0);      -- (MAXRADIUS: 32 units)
  xh = MINVALUE(BIN_SHR(x + rad - orgx + 2097152, 23), bw - 1);
  yl = MAXVALUE(BIN_SHR(y - rad - orgy - 2097152, 23), 0);
  yh = MINVALUE(BIN_SHR(y + rad - orgy + 2097152, 23), bh - 1);
  FOR SELECT t.id, t.thing_type, t.kind, fx_of(t.z), fx_of(t.height),
             IIF(t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.state IS NOT NULL, 1,
                 IIF(t.kind = 'player' AND t.solid = 1, 1, 0)), t.solid
        FROM things t
       WHERE t.x BETWEEN (:x - :rad) / 65536e0 - 160 AND (:x + :rad) / 65536e0 + 160 AND t.id <> :tid
         AND (t.solid = 1 OR (t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.state IS NOT NULL))
         AND ABS(fx_of(t.x) - :x) < fx_of(t.radius) + :rad AND ABS(fx_of(t.y) - :y) < fx_of(t.radius) + :rad
         AND BIN_SHR(fx_of(t.x) - :orgx, 23) BETWEEN :xl AND :xh
         AND BIN_SHR(fx_of(t.y) - :orgy, 23) BETWEEN :yl AND :yh
       ORDER BY BIN_SHR(fx_of(t.x) - :orgx, 23), BIN_SHR(fx_of(t.y) - :orgy, 23), t.link_seq DESC
        INTO hid, htype, hkind, hz, hh, shoot, hsolid
  DO
  BEGIN
    IF (z > hz + hh) THEN CONTINUE;                 -- (overhead)
    IF (z + hgt < hz) THEN CONTINUE;                -- (underneath)
    IF (otype IS NOT NULL AND (otype = htype OR (otype IN (69, 3003) AND htype IN (69, 3003)))) THEN
    BEGIN
      IF (hid = owner) THEN CONTINUE;
      IF (hkind <> 'player') THEN EXIT;             -- (explode, but do no damage)
    END
    IF (shoot = 0) THEN
    BEGIN
      IF (hsolid = 1) THEN EXIT;
      CONTINUE;
    END
    dmg = (MOD(p_rand256(), 8) + 1) * mdmg;
    hitp = NULL;
    SELECT p.id FROM player p WHERE p.thing_id = :hid INTO hitp;
    IF (hitp IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(dmg, owner, hitp, tid);
    ELSE EXECUTE PROCEDURE damage_thing(hid, dmg, owner, tid);
    EXIT;
  END
  EXECUTE PROCEDURE check_position_fx(tid, x, y, rad, 0, 0, 0, 1) RETURNING_VALUES lok, fz, cz, dz, spec;
  IF (lok = 0) THEN EXIT;
  IF (cz - fz < hgt) THEN EXIT;                     -- (doesn't fit)
  IF (cz - z < hgt) THEN EXIT;                      -- (under the ceiling)
  IF (fz - z > 1572864) THEN EXIT;                  -- (a step of more than 24)
  ok = 1;
  UPDATE things t SET x = :x / 65536e0, y = :y / 65536e0, sector_id = sector_at_fx(:x, :y),
                      floorz = :fz / 65536e0, ceilz = :cz / 65536e0, fz_x = :x / 65536e0, fz_y = :y / 65536e0
   WHERE t.id = :tid;
  IF (mtype IN (9000, 9001, 9002, 9003, 9004, 9005)) THEN EXIT;
  WHILE (spec <> '') DO
  BEGIN
    k = POSITION(',' IN spec);
    lid = CAST(SUBSTRING(spec FROM 1 FOR k - 1) AS INTEGER);
    spec = SUBSTRING(spec FROM k + 1);
    SELECT l.fx, l.fy, l.fdx, l.fdy, l.special FROM linedefs l WHERE l.id = :lid INTO lx, ly, ldx, ldy, lsp;
    IF (lsp NOT IN (39, 97, 125, 126, 4, 10, 88)) THEN CONTINUE;   -- (P_CrossSpecialLine: a monster's few)
    nx = NULL;
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO nx, ny;
    IF (nx IS NULL) THEN EXIT;
    oldside = point_on_line_side(ox, oy, lx, ly, ldx, ldy);
    IF (point_on_line_side(nx, ny, lx, ly, ldx, ldy) <> oldside
        AND NOT (lsp IN (39, 97, 125, 126) AND oldside = 1)) THEN
      EXECUTE PROCEDURE activate_line(lid, 'walk', tid);
  END
END^

-- P_CheckMissileSpawn: a missile just fired has its first tics cut by P_Random() & 3 (at least
-- 1), moves half its momentum on (>> 1), and bursts at once if it can't be there (P_TryMove:
-- against a wall, a sky or not, or a thing, which it hurts)
CREATE OR ALTER PROCEDURE check_missile_spawn (mid INTEGER)
AS
DECLARE tic INTEGER;
DECLARE ok SMALLINT;
DECLARE x BIGINT;
DECLARE y BIGINT;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1)
   WHERE t.id = :mid AND t.state_tic IS NOT NULL;
  UPDATE things t SET x = (fx_of(t.x) + BIN_SHR(fx_of(t.momx), 1)) / 65536e0, y = (fx_of(t.y) + BIN_SHR(fx_of(t.momy), 1)) / 65536e0,
                      z = (fx_of(t.z) + BIN_SHR(fx_of(t.momz), 1)) / 65536e0
   WHERE t.id = :mid;
  x = NULL;
  SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :mid INTO x, y;
  IF (x IS NULL) THEN EXIT;
  EXECUTE PROCEDURE try_move_missile(mid, x, y) RETURNING_VALUES ok;
  IF (ok = 0 AND EXISTS (SELECT 1 FROM things t WHERE t.id = :mid)) THEN EXECUTE PROCEDURE explode_missile(mid, tic);
END^

-- P_SpawnPlayerMissile: a projectile from the player's gun height (+32), autoaimed by
-- P_AimLineAttack 1024 out: straight ahead, else 1 << 26 (5.6°) left, else as far right, else
-- level along the player's angle; MTYPE's speed along it, climbing by the slope; then
-- P_CheckMissileSpawn. (SX, SY, SZ, ANG: the owner's own position and angle.)
CREATE OR ALTER PROCEDURE fire_missile (
  mtype INTEGER, owner INTEGER, sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION, ang DOUBLE PRECISION)
AS
DECLARE mid INTEGER;
DECLARE spd BIGINT;
DECLARE slope BIGINT;
DECLARE tgt INTEGER;
DECLARE an BIGINT;
DECLARE fa INTEGER;
BEGIN
  an = bam_of(ang);
  EXECUTE PROCEDURE aim_line_attack(owner, an, 67108864) RETURNING_VALUES slope, tgt;      -- (16 × 64 units)
  IF (tgt IS NULL) THEN
  BEGIN
    an = BIN_AND(an + 67108864, 4294967295);                                            -- (1 << 26)
    EXECUTE PROCEDURE aim_line_attack(owner, an, 67108864) RETURNING_VALUES slope, tgt;
    IF (tgt IS NULL) THEN
    BEGIN
      an = BIN_AND(an - 134217728, 4294967295);                                         -- (2 << 26)
      EXECUTE PROCEDURE aim_line_attack(owner, an, 67108864) RETURNING_VALUES slope, tgt;
    END
    IF (tgt IS NULL) THEN
    BEGIN
      an = bam_of(ang);
      slope = 0;
    END
  END
  SELECT fx_of(tt.speed) FROM thing_types tt WHERE tt.thing_type = :mtype INTO spd;
  EXECUTE PROCEDURE spawn_thing(mtype, sx, sy, sz + 32, rad_of(an)) RETURNING_VALUES mid;
  fa = BIN_SHR(an, 19);
  -- (P_SpawnMobj: the floor and ceiling of its subsector)
  UPDATE things t SET momx = fx_mul(:spd, fine_cosine(:fa)) / 65536e0, momy = fx_mul(:spd, fine_sine(:fa)) / 65536e0,
                      momz = fx_mul(:spd, :slope) / 65536e0, owner_id = :owner,
                      floorz = (SELECT s.floor_h FROM sectors s WHERE s.id = t.sector_id),
                      ceilz = (SELECT s.ceil_h FROM sectors s WHERE s.id = t.sector_id), fz_x = t.x, fz_y = t.y
   WHERE t.id = :mid;
  IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :mid AND t.state IS NOT NULL)) THEN
    EXECUTE PROCEDURE check_missile_spawn(mid);
END^

-- P_SpawnMissile: a monster's projectile, MTYPE, from its middle 32 up (ZOFF higher: the
-- revenant's 16), at its target: R_PointToAngle2 to it (at a shadow, P_SubRandom() << 20
-- astray), turned by TURN (BAMs: the mancubus's spreads), its speed along that (20 for the
-- imp's, cacodemon's and baron's fireballs on Nightmare or -fast), and climbing or sinking to
-- reach the target's feet over P_AproxDistance / speed tics (at least 1; C's division); then
-- P_CheckMissileSpawn. → MID
CREATE OR ALTER PROCEDURE spawn_missile_fx (owner INTEGER, mtype INTEGER, zoff BIGINT = 0, turn BIGINT = 0)
RETURNS (mid INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE sx BIGINT;
DECLARE sy BIGINT;
DECLARE sz BIGINT;
DECLARE spd BIGINT;
DECLARE an BIGINT;
DECLARE r INTEGER;
DECLARE fa INTEGER;
DECLARE dist BIGINT;
BEGIN
  mid = NULL;
  EXECUTE PROCEDURE chase_target(owner) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL) THEN EXIT;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z) + :zoff FROM things t WHERE t.id = :owner INTO sx, sy, sz;
  SELECT fx_of(tt.speed) FROM thing_types tt WHERE tt.thing_type = :mtype INTO spd;
  IF (mtype IN (9000, 9001, 9002) AND EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND (g.skill = 5 OR g.fast = 1))) THEN
    spd = 1310720;
  EXECUTE PROCEDURE spawn_thing(mtype, sx / 65536e0, sy / 65536e0, (sz + 2097152) / 65536e0, 0) RETURNING_VALUES mid;
  an = point_to_angle2(sx, sy, fx_of(px), fx_of(py));
  IF (shadow = 1) THEN
  BEGIN
    r = p_rand256();
    r = r - p_rand256();
    an = BIN_AND(an + r * 1048576, 4294967295);
  END
  an = BIN_AND(an + turn, 4294967295);
  fa = BIN_SHR(an, 19);
  dist = aprox_distance(fx_of(px) - sx, fx_of(py) - sy) / spd;
  IF (dist < 1) THEN dist = 1;
  UPDATE things t SET angle = rad_of(:an), momx = fx_mul(:spd, fine_cosine(:fa)) / 65536e0, momy = fx_mul(:spd, fine_sine(:fa)) / 65536e0,
                      momz = ((fx_of(:pz) - :sz) / :dist) / 65536e0, owner_id = :owner,
                      target_id = (SELECT o.target_id FROM things o WHERE o.id = :owner),
                      tplayer = COALESCE((SELECT o.tplayer FROM things o WHERE o.id = :owner), t.tplayer),
                      floorz = (SELECT s.floor_h FROM sectors s WHERE s.id = t.sector_id),
                      ceilz = (SELECT s.ceil_h FROM sectors s WHERE s.id = t.sector_id), fz_x = t.x, fz_y = t.y
   WHERE t.id = :mid;
  IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :mid AND t.state IS NOT NULL)) THEN
    EXECUTE PROCEDURE check_missile_spawn(mid);
END^

-- P_TryMove for a monster (not a player: TRY_MOVE_FX), in 16.16: to (X, Y) if P_CheckPosition
-- lets it (MONSTER) and it fits – the gap as tall as it, the ceiling above its head, a step up
-- of 24 at most, and, but for a flier, no drop of more than 24 under it. FLOATOK: it would fit
-- but for its height (a flier then rises or sinks to it). TMFLOORZ the floor found there.
-- SPECHIT: the special lines its box met, last first, as far as P_CheckPosition got. Moved,
-- it crosses those whose side it changed that a monster sets off (teleporters only from the
-- front; doors 4, lifts 10 and 88), each looking at where it is now.
CREATE OR ALTER PROCEDURE try_move_mobj (tid INTEGER, x BIGINT, y BIGINT, things SMALLINT = 1)
RETURNS (ok SMALLINT, floatok SMALLINT, tmfloorz BIGINT, spechit VARCHAR(4000))
AS
DECLARE ox BIGINT;
DECLARE oy BIGINT;
DECLARE z BIGINT;
DECLARE rad BIGINT;
DECLARE hgt BIGINT;
DECLARE fl SMALLINT;
DECLARE cz BIGINT;
DECLARE dz BIGINT;
DECLARE spec VARCHAR(4000);
DECLARE k INTEGER;
DECLARE lid INTEGER;
DECLARE lx BIGINT;
DECLARE ly BIGINT;
DECLARE ldx BIGINT;
DECLARE ldy BIGINT;
DECLARE lsp INTEGER;
DECLARE nx BIGINT;
DECLARE ny BIGINT;
DECLARE oldside SMALLINT;
BEGIN
  floatok = 0;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.radius), fx_of(t.height),
         IIF(COALESCE(tt.floats, 0) = 1 OR t.st IN ('dying', 'dead'), 1, 0)
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO ox, oy, z, rad, hgt, fl;
  EXECUTE PROCEDURE check_position_fx(tid, x, y, rad, 0, things, 1) RETURNING_VALUES ok, tmfloorz, cz, dz, spechit;
  IF (ok = 0) THEN EXIT;
  ok = 0;
  IF (cz - tmfloorz < hgt) THEN EXIT;           -- (doesn't fit)
  floatok = 1;
  IF (cz - z < hgt) THEN EXIT;                  -- (it must come down to fit)
  IF (tmfloorz - z > 1572864) THEN EXIT;        -- (a step up of more than 24)
  IF (fl = 0 AND tmfloorz - dz > 1572864) THEN EXIT;   -- (over a drop-off: MF_DROPOFF – a corpse – and MF_FLOAT may)
  ok = 1;
  UPDATE things t SET x = :x / 65536e0, y = :y / 65536e0, sector_id = sector_at_fx(:x, :y),
                      floorz = :tmfloorz / 65536e0, ceilz = :cz / 65536e0, fz_x = :x / 65536e0, fz_y = :y / 65536e0
   WHERE t.id = :tid;
  spec = spechit;
  WHILE (spec <> '') DO
  BEGIN
    k = POSITION(',' IN spec);
    lid = CAST(SUBSTRING(spec FROM 1 FOR k - 1) AS INTEGER);
    spec = SUBSTRING(spec FROM k + 1);
    SELECT l.fx, l.fy, l.fdx, l.fdy, l.special FROM linedefs l WHERE l.id = :lid INTO lx, ly, ldx, ldy, lsp;
    IF (lsp NOT IN (39, 97, 125, 126, 4, 10, 88)) THEN CONTINUE;   -- (P_CrossSpecialLine: a monster's few)
    nx = NULL;
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO nx, ny;
    IF (nx IS NULL) THEN EXIT;
    oldside = point_on_line_side(ox, oy, lx, ly, ldx, ldy);
    IF (point_on_line_side(nx, ny, lx, ly, ldx, ldy) <> oldside
        AND NOT (lsp IN (39, 97, 125, 126) AND oldside = 1)) THEN
      EXECUTE PROCEDURE activate_line(lid, 'walk', tid);
  END
END^

-- P_Move: a step of its speed in its heading (xspeed/yspeed: the diagonals 47000/65536), by
-- P_TryMove. A flier only blocked by the height rises or sinks FLOATSPEED (4) instead, and
-- that's a move (MF_INFLOAT, 131072 in THINGS.FLAGS, keeps P_ZMovement off its height
-- meanwhile). Else, blocked, the special lines it met are tried (P_UseSpecialLine: a
-- monster opens a door, special 1, and stands at a locked one, 32–34; none secret), last
-- first, and its heading is spent: one answering counts as a move. Moved, a walker stands
-- on the floor it found. → OK.
CREATE OR ALTER PROCEDURE p_move_fx (tid INTEGER)
RETURNS (ok SMALLINT)
AS
DECLARE dir SMALLINT;
DECLARE spd INTEGER;
DECLARE fl SMALLINT;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE tok SMALLINT;
DECLARE floatok SMALLINT;
DECLARE tmfz BIGINT;
DECLARE spec VARCHAR(4000);
DECLARE k INTEGER;
DECLARE lid INTEGER;
DECLARE lsp INTEGER;
DECLARE lflags INTEGER;
BEGIN
  ok = 0;
  SELECT t.movedir, CAST(tt.speed AS INTEGER), COALESCE(tt.floats, 0), fx_of(t.x), fx_of(t.y), fx_of(t.z)
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO dir, spd, fl, x, y, z;
  IF (dir IS NULL OR dir < 0 OR dir > 7) THEN EXIT;
  tx = x + spd * CASE dir WHEN 0 THEN 65536 WHEN 1 THEN 47000 WHEN 2 THEN 0 WHEN 3 THEN -47000
                          WHEN 4 THEN -65536 WHEN 5 THEN -47000 WHEN 6 THEN 0 ELSE 47000 END;
  ty = y + spd * CASE dir WHEN 0 THEN 0 WHEN 1 THEN 47000 WHEN 2 THEN 65536 WHEN 3 THEN 47000
                          WHEN 4 THEN 0 WHEN 5 THEN -47000 WHEN 6 THEN -65536 ELSE -47000 END;
  EXECUTE PROCEDURE try_move_mobj(tid, tx, ty) RETURNING_VALUES tok, floatok, tmfz, spec;
  IF (tok = 0) THEN
  BEGIN
    IF (fl = 1 AND floatok = 1) THEN
    BEGIN
      UPDATE things t SET z = :z / 65536e0 + IIF(:z < :tmfz, 4, -4), flags = BIN_OR(t.flags, 131072) WHERE t.id = :tid;
      ok = 1;
      EXIT;
    END
    IF (spec = '') THEN EXIT;
    UPDATE things t SET movedir = 8 WHERE t.id = :tid;
    WHILE (spec <> '') DO
    BEGIN
      k = POSITION(',' IN spec);
      lid = CAST(SUBSTRING(spec FROM 1 FOR k - 1) AS INTEGER);
      spec = SUBSTRING(spec FROM k + 1);
      SELECT l.special, l.flags FROM linedefs l WHERE l.id = :lid INTO lsp, lflags;
      IF (BIN_AND(lflags, 32) <> 0) THEN CONTINUE;            -- (ML_SECRET)
      IF (lsp = 1) THEN
      BEGIN
        EXECUTE PROCEDURE activate_line(lid, 'use', tid);
        ok = 1;
      END
      ELSE IF (lsp IN (32, 33, 34)) THEN ok = 1;             -- (a locked door: no, but it answered)
    END
    EXIT;
  END
  UPDATE things t SET flags = BIN_AND(t.flags, BIN_NOT(131072)) WHERE t.id = :tid AND BIN_AND(t.flags, 131072) <> 0;
  IF (fl = 0) THEN UPDATE things t SET z = :tmfz / 65536e0 WHERE t.id = :tid;
  ok = 1;
END^

-- P_TryWalk: P_Move, and a step taken, MOVECOUNT = P_Random() & 15
CREATE OR ALTER PROCEDURE try_walk (tid INTEGER, dir SMALLINT)
RETURNS (ok SMALLINT)
AS
BEGIN
  UPDATE things t SET movedir = :dir WHERE t.id = :tid;
  EXECUTE PROCEDURE p_move_fx(tid) RETURNING_VALUES ok;
  IF (ok = 1) THEN UPDATE things t SET movecount = p_rand_and(15) WHERE t.id = :tid;
END^

-- P_NewChaseDir, in 16.16, toward the target at (TX, TY): the diagonal first (not the way it
-- came), then the straight ways – the bigger difference first, or swapped 55 times in 256 –
-- then the old heading, then every heading in a random sweep, and only then a turnaround;
-- each a P_TryWalk. None: no heading (DI_NODIR).
CREATE OR ALTER PROCEDURE new_chase_dir_fx (tid INTEGER, tx BIGINT, ty BIGINT)
AS
DECLARE olddir SMALLINT;
DECLARE turnaround SMALLINT;
DECLARE dx BIGINT;
DECLARE dy BIGINT;
DECLARE d1 SMALLINT;
DECLARE d2 SMALLINT;
DECLARE t SMALLINT;
DECLARE ok SMALLINT;
DECLARE up SMALLINT;
BEGIN
  SELECT t.movedir, fx32(:tx - fx_of(t.x)), fx32(:ty - fx_of(t.y)) FROM things t WHERE t.id = :tid INTO olddir, dx, dy;
  turnaround = IIF(olddir >= 8, 8, MOD(olddir + 4, 8));
  d1 = IIF(dx > 655360, 0, IIF(dx < -655360, 4, 8));
  d2 = IIF(dy < -655360, 6, IIF(dy > 655360, 2, 8));
  IF (d1 <> 8 AND d2 <> 8) THEN
  BEGIN
    -- diags[((deltay < 0) << 1) + (deltax > 0)]
    t = CASE WHEN dy < 0 AND dx > 0 THEN 7 WHEN dy < 0 THEN 5 WHEN dx > 0 THEN 1 ELSE 3 END;
    UPDATE things o SET movedir = :t WHERE o.id = :tid;
    IF (t <> turnaround) THEN
    BEGIN
      EXECUTE PROCEDURE try_walk(tid, t) RETURNING_VALUES ok;
      IF (ok = 1) THEN EXIT;
    END
  END
  IF (p_rand256() > 200 OR ABS(dy) > ABS(dx)) THEN
  BEGIN
    t = d1;
    d1 = d2;
    d2 = t;
  END
  IF (d1 = turnaround) THEN d1 = 8;
  IF (d2 = turnaround) THEN d2 = 8;
  IF (d1 <> 8) THEN
  BEGIN
    EXECUTE PROCEDURE try_walk(tid, d1) RETURNING_VALUES ok;
    IF (ok = 1) THEN EXIT;
  END
  IF (d2 <> 8) THEN
  BEGIN
    EXECUTE PROCEDURE try_walk(tid, d2) RETURNING_VALUES ok;
    IF (ok = 1) THEN EXIT;
  END
  IF (olddir <> 8) THEN
  BEGIN
    EXECUTE PROCEDURE try_walk(tid, olddir) RETURNING_VALUES ok;
    IF (ok = 1) THEN EXIT;
  END
  up = p_rand_and(1);
  t = IIF(up = 1, 0, 7);
  WHILE (t >= 0 AND t <= 7) DO
  BEGIN
    IF (t <> turnaround) THEN
    BEGIN
      EXECUTE PROCEDURE try_walk(tid, t) RETURNING_VALUES ok;
      IF (ok = 1) THEN EXIT;
    END
    t = t + IIF(up = 1, 1, -1);
  END
  IF (turnaround <> 8) THEN
  BEGIN
    EXECUTE PROCEDURE try_walk(tid, turnaround) RETURNING_VALUES ok;
    IF (ok = 1) THEN EXIT;
  END
  UPDATE things o SET movedir = 8 WHERE o.id = :tid;
END^

-- A_Chase: a step of the hunt. The reaction time and the threshold count down; it
-- turns 45° towards its heading; with no live target it looks all around, or goes
-- back to its spawn state; after a missile attack it only picks a heading; in range,
-- its melee or (P_CheckMissileRange) missile state; else a step along its heading
-- (P_Move) while MOVECOUNT lasts, or a new one (P_NewChaseDir); and now and then its
-- active sound.
CREATE OR ALTER PROCEDURE a_chase (tid INTEGER, tic INTEGER)
AS
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE reaction INTEGER;
DECLARE threshold INTEGER;
DECLARE movedir SMALLINT;
DECLARE movecount INTEGER;
DECLARE just_attacked SMALLINT;
DECLARE just_hit SMALLINT;
DECLARE momz DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION;
DECLARE fl SMALLINT;
DECLARE melee_state INTEGER;
DECLARE missile_state INTEGER;
DECLARE spawn_state INTEGER;
DECLARE atk_snd VARCHAR(8);
DECLARE active_snd VARCHAR(8);
DECLARE ttype INTEGER;
DECLARE cant SMALLINT;
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE skill SMALLINT;
DECLARE fast SMALLINT;
DECLARE nplayers SMALLINT;
DECLARE bam BIGINT;
DECLARE bdelta BIGINT;
DECLARE fdist BIGINT;
DECLARE found SMALLINT;
DECLARE nst INTEGER;
DECLARE snd VARCHAR(8);
DECLARE dist DOUBLE PRECISION;
DECLARE adx DOUBLE PRECISION;
DECLARE ady DOUBLE PRECISION;
DECLARE fire SMALLINT;
DECLARE walk SMALLINT = 0;
DECLARE moved SMALLINT;
DECLARE bump SMALLINT;
DECLARE tele SMALLINT;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE nz DOUBLE PRECISION;
DECLARE msec INTEGER;
DECLARE alive SMALLINT;
BEGIN
  SELECT t.x, t.y, t.z, t.height, t.radius, t.angle, t.sector_id, t.reaction, t.threshold, t.movedir, t.movecount,
         t.just_attacked, t.just_hit, t.momz, tt.speed, tt.floats, tt.melee_state, tt.missile_state, tt.spawn_state,
         tt.atk_snd, tt.active_snd, t.thing_type
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO x, y, z, hgt, rad, ang, sec, reaction, threshold, movedir, movecount,
         just_attacked, just_hit, momz, spd, fl, melee_state, missile_state, spawn_state, atk_snd, active_snd, ttype;
  SELECT g.skill, IIF(g.skill = 5 OR g.fast = 1, 1, 0), g.players FROM game g WHERE g.id = 1 INTO skill, fast, nplayers;
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (reaction > 0) THEN reaction = reaction - 1;
  -- (the threshold lapses at once when its target is dead)
  IF (threshold > 0) THEN threshold = IIF(px IS NULL OR palive = 0, 0, threshold - 1);
  -- turn towards the heading, 45° at a time: angle &= 7 << 29, and by the sign of the
  -- difference as a 32-bit int (so from 180° to the east, 0, it turns on round to 225°)
  IF (movedir < 8) THEN
  BEGIN
    bam = BIN_AND(bam_of(ang), 3758096384);
    bdelta = fx32(bam - movedir * 536870912);
    IF (bdelta > 0) THEN bam = bam - 536870912;
    ELSE IF (bdelta < 0) THEN bam = bam + 536870912;
    ang = rad_of(BIN_AND(bam, 4294967295));
  END
  nst = NULL;
  snd = NULL;
  IF (px IS NULL OR palive = 0) THEN
  BEGIN
    -- no target: P_LookForPlayers all around, or back to its spawn state
    EXECUTE PROCEDURE look_for_players(tid, 1) RETURNING_VALUES found;
    IF (found > 0) THEN
    BEGIN
      tgt = NULL;
      tp = found;
    END
    ELSE nst = spawn_state;
  END
  ELSE IF (just_attacked = 1) THEN
  BEGIN
    -- MF_JUSTATTACKED: this step only picks a heading (on Nightmare or -fast, not even that)
    just_attacked = 0;
    IF (fast = 0) THEN walk = 2;
  END
  ELSE
  BEGIN
    fdist = aprox_distance(fx32(fx_of(px) - fx_of(x)), fx32(fx_of(py) - fx_of(y)));   -- P_AproxDistance, in 16.16
    fire = 0;
    -- P_CheckMeleeRange: closer than MELEERANGE - 20 + the target's radius
    IF (melee_state > 0 AND fdist < 4194304 - 1310720 + fx_of(prad)) THEN
      IF (mobj_sees(tid, px, py, pz, psec) = 1) THEN
      BEGIN
        snd = atk_snd;   -- (its attacksound: the demons' DSSGTATK)
        nst = melee_state;
        fire = 1;
      END
    -- a missile attack waits for MOVECOUNT to run out (not on Nightmare or -fast)
    IF (fire = 0 AND missile_state > 0 AND (fast = 1 OR movecount = 0)) THEN
    BEGIN
      -- P_CheckMissileRange: in sight; hurt just now, it fires back at once; else not
      -- while it reacts, and less likely the further off (with no melee, 128 further)
      IF (mobj_sees(tid, px, py, pz, psec) = 1) THEN
      BEGIN
        IF (just_hit = 1) THEN
        BEGIN
          just_hit = 0;
          fire = 1;
        END
        ELSE IF (reaction = 0) THEN
        BEGIN
          dist = BIN_SHR(fdist - 4194304 - IIF(melee_state > 0, 0, 8388608), 16);
          -- the arch-vile only within 14 × 64; the revenant not under 196, and keener;
          -- the cyberdemon, the spider mastermind and the lost soul keener too, and the
          -- cyberdemon keenest
          cant = 0;
          IF (ttype = 64 AND dist > 14 * 64) THEN cant = 1;
          IF (ttype = 66) THEN
            IF (dist < 196) THEN cant = 1;
            ELSE dist = FLOOR(dist / 2);
          IF (ttype IN (16, 7, 3006)) THEN dist = FLOOR(dist / 2);
          dist = MINVALUE(200, dist);
          IF (ttype = 16 AND dist > 160) THEN dist = 160;
          IF (cant = 0) THEN
            IF (p_rand256() >= dist) THEN fire = 1;
        END
      END
      IF (fire = 1) THEN
      BEGIN
        nst = missile_state;
        just_attacked = 1;
      END
    END
    IF (fire = 0) THEN
    BEGIN
      found = 0;
      -- in a netgame, a target out of sight (once the threshold is spent) may give way
      -- to another player it can see
      IF (nplayers > 1 AND threshold = 0) THEN
        IF (mobj_sees(tid, px, py, pz, psec) = 0) THEN
          EXECUTE PROCEDURE look_for_players(tid, 1) RETURNING_VALUES found;
      IF (found > 0) THEN
      BEGIN
        tgt = NULL;
        tp = found;
      END
      ELSE walk = 1;
    END
  END
  IF (walk > 0) THEN
  BEGIN
    -- (P_Move and P_NewChaseDir move the thing in its row: what this step decided goes first)
    UPDATE things t
       SET angle = :ang, reaction = :reaction, threshold = :threshold, movedir = :movedir, movecount = :movecount,
           just_attacked = :just_attacked, just_hit = :just_hit, target_id = :tgt, tplayer = :tp
     WHERE t.id = :tid;
    moved = 0;
    IF (walk = 1) THEN
    BEGIN
      -- if (--actor->movecount < 0 || !P_Move (actor)) P_NewChaseDir (actor)
      movecount = movecount - 1;
      UPDATE things t SET movecount = :movecount WHERE t.id = :tid;
      IF (movecount >= 0) THEN EXECUTE PROCEDURE p_move_fx(tid) RETURNING_VALUES moved;
    END
    IF (moved = 0) THEN EXECUTE PROCEDURE new_chase_dir_fx(tid, fx_of(px), fx_of(py));
    SELECT t.x, t.y, t.z, t.angle, t.sector_id, t.movedir, t.movecount FROM things t WHERE t.id = :tid
      INTO x, y, z, ang, sec, movedir, movecount;
    -- last, the active sound, 3 times in 256
    IF (walk = 1 AND active_snd IS NOT NULL) THEN
      IF (p_rand256() < 3) THEN snd = active_snd;
  END
  -- (written back before the next state, whose action reads it)
  UPDATE things t
     SET x = :x, y = :y, z = :z, angle = :ang, sector_id = :sec, reaction = :reaction, threshold = :threshold,
         movedir = :movedir, movecount = :movecount, just_attacked = :just_attacked, just_hit = :just_hit,
         target_id = :tgt, tplayer = :tp
   WHERE t.id = :tid;
  IF (snd IS NOT NULL) THEN EXECUTE PROCEDURE play_sound(snd, tid, x, y);
  IF (nst IS NOT NULL) THEN EXECUTE PROCEDURE set_state(tid, nst, tic) RETURNING_VALUES alive;
END^

-- A_VileChase: where its next step would take it, a corpse lying still that can be raised
-- (a raise state), within its radius and the arch-vile's (20), with room to stand up
-- (P_CheckPosition: the arch-vile itself in the way counts)? Then the arch-vile turns to it
-- and goes into S_VILE_HEAL1, DSSLOP, and the corpse gets up through its raise state, at
-- full health, solid, with no target. Else A_Chase.
CREATE OR ALTER PROCEDURE a_vile_chase (tid INTEGER, tic INTEGER)
AS
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION;
DECLARE movedir SMALLINT;
DECLARE d DOUBLE PRECISION = 0.7171630859375e0;
DECLARE tx DOUBLE PRECISION;
DECLARE ty DOUBLE PRECISION;
DECLARE cid INTEGER;
DECLARE cx DOUBLE PRECISION;
DECLARE cy DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE crad DOUBLE PRECISION;
DECLARE chgt DOUBLE PRECISION;
DECLARE craise INTEGER;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz2 DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE alive SMALLINT;
BEGIN
  SELECT t.x, t.y, tt.speed, t.movedir FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO x, y, spd, movedir;
  IF (movedir < 8) THEN
  BEGIN
    tx = x + spd * CASE movedir WHEN 0 THEN 1 WHEN 1 THEN d WHEN 2 THEN 0 WHEN 3 THEN -d
                                WHEN 4 THEN -1 WHEN 5 THEN -d WHEN 6 THEN 0 ELSE d END;
    ty = y + spd * CASE movedir WHEN 0 THEN 0 WHEN 1 THEN d WHEN 2 THEN 1 WHEN 3 THEN d
                                WHEN 4 THEN 0 WHEN 5 THEN -d WHEN 6 THEN -1 ELSE -d END;
    FOR SELECT c.id, c.x, c.y, c.z, ct.radius, ct.height, ct.raise_state
          FROM things c JOIN thing_types ct ON ct.thing_type = c.thing_type
         WHERE c.x BETWEEN :tx - 160 AND :tx + 160 AND c.state IS NOT NULL AND c.state_tic IS NULL
           AND c.st = 'dead' AND ct.raise_state > 0
           AND ABS(c.x - :tx) <= ct.radius + 20 AND ABS(c.y - :ty) <= ct.radius + 20
         ORDER BY c.id
          INTO cid, cx, cy, cz, crad, chgt, craise
    DO
    BEGIN
      EXECUTE PROCEDURE check_position(cid, cx, cy, cz, crad, chgt, 1) RETURNING_VALUES ok, fz, cz2, dz, sec;
      IF (ok = 1) THEN
      BEGIN
        UPDATE things t SET angle = atan2_safe(:cy - t.y, :cx - t.x) WHERE t.id = :tid;
        EXECUTE PROCEDURE set_state(tid, (SELECT s.id FROM states s WHERE s.name = 'S_VILE_HEAL1'), tic) RETURNING_VALUES alive;
        EXECUTE PROCEDURE play_sound('DSSLOP', cid, cx, cy);
        UPDATE things t SET hp = (SELECT ct.hp FROM thing_types ct WHERE ct.thing_type = t.thing_type), solid = 1,
                            height = (SELECT ct.height FROM thing_types ct WHERE ct.thing_type = t.thing_type),
                            target_id = NULL, just_hit = 0, dead_tic = NULL, flags = BIN_AND(t.flags, BIN_NOT(8))
         WHERE t.id = :cid;
        EXECUTE PROCEDURE set_state(cid, craise, tic) RETURNING_VALUES alive;
        EXIT;
      END
    END
  END
  EXECUTE PROCEDURE a_chase(tid, tic);
END^

-- A_Tracer: every fourth tic, a puff where the revenant's missile is and smoke (MT_SMOKE) just
-- behind it; then, while its target lives, it turns towards it by at
-- most TRACEANGLE (16.875°), goes on at its speed that way, and climbs or sinks by 1/8 towards
-- 40 above the target's feet
CREATE OR ALTER PROCEDURE a_tracer (tid INTEGER, tic INTEGER)
AS
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION;
DECLARE d DOUBLE PRECISION;
DECLARE ta DOUBLE PRECISION;
DECLARE adx DOUBLE PRECISION;
DECLARE ady DOUBLE PRECISION;
DECLARE n DOUBLE PRECISION;
DECLARE mid INTEGER;
BEGIN
  IF (MOD(tic, 4) <> 0) THEN EXIT;
  SELECT t.x, t.y, t.z, t.momx, t.momy, t.momz, t.angle, tt.speed FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :tid INTO x, y, z, momx, momy, momz, ang, spd;
  EXECUTE PROCEDURE spawn_puff(x, y, z) RETURNING_VALUES mid;
  EXECUTE PROCEDURE spawn_thing(9018, x - momx, y - momy, z, 0) RETURNING_VALUES mid;
  UPDATE things t SET momz = 1, state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1) WHERE t.id = :mid;
  EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
  IF (px IS NULL OR palive = 0) THEN EXIT;
  ta = 0.29452431127404e0;   -- TRACEANGLE, 0xc000000
  d = atan2_safe(py - y, px - x) - ang;
  d = d - 2 * PI() * FLOOR((d + PI()) / (2 * PI()));   -- (into [−π, π))
  IF (ABS(d) <= ta) THEN ang = ang + d;
  ELSE ang = ang + SIGN(d) * ta;
  adx = ABS(px - x);
  ady = ABS(py - y);
  n = MAXVALUE(1, FLOOR((adx + ady - MINVALUE(adx, ady) / 2) / spd));
  momz = IIF((pz + 40 - z) / n < momz, momz - 0.125e0, momz + 0.125e0);
  UPDATE things t SET angle = :ang, momx = COS(:ang) * :spd, momy = SIN(:ang) * :spd, momz = :momz WHERE t.id = :tid;
END^

-- A_BrainSpit: on skills 1 and 2 only every other time; a cube (MT_SPAWNSHOT, DSBOSPIT) at the
-- next of the spawn spots in turn (braintargeton), its reaction time the tics it'll take to get
-- there, worked out from the y distance alone, as DOOM does: (dy / momy) / its state's 3 tics
CREATE OR ALTER PROCEDURE a_brain_spit (tid INTEGER)
AS
DECLARE n INTEGER;
DECLARE k INTEGER;
DECLARE spot INTEGER;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sz DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE adx DOUBLE PRECISION;
DECLARE ady DOUBLE PRECISION;
DECLARE flight DOUBLE PRECISION;
DECLARE mid INTEGER;
DECLARE momy DOUBLE PRECISION;
DECLARE tic INTEGER;
BEGIN
  UPDATE game g SET brain_easy = 1 - g.brain_easy WHERE g.id = 1;
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.skill <= 2 AND g.brain_easy = 0)) THEN EXIT;
  n = (SELECT COUNT(*) FROM things t WHERE t.thing_type = 87);
  IF (n = 0) THEN EXIT;
  SELECT MOD(g.brain_on, :n), g.tic FROM game g WHERE g.id = 1 INTO k, tic;
  UPDATE game g SET brain_on = MOD(:k + 1, :n) WHERE g.id = 1;
  SELECT FIRST 1 SKIP (:k) t.id, t.x, t.y, t.z FROM things t WHERE t.thing_type = 87 ORDER BY t.id INTO spot, sx, sy, sz;
  SELECT t.x, t.y, t.z FROM things t WHERE t.id = :tid INTO x, y, z;
  -- P_SpawnMissile
  ang = atan2_safe(sy - y, sx - x);
  EXECUTE PROCEDURE spawn_thing(9009, x, y, z + 32, ang) RETURNING_VALUES mid;
  adx = ABS(sx - x);
  ady = ABS(sy - y);
  flight = MAXVALUE(1, FLOOR((adx + ady - MINVALUE(adx, ady) / 2) / 10));
  momy = SIN(ang) * 10;
  UPDATE things t SET momx = COS(:ang) * 10, momy = :momy, momz = (:sz - :z) / :flight, owner_id = :spot,
         reaction = IIF(ABS(:momy) < 1e-9, 0, TRUNC(TRUNC((:sy - :y) / :momy) / 3)),
         -- (P_CheckMissileSpawn: through walls, it's never stopped)
         state_tic = t.state_tic - MINVALUE(p_rand_and(3), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1),
         x = t.x + COS(:ang) * 5, y = t.y + :momy / 2, z = t.z + (:sz - :z) / :flight / 2
   WHERE t.id = :mid;
  EXECUTE PROCEDURE play_sound('DSBOSPIT', mid, x, y);
  EXECUTE PROCEDURE play_sound('DSBOSPIT', NULL, NULL, NULL);
END^

-- A_SpawnFly: when the cube's reaction time runs out (if it was 0, it never does), at its spot
-- the spawn fire (DSTELEPT) and a monster, picked by P_Random() as DOOM does; one that sees a
-- player at once (P_LookForPlayers, all around) goes into its see state. On MAP30 it
-- telefrags whatever stands there (P_TeleportMove). The cube is gone.
CREATE OR ALTER PROCEDURE a_spawn_fly (tid INTEGER, tic INTEGER)
AS
DECLARE r INTEGER;
DECLARE spot INTEGER;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sz DOUBLE PRECISION;
DECLARE mid INTEGER;
DECLARE ttype INTEGER;
DECLARE found SMALLINT;
DECLARE hgt DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE sec INTEGER;
DECLARE alive SMALLINT;
DECLARE vid INTEGER;
DECLARE pid SMALLINT;
BEGIN
  UPDATE things t SET reaction = t.reaction - 1 WHERE t.id = :tid;
  IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND t.reaction <> 0)) THEN EXIT;
  SELECT t.owner_id FROM things t WHERE t.id = :tid INTO spot;
  sx = NULL;
  SELECT t.x, t.y, t.z FROM things t WHERE t.id = :spot INTO sx, sy, sz;
  IF (sx IS NOT NULL) THEN
  BEGIN
    EXECUTE PROCEDURE spawn_thing(9014, sx, sy, sz, 0) RETURNING_VALUES mid;
    EXECUTE PROCEDURE play_sound('DSTELEPT', mid, sx, sy);
    r = p_rand256();
    ttype = CASE WHEN r < 50 THEN 3001 WHEN r < 90 THEN 3002 WHEN r < 120 THEN 58 WHEN r < 130 THEN 71
                 WHEN r < 160 THEN 3005 WHEN r < 162 THEN 64 WHEN r < 172 THEN 66 WHEN r < 192 THEN 68
                 WHEN r < 222 THEN 67 WHEN r < 246 THEN 69 ELSE 3003 END;
    EXECUTE PROCEDURE spawn_thing(ttype, sx, sy, sz, 0) RETURNING_VALUES mid;
    SELECT t.height, t.radius, t.sector_id FROM things t WHERE t.id = :mid INTO hgt, rad, sec;
    EXECUTE PROCEDURE look_for_players(mid, 1) RETURNING_VALUES found;
    IF (found > 0) THEN
    BEGIN
      UPDATE things t SET tplayer = :found, target_id = NULL WHERE t.id = :mid;
      EXECUTE PROCEDURE set_state(mid, (SELECT tt.see_state FROM thing_types tt WHERE tt.thing_type = :ttype), tic)
        RETURNING_VALUES alive;
    END
    -- P_TeleportMove: on MAP30 the new monster telefrags what's in its way (PIT_StompThing)
    IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.map_name = 'MAP30')) THEN
      FOR SELECT o.id FROM things o
           WHERE o.id <> :mid AND o.x BETWEEN :sx - 160 AND :sx + 160
             AND ABS(o.x - :sx) < o.radius + :rad AND ABS(o.y - :sy) < o.radius + :rad
             AND (o.kind IN ('monster', 'barrel', 'keen', 'brain') AND o.st NOT IN ('dying', 'dead') OR o.kind = 'player')
           ORDER BY o.id
            INTO vid
      DO
      BEGIN
        pid = NULL;
        SELECT p.id FROM player p WHERE p.thing_id = :vid AND p.dead = 0 INTO pid;
        IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(10000, mid, pid, mid);
        ELSE IF (NOT EXISTS (SELECT 1 FROM things o WHERE o.id = :vid AND o.kind = 'player')) THEN
          EXECUTE PROCEDURE damage_thing(vid, 10000, mid, mid);
      END
  END
  DELETE FROM things t WHERE t.id = :tid;
END^

-- A_BrainScream: a row of rockets bursting along the wall 320 behind the brain, every 8 from
-- 196 to its left to 320 to its right, each 128 + up to 510 up, rising up to 2 a tic, its first
-- frame up to 7 tics short; and the death cry, heard everywhere. A_BrainExplode: each, as its
-- third frame comes, another within 8 either side of it.
CREATE OR ALTER PROCEDURE brain_rocket (x DOUBLE PRECISION, y DOUBLE PRECISION, tic INTEGER)
AS
DECLARE mid INTEGER;
DECLARE z DOUBLE PRECISION;
BEGIN
  z = 128 + p_rand256() * 2;
  EXECUTE PROCEDURE spawn_thing(9013, x, y, z, 0) RETURNING_VALUES mid;
  UPDATE things t SET momz = p_rand256() / 128e0 WHERE t.id = :mid;
  UPDATE things t SET state_tic = t.state_tic - MINVALUE(p_rand_and(7), (SELECT st0.tics FROM states st0 WHERE st0.id = t.state) - 1) WHERE t.id = :mid;
END^

CREATE OR ALTER PROCEDURE a_brain_scream (tid INTEGER, tic INTEGER)
AS
DECLARE bx DOUBLE PRECISION;
DECLARE by2 DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION;
BEGIN
  SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO bx, by2;
  x = bx - 196;
  WHILE (x < bx + 320) DO
  BEGIN
    EXECUTE PROCEDURE brain_rocket(x, by2 - 320, tic);
    x = x + 8;
  END
  EXECUTE PROCEDURE play_sound('DSBOSDTH', NULL, NULL, NULL);
END^

-- The actions, by name (info.c's codepointers). Only those the first things on the
-- table need are here; any other name does nothing until its phase brings it.
CREATE OR ALTER PROCEDURE state_action (tid INTEGER, act VARCHAR(24), tic INTEGER)
AS
DECLARE snd VARCHAR(8);
DECLARE ttype INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
BEGIN
  IF (act = 'A_Look') THEN EXECUTE PROCEDURE a_look(tid, tic);
  ELSE IF (act = 'A_Chase') THEN EXECUTE PROCEDURE a_chase(tid, tic);
  ELSE IF (act = 'A_FaceTarget') THEN EXECUTE PROCEDURE a_face_target(tid);
  ELSE IF (act = 'A_PosAttack') THEN EXECUTE PROCEDURE a_bullets(tid, 1, 'DSPISTOL');
  ELSE IF (act = 'A_SPosAttack') THEN EXECUTE PROCEDURE a_bullets(tid, 3, 'DSSHOTGN');
  ELSE IF (act = 'A_CPosAttack') THEN EXECUTE PROCEDURE a_bullets(tid, 1, 'DSSHOTGN');
  ELSE IF (act = 'A_CPosRefire') THEN EXECUTE PROCEDURE a_cpos_refire(tid, tic);
  ELSE IF (act = 'A_TroopAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, 8, 3, 'DSCLAW', 0, 9000);
  ELSE IF (act = 'A_SargAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, 10, 4, NULL);
  ELSE IF (act = 'A_SkullAttack') THEN EXECUTE PROCEDURE a_skull_attack(tid);
  ELSE IF (act = 'A_HeadAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, 6, 10, NULL, 0, 9001);
  ELSE IF (act = 'A_BruisAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, 8, 10, 'DSCLAW', 0, 9002);
  ELSE IF (act = 'A_CyberAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, NULL, NULL, NULL, 0, 9003);
  ELSE IF (act = 'A_SpidRefire') THEN EXECUTE PROCEDURE a_cpos_refire(tid, tic, 10);
  ELSE IF (act = 'A_BspiAttack') THEN EXECUTE PROCEDURE a_melee_missile(tid, NULL, NULL, NULL, 0, 9008);
  ELSE IF (act = 'A_Explode') THEN
  BEGIN
    -- A_Explode: P_RadiusAttack, 128 at the centre, from whoever fired it
    SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE radius_attack(x, y, (SELECT t.z FROM things t WHERE t.id = :tid), 128,
                                    (SELECT t.owner_id FROM things t WHERE t.id = :tid), tid);
  END
  ELSE IF (act = 'A_BFGSpray') THEN
    EXECUTE PROCEDURE bfg_spray((SELECT t.angle FROM things t WHERE t.id = :tid), (SELECT t.owner_id FROM things t WHERE t.id = :tid));
  ELSE IF (act = 'A_Tracer') THEN EXECUTE PROCEDURE a_tracer(tid, tic);
  ELSE IF (act IN ('A_Fire', 'A_StartFire', 'A_FireCrackle')) THEN
  BEGIN
    -- A_StartFire (DSFLAMST), A_FireCrackle (DSFLAME), then A_Fire
    IF (act <> 'A_Fire') THEN
    BEGIN
      SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
      EXECUTE PROCEDURE play_sound(TRIM(IIF(act = 'A_StartFire', 'DSFLAMST', 'DSFLAME')), tid, x, y);
    END
    EXECUTE PROCEDURE a_fire(tid);
  END
  ELSE IF (act = 'A_BrainAwake') THEN
  BEGIN
    -- A_BrainAwake: the spots counted from the first, and its cry
    UPDATE game g SET brain_on = 0 WHERE g.id = 1;
    EXECUTE PROCEDURE play_sound('DSBOSSIT', NULL, NULL, NULL);
  END
  ELSE IF (act = 'A_BrainSpit') THEN EXECUTE PROCEDURE a_brain_spit(tid);
  ELSE IF (act IN ('A_SpawnSound', 'A_SpawnFly')) THEN
  BEGIN
    IF (act = 'A_SpawnSound') THEN
    BEGIN
      SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
      EXECUTE PROCEDURE play_sound('DSBOSCUB', tid, x, y);
    END
    EXECUTE PROCEDURE a_spawn_fly(tid, tic);
  END
  ELSE IF (act = 'A_BrainPain') THEN EXECUTE PROCEDURE play_sound('DSBOSPN', NULL, NULL, NULL);
  ELSE IF (act = 'A_BrainScream') THEN EXECUTE PROCEDURE a_brain_scream(tid, tic);
  ELSE IF (act = 'A_BrainExplode') THEN
  BEGIN
    SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE brain_rocket(x + (p_rand256() - p_rand256()) / 32e0, y, tic);
  END
  ELSE IF (act = 'A_BrainDie') THEN UPDATE game g SET exit_kind = 1 WHERE g.id = 1;   -- (G_ExitLevel)
  ELSE IF (act = 'A_SkelFist') THEN EXECUTE PROCEDURE a_melee_missile(tid, 10, 6, 'DSSKEPCH', 1);
  ELSE IF (act = 'A_SkelMissile') THEN EXECUTE PROCEDURE a_skel_missile(tid);
  ELSE IF (act = 'A_VileChase') THEN EXECUTE PROCEDURE a_vile_chase(tid, tic);
  ELSE IF (act = 'A_VileTarget') THEN EXECUTE PROCEDURE a_vile_target(tid);
  ELSE IF (act = 'A_VileAttack') THEN EXECUTE PROCEDURE a_vile_attack(tid);
  ELSE IF (act IN ('A_SkelWhoosh', 'A_VileStart')) THEN
  BEGIN
    -- A_SkelWhoosh: face the target and swing (DSSKESWG); A_VileStart: DSVILATK
    IF (act = 'A_SkelWhoosh') THEN EXECUTE PROCEDURE a_face_target(tid);
    SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE play_sound(IIF(act = 'A_SkelWhoosh', 'DSSKESWG', 'DSVILATK'), tid, x, y);
  END
  ELSE IF (act = 'A_FatRaise') THEN
  BEGIN
    EXECUTE PROCEDURE a_face_target(tid);
    SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE play_sound('DSMANATK', tid, x, y);
  END
  ELSE IF (act = 'A_FatAttack1') THEN EXECUTE PROCEDURE a_fat_attack(tid, 1, 0, 1);
  ELSE IF (act = 'A_FatAttack2') THEN EXECUTE PROCEDURE a_fat_attack(tid, -1, 0, -2);
  ELSE IF (act = 'A_FatAttack3') THEN EXECUTE PROCEDURE a_fat_attack(tid, 0, -0.5e0, 0.5e0);
  ELSE IF (act = 'A_PainAttack') THEN EXECUTE PROCEDURE a_pain_attack(tid);
  ELSE IF (act = 'A_PainDie') THEN EXECUTE PROCEDURE a_pain_die(tid);
  ELSE IF (act = 'A_KeenDie') THEN
  BEGIN
    -- A_KeenDie: A_Fall, and with the last Commander Keen dead the tag-666 doors open
    UPDATE things SET solid = 0 WHERE id = :tid;
    EXECUTE PROCEDURE keen_die;
  END
  ELSE IF (act IN ('A_Hoof', 'A_Metal', 'A_BabyMetal')) THEN
  BEGIN
    -- A_Hoof, A_Metal, A_BabyMetal: the cyberdemon's hoof, the bosses' metal footfall, the
    -- arachnotron's whirr, then A_Chase
    SELECT t.x, t.y FROM things t WHERE t.id = :tid INTO x, y;
    EXECUTE PROCEDURE play_sound(TRIM(CASE act WHEN 'A_Hoof' THEN 'DSHOOF' WHEN 'A_Metal' THEN 'DSMETAL' ELSE 'DSBSPWLK' END), tid, x, y);
    EXECUTE PROCEDURE a_chase(tid, tic);
  END
  ELSE IF (act = 'A_Fall') THEN
    -- A_Fall: the corpse no longer blocks (MF_SOLID off)
    UPDATE things SET solid = 0 WHERE id = :tid;
  ELSE IF (act IN ('A_Scream', 'A_Pain', 'A_XScream')) THEN
  BEGIN
    -- A_Scream: the death sound (one of the zombies' three, the imps' two); the
    -- spider mastermind's and the cyberdemon's at full volume. A_Pain: the pain
    -- sound. A_XScream: the gibbing.
    SELECT CASE :act WHEN 'A_Scream' THEN tt.death_snd WHEN 'A_Pain' THEN tt.pain_snd ELSE 'DSSLOP' END,
           t.thing_type, t.x, t.y
      FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
     WHERE t.id = :tid INTO snd, ttype, x, y;
    IF (act = 'A_Scream') THEN snd = cry_variant(snd);
    IF (snd IS NULL) THEN EXIT;
    IF (act = 'A_Scream' AND ttype IN (7, 16)) THEN EXECUTE PROCEDURE play_sound(snd, NULL, NULL, NULL);
    ELSE EXECUTE PROCEDURE play_sound(snd, tid, x, y);
  END
  ELSE IF (act = 'A_BossDeath') THEN
    EXECUTE PROCEDURE boss_death((SELECT t.thing_type FROM things t WHERE t.id = :tid));
  ELSE IF (act = 'A_PlayerScream') THEN
  BEGIN
    -- A_PlayerScream: the player's death cry; in DOOM II, below -50 health, the louder one
    -- (from the player: for whoever's playing it, full volume in the middle)
    SELECT t.x, t.y, TRIM(IIF(t.hp < -50 AND g.map_name STARTING WITH 'MAP', 'DSPDIEHI', 'DSPLDETH'))
      FROM things t CROSS JOIN game g WHERE t.id = :tid AND g.id = 1 INTO x, y, snd;
    EXECUTE PROCEDURE play_sound(snd, tid, x, y);
  END
END^

-- P_SetMobjState: TID into state ST at TIC – its tics start, then its action is called.
-- A state of 0 tics goes straight on to the next, and S_NULL (0) removes the thing
-- (P_RemoveMobj). ALIVE says whether it's still there.
CREATE OR ALTER PROCEDURE set_state (tid INTEGER, st INTEGER, tic INTEGER)
RETURNS (alive SMALLINT)
AS
DECLARE tics INTEGER;
DECLARE act VARCHAR(24);
DECLARE nxt INTEGER;
DECLARE n INTEGER = 0;
DECLARE md VARCHAR(8);
DECLARE was VARCHAR(8);
DECLARE ahead SMALLINT;
BEGIN
  alive = 1;
  -- (its turn still to come this tic? then its tics count down this tic too)
  ahead = think_ahead((SELECT COALESCE(t.think_key, 2 * t.id) FROM things t WHERE t.id = :tid));
  WHILE (n < 100) DO   -- (a ring of 0-tic states would hang DOOM; here it stops)
  BEGIN
    n = n + 1;
    IF (st = 0) THEN
    BEGIN
      DELETE FROM things WHERE id = :tid;
      alive = 0;
      EXIT;
    END
    SELECT IIF(s.fast = 1 AND g.fast_states = 1, BIN_SHR(s.tics, 1), s.tics), s.action, s.next_state, s.mode
      FROM states s CROSS JOIN (SELECT IIF(gm.skill = 5 OR gm.fast = 1, 1, 0) fast_states FROM game gm WHERE gm.id = 1) g
     WHERE s.id = :st INTO tics, act, nxt, md;
    was = NULL;
    SELECT t.st FROM things t WHERE t.id = :tid INTO was;
    -- (ST, the old rules' word for it, follows: what can be shot, what's a corpse)
    UPDATE things SET state = :st, state_tic = IIF(:tics < 0, NULL, :tic + :tics - IIF(:tics > 0, :ahead, 0)), st = COALESCE(:md, :was),
                      dead_tic = IIF(:md = 'dead' AND :was IS DISTINCT FROM 'dead', :tic, dead_tic)
     WHERE id = :tid;
    IF (act IS NOT NULL) THEN EXECUTE PROCEDURE state_action(tid, act, tic);
    IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid)) THEN
    BEGIN
      alive = 0;
      EXIT;
    END
    -- (DOOM's loop runs while mobj->tics is 0: here, while its state is still this one of 0 tics)
    IF (tics <> 0 OR NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND t.state = :st AND t.state_tic = :tic)) THEN EXIT;
    st = nxt;
  END
END^

-- P_MobjThinker's movement for the missiles on the tables (those not yet burst):
-- P_XYMovement, in half moves while one of them is over MAXMOVE/2 (15: DOOM asks only of
-- the positive ones), each a MISSILE_TRY; then P_ZMovement: on through the floor or the
-- ceiling, it bursts there (sky or not). AFTER_ID: only those spawned after it.
-- One missile's P_XYMovement and P_ZMovement (or a boss cube's flight)
CREATE OR ALTER PROCEDURE missile_step (tid INTEGER, tic INTEGER)
AS
DECLARE fx BIGINT;
DECLARE fy BIGINT;
DECLARE bx BIGINT;
DECLARE by_ BIGINT;
DECLARE bz BIGINT;
DECLARE mz BIGINT;
DECLARE hz BIGINT;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE ffz BIGINT;
DECLARE fcz BIGINT;
DECLARE sfz BIGINT;
DECLARE scz BIGINT;
DECLARE cl VARCHAR(255);
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE xmove DOUBLE PRECISION;
DECLARE ymove DOUBLE PRECISION;
DECLARE moved SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND t.kind IN ('missile', 'cube') AND t.state IS NOT NULL
                   AND t.st NOT IN ('dying', 'dead'))) THEN EXIT;
  -- a boss cube (MF_NOCLIP): straight through everything, kept between floor and ceiling
  IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND t.kind = 'cube')) THEN
  BEGIN
    SELECT t.x + t.momx, t.y + t.momy, t.z + t.momz, t.momz, t.radius, t.height FROM things t WHERE t.id = :tid
      INTO x, y, z, momz, rad, hgt;
    EXECUTE PROCEDURE z_range(x, y, rad) RETURNING_VALUES fz, cz;
    IF (z <= fz) THEN
    BEGIN
      z = fz;
      IF (momz < 0) THEN momz = 0;
    END
    IF (z + hgt > cz) THEN
    BEGIN
      IF (momz > 0) THEN momz = 0;
      z = cz - hgt;
    END
    UPDATE things t SET x = :x, y = :y, z = :z, momz = :momz, sector_id = sector_at(:x, :y) WHERE t.id = :tid;
    EXIT;
  END
  -- (in 16.16: MAXMOVE, the halved steps, each a TRY_MOVE_MISSILE; stopped, it bursts – or, the
  -- line that lowered the ceiling having a sky behind it, it's gone: id's hack, so a missile
  -- fired at the sky doesn't burst on it)
  fx = NULL;
  SELECT fx_of(t.momx), fx_of(t.momy) FROM things t WHERE t.id = :tid AND t.st NOT IN ('dying', 'dead') INTO fx, fy;
  IF (fx IS NULL) THEN EXIT;
  IF (fx <> 0 OR fy <> 0) THEN
  BEGIN
    fx = MAXVALUE(-1966080, MINVALUE(1966080, fx));
    fy = MAXVALUE(-1966080, MINVALUE(1966080, fy));
    UPDATE things t SET momx = :fx / 65536e0, momy = :fy / 65536e0 WHERE t.id = :tid;
    WHILE (1 = 1) DO
    BEGIN
      SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO bx, by_;
      IF (fx > 983040 OR fy > 983040) THEN
      BEGIN
        tx = bx + fx / 2;                        -- (C's division: towards 0)
        ty = by_ + fy / 2;
        fx = BIN_SHR(fx, 1);
        fy = BIN_SHR(fy, 1);
      END
      ELSE
      BEGIN
        tx = bx + fx;
        ty = by_ + fy;
        fx = 0;
        fy = 0;
      END
      EXECUTE PROCEDURE try_move_missile(tid, tx, ty) RETURNING_VALUES moved;
      IF (moved = 0) THEN
      BEGIN
        IF (NOT EXISTS (SELECT 1 FROM things t WHERE t.id = :tid)) THEN EXIT;
        cl = RDB$GET_CONTEXT('USER_TRANSACTION', 'CEILINGLINE');
        IF (cl IS NOT NULL AND EXISTS (SELECT 1 FROM linedefs l JOIN sectors bs ON bs.id = l.back_sector
                                        WHERE l.id = CAST(:cl AS INTEGER) AND bs.sky = 1)) THEN
          DELETE FROM things t WHERE t.id = :tid;   -- (P_RemoveMobj)
        ELSE EXECUTE PROCEDURE explode_missile(tid, tic);
        EXIT;
      END
      IF (fx = 0 AND fy = 0) THEN LEAVE;
    END
  END
  -- P_ZMovement: on through the floor or the ceiling (the floorz and ceilingz its last move found,
  -- P_SpawnMobj's to start with) it bursts there, sky or not
  SELECT fx_of(t.z), fx_of(t.momz), fx_of(t.height), fx_of(t.floorz), fx_of(t.ceilz),
         (SELECT fx_of(s.floor_h) FROM sectors s WHERE s.id = t.sector_id), (SELECT fx_of(s.ceil_h) FROM sectors s WHERE s.id = t.sector_id)
    FROM things t WHERE t.id = :tid INTO bz, mz, hz, ffz, fcz, sfz, scz;
  ffz = COALESCE(ffz, sfz);
  fcz = COALESCE(fcz, scz);
  IF (bz = ffz AND mz = 0) THEN EXIT;
  bz = bz + mz;
  IF (bz <= ffz) THEN
  BEGIN
    UPDATE things t SET z = :ffz / 65536e0 WHERE t.id = :tid;
    EXECUTE PROCEDURE explode_missile(tid, tic);
  END
  ELSE IF (bz + hz > fcz) THEN
  BEGIN
    UPDATE things t SET z = (:fcz - :hz) / 65536e0 WHERE t.id = :tid;
    EXECUTE PROCEDURE explode_missile(tid, tic);
  END
  ELSE UPDATE things t SET z = :bz / 65536e0 WHERE t.id = :tid;
END^

CREATE OR ALTER PROCEDURE missiles_think (tic INTEGER, after_id INTEGER = 0)
AS
DECLARE tid INTEGER;
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE xmove DOUBLE PRECISION;
DECLARE ymove DOUBLE PRECISION;
DECLARE moved SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
BEGIN
  FOR SELECT t.id FROM things t
       WHERE t.kind IN ('missile', 'cube') AND t.state IS NOT NULL AND t.st NOT IN ('dying', 'dead') AND t.id > :after_id
       ORDER BY t.id
        INTO tid
  DO
    EXECUTE PROCEDURE missile_step(tid, tic);
END^

-- P_MobjThinker's countdown, for the things on the table: each whose state ends this
-- tic goes on to the next, in spawn order (P_RunThinkers). Only those are touched
-- (the index on STATE_TIC), not every thing every tic.
-- One thing's P_ZMovement (not a missile's, nor a player's): a walker thrown up (an
-- arch-vile's blast) rises, bumps the ceiling and falls at 1 unit/tic² to the floor; a flier
-- (MF_FLOAT, MF_NOGRAVITY) drifts 4 units a tic towards its target's middle while it's alive
-- and not charging or squeezing through (MF_INFLOAT); a charging skull bounces off floor and
-- ceiling. (It runs while the thing moves up or down or is off the floor, z != floorz: off the
-- floor with no momz is the top of a toss, marked 1048576 in THINGS.FLAGS for the tic it lasts.)
CREATE OR ALTER PROCEDURE z_step (tid INTEGER, tic INTEGER)
AS
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE momz DOUBLE PRECISION;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE floats SMALLINT;
DECLARE flags INTEGER;
DECLARE living SMALLINT;
DECLARE ttype INTEGER;
DECLARE skullfly SMALLINT;
DECLARE tgt INTEGER;
DECLARE tp SMALLINT;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE psec INTEGER;
DECLARE prad DOUBLE PRECISION;
DECLARE palive SMALLINT;
DECLARE shadow SMALLINT;
DECLARE adx DOUBLE PRECISION;
DECLARE ady DOUBLE PRECISION;
DECLARE dist DOUBLE PRECISION;
DECLARE delta DOUBLE PRECISION;
DECLARE st VARCHAR(8);
DECLARE nograv SMALLINT;
DECLARE fx SMALLINT;
DECLARE sfz DOUBLE PRECISION;
DECLARE scz DOUBLE PRECISION;
DECLARE doom2 SMALLINT;
BEGIN
  x = NULL;
  SELECT t.x, t.y, t.z, t.momz, t.radius, t.height, IIF(tt.floats = 1 AND t.kind = 'monster', 1, 0), t.flags,
         IIF(t.st IN ('dying', 'dead'), 0, 1), t.thing_type, t.st, tt.nogravity, IIF(t.kind = 'fx', 1, 0),
         t.floorz, t.ceilz
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :tid AND t.state IS NOT NULL AND t.kind NOT IN ('missile', 'cube', 'player')
     AND (t.momz <> 0 OR tt.floats = 1 OR BIN_AND(t.flags, 1048576) <> 0)
    INTO x, y, z, momz, rad, hgt, floats, flags, living, ttype, st, nograv, fx, sfz, scz;
  IF (x IS NULL) THEN EXIT;
  -- (mobj->floorz and ceilingz: P_SpawnMobj's, its subsector's, then P_TryMove's where it moved
  -- to and P_ChangeSector's when a sector moved – a puff or blood, out of the blockmap, keeps
  -- the ones it was born with)
  IF (sfz IS NOT NULL) THEN
  BEGIN
    fz = sfz;
    cz = scz;
  END
  ELSE EXECUTE PROCEDURE z_range(x, y, rad) RETURNING_VALUES fz, cz;
  -- (P_MobjThinker: P_ZMovement only for one off its floor or moving up or down – a flier at rest
  -- on its floor stays there)
  IF (sfz IS NOT NULL AND z = sfz AND momz = 0) THEN
  BEGIN
    UPDATE things t SET flags = BIN_AND(t.flags, BIN_NOT(1048576)) WHERE t.id = :tid AND BIN_AND(t.flags, 1048576) <> 0;
    EXIT;
  END
  z = z + momz;
  skullfly = IIF(BIN_AND(flags, 262144) <> 0, 1, 0);
  doom2 = IIF(EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.map_name STARTING WITH 'MAP'), 1, 0);
  -- (asleep it has no target yet: DOOM's A_Look gives it one)
  IF (floats = 1 AND living = 1 AND skullfly = 0 AND BIN_AND(flags, 131072) = 0 AND st <> 'idle') THEN
  BEGIN
    EXECUTE PROCEDURE chase_target(tid) RETURNING_VALUES tgt, tp, px, py, pz, psec, prad, palive, shadow;
    IF (px IS NOT NULL) THEN
    BEGIN
      -- (in 16.16: P_AproxDistance to the target; delta from its feet plus half the flier's own
      -- height, mo->height >> 1, to where the flier is)
      dist = aprox_distance(fx_of(x) - fx_of(px), fx_of(y) - fx_of(py)) / 65536e0;
      delta = (fx_of(pz) + BIN_SHR(fx_of(hgt), 1) - fx_of(z)) / 65536e0;
      IF (delta < 0 AND dist < -delta * 3) THEN z = z - 4;
      ELSE IF (delta > 0 AND dist < delta * 3) THEN z = z + 4;
    END
  END
  IF (z <= fz) THEN
  BEGIN
    -- (the lost soul bounces off the floor – in DOOM II's exe, v1.9, the bounce comes after
    -- momz is zeroed, so it doesn't: Chocolate Doom's correct_lost_soul_bounce)
    IF (skullfly = 1 AND doom2 = 0) THEN momz = -momz;
    IF (momz < 0) THEN momz = 0;
    z = fz;
    IF (skullfly = 1 AND doom2 = 1) THEN momz = -momz;
  END
  ELSE IF (nograv = 0 OR (floats = 1 AND living = 0 AND ttype <> 3006)) THEN
    -- (MF_NOGRAVITY goes with a flier's death, but not the lost soul's; from rest, 2 at once)
    momz = IIF(momz = 0, -2, momz - 1);
  IF (z + hgt > cz) THEN
  BEGIN
    IF (momz > 0) THEN momz = 0;
    z = cz - hgt;
    IF (skullfly = 1) THEN momz = -momz;
  END
  -- (at the top of a toss, no momz but off the floor: still falling next tic)
  UPDATE things t SET z = :z, momz = :momz,
         flags = IIF(:momz = 0 AND :z > :fz AND :nograv = 0, BIN_OR(t.flags, 1048576), BIN_AND(t.flags, BIN_NOT(1048576)))
   WHERE t.id = :tid;
END^

-- PIT_CheckThing for a charging lost soul at (X, Y) (MF_SKULLFLY): the first thing, in
-- P_CheckPosition's order (the blocks MAXRADIUS around, column by column; in a block the newest
-- first), that is solid, a pickup (MF_SPECIAL) or shootable, whose box its own touches – no
-- heights asked. → HIT, or NULL
CREATE OR ALTER PROCEDURE skull_contact (tid INTEGER, x BIGINT, y BIGINT, rad BIGINT)
RETURNS (hit INTEGER)
AS
DECLARE orgx BIGINT;
DECLARE orgy BIGINT;
DECLARE bw INTEGER;
DECLARE bh INTEGER;
DECLARE xl INTEGER;
DECLARE xh INTEGER;
DECLARE yl INTEGER;
DECLARE yh INTEGER;
BEGIN
  hit = NULL;
  SELECT CAST(b.org_x AS BIGINT) * 65536, CAST(b.org_y AS BIGINT) * 65536, b.w, b.h
    FROM blockmap_info b WHERE b.id = 1 INTO orgx, orgy, bw, bh;
  xl = MAXVALUE(BIN_SHR(x - rad - orgx - 2097152, 23), 0);      -- (MAXRADIUS: 32 units)
  xh = MINVALUE(BIN_SHR(x + rad - orgx + 2097152, 23), bw - 1);
  yl = MAXVALUE(BIN_SHR(y - rad - orgy - 2097152, 23), 0);
  yh = MINVALUE(BIN_SHR(y + rad - orgy + 2097152, 23), bh - 1);
  SELECT FIRST 1 t.id FROM things t
   WHERE t.x BETWEEN (:x - :rad) / 65536e0 - 160 AND (:x + :rad) / 65536e0 + 160 AND t.id <> :tid
     AND (t.solid = 1 OR t.kind = 'item'
          OR (t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.state IS NOT NULL))
     AND ABS(fx_of(t.x) - :x) < fx_of(t.radius) + :rad AND ABS(fx_of(t.y) - :y) < fx_of(t.radius) + :rad
     AND BIN_SHR(fx_of(t.x) - :orgx, 23) BETWEEN :xl AND :xh
     AND BIN_SHR(fx_of(t.y) - :orgy, 23) BETWEEN :yl AND :yh
   ORDER BY BIN_SHR(fx_of(t.x) - :orgx, 23), BIN_SHR(fx_of(t.y) - :orgy, 23), t.link_seq DESC
    INTO hit;
END^

-- P_XYMovement for anything else with momentum (not a player's body, a missile or a charging
-- lost soul): a monster or barrel thrown by a hit, a corpse sliding. At most MAXMOVE (30) each
-- way, in steps of at most half that (halved only when positive), each a P_TryMove
-- (TRY_MOVE_MOBJ: it crosses the lines a monster sets off – a corpse slides through a
-- teleporter); a step that fails stops it dead, and what's left of the move is still tried.
-- Then, on its floor (in the air: no friction, a floating cacodemon drifts on), friction
-- (FRICTION, 0xe800), or a stop under STOPSPEED (0x1000); a corpse with some speed left
-- doesn't stop while it's halfway off a step (its floorz isn't its sector's floor).
-- A charging lost soul (MF_SKULLFLY) flies on with no friction; the first thing its box meets
-- (SKULL_CONTACT) it slams into for (P_Random() % 8 + 1) × its damage (P_DamageMobj, from
-- itself: shootable or not, the draw is made), stopping dead in its spawn state; a wall stops
-- it, and with no momentum left it goes back to its spawn state the tic after.
CREATE OR ALTER PROCEDURE xy_movement_mobj (tid INTEGER)
AS
DECLARE momx BIGINT;
DECLARE momy BIGINT;
DECLARE x BIGINT;
DECLARE y BIGINT;
DECLARE z BIGINT;
DECLARE fz BIGINT;
DECLARE xmove BIGINT;
DECLARE ymove BIGINT;
DECLARE tx BIGINT;
DECLARE ty BIGINT;
DECLARE ok SMALLINT;
DECLARE floatok SMALLINT;
DECLARE tmfz BIGINT;
DECLARE spec VARCHAR(4000);
DECLARE corpse SMALLINT;
DECLARE secfloor BIGINT;
DECLARE nograv SMALLINT;
DECLARE skull SMALLINT;
DECLARE rad BIGINT;
DECLARE hit INTEGER;
DECLARE hitp SMALLINT;
DECLARE dmg INTEGER;
DECLARE tic INTEGER;
DECLARE alive SMALLINT;
BEGIN
  momx = NULL;
  SELECT fx_of(t.momx), fx_of(t.momy), IIF(BIN_AND(t.flags, 262144) <> 0, 1, 0), fx_of(t.radius)
    FROM things t WHERE t.id = :tid INTO momx, momy, skull, rad;
  IF (momx IS NULL) THEN EXIT;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  IF (momx = 0 AND momy = 0) THEN
  BEGIN
    -- (the skull slammed into something: back to its spawn state)
    IF (skull = 1) THEN
    BEGIN
      UPDATE things t SET flags = BIN_AND(t.flags, BIN_NOT(262144)), momz = 0 WHERE t.id = :tid;
      EXECUTE PROCEDURE set_state(tid, (SELECT tt.spawn_state FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                                         WHERE t.id = :tid), tic) RETURNING_VALUES alive;
    END
    EXIT;
  END
  momx = MAXVALUE(-1966080, MINVALUE(1966080, momx));
  momy = MAXVALUE(-1966080, MINVALUE(1966080, momy));
  UPDATE things t SET momx = :momx / 65536e0, momy = :momy / 65536e0 WHERE t.id = :tid;
  xmove = momx;
  ymove = momy;
  WHILE (1 = 1) DO
  BEGIN
    x = NULL;
    SELECT fx_of(t.x), fx_of(t.y) FROM things t WHERE t.id = :tid INTO x, y;
    IF (x IS NULL) THEN EXIT;                    -- (gone: a teleporter's telefrag)
    IF (xmove > 983040 OR ymove > 983040) THEN
    BEGIN
      tx = x + xmove / 2;                        -- (C's division: towards 0)
      ty = y + ymove / 2;
      xmove = BIN_SHR(xmove, 1);
      ymove = BIN_SHR(ymove, 1);
    END
    ELSE
    BEGIN
      tx = x + xmove;
      ty = y + ymove;
      xmove = 0;
      ymove = 0;
    END
    hit = NULL;
    IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND BIN_AND(t.flags, 262144) <> 0)) THEN
    BEGIN
      EXECUTE PROCEDURE skull_contact(tid, tx, ty, rad) RETURNING_VALUES hit;
      IF (hit IS NOT NULL) THEN
      BEGIN
        dmg = (MOD(p_rand256(), 8) + 1) * COALESCE((SELECT tt.dmg_lo FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                                                      WHERE t.id = :tid), 3);   -- (info->damage: the lost soul's 3)
        hitp = NULL;
        SELECT p.id FROM player p WHERE p.thing_id = :hit INTO hitp;
        IF (hitp IS NOT NULL) THEN EXECUTE PROCEDURE damage_player(dmg, tid, hitp, tid);
        ELSE EXECUTE PROCEDURE damage_thing(hit, dmg, tid, tid);
        UPDATE things t SET flags = BIN_AND(t.flags, BIN_NOT(262144)), momx = 0, momy = 0, momz = 0 WHERE t.id = :tid;
        EXECUTE PROCEDURE set_state(tid, (SELECT tt.spawn_state FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                                           WHERE t.id = :tid), tic) RETURNING_VALUES alive;
        ok = 0;
      END
      ELSE EXECUTE PROCEDURE try_move_mobj(tid, tx, ty, 0) RETURNING_VALUES ok, floatok, tmfz, spec;
    END
    ELSE EXECUTE PROCEDURE try_move_mobj(tid, tx, ty) RETURNING_VALUES ok, floatok, tmfz, spec;
    IF (ok = 0) THEN UPDATE things t SET momx = 0, momy = 0 WHERE t.id = :tid;
    IF (xmove = 0 AND ymove = 0) THEN LEAVE;
  END
  -- (still charging: no friction)
  IF (EXISTS (SELECT 1 FROM things t WHERE t.id = :tid AND BIN_AND(t.flags, 262144) <> 0)) THEN EXIT;
  -- (mobj->floorz: where P_TryMove last left it, else the floor where it stands)
  x = NULL;
  SELECT fx_of(t.x), fx_of(t.y), fx_of(t.z), fx_of(t.momx), fx_of(t.momy),
         IIF(t.fz_x = t.x AND t.fz_y = t.y, fx_of(t.floorz), NULL), IIF(t.st IN ('dying', 'dead'), 1, 0),
         (SELECT fx_of(s.floor_h) FROM sectors s WHERE s.id = t.sector_id), tt.nogravity
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type WHERE t.id = :tid
    INTO x, y, z, momx, momy, fz, corpse, secfloor, nograv;
  IF (x IS NULL) THEN EXIT;
  fz = COALESCE(fz, secfloor);
  -- (off its floor: P_ZMovement brings it down, or up a step at once)
  IF (z < fz OR (z > fz AND nograv = 0)) THEN UPDATE things t SET flags = BIN_OR(t.flags, 1048576) WHERE t.id = :tid AND t.momz = 0;
  IF (z > fz) THEN EXIT;
  IF (corpse = 1 AND (momx > 16384 OR momx < -16384 OR momy > 16384 OR momy < -16384) AND fz <> secfloor) THEN EXIT;
  IF (momx > -4096 AND momx < 4096 AND momy > -4096 AND momy < 4096) THEN
  BEGIN
    momx = 0;
    momy = 0;
  END
  ELSE
  BEGIN
    momx = fx_mul(momx, 59392);
    momy = fx_mul(momy, 59392);
  END
  UPDATE things t SET momx = :momx / 65536e0, momy = :momy / 65536e0 WHERE t.id = :tid;
END^

-- One thing's thinker, P_MobjThinker: its movement (a player's body, P_XYMovement and
-- P_ZMovement in 16.16 and what it picks up; a charging lost soul's flight; a missile's), its
-- P_ZMovement, then its state's countdown – the state ending this tic goes on to the next
-- (SET_STATE, the next state's action) – and on Nightmare (NIGHTMARE, every 32 tics) a corpse's
-- chance to rise.
CREATE OR ALTER PROCEDURE thing_think (tid INTEGER, tic INTEGER, nightmare SMALLINT, key_ BIGINT)
AS
DECLARE k VARCHAR(10);
DECLARE skull SMALLINT;
DECLARE stt INTEGER;
DECLARE pid SMALLINT;
DECLARE nxt INTEGER;
DECLARE alive SMALLINT;
DECLARE moving SMALLINT;
BEGIN
  k = NULL;
  SELECT t.kind, IIF(BIN_AND(t.flags, 262144) <> 0, 1, 0), t.state, IIF(t.momx <> 0 OR t.momy <> 0, 1, 0)
    FROM things t WHERE t.id = :tid INTO k, skull, stt, moving;
  IF (k IS NULL) THEN EXIT;                      -- (removed earlier in the pass)
  -- (while it moves, its countdown is still to come: THINK_AHEAD)
  RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', key_ - 1);
  IF (k = 'player') THEN
  BEGIN
    pid = NULL;
    SELECT p.id FROM player p WHERE p.thing_id = :tid INTO pid;
    IF (pid IS NOT NULL) THEN EXECUTE PROCEDURE player_body(pid, tic);
  END
  ELSE IF (k IN ('missile', 'cube')) THEN EXECUTE PROCEDURE missile_step(tid, tic);
  ELSE IF (moving = 1 OR (skull = 1 AND stt IS NOT NULL)) THEN EXECUTE PROCEDURE xy_movement_mobj(tid);
  EXECUTE PROCEDURE z_step(tid, tic);
  RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', key_);
  -- (still due? an action before it may have changed or removed it; and one made due during
  -- the last pass, after its turn, goes on now)
  nxt = NULL;
  SELECT s.next_state FROM things t JOIN states s ON s.id = t.state
   WHERE t.id = :tid AND t.state_tic BETWEEN :tic - 1 AND :tic INTO nxt;
  IF (nxt IS NOT NULL) THEN EXECUTE PROCEDURE set_state(tid, nxt, tic) RETURNING_VALUES alive;
  IF (nightmare = 1) THEN EXECUTE PROCEDURE nightmare_step(tid, tic);
END^

-- The things set moving this tic before their turn (LATE_MOVERS) whose turn comes before UPTO:
-- each one's thinker, in its turn
CREATE OR ALTER PROCEDURE run_late (tic INTEGER, upto BIGINT, nightmare SMALLINT)
AS
DECLARE k BIGINT;
DECLARE id INTEGER;
BEGIN
  FOR SELECT lm.k, lm.id FROM late_movers lm WHERE lm.k < :upto ORDER BY lm.k INTO k, id
  DO
  BEGIN
    DELETE FROM late_movers lm WHERE lm.id = :id;
    RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', k);
    EXECUTE PROCEDURE thing_think(id, tic, nightmare, k);
  END
END^

-- P_RunThinkers: every thinker with something to do this tic, in the list's order – the order
-- they were made in (THINK_KEY: a thing's is twice its id, a player's body sits among the map's
-- things where its start was, and a light's or a mover's is taken from THING_SEQ as it's made,
-- so P_SpawnSpecials' come after the map's things) – between LO and HI (exclusive, inclusive).
-- KINDS: T things, L lights, M movers. → N, how many ran.
CREATE OR ALTER PROCEDURE run_thinkers (tic INTEGER, lo BIGINT, hi BIGINT, kinds VARCHAR(3))
RETURNS (n INTEGER)
AS
DECLARE kind CHAR(1);
DECLARE key_ BIGINT;
DECLARE id INTEGER;
DECLARE nightmare SMALLINT;
BEGIN
  n = 0;
  nightmare = IIF(MOD(tic, 32) = 0 AND EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND (g.skill = 5 OR g.respawn = 1)), 1, 0);
  FOR SELECT q.kind, q.k, q.id
        FROM (SELECT 'T' kind, COALESCE(t.think_key, 2 * t.id) k, t.id FROM things t WHERE t.state_tic BETWEEN :tic - 1 AND :tic
              UNION
              SELECT 'T', COALESCE(t.think_key, 2 * t.id), t.id FROM things t
               WHERE t.kind IN ('player', 'missile', 'cube')
              UNION
              SELECT 'T', COALESCE(t.think_key, 2 * t.id), t.id FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
               WHERE t.state IS NOT NULL
                 AND (BIN_AND(t.flags, 262144) <> 0 OR t.momz <> 0 OR t.momx <> 0 OR t.momy <> 0
                      OR tt.floats = 1 OR BIN_AND(t.flags, 1048576) <> 0
                      OR (:nightmare = 1 AND t.kind = 'monster' AND t.st = 'dead'))
              UNION ALL
              SELECT 'L', COALESCE(s.lfx_key, 0), s.id FROM sectors s
               WHERE s.lfx IN ('flash', 'strobe', 'flicker') AND s.lfx_count = 0
              UNION ALL
              SELECT 'M', COALESCE(m.think_key, 0), m.sector_id FROM movers m) q
       WHERE q.k > :lo AND q.k <= :hi AND POSITION(q.kind IN :kinds) > 0
       ORDER BY q.k, q.kind
        INTO kind, key_, id
  DO
  BEGIN
    n = n + 1;
    -- (a thing set moving earlier in the pass: in its turn, before this one; one in the list
    -- anyway takes its turn here)
    IF (RDB$GET_CONTEXT('USER_TRANSACTION', 'LATE') IS NOT NULL) THEN
    BEGIN
      IF (kind = 'T') THEN DELETE FROM late_movers lm WHERE lm.id = :id;
      EXECUTE PROCEDURE run_late(tic, key_, nightmare);
    END
    RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', key_);
    IF (kind = 'T') THEN EXECUTE PROCEDURE thing_think(id, tic, nightmare, key_);
    ELSE IF (kind = 'L') THEN EXECUTE PROCEDURE light_step(id);
    ELSE IF (EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = :id AND COALESCE(m.think_key, 0) = :key_)) THEN
      EXECUTE PROCEDURE mover_step(id);
  END
  -- (the rest of them, to the end of this round; those made this tic are in the next round's list)
  IF (RDB$GET_CONTEXT('USER_TRANSACTION', 'LATE') IS NOT NULL) THEN
  BEGIN
    EXECUTE PROCEDURE run_late(tic, hi + 1, nightmare);
    DELETE FROM late_movers;
    RDB$SET_CONTEXT('USER_TRANSACTION', 'LATE', NULL);
  END
END^

-- The whole pass, P_RunThinkers to the end of the list: the thinkers there at its start, then
-- those they made (a missile fired, a lost soul spat, a door opened), which run this same tic as
-- DOOM's do, appended to the list; and so on, a few rounds at most
CREATE OR ALTER PROCEDURE think_all (tic INTEGER, kinds VARCHAR(3))
AS
DECLARE lo BIGINT;
DECLARE hi BIGINT;
DECLARE n INTEGER;
DECLARE rounds INTEGER = 0;
BEGIN
  lo = -1;
  hi = 2 * GEN_ID(thing_seq, 0) + 1;
  WHILE (rounds < 8) DO
  BEGIN
    EXECUTE PROCEDURE run_thinkers(tic, lo, hi, kinds) RETURNING_VALUES n;
    lo = hi;
    hi = 2 * GEN_ID(thing_seq, 0) + 1;
    IF (hi = lo) THEN LEAVE;
    rounds = rounds + 1;
  END
  RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', NULL);
END^

-- The things' thinkers alone, in their order (THINK_ALL with things only): what STATES_THINK
-- always did – the movement, the falls, each state ending this tic going on to the next – for
-- the tests that run the things without the rest of the world
CREATE OR ALTER PROCEDURE states_think (tic INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE think_all(tic, 'T');
END^

-- A save from before a type moved onto the tables: its things of that type take the
-- state matching where they were (asleep: the spawn state; a corpse: the end of the
-- death; else the see state), no action called. (restoreGame)
CREATE OR ALTER PROCEDURE adopt_states
AS
DECLARE tid INTEGER;
DECLARE st VARCHAR(8);
DECLARE nst INTEGER;
DECLARE tics INTEGER;
DECLARE nxt INTEGER;
DECLARE n INTEGER;
DECLARE tic INTEGER;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  -- (a player's body never changed its ST then: dead is the player's own DEAD)
  FOR SELECT t.id, q.st, CASE WHEN q.st = 'idle' THEN tt.spawn_state
                              WHEN q.st IN ('dying', 'dead') THEN tt.death_state
                              ELSE tt.see_state END
        FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
        CROSS JOIN LATERAL (SELECT IIF(EXISTS (SELECT 1 FROM player p WHERE p.thing_id = t.id AND p.dead = 1), 'dead',
                                        IIF(t.kind = 'player', 'idle', t.st)) st FROM rdb$database) q
       WHERE tt.on_states = 1 AND t.state IS NULL
       ORDER BY t.id
        INTO tid, st, nst
  DO
  BEGIN
    SELECT s.tics, s.next_state FROM states s WHERE s.id = :nst INTO tics, nxt;
    n = 0;
    WHILE (st IN ('dying', 'dead') AND tics >= 0 AND nxt > 0 AND n < 64) DO
    BEGIN
      nst = nxt;
      SELECT s.tics, s.next_state FROM states s WHERE s.id = :nst INTO tics, nxt;
      n = n + 1;
    END
    UPDATE things t SET state = :nst, state_tic = IIF(:tics < 0, NULL, :tic + :tics),
           st = IIF(:st = 'dying', 'dead', :st), solid = IIF(:st IN ('dying', 'dead'), 0, t.solid)
     WHERE t.id = :tid;
  END
  -- saves from phase 2's first commits: a corpse whose last frame is also a decoration's spawn
  -- state was given that state's 'idle'; it lies there 'dead' (dated now, for Nightmare)
  -- (monsters only: a dead-body decoration lies in a corpse's last frame too, and stays scenery)
  UPDATE things t SET st = 'dead', dead_tic = COALESCE(t.dead_tic, :tic)
   WHERE t.state IS NOT NULL AND t.st <> 'dead' AND t.kind IN ('monster', 'keen')
     AND EXISTS (SELECT 1 FROM states s WHERE s.id = t.state AND s.mode = 'dead');
  -- saves from before the weapons were on the tables (phase 4): the weapon ready and up, or a
  -- dead player's down out of sight
  UPDATE player p
     SET psp_state = (SELECT IIF(p.dead = 1, wi.down_state, wi.ready_state) FROM weapon_info wi WHERE wi.weapon = p.weapon),
         psp_tics = 1, psp_sx = 1, psp_sy = IIF(p.dead = 1, 128, 32), flash_state = NULL, extralight = 0
   WHERE p.psp_state IS NULL;
END^

CREATE OR ALTER PROCEDURE world_tic (tic INTEGER)
AS
BEGIN
  -- P_RunThinkers: the lights' countdowns (no draws: all at once), then every thinker in the
  -- list's order – the things (their movement, falls and states; on Nightmare or with -respawn,
  -- G_InitNew's respawnmonsters, a corpse's chance to rise), the lights whose count ran out,
  -- the doors, lifts and floors moving (THINK_ALL)
  EXECUTE PROCEDURE lights_count(tic);
  EXECUTE PROCEDURE think_all(tic, 'TLM');
  IF ((SELECT g.deathmatch FROM game g WHERE g.id = 1) = 2) THEN EXECUTE PROCEDURE respawn_specials(tic);
  -- -timer: the level ends after that many minutes
  UPDATE game g SET exit_kind = 1
   WHERE g.id = 1 AND g.exit_kind = 0 AND g.time_limit > 0 AND :tic >= g.time_limit * 35 * 60;
  UPDATE player p
     SET damage_count = MAXVALUE(0, p.damage_count - 1),
         bonus_count = MAXVALUE(0, p.bonus_count - 1),
         msg_tics = MAXVALUE(0, p.msg_tics - 1),
         invis_tics = MAXVALUE(0, p.invis_tics - 1),
         invuln_tics = MAXVALUE(0, p.invuln_tics - 1),
         iron_tics = MAXVALUE(0, p.iron_tics - 1),
         infra_tics = MAXVALUE(0, p.infra_tics - 1),
         strength_tics = IIF(p.strength_tics > 0, p.strength_tics + 1, 0);
END^

-- A netgame's consistency check (every 35 tics each peer sends it to the
-- host): the random state, the tic, and where every player and monster is
-- and how it is. Peers that agree on this are playing the same game.
CREATE OR ALTER PROCEDURE net_checksum
RETURNS (csum VARCHAR(200))
AS
BEGIN
  SELECT g.tic || ':' || g.rng || ':' ||
         COALESCE((SELECT SUM(CAST(FLOOR((t.x * 3 + t.y * 7 + t.z * 11) * 16) AS BIGINT) + COALESCE(t.hp, 0) * 13)
                     FROM things t WHERE t.kind IN ('player', 'monster')), 0) || ':' ||
         COALESCE((SELECT SUM(p.health * 7 + p.bullets + p.armor * 3) FROM player p), 0)
    FROM game g WHERE g.id = 1
    INTO csum;
  SUSPEND;
END^

-- One player's game: TICS tics of player 1 with these inputs, then the HUD
-- (of VIEWCFG.PLAYER_ID, which alone is 1).
CREATE OR ALTER PROCEDURE doom_tic (
  tics INTEGER, fwd DOUBLE PRECISION, side DOUBLE PRECISION, turn DOUBLE PRECISION,
  fire SMALLINT, use_key SMALLINT, weapon_sel SMALLINT, run SMALLINT)
RETURNS (
  tic INTEGER, health INTEGER, armor INTEGER, bullets INTEGER, shells INTEGER, weapon SMALLINT,
  has_shotgun SMALLINT, has_chaingun SMALLINT, keycards INTEGER,
  rockets INTEGER, cells INTEGER, has_launcher SMALLINT, has_plasma SMALLINT, has_bfg SMALLINT,
  has_chainsaw SMALLINT, has_ssg SMALLINT,
  max_bullets INTEGER, max_shells INTEGER, max_rockets INTEGER, max_cells INTEGER,
  psp_pic VARCHAR(8), flash_pic VARCHAR(8), damage_count INTEGER, bonus_count INTEGER,
  msg VARCHAR(80), dead SMALLINT, exit_kind SMALLINT,
  kills INTEGER, total_kills INTEGER, items INTEGER, total_items INTEGER,
  secrets INTEGER, total_secrets INTEGER,
  px DOUBLE PRECISION, py DOUBLE PRECISION, pangle DOUBLE PRECISION, view_z DOUBLE PRECISION,
  sides_rev INTEGER, map_name VARCHAR(8), invis_tics INTEGER, invuln_tics INTEGER,
  iron_tics INTEGER, infra_tics INTEGER, strength_tics INTEGER, allmap SMALLINT, god SMALLINT, psp_sx DOUBLE PRECISION, psp_sy DOUBLE PRECISION, extralight SMALLINT,
  attacker_angle DOUBLE PRECISION, frags INTEGER, deathmatch SMALLINT)
AS
DECLARE i INTEGER = 0;
BEGIN
  DELETE FROM sound_events e
   WHERE e.tic < (SELECT g.tic FROM game g WHERE g.id = 1) - 70;
  WHILE (i < tics) DO
  BEGIN
    UPDATE game g SET tic = g.tic + 1 WHERE g.id = 1;
    SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
    RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', -1);   -- (P_PlayerThink, before the list)
    EXECUTE PROCEDURE player_think(1, fwd, side, turn / tics, fire, use_key, IIF(i = 0, weapon_sel, 0), run, tic);
    EXECUTE PROCEDURE world_tic(tic);
    i = i + 1;
  END
  FOR SELECT tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards, rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg, max_bullets, max_shells, max_rockets, max_cells, psp_pic, flash_pic, damage_count, bonus_count, msg, dead, exit_kind, kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z, sides_rev, map_name, invis_tics, invuln_tics, iron_tics, infra_tics, strength_tics, allmap, god, psp_sx, psp_sy, extralight, attacker_angle, frags, deathmatch FROM hud_row((SELECT vc.player_id FROM viewcfg vc WHERE vc.id = 1))
      INTO tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards, rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg, max_bullets, max_shells, max_rockets, max_cells, psp_pic, flash_pic, damage_count, bonus_count, msg, dead, exit_kind, kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z, sides_rev, map_name, invis_tics, invuln_tics, iron_tics, infra_tics, strength_tics, allmap, god, psp_sx, psp_sy, extralight, attacker_angle, frags, deathmatch
  DO SUSPEND;
END^

-- A netgame's tic (TryRunTics → G_Ticker): every player in the game, in order,
-- with their TICCMD row, then the world; the HUD of this browser's player.
-- Every peer runs it with the same commands, and the same game unfolds.
CREATE OR ALTER PROCEDURE net_tic
RETURNS (
  tic INTEGER, health INTEGER, armor INTEGER, bullets INTEGER, shells INTEGER, weapon SMALLINT,
  has_shotgun SMALLINT, has_chaingun SMALLINT, keycards INTEGER,
  rockets INTEGER, cells INTEGER, has_launcher SMALLINT, has_plasma SMALLINT, has_bfg SMALLINT,
  has_chainsaw SMALLINT, has_ssg SMALLINT,
  max_bullets INTEGER, max_shells INTEGER, max_rockets INTEGER, max_cells INTEGER,
  psp_pic VARCHAR(8), flash_pic VARCHAR(8), damage_count INTEGER, bonus_count INTEGER,
  msg VARCHAR(80), dead SMALLINT, exit_kind SMALLINT,
  kills INTEGER, total_kills INTEGER, items INTEGER, total_items INTEGER,
  secrets INTEGER, total_secrets INTEGER,
  px DOUBLE PRECISION, py DOUBLE PRECISION, pangle DOUBLE PRECISION, view_z DOUBLE PRECISION,
  sides_rev INTEGER, map_name VARCHAR(8), invis_tics INTEGER, invuln_tics INTEGER,
  iron_tics INTEGER, infra_tics INTEGER, strength_tics INTEGER, allmap SMALLINT, god SMALLINT, psp_sx DOUBLE PRECISION, psp_sy DOUBLE PRECISION, extralight SMALLINT,
  attacker_angle DOUBLE PRECISION, frags INTEGER, deathmatch SMALLINT)
AS
DECLARE pid SMALLINT;
DECLARE c_fwd DOUBLE PRECISION;
DECLARE c_side DOUBLE PRECISION;
DECLARE c_turn DOUBLE PRECISION;
DECLARE c_fire SMALLINT;
DECLARE c_use SMALLINT;
DECLARE c_weapon SMALLINT;
DECLARE c_run SMALLINT;
BEGIN
  DELETE FROM sound_events e
   WHERE e.tic < (SELECT g.tic FROM game g WHERE g.id = 1) - 70;
  UPDATE game g SET tic = g.tic + 1 WHERE g.id = 1;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', -1);   -- (P_PlayerThink, before the list)
  FOR SELECT p.id, COALESCE(c.fwd, 0), COALESCE(c.side, 0), COALESCE(c.turn, 0), COALESCE(c.fire, 0),
             COALESCE(c.use_key, 0), COALESCE(c.weapon_sel, 0), COALESCE(c.run, 0)
        FROM player p LEFT JOIN ticcmd c ON c.player_id = p.id
       ORDER BY p.id
        INTO pid, c_fwd, c_side, c_turn, c_fire, c_use, c_weapon, c_run
  DO
  BEGIN
    EXECUTE PROCEDURE player_think(pid, c_fwd, c_side, c_turn, c_fire, c_use, c_weapon, c_run, tic);
  END
  EXECUTE PROCEDURE world_tic(tic);
  FOR SELECT tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards, rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg, max_bullets, max_shells, max_rockets, max_cells, psp_pic, flash_pic, damage_count, bonus_count, msg, dead, exit_kind, kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z, sides_rev, map_name, invis_tics, invuln_tics, iron_tics, infra_tics, strength_tics, allmap, god, psp_sx, psp_sy, extralight, attacker_angle, frags, deathmatch FROM hud_row((SELECT vc.player_id FROM viewcfg vc WHERE vc.id = 1))
      INTO tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards, rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg, max_bullets, max_shells, max_rockets, max_cells, psp_pic, flash_pic, damage_count, bonus_count, msg, dead, exit_kind, kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z, sides_rev, map_name, invis_tics, invuln_tics, iron_tics, infra_tics, strength_tics, allmap, god, psp_sx, psp_sy, extralight, attacker_angle, frags, deathmatch
  DO SUSPEND;
END^

-- P_SpawnSpecials' timed doors. 10: P_SpawnDoorCloseIn30, the door (open in
-- the map) waits 30 seconds and closes for good. 14: P_SpawnDoorRaiseIn5Mins,
-- the door (closed in the map) waits five minutes, then opens to 4 below the
-- lowest ceiling around and goes on as a normal door (VDOORWAIT, then down).
-- Either way the sector's special is spent.
CREATE OR ALTER PROCEDURE spawn_door_specials (sid INTEGER = NULL)
AS
BEGIN
  INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, wait_left, stay)
  SELECT s.id, 'door', 'normal', 0, 2, s.ceil_h, s.floor_h, 150, 30 * 35, 0
    FROM sectors s
   WHERE s.special = 10 AND (s.id = :sid OR :sid IS NULL) AND NOT EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = s.id)
   ORDER BY s.id;
  INSERT INTO movers (sector_id, kind, mtype, dir, speed, top_h, bottom_h, wait_tics, wait_left, stay)
  SELECT s.id, 'door', 'raiseIn5Mins', 2, 2, COALESCE(neighbor_h(s.id, 'min_ceil'), s.ceil_h + 64) - 4, s.floor_h, 150, 5 * 60 * 35, 0
    FROM sectors s
   WHERE s.special = 14 AND (s.id = :sid OR :sid IS NULL) AND NOT EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = s.id)
   ORDER BY s.id;
  UPDATE sectors SET special = 0 WHERE special IN (10, 14) AND (id = :sid OR :sid IS NULL);
END^

-- ── level setup ───────────────────────────────────────────────────────────
-- P_SetupLevel: derive everything the hot paths need from the raw lumps,
-- then P_SpawnMapThing for the chosen skill.
CREATE OR ALTER PROCEDURE init_map (map_name VARCHAR(8), skill_bit INTEGER, new_game SMALLINT, skill SMALLINT = 3)
AS
DECLARE np SMALLINT;
DECLARE nomon SMALLINT;
DECLARE dm SMALLINT;
DECLARE i SMALLINT;
DECLARE tid INTEGER;
DECLARE sid INTEGER;
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pa DOUBLE PRECISION;
DECLARE lid INTEGER;
DECLARE lx DOUBLE PRECISION;
DECLARE ly DOUBLE PRECISION;
DECLARE ldx DOUBLE PRECISION;
DECLARE ldy DOUBLE PRECISION;
DECLARE llen DOUBLE PRECISION;
DECLARE lminx DOUBLE PRECISION;
DECLARE lmaxx DOUBLE PRECISION;
DECLARE lminy DOUBLE PRECISION;
DECLARE lmaxy DOUBLE PRECISION;
DECLARE cx INTEGER;
DECLARE cy INTEGER;
DECLARE stid INTEGER;
DECLARE sstate INTEGER;
DECLARE stics INTEGER;
DECLARE sreact INTEGER;
DECLARE son SMALLINT;
DECLARE mid INTEGER;
DECLARE mtype INTEGER;
DECLARE lastlook INTEGER;
DECLARE lsec INTEGER;
DECLARE lspec INTEGER;
DECLARE pstart INTEGER;
BEGIN
  MERGE INTO linedefs l
  USING (SELECT l2.id, a.x ax, a.y ay, b.x bx, b.y bby, fs.sector_id fsec, bs.sector_id bsec
           FROM linedefs l2
           JOIN vertexes a ON a.id = l2.v1
           JOIN vertexes b ON b.id = l2.v2
           LEFT JOIN sidedefs fs ON fs.id = l2.front_side
           LEFT JOIN sidedefs bs ON bs.id = l2.back_side) s
     ON l.id = s.id
   WHEN MATCHED THEN UPDATE SET
        x1 = s.ax, y1 = s.ay, x2 = s.bx, y2 = s.bby,
        dx = s.bx - s.ax, dy = s.bby - s.ay,
        len = SQRT((s.bx - s.ax) * (s.bx - s.ax) + (s.bby - s.ay) * (s.bby - s.ay)),
        len2 = (s.bx - s.ax) * (s.bx - s.ax) + (s.bby - s.ay) * (s.bby - s.ay),
        minx = MINVALUE(s.ax, s.bx), maxx = MAXVALUE(s.ax, s.bx),
        miny = MINVALUE(s.ay, s.bby), maxy = MAXVALUE(s.ay, s.bby),
        front_sector = s.fsec, back_sector = s.bsec,
        light_delta = CASE WHEN s.ay = s.bby THEN -16 WHEN s.ax = s.bx THEN 16 ELSE 0 END,
        -- P_LoadLineDefs: v1 and dx, dy in 16.16, and the slopetype
        fx = CAST(s.ax AS BIGINT) * 65536, fy = CAST(s.ay AS BIGINT) * 65536,
        fdx = CAST(s.bx - s.ax AS BIGINT) * 65536, fdy = CAST(s.bby - s.ay AS BIGINT) * 65536,
        slope = CASE WHEN s.bx = s.ax THEN 1 WHEN s.bby = s.ay THEN 0
                     WHEN (s.bx - s.ax) * (s.bby - s.ay) > 0 THEN 2 ELSE 3 END;

  -- BLOCKMAP: every 128×128 cell whose centre lies within half a diagonal
  -- of the line, inside the line's bounding box.
  DELETE FROM line_blocks;
  FOR SELECT id, x1, y1, dx, dy, len, minx, maxx, miny, maxy FROM linedefs
      INTO lid, lx, ly, ldx, ldy, llen, lminx, lmaxx, lminy, lmaxy
  DO
  BEGIN
    cx = FLOOR(lminx / 128);
    WHILE (cx <= FLOOR(lmaxx / 128)) DO
    BEGIN
      cy = FLOOR(lminy / 128);
      WHILE (cy <= FLOOR(lmaxy / 128)) DO
      BEGIN
        IF (llen = 0 OR ABS(ldx * (cy * 128 + 64 - ly) - ldy * (cx * 128 + 64 - lx)) / llen <= 91) THEN
          INSERT INTO line_blocks (bx, by_, line_id, cell) VALUES (:cx, :cy, :lid, :cy * 4096 + :cx);
        cy = cy + 1;
      END
      cx = cx + 1;
    END
  END

  MERGE INTO segs sg
  USING (SELECT s.id, a.x ax, a.y ay, b.x bx, b.y bby, sd.sector_id fsec, od.sector_id bsec
           FROM segs s
           JOIN vertexes a ON a.id = s.v1
           JOIN vertexes b ON b.id = s.v2
           JOIN linedefs l ON l.id = s.linedef
           LEFT JOIN sidedefs sd ON sd.id = IIF(s.side_ = 0, l.front_side, l.back_side)
           LEFT JOIN sidedefs od ON od.id = IIF(s.side_ = 0, l.back_side, l.front_side)) q
     ON sg.id = q.id
   WHEN MATCHED THEN UPDATE SET
        x1 = q.ax, y1 = q.ay, x2 = q.bx, y2 = q.bby,
        len = SQRT((q.bx - q.ax) * (q.bx - q.ax) + (q.bby - q.ay) * (q.bby - q.ay)),
        front_sector = q.fsec, back_sector = q.bsec;

  -- the sound graph for P_NoiseAlert, both directions
  DELETE FROM sound_links;
  INSERT INTO sound_links (a, b, block)
  SELECT e.a, e.b, MIN(e.block)
    FROM (SELECT front_sector a, back_sector b, IIF(BIN_AND(flags, 64) = 64, 1, 0) block
            FROM linedefs WHERE back_sector IS NOT NULL AND back_sector <> front_sector
          UNION ALL
          SELECT back_sector, front_sector, IIF(BIN_AND(flags, 64) = 64, 1, 0)
            FROM linedefs WHERE back_sector IS NOT NULL AND back_sector <> front_sector) e
   GROUP BY e.a, e.b;

  MERGE INTO ssectors ss
  USING (SELECT ss2.id, sd.sector_id
           FROM ssectors ss2
           JOIN segs sg ON sg.id = ss2.first_seg
           JOIN linedefs l ON l.id = sg.linedef
           JOIN sidedefs sd ON sd.id = IIF(sg.side_ = 0, l.front_side, l.back_side)) s
     ON ss.id = s.id
   WHEN MATCHED THEN UPDATE SET sector_id = s.sector_id;

  UPDATE nodes n SET fx = CAST(n.x AS BIGINT) * 65536, fy = CAST(n.y AS BIGINT) * 65536,
                     fdx = CAST(n.dx AS BIGINT) * 65536, fdy = CAST(n.dy AS BIGINT) * 65536;
  UPDATE game
     SET tic = 0, exit_kind = 0, noise_tic = -1000, noise_sector = NULL, map_name = :map_name, skill = :skill,
         root_node = (SELECT MAX(id) FROM nodes)
   WHERE id = 1;

  UPDATE sectors s SET sky = IIF(EXISTS (SELECT 1 FROM flats f WHERE f.id = s.ceil_flat AND f.is_sky = 1), 1, 0);
  UPDATE sectors s SET lfx = NULL, lfx_count = 0, lfx_key = NULL;

  -- the players in the game: rows 1…GAME.PLAYERS
  SELECT g.players, g.deathmatch, g.nomonsters FROM game g WHERE g.id = 1 INTO np, dm, nomon;
  DELETE FROM player p WHERE p.id > :np;
  i = 1;
  WHILE (i <= np) DO
  BEGIN
    IF (NOT EXISTS (SELECT 1 FROM player p WHERE p.id = :i)) THEN INSERT INTO player (id) VALUES (:i);
    i = i + 1;
  END
  -- things for this skill level, minus multiplayer-only ones (unless it's a netgame), each facing
  -- ANG45 × (angle / 45), P_SpawnMapThing's: a map's 15° is 0
  INSERT INTO things (id, thing_type, kind, x, y, angle, flags, hp, radius, height, solid, st,
                      spawn_x, spawn_y, spawn_angle, mthing)
  SELECT NEXT VALUE FOR thing_seq, m.ttype, tt.kind, m.x, m.y, TRUNC(m.angle / 45) * PI() / 4, m.flags,
         tt.hp, tt.radius, tt.height, tt.solid, 'idle',
         m.x, m.y, TRUNC(m.angle / 45) * PI() / 4, m.id
    FROM map_things m JOIN thing_types tt ON tt.thing_type = m.ttype
   WHERE (BIN_AND(m.flags, 16) = 0 OR :np > 1) AND BIN_AND(m.flags, :skill_bit) <> 0 AND tt.kind <> 'player'
     AND NOT (:dm > 0 AND tt.pickup = 'key')            -- (MF_NOTDMATCH: no keys in deathmatch)
     AND NOT (:nomon = 1 AND (tt.count_kill = 1 OR m.ttype = 3006))   -- (-nomonsters: P_SpawnMapThing skips MF_COUNTKILL and the lost soul)
   ORDER BY m.id;                                       -- (the same ids on every load)
  -- P_LoadThings, in the map's order: each thing's P_SpawnMobj draws (lastlook), then
  -- P_SpawnMapThing starts it partway into its spawn state (1 + P_Random() % tics); a player's
  -- start draws for its P_SpawnMobj where it lies among them (not in deathmatch: those come
  -- after). P_SpawnMobj gives each mobjinfo's reaction time (8; on Nightmare none).
  FOR SELECT m.id, m.ttype, t.id, tt.spawn_state, s.tics, tt.reaction_time, tt.on_states
        FROM map_things m
        LEFT JOIN things t ON t.mthing = m.id
        LEFT JOIN thing_types tt ON tt.thing_type = t.thing_type
        LEFT JOIN states s ON s.id = tt.spawn_state
       ORDER BY m.id
        INTO mid, mtype, stid, sstate, stics, sreact, son
  DO
  BEGIN
    IF (stid IS NULL) THEN
    BEGIN
      IF (mtype BETWEEN 1 AND 4 AND mtype <= np AND dm = 0) THEN lastlook = p_rand256();
      CONTINUE;
    END
    lastlook = MOD(p_rand256(), 4);
    UPDATE things t SET lastlook = :lastlook WHERE t.id = :stid;
    IF (son = 1) THEN
      UPDATE things t SET state = :sstate, reaction = IIF(:skill = 5, 0, :sreact),
             state_tic = IIF(:stics < 0, NULL, (SELECT g.tic FROM game g WHERE g.id = 1) + IIF(:stics > 0, 1 + MOD(p_rand256(), :stics), 0))
       WHERE t.id = :stid;
  END
  DELETE FROM respawn_queue;
  -- G_DoLoadLevel: the frags start over with the level
  DELETE FROM frags;
  i = 1;
  WHILE (i <= np) DO
  BEGIN
    INSERT INTO frags (killer, victim, n) SELECT :i, p.id, 0 FROM player p WHERE p.id <= :np;
    i = i + 1;
  END

  -- P_SpawnPlayer: each player at their own start (types 1–4); without one,
  -- beside player 1's. In deathmatch, each at a deathmatch start, at random.
  i = 1;
  WHILE (i <= np) DO
  BEGIN
    px = NULL;
    pstart = NULL;
    IF (dm > 0) THEN SELECT d.sx, d.sy, d.sa FROM deathmatch_spot(:i, NULL) d INTO px, py, pa;
    -- (P_SpawnMapThing spawns a player at every start of its number: the last is where it plays)
    ELSE SELECT FIRST 1 m.x, m.y, TRUNC(m.angle / 45) * PI() / 4, m.id FROM map_things m WHERE m.ttype = :i ORDER BY m.id DESC
      INTO px, py, pa, pstart;
    IF (px IS NULL) THEN
    BEGIN
      SELECT FIRST 1 x, y, angle * PI() / 180 FROM map_things WHERE ttype = 1 INTO px, py, pa;
      px = px + 40 * (i - 1) * COS(pa + PI() / 2);
      py = py + 40 * (i - 1) * SIN(pa + PI() / 2);
    END
    -- (in deathmatch, G_DeathMatchSpawnPlayer's P_SpawnPlayer: its P_SpawnMobj's draw)
    IF (dm > 0) THEN lastlook = p_rand256();
    tid = NEXT VALUE FOR thing_seq;
    INSERT INTO things (id, thing_type, kind, x, y, angle, hp, radius, height, solid, st, translation, state, reaction)
    VALUES (:tid, 1, 'player', :px, :py, :pa, 100, 16, 56, 1, 'idle', :i - 1,
            (SELECT tt.spawn_state FROM thing_types tt WHERE tt.thing_type = 1),
            (SELECT IIF(:skill = 5, 0, tt.reaction_time) FROM thing_types tt WHERE tt.thing_type = 1));
    UPDATE player SET thing_id = :tid WHERE id = :i;
    -- its place in the thinkers' list: among the map's things, where its start is (P_LoadThings'
    -- order); in deathmatch, after them all (G_DeathMatchSpawnPlayer), as its id says
    IF (pstart IS NOT NULL) THEN
      UPDATE things t SET think_key = 2 * COALESCE((SELECT MAX(o.id) FROM things o WHERE o.mthing < :pstart), 0) + 1
       WHERE t.id = :tid;
    i = i + 1;
  END

  -- P_SpawnSpecials: the sectors' thinkers, in sector order, after the things in the list (their
  -- draws come after the things'): the lights, and the doors of specials 10 and 14
  FOR SELECT s.id, s.special FROM sectors s WHERE s.special IN (1, 2, 3, 4, 8, 10, 12, 13, 14, 17) ORDER BY s.id
      INTO lsec, lspec
  DO
    IF (lspec IN (10, 14)) THEN EXECUTE PROCEDURE spawn_door_specials(lsec);
    ELSE EXECUTE PROCEDURE spawn_light(lsec, lspec);

  -- Every thing's sector in one set-based pass: a recursive CTE walks the BSP
  -- tree for all of them at once (R_PointOnSide in 16.16, as P_SetThingPosition finds it).
  FOR WITH RECURSIVE walk (tid, px, py, node) AS (
        SELECT t.id, t.x, t.y, g.root_node FROM things t CROSS JOIN game g WHERE g.id = 1
        UNION ALL
        SELECT w.tid, w.px, w.py,
               IIF(point_on_node_side(fx_of(w.px), fx_of(w.py), CAST(n.x AS BIGINT) * 65536, CAST(n.y AS BIGINT) * 65536,
                                      CAST(n.dx AS BIGINT) * 65536, CAST(n.dy AS BIGINT) * 65536) = 0, n.right_child, n.left_child)
          FROM walk w JOIN nodes n ON n.id = w.node
      )
      SELECT w.tid, ss.sector_id FROM walk w JOIN ssectors ss ON ss.id = w.node - 32768
       WHERE w.node >= 32768
      INTO tid, sid
  DO
    UPDATE things SET sector_id = :sid WHERE id = :tid;
  UPDATE things t
     SET z = (SELECT IIF(tt.hang = 1, s.ceil_h - tt.height, s.floor_h)
                FROM sectors s, thing_types tt
               WHERE s.id = t.sector_id AND tt.thing_type = t.thing_type);
  -- P_SpawnMobj: a thing's floorz and ceilingz are its subsector's to start with
  UPDATE things t
     SET floorz = (SELECT s.floor_h FROM sectors s WHERE s.id = t.sector_id),
         ceilz = (SELECT s.ceil_h FROM sectors s WHERE s.id = t.sector_id), fz_x = t.x, fz_y = t.y;
  -- P_GroupLines: each sector's box of blocks, MAXRADIUS wider, for P_ChangeSector
  UPDATE sectors s
     SET bb_xl = (SELECT MAXVALUE(BIN_SHR(CAST(MIN(l.minx) AS BIGINT) * 65536 - CAST(b.org_x AS BIGINT) * 65536 - 2097152, 23), 0)
                    FROM linedefs l, blockmap_info b WHERE b.id = 1 AND (l.front_sector = s.id OR l.back_sector = s.id) GROUP BY b.org_x),
         bb_xh = (SELECT MINVALUE(BIN_SHR(CAST(MAX(l.maxx) AS BIGINT) * 65536 - CAST(b.org_x AS BIGINT) * 65536 + 2097152, 23), MIN(b.w) - 1)
                    FROM linedefs l, blockmap_info b WHERE b.id = 1 AND (l.front_sector = s.id OR l.back_sector = s.id) GROUP BY b.org_x),
         bb_yl = (SELECT MAXVALUE(BIN_SHR(CAST(MIN(l.miny) AS BIGINT) * 65536 - CAST(b.org_y AS BIGINT) * 65536 - 2097152, 23), 0)
                    FROM linedefs l, blockmap_info b WHERE b.id = 1 AND (l.front_sector = s.id OR l.back_sector = s.id) GROUP BY b.org_y),
         bb_yh = (SELECT MINVALUE(BIN_SHR(CAST(MAX(l.maxy) AS BIGINT) * 65536 - CAST(b.org_y AS BIGINT) * 65536 + 2097152, 23), MIN(b.h) - 1)
                    FROM linedefs l, blockmap_info b WHERE b.id = 1 AND (l.front_sector = s.id OR l.back_sector = s.id) GROUP BY b.org_y);

  UPDATE game g
     SET total_kills = (SELECT COUNT(*) FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                         WHERE tt.count_kill = 1),
         total_items = (SELECT COUNT(*) FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
                         WHERE tt.count_item = 1),
         total_secrets = (SELECT COUNT(*) FROM sectors WHERE special = 9),
         sides_rev = 0          -- (the switches' textures start over with the map)
   WHERE id = 1;

  UPDATE player SET pending_weapon = 0, refire = 0, attacker_id = NULL;
  IF (new_game = 1) THEN
    UPDATE player
       SET health = (SELECT r.init_health FROM rules r WHERE r.id = 1), armor = 0, armor_type = 0, bullets = (SELECT r.init_bullets FROM rules r WHERE r.id = 1), shells = 0,
           max_bullets = (SELECT r.max_bullets FROM rules r WHERE r.id = 1), max_shells = (SELECT r.max_shells FROM rules r WHERE r.id = 1),
           weapon = 2, has_shotgun = 0, has_chaingun = 0, has_launcher = 0, has_plasma = 0, has_bfg = 0,
           has_chainsaw = 0, has_ssg = 0,
           rockets = 0, cells = 0, max_rockets = (SELECT r.max_rockets FROM rules r WHERE r.id = 1), max_cells = (SELECT r.max_cells FROM rules r WHERE r.id = 1), god = 0, noclip = 0;
  UPDATE player
     SET keycards = IIF(:dm > 0, 7, 0), kills = 0, items = 0, secrets = 0, dead = 0,
         damage_count = 0, bonus_count = 0, view_h = 41, delta_vh = 0, use_down = 0, invis_tics = 0, invuln_tics = 0, iron_tics = 0, infra_tics = 0, strength_tics = 0, allmap = 0,
         msg = :map_name, msg_tics = 105;
  UPDATE player p SET view_z = (SELECT z FROM things t WHERE t.id = p.thing_id) + 41;
  -- P_SpawnPlayer's P_SetupPsprites: every level starts with the weapon coming up
  FOR SELECT p.id FROM player p ORDER BY p.id INTO i
  DO
    EXECUTE PROCEDURE setup_psprites(i, 0);
END^

SET TERM ; ^
