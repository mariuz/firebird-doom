-- render.sql – DOOM's renderer inside Firebird.
--
-- FRAME_WALLS replaces r_bsp.c / r_segs.c / r_plane.c. DOOM walks the BSP
-- front to back and keeps mutable ceilingclip[]/floorclip[] arrays. Here:
--
--   RENDER_SLICES (PSQL generator)
--     1. transforms every linedef into view space (forward f, right r),
--     2. picks the side facing the viewer and clips to the near plane,
--     3. projects it to a range of screen columns, and
--     4. for each column intersects the column's ray with the line, giving
--        an exact depth and the screen y of every floor/ceiling edge.
--
--   RENDER_WALLS / FRAME_WALLS
--     5. sorts each column front to back and carries the clip window down
--        it: a slice is visible only while the opening left by everything
--        in front is still open. FRAME_WALLS_WINDOWED says the same thing
--        with MAX/MIN OVER (PARTITION BY col ORDER BY depth ...).
--
-- Each output row is a visible wall slice: column, depth, texture column u,
-- the linedef and which side we see, and the clip window it was drawn into.
-- The browser turns that into textured ceiling/upper/middle/lower/floor
-- spans using the sector heights of the same frame (FRAME_SECTORS). Rows
-- are kept narrow on purpose: the window sort dominates, and its cost
-- grows with row width.
--
-- FRAME_SPRITES replaces r_things.c: project things, choose the rotation
-- frame from the view angle, and size the sprite from its patch offsets.
--
-- Why PSQL for steps 1–4 rather than one big CTE? Firebird inlines derived
-- tables, so every reference to a computed column re-evaluates its whole
-- expression tree; a 5-deep CTE chain of projections costs seconds. A
-- generator procedure computes each value once into a variable.

SET TERM ^ ;

CREATE OR ALTER PROCEDURE render_slices
RETURNS (
  col INTEGER, depth DOUBLE PRECISION, u DOUBLE PRECISION, line_id INTEGER, back_view SMALLINT,
  open_top DOUBLE PRECISION, open_bot DOUBLE PRECISION)
