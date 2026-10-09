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
--   RENDER_SLICES_BSP (PSQL generator, the default)
--     the same per-column math, but driven by a front-to-back BSP walk with
--     DOOM's solidsegs occlusion, so hidden walls are never projected.
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
  open_top DOUBLE PRECISION, open_bot DOUBLE PRECISION,
  fsec INTEGER, ff DOUBLE PRECISION, fc DOUBLE PRECISION)
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
   WHERE p.id = c.player_id AND c.id = 1
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

-- R_RenderBSPNode + R_AddLine + R_ClipSolidWallSegment.
--
-- Walks the BSP from the root, nearer child first, so segs come out front to
-- back. DOOM's solidsegs list becomes COV, a string with one character per
-- screen column: '1' once a solid wall covers that column. A seg whose
-- columns are all covered is skipped, a child whose bounding box projects
-- onto covered columns only is never descended into (R_CheckBBox), and the
-- walk stops as soon as the screen is full. PSQL has no arrays, so the
-- traversal stack is a string too: entries of 7 characters, 'N' + node to
-- visit, or 'C' + node + side for "check that child's bounding box first".
CREATE OR ALTER PROCEDURE render_slices_bsp
RETURNS (
  col INTEGER, depth DOUBLE PRECISION, u DOUBLE PRECISION, line_id INTEGER, back_view SMALLINT,
  open_top DOUBLE PRECISION, open_bot DOUBLE PRECISION,
  fsec INTEGER, ff DOUBLE PRECISION, fc DOUBLE PRECISION)
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
DECLARE fov DOUBLE PRECISION;
DECLARE cov VARCHAR(1280);
DECLARE stk VARCHAR(8000);
DECLARE entry VARCHAR(7);
DECLARE n INTEGER;
DECLARE side_ SMALLINT;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE ndx DOUBLE PRECISION;
DECLARE ndy DOUBLE PRECISION;
DECLARE rc INTEGER;
DECLARE lc INTEGER;
DECLARE bt DOUBLE PRECISION;
DECLARE bb DOUBLE PRECISION;
DECLARE bl DOUBLE PRECISION;
DECLARE br DOUBLE PRECISION;
DECLARE fcen DOUBLE PRECISION;
DECLARE rcen DOUBLE PRECISION;
DECLARE ac DOUBLE PRECISION;
DECLARE ai DOUBLE PRECISION;
DECLARE amin DOUBLE PRECISION;
DECLARE amax DOUBLE PRECISION;
DECLARE corner INTEGER;
DECLARE cxp DOUBLE PRECISION;
DECLARE cyp DOUBLE PRECISION;
DECLARE visible SMALLINT;
DECLARE first_seg INTEGER;
DECLARE seg_count INTEGER;
DECLARE sx1 DOUBLE PRECISION;
DECLARE sy1 DOUBLE PRECISION;
DECLARE sx2 DOUBLE PRECISION;
DECLARE sy2 DOUBLE PRECISION;
DECLARE slen DOUBLE PRECISION;
DECLARE sxoff DOUBLE PRECISION;
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
   WHERE p.id = c.player_id AND c.id = 1
    INTO px, py, pz, ca, sa, w, h, proj, projy, nz;
  hw = w / 2;
  hh = h / 2;
  fov = ATAN(hw / proj) + 0.02e0;
  cov = RPAD('', CAST(w AS INTEGER), '0');
  SELECT g.root_node FROM game g WHERE g.id = 1 INTO n;
  IF (n IS NULL) THEN n = 32768;
  stk = 'N' || LPAD(n, 5, '0') || '0';

  WHILE (CHAR_LENGTH(stk) > 0 AND POSITION('0' IN cov) > 0) DO
  BEGIN
    -- pop
    entry = SUBSTRING(stk FROM CHAR_LENGTH(stk) - 6 FOR 7);
    stk = SUBSTRING(stk FROM 1 FOR CHAR_LENGTH(stk) - 7);
    n = CAST(SUBSTRING(entry FROM 2 FOR 5) AS INTEGER);

    IF (entry STARTING WITH 'C') THEN
    BEGIN
      -- R_CheckBBox: can the far child's box still reach an uncovered column?
      side_ = CAST(SUBSTRING(entry FROM 7 FOR 1) AS SMALLINT);
      SELECT IIF(:side_ = 0, nd.r_top, nd.l_top), IIF(:side_ = 0, nd.r_bot, nd.l_bot),
             IIF(:side_ = 0, nd.r_left, nd.l_left), IIF(:side_ = 0, nd.r_right, nd.l_right),
             IIF(:side_ = 0, nd.right_child, nd.left_child)
        FROM nodes nd WHERE nd.id = :n
        INTO bt, bb, bl, br, n;
      IF (px >= bl AND px <= br AND py >= bb AND py <= bt) THEN
        visible = 1;                                   -- we are inside the box
      ELSE
      BEGIN
        -- angular extent of the four corners, measured around the box centre
        -- (the box does not contain us, so the extent is under 180°)
        fcen = ((bl + br) / 2 - px) * ca + ((bb + bt) / 2 - py) * sa;
        rcen = ((bl + br) / 2 - px) * sa - ((bb + bt) / 2 - py) * ca;
        ac = ATAN2(rcen, fcen);
        amin = 1e9;
        amax = -1e9;
        corner = 0;
        WHILE (corner < 4) DO
        BEGIN
          cxp = IIF(BIN_AND(corner, 1) = 0, bl, br) - px;
          cyp = IIF(corner < 2, bt, bb) - py;
          ai = ATAN2(cxp * sa - cyp * ca, cxp * ca + cyp * sa) - ac;
          IF (ai > PI()) THEN ai = ai - 2 * PI();
          IF (ai < -PI()) THEN ai = ai + 2 * PI();
          amin = MINVALUE(amin, ai);
          amax = MAXVALUE(amax, ai);
          corner = corner + 1;
        END
        amin = ac + amin;
        amax = ac + amax;
        -- the span is under 180° but may sit a full turn away: bring it round
        IF (amax < -fov) THEN
        BEGIN
          amin = amin + 2 * PI();
          amax = amax + 2 * PI();
        END
        ELSE IF (amin > fov) THEN
        BEGIN
          amin = amin - 2 * PI();
          amax = amax - 2 * PI();
        END
        visible = 0;
        IF (amax >= -fov AND amin <= fov) THEN
        BEGIN
          xl = MAXVALUE(0, FLOOR(hw + TAN(MAXVALUE(amin, -fov + 0.02e0)) * proj) - 1);
          xr = MINVALUE(w - 1, CEILING(hw + TAN(MINVALUE(amax, fov - 0.02e0)) * proj) + 1);
          IF (xl <= xr AND POSITION('0' IN SUBSTRING(cov FROM xl + 1 FOR xr - xl + 1)) > 0) THEN
            visible = 1;
        END
      END
      IF (visible = 0) THEN CONTINUE;
    END

    IF (n < 32768) THEN
    BEGIN
      -- a node: push "check the far side" first, so the near side pops first
      SELECT nd.x, nd.y, nd.dx, nd.dy, nd.right_child, nd.left_child FROM nodes nd WHERE nd.id = :n
        INTO nx, ny, ndx, ndy, rc, lc;
      side_ = IIF((py - ny) * ndx < ndy * (px - nx), 0, 1);
      stk = stk || 'C' || LPAD(n, 5, '0') || (1 - side_)
                || 'N' || LPAD(IIF(side_ = 0, rc, lc), 5, '0') || '0';
      CONTINUE;
    END

    -- a subsector: R_AddLine for each of its segs
    SELECT ss.first_seg, ss.seg_count FROM ssectors ss WHERE ss.id = :n - 32768 INTO first_seg, seg_count;
    FOR SELECT sg.linedef, sg.side_, sg.x1, sg.y1, sg.x2, sg.y2, sg.len, sg.xoff, sg.front_sector, sg.back_sector
          FROM segs sg
         WHERE sg.id BETWEEN :first_seg AND :first_seg + :seg_count - 1
          INTO line_id, back_view, sx1, sy1, sx2, sy2, slen, sxoff, fsec, bsec
    DO
    BEGIN
      -- back faces: a seg is only seen from its right-hand side
      IF ((sx2 - sx1) * (py - sy1) - (sy2 - sy1) * (px - sx1) >= 0) THEN CONTINUE;
      f1 = (sx1 - px) * ca + (sy1 - py) * sa;
      f2 = (sx2 - px) * ca + (sy2 - py) * sa;
      IF (f1 < nz AND f2 < nz) THEN CONTINUE;
      r1 = (sx1 - px) * sa - (sy1 - py) * ca;
      r2 = (sx2 - px) * sa - (sy2 - py) * ca;
      dfr = f2 - f1;
      drr = r2 - r1;
      ta = 0;
      tb = 1;
      IF (f1 < nz) THEN ta = (nz - f1) / dfr;
      IF (f2 < nz) THEN tb = (nz - f1) / dfr;
      sxa = hw + (r1 + ta * drr) * proj / (f1 + ta * dfr);
      sxb = hw + (r1 + tb * drr) * proj / (f1 + tb * dfr);
      xl = MAXVALUE(0, CEILING(MINVALUE(sxa, sxb) - 0.5e0));
      xr = MINVALUE(w - 1, FLOOR(MAXVALUE(sxa, sxb) - 0.5e0));
      IF (xl > xr) THEN CONTINUE;
      -- entirely behind solid walls already drawn?
      IF (POSITION('0' IN SUBSTRING(cov FROM xl + 1 FOR xr - xl + 1)) = 0) THEN CONTINUE;

      SELECT se.floor_h, se.ceil_h, se.sky FROM sectors se WHERE se.id = :fsec INTO ff, fc, fsky;
      closed = 1;
      IF (bsec IS NOT NULL) THEN
      BEGIN
        SELECT se.floor_h, se.ceil_h, se.sky FROM sectors se WHERE se.id = :bsec INTO bf, bc, bsky;
        IF (fsky = 1 AND bsky = 1) THEN bc = fc;
        closed = IIF(bc <= bf OR bc <= ff OR bf >= fc, 1, 0);
      END

      col = xl;
      WHILE (col <= xr) DO
      BEGIN
        IF (SUBSTRING(cov FROM col + 1 FOR 1) = '0') THEN
        BEGIN
          k = (col + 0.5e0 - hw) / proj;
          den = drr - k * dfr;
          IF (den <> 0) THEN
          BEGIN
            t = MINVALUE(1e0, MAXVALUE(0e0, (k * f1 - r1) / den));
            depth = MAXVALUE(nz, f1 + t * dfr);
            u = sxoff + t * slen;
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
        END
        col = col + 1;
      END

      -- R_ClipSolidWallSegment: these columns are hidden for good now
      IF (closed = 1) THEN
        cov = SUBSTRING(cov FROM 1 FOR xl) || RPAD('', xr - xl + 1, '1') || SUBSTRING(cov FROM xr + 2);
    END
  END
END^

CREATE OR ALTER PROCEDURE render_sprites
RETURNS (id INTEGER, depth DOUBLE PRECISION, lump INTEGER, flip SMALLINT,
         x1 DOUBLE PRECISION, x2 DOUBLE PRECISION, y1 DOUBLE PRECISION, y2 DOUBLE PRECISION,
         light INTEGER, fuzz SMALLINT)
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
DECLARE me INTEGER;
BEGIN
  SELECT th.x, th.y, p.view_z, th.angle, c.w, c.h, c.proj, c.projy, c.near_z, g.tic, th.id
    FROM player p
    JOIN things th ON th.id = p.thing_id
   CROSS JOIN viewcfg c
   CROSS JOIN game g
   WHERE p.id = c.player_id AND c.id = 1 AND g.id = 1
    INTO px, py, pz, pa, w, h, proj, projy, nz, tic, me;
  ca = COS(pa);
  sa = SIN(pa);

  FOR SELECT th.id, th.x, th.y, th.z, th.angle, th.kind, th.frame, COALESCE(th.sprite, tt.sprite),
             th.sector_id, tt.walk_fr, tt.bright, COALESCE(tt.shadow, 0)
        FROM things th
        LEFT JOIN thing_types tt ON tt.thing_type = th.thing_type
       WHERE th.kind NOT IN ('marker', 'shooter') AND th.id <> :me   -- (every player but the one looking)
        INTO id, tx, ty, tz, tang, kind, fr, spr, sec, walk_fr, bright, fuzz
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
  clip_top DOUBLE PRECISION, clip_bot DOUBLE PRECISION,
  fsec INTEGER, c_top INTEGER, c_bot INTEGER, f_top INTEGER, f_bot INTEGER)