AS
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE ca DOUBLE PRECISION;
DECLARE sa DOUBLE PRECISION;
DECLARE w DOUBLE PRECISION;
DECLARE h DOUBLE PRECISION;
DECLARE hw DOUBLE PRECISION;
DECLARE hh DOUBLE PRECISION;
DECLARE proj DOUBLE PRECISION;
DECLARE projy DOUBLE PRECISION;
DECLARE nz DOUBLE PRECISION;
DECLARE lx1 DOUBLE PRECISION;
DECLARE ly1 DOUBLE PRECISION;
DECLARE lx2 DOUBLE PRECISION;
DECLARE ly2 DOUBLE PRECISION;
DECLARE ldx DOUBLE PRECISION;
DECLARE ldy DOUBLE PRECISION;
DECLARE llen DOUBLE PRECISION;
DECLARE lfs INTEGER;
DECLARE lbs INTEGER;
DECLARE fsec INTEGER;
DECLARE bsec INTEGER;
DECLARE f1 DOUBLE PRECISION;
DECLARE r1 DOUBLE PRECISION;
DECLARE f2 DOUBLE PRECISION;
DECLARE r2 DOUBLE PRECISION;
DECLARE dfr DOUBLE PRECISION;
DECLARE drr DOUBLE PRECISION;
DECLARE ta DOUBLE PRECISION;
DECLARE tb DOUBLE PRECISION;
DECLARE sxa DOUBLE PRECISION;
DECLARE sxb DOUBLE PRECISION;
DECLARE xl INTEGER;
DECLARE xr INTEGER;
DECLARE ff DOUBLE PRECISION;
DECLARE fc DOUBLE PRECISION;
DECLARE bf DOUBLE PRECISION;
DECLARE bc DOUBLE PRECISION;
DECLARE fsky SMALLINT;
DECLARE bsky SMALLINT;
DECLARE closed SMALLINT;
DECLARE k DOUBLE PRECISION;
DECLARE den DOUBLE PRECISION;
DECLARE t DOUBLE PRECISION;
DECLARE s DOUBLE PRECISION;
BEGIN
  SELECT th.x, th.y, p.view_z, COS(th.angle), SIN(th.angle), c.w, c.h, c.proj, c.projy, c.near_z
    FROM player p
    JOIN things th ON th.id = p.thing_id
   CROSS JOIN viewcfg c
   WHERE p.id = 1 AND c.id = 1
    INTO px, py, pz, ca, sa, w, h, proj, projy, nz;
  hw = w / 2;
  hh = h / 2;

  FOR SELECT l.id, l.x1, l.y1, l.x2, l.y2, l.dx, l.dy, l.len, l.front_sector, l.back_sector
        FROM linedefs l
        INTO line_id, lx1, ly1, lx2, ly2, ldx, ldy, llen, lfs, lbs
  DO
  BEGIN
    -- 1. view space
    f1 = (lx1 - px) * ca + (ly1 - py) * sa;
    f2 = (lx2 - px) * ca + (ly2 - py) * sa;
    IF (f1 < nz AND f2 < nz) THEN CONTINUE;          -- entirely behind us

    -- 2. which side faces us; one-sided lines seen from behind are culled
    IF (ldx * (py - ly1) - ldy * (px - lx1) < 0) THEN
    BEGIN
      back_view = 0;
      fsec = lfs;
      bsec = lbs;
    END
    ELSE
    BEGIN
      IF (lbs IS NULL) THEN CONTINUE;
      back_view = 1;
      fsec = lbs;
      bsec = lfs;
    END

    r1 = (lx1 - px) * sa - (ly1 - py) * ca;
    r2 = (lx2 - px) * sa - (ly2 - py) * ca;
    dfr = f2 - f1;
    drr = r2 - r1;
    ta = 0;
    tb = 1;
    IF (f1 < nz) THEN ta = (nz - f1) / dfr;
    IF (f2 < nz) THEN tb = (nz - f1) / dfr;

    -- 3. screen columns covered
    sxa = hw + (r1 + ta * drr) * proj / (f1 + ta * dfr);
    sxb = hw + (r1 + tb * drr) * proj / (f1 + tb * dfr);
    xl = MAXVALUE(0, CEILING(MINVALUE(sxa, sxb) - 0.5e0));
    xr = MINVALUE(w - 1, FLOOR(MAXVALUE(sxa, sxb) - 0.5e0));
    IF (xl > xr) THEN CONTINUE;

    -- is the opening through this line closed (one-sided, or a shut door)?
    SELECT se.floor_h, se.ceil_h, se.sky FROM sectors se WHERE se.id = :fsec INTO ff, fc, fsky;
    closed = 1;
    IF (bsec IS NOT NULL) THEN
    BEGIN
      SELECT se.floor_h, se.ceil_h, se.sky FROM sectors se WHERE se.id = :bsec INTO bf, bc, bsky;
      IF (fsky = 1 AND bsky = 1) THEN bc = fc;      -- the sky hack
      closed = IIF(bc <= bf OR bc <= ff OR bf >= fc, 1, 0);
    END

    -- 4. one slice per column
    col = xl;
    WHILE (col <= xr) DO
    BEGIN
      k = (col + 0.5e0 - hw) / proj;
      den = drr - k * dfr;
      IF (den <> 0) THEN
      BEGIN
        t = MINVALUE(1e0, MAXVALUE(0e0, (k * f1 - r1) / den));
        depth = MAXVALUE(nz, f1 + t * dfr);
        u = IIF(back_view = 0, t, 1 - t) * llen;
        IF (closed = 1) THEN
        BEGIN
          open_top = h;
          open_bot = 0;
        END
        ELSE
        BEGIN
          s = projy / depth;
          open_top = hh - (MINVALUE(fc, bc) - pz) * s;
          open_bot = hh - (MAXVALUE(ff, bf) - pz) * s;
        END
        SUSPEND;
      END
      col = col + 1;
    END
  END
END^

CREATE OR ALTER PROCEDURE render_sprites
RETURNS (id INTEGER, depth DOUBLE PRECISION, lump INTEGER, flip SMALLINT,
         x1 DOUBLE PRECISION, x2 DOUBLE PRECISION, y1 DOUBLE PRECISION, y2 DOUBLE PRECISION,
         light INTEGER)