AS
DECLARE last_col INTEGER = -1;
DECLARE use_bsp SMALLINT;
DECLARE ff DOUBLE PRECISION;
DECLARE fc DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE h DOUBLE PRECISION;
DECLARE projy DOUBLE PRECISION;
DECLARE s DOUBLE PRECISION;
DECLARE yt INTEGER;
DECLARE yb INTEGER;
DECLARE bsp CURSOR FOR (SELECT col, depth, u, line_id, back_view, open_top, open_bot, fsec, ff, fc
                          FROM render_slices_bsp ORDER BY col, depth);
DECLARE brute CURSOR FOR (SELECT col, depth, u, line_id, back_view, open_top, open_bot, fsec, ff, fc
                            FROM render_slices ORDER BY col, depth);
BEGIN
  -- viewcfg.use_bsp picks the slice generator; the clipping is the same
  SELECT vc.use_bsp, vc.h, vc.projy, p.view_z FROM viewcfg vc CROSS JOIN player p
   WHERE vc.id = 1 AND p.id = vc.player_id
    INTO use_bsp, h, projy, pz;
  IF (use_bsp = 1) THEN OPEN bsp; ELSE OPEN brute;
  WHILE (1 = 1) DO
  BEGIN
    IF (use_bsp = 1) THEN
      FETCH bsp INTO col, depth, u, line_id, back_view, open_top, open_bot, fsec, ff, fc;
    ELSE
      FETCH brute INTO col, depth, u, line_id, back_view, open_top, open_bot, fsec, ff, fc;
    IF (ROW_COUNT = 0) THEN LEAVE;
    IF (col <> last_col) THEN
    BEGIN
      last_col = col;
      clip_top = 0;
      clip_bot = 1e9;
    END
    IF (clip_top < clip_bot) THEN
    BEGIN
      -- R_StoreWallRange's markceiling / markfloor: the rows between the
      -- clip window and this wall belong to the front sector's ceiling and
      -- floor visplanes. Rows [c_top, c_bot) and [f_top, f_bot).
      s = projy / depth;
      yt = MAXVALUE(0, CEILING(clip_top));
      yb = MINVALUE(h, CEILING(clip_bot));
      c_top = yt;
      c_bot = MINVALUE(yb, MAXVALUE(yt, CEILING(h / 2 - (fc - pz) * s)));
      f_top = MAXVALUE(yt, MINVALUE(yb, CEILING(h / 2 - (ff - pz) * s)));
      f_bot = yb;
      SUSPEND;
      clip_top = MAXVALUE(clip_top, open_top);
      clip_bot = MINVALUE(clip_bot, open_bot);
    END
  END
  IF (use_bsp = 1) THEN CLOSE bsp; ELSE CLOSE brute;
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

-- R_FindPlane, declaratively: this frame's visplanes, one row per distinct
-- (surface, height, flat, light). The browser does the same grouping per
-- column (splitting a plane when a column is used twice, as R_CheckPlane does)
-- and then draws each plane as horizontal spans (R_MakeSpans / R_MapPlane).
CREATE OR ALTER VIEW frame_visplanes AS
SELECT p.surface, p.height, f.name flat, p.light, p.sky,
       COUNT(*) columns_, MIN(p.col) minx, MAX(p.col) maxx, SUM(p.rows_) pixels
  FROM (SELECT CAST('ceiling' AS VARCHAR(7)) surface, se.ceil_h height, se.ceil_flat flat, se.light, se.sky,
               w.col, w.c_bot - w.c_top rows_
          FROM render_walls w LEFT JOIN sectors se ON se.id = w.fsec
         WHERE w.c_bot > w.c_top
        UNION ALL
        SELECT 'floor', se.floor_h, se.floor_flat, se.light, 0,
               w.col, w.f_bot - w.f_top
          FROM render_walls w LEFT JOIN sectors se ON se.id = w.fsec
         WHERE w.f_bot > w.f_top) p
  LEFT JOIN flats f ON f.id = p.flat
 GROUP BY p.surface, p.height, f.name, p.light, p.sky;

CREATE OR ALTER VIEW frame_sprites AS
SELECT * FROM render_sprites;

-- Live sector state the browser needs to texture the slices above.
CREATE OR ALTER VIEW frame_sectors AS
SELECT id, floor_h, ceil_h, floor_flat, ceil_flat, light, sky FROM sectors;