AS
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE pa DOUBLE PRECISION;
DECLARE ca DOUBLE PRECISION;
DECLARE sa DOUBLE PRECISION;
DECLARE w DOUBLE PRECISION;
DECLARE h DOUBLE PRECISION;
DECLARE proj DOUBLE PRECISION;
DECLARE projy DOUBLE PRECISION;
DECLARE nz DOUBLE PRECISION;
DECLARE tic INTEGER;
DECLARE tx DOUBLE PRECISION;
DECLARE ty DOUBLE PRECISION;
DECLARE tz DOUBLE PRECISION;
DECLARE tang DOUBLE PRECISION;
DECLARE kind VARCHAR(10);
DECLARE fr CHAR(1);
DECLARE spr CHAR(4);
DECLARE sec INTEGER;
DECLARE walk_fr VARCHAR(16);
DECLARE bright SMALLINT;
DECLARE r DOUBLE PRECISION;
DECLARE rot INTEGER;
DECLARE sw DOUBLE PRECISION;
DECLARE sh DOUBLE PRECISION;
DECLARE leftoff DOUBLE PRECISION;
DECLARE topoff DOUBLE PRECISION;
DECLARE scale DOUBLE PRECISION;
BEGIN
  SELECT th.x, th.y, p.view_z, th.angle, c.w, c.h, c.proj, c.projy, c.near_z, g.tic
    FROM player p
    JOIN things th ON th.id = p.thing_id
   CROSS JOIN viewcfg c
   CROSS JOIN game g
   WHERE p.id = 1 AND c.id = 1 AND g.id = 1
    INTO px, py, pz, pa, w, h, proj, projy, nz, tic;
  ca = COS(pa);
  sa = SIN(pa);

  FOR SELECT th.id, th.x, th.y, th.z, th.angle, th.kind, th.frame, COALESCE(th.sprite, tt.sprite),
             th.sector_id, tt.walk_fr, tt.bright
        FROM things th
        LEFT JOIN thing_types tt ON tt.thing_type = th.thing_type
       WHERE th.kind NOT IN ('player', 'marker')
        INTO id, tx, ty, tz, tang, kind, fr, spr, sec, walk_fr, bright
  DO
  BEGIN
    depth = (tx - px) * ca + (ty - py) * sa;
    IF (depth <= nz * 2) THEN CONTINUE;
    r = (tx - px) * sa - (ty - py) * ca;
    IF (ABS(r) > depth * (w / 2) / proj + 128) THEN CONTINUE;   -- well outside the view

    IF (fr IS NULL) THEN
      fr = SUBSTRING(walk_fr FROM 1 + MOD(tic / 6 + id, CHAR_LENGTH(walk_fr)) FOR 1);
    -- R_ProjectSprite: rotation 1..8 from the angle between viewer and thing
    rot = 1 + MOD(CAST(FLOOR((ATAN2(ty - py, tx - px) - tang + PI() * 9 / 8) / (PI() / 4)) AS INTEGER) + 64, 8);
    lump = NULL;
    SELECT FIRST 1 sf.lump, sf.flip, sf.w, sf.h, sf.leftoff, sf.topoff
      FROM sprite_frames sf
     WHERE sf.sprite = :spr AND sf.frame = :fr AND sf.rot IN (0, :rot)
      INTO lump, flip, sw, sh, leftoff, topoff;
    IF (lump IS NULL) THEN CONTINUE;

    scale = proj / depth;
    x1 = w / 2 + r * scale - IIF(flip = 1, sw - leftoff, leftoff) * scale;
    x2 = x1 + sw * scale;
    IF (x2 < 0 OR x1 >= w) THEN CONTINUE;
    scale = projy / depth;
    y1 = h / 2 - (tz + topoff - pz) * scale;
    y2 = y1 + sh * scale;
    IF (bright = 1 OR kind IN ('fx', 'missile')) THEN
      light = 255;
    ELSE
      SELECT COALESCE(MAX(se.light), 160) FROM sectors se WHERE se.id = :sec INTO light;
    SUSPEND;
  END
END^

SET TERM ; ^

SET TERM ^ ;

-- 5. ceilingclip[] / floorclip[]: walk each column front to back (the ORDER BY
-- is the BSP's job in DOOM) carrying the open window; emit a slice only while
-- the window is still open, and stop caring about a column once it closes.
CREATE OR ALTER PROCEDURE render_walls
RETURNS (
  col INTEGER, depth DOUBLE PRECISION, u DOUBLE PRECISION, line_id INTEGER, back_view SMALLINT,
  open_top DOUBLE PRECISION, open_bot DOUBLE PRECISION,
  clip_top DOUBLE PRECISION, clip_bot DOUBLE PRECISION)
AS
DECLARE last_col INTEGER = -1;
BEGIN
  FOR SELECT col, depth, u, line_id, back_view, open_top, open_bot
        FROM render_slices
       ORDER BY col, depth
        INTO col, depth, u, line_id, back_view, open_top, open_bot
  DO
  BEGIN
    IF (col <> last_col) THEN
    BEGIN
      last_col = col;
      clip_top = 0;
      clip_bot = 1e9;
    END
    IF (clip_top < clip_bot) THEN
    BEGIN
      SUSPEND;
      clip_top = MAXVALUE(clip_top, open_top);
      clip_bot = MINVALUE(clip_bot, open_bot);
    END
  END
END^

SET TERM ; ^

CREATE OR ALTER VIEW frame_walls AS
SELECT * FROM render_walls;

-- The same clipping, stated declaratively: running MAX/MIN window aggregates
-- over everything in front. Equivalent to FRAME_WALLS (the smoke test checks)
-- but about twice as slow in Firebird, so the game uses the procedure.
CREATE OR ALTER VIEW frame_walls_windowed AS
SELECT *
  FROM (SELECT s.*,
               COALESCE(MAX(s.open_top) OVER (PARTITION BY s.col ORDER BY s.depth
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0e0) clip_top,
               COALESCE(MIN(s.open_bot) OVER (PARTITION BY s.col ORDER BY s.depth
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 1e9) clip_bot
          FROM render_slices s) q
 WHERE q.clip_top < q.clip_bot;

CREATE OR ALTER VIEW frame_sprites AS
SELECT * FROM render_sprites;

-- Live sector state the browser needs to texture the slices above.
CREATE OR ALTER VIEW frame_sectors AS
SELECT id, floor_h, ceil_h, floor_flat, ceil_flat, light, sky FROM sectors;
