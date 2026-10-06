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

-- Lowest/highest heights and light among a sector's neighbours.
CREATE OR ALTER FUNCTION neighbor_h (sec INTEGER, what VARCHAR(12))
RETURNS DOUBLE PRECISION
AS
DECLARE r DOUBLE PRECISION;
BEGIN
  SELECT CASE :what
           WHEN 'min_ceil'  THEN MIN(s.ceil_h)
           WHEN 'min_floor' THEN MIN(s.floor_h)
           WHEN 'max_floor' THEN MAX(s.floor_h)
         END
    FROM linedefs l
    JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
   WHERE (l.front_sector = :sec OR l.back_sector = :sec)
     AND l.back_sector IS NOT NULL AND s.id <> :sec
    INTO r;
  RETURN r;
END^

-- BLOCKMAP lookup: every linedef in the cells overlapping a box.
CREATE OR ALTER PROCEDURE lines_in_box (
  ax DOUBLE PRECISION, ay DOUBLE PRECISION, bx DOUBLE PRECISION, bdy DOUBLE PRECISION)
RETURNS (line_id INTEGER)
AS
BEGIN
  FOR SELECT DISTINCT lb.line_id
        FROM line_blocks lb
       WHERE lb.bx BETWEEN FLOOR(:ax / 128) AND FLOOR(:bx / 128)
         AND lb.by_ BETWEEN FLOOR(:ay / 128) AND FLOOR(:bdy / 128)
        INTO line_id
  DO SUSPEND;
END^

-- ── collision ─────────────────────────────────────────────────────────────
-- P_CheckPosition: can a thing of this radius/height stand at (px, py)?
-- Returns the floor and ceiling it would see, from every line it touches.
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
  IF (ceil_z - floor_z < hgt OR ceil_z - pz < hgt OR floor_z - pz > 24) THEN
  BEGIN
    ok = 0;
    EXIT;
  END
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
                   WHERE lb.bx = :cx AND lb.by_ = :cy AND :ddx * l.dy - :ddy * l.dx <> 0) i
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
CREATE OR ALTER PROCEDURE play_sound (snd VARCHAR(8), origin INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION)
AS
BEGIN
  IF (snd IS NULL) THEN EXIT;
  INSERT INTO sound_events (id, tic, sound, origin, x, y)
  SELECT NEXT VALUE FOR sound_seq, g.tic, :snd, :origin, :px, :py FROM game g WHERE g.id = 1;
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
CREATE OR ALTER PROCEDURE spawn_thing (
  ttype INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION, ang DOUBLE PRECISION)
RETURNS (new_id INTEGER)
AS
DECLARE sec INTEGER;
BEGIN
  new_id = NEXT VALUE FOR thing_seq;
  sec = sector_at(px, py);
  INSERT INTO things (id, thing_type, kind, x, y, z, angle, hp, radius, height, solid, sector_id,
                      st, st_tics, st_len, frame)
  SELECT :new_id, tt.thing_type, tt.kind, :px, :py,
         COALESCE(:pz, (SELECT floor_h FROM sectors WHERE id = :sec)), :ang,
         tt.hp, tt.radius, tt.height, tt.solid, :sec,
         CASE tt.kind WHEN 'fx' THEN 'fx' WHEN 'missile' THEN 'fly' ELSE 'idle' END,
         IIF(tt.kind = 'fx', CHAR_LENGTH(tt.walk_fr) * 4, 0),
         IIF(tt.kind = 'fx', CHAR_LENGTH(tt.walk_fr) * 4, 0),
         IIF(tt.kind IN ('fx', 'missile', 'monster'), SUBSTRING(tt.walk_fr FROM 1 FOR 1), NULL)
    FROM thing_types tt WHERE tt.thing_type = :ttype;
END^

CREATE OR ALTER PROCEDURE damage_player (dmg INTEGER)
AS
DECLARE arm INTEGER;
DECLARE saved INTEGER;
DECLARE is_dead SMALLINT;
BEGIN
  SELECT armor, dead FROM player WHERE id = 1 INTO arm, is_dead;
  IF (is_dead = 1 OR dmg <= 0) THEN EXIT;
  saved = IIF(arm > 0, MINVALUE(arm, dmg / 3), 0);
  UPDATE player
     SET armor = armor - :saved,
         health = health - (:dmg - :saved),
         damage_count = MINVALUE(damage_count + :dmg, 100)
   WHERE id = 1;
  UPDATE player SET dead = 1, health = 0, msg = 'You died. Press USE to restart.', msg_tics = 100000
   WHERE id = 1 AND health <= 0;
  EXECUTE PROCEDURE play_sound(IIF(ROW_COUNT > 0, 'DSPLDETH', 'DSPLPAIN'), 0, NULL, NULL);
END^

CREATE OR ALTER PROCEDURE damage_thing (tid INTEGER, dmg INTEGER)
AS
DECLARE k VARCHAR(10);
DECLARE hp INTEGER;
DECLARE st VARCHAR(8);
DECLARE pain_chance INTEGER;
DECLARE pain_fr VARCHAR(16);
DECLARE death_fr VARCHAR(16);
DECLARE death_sprite CHAR(4);
DECLARE drop_type INTEGER;
DECLARE tx DOUBLE PRECISION;
DECLARE ty DOUBLE PRECISION;
DECLARE dummy INTEGER;
DECLARE pain_snd VARCHAR(8);
DECLARE death_snd VARCHAR(8);
BEGIN
  SELECT t.kind, t.hp, t.st, tt.pain_chance, tt.pain_fr, tt.death_fr, tt.death_sprite, tt.drop_type, t.x, t.y,
         tt.pain_snd, tt.death_snd
    FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
   WHERE t.id = :tid
    INTO k, hp, st, pain_chance, pain_fr, death_fr, death_sprite, drop_type, tx, ty, pain_snd, death_snd;
  IF (k IS NULL OR k NOT IN ('monster', 'barrel', 'keen', 'brain') OR st IN ('dying', 'dead')) THEN EXIT;
  hp = hp - dmg;
  IF (hp <= 0) THEN
  BEGIN
    UPDATE things
       SET hp = :hp, st = 'dying', solid = 0, momx = 0, momy = 0,
           st_tics = CHAR_LENGTH(:death_fr) * 5, st_len = CHAR_LENGTH(:death_fr) * 5,
           frame = SUBSTRING(:death_fr FROM 1 FOR 1), sprite = :death_sprite
     WHERE id = :tid;
    IF (k IN ('monster', 'keen')) THEN UPDATE player SET kills = kills + 1 WHERE id = 1;
    IF (k = 'brain') THEN UPDATE things SET st_tics = 100, st_len = 100 WHERE id = :tid;   -- A_BrainScream
    EXECUTE PROCEDURE play_sound(death_snd, tid, tx, ty);
    IF (drop_type IS NOT NULL) THEN
      EXECUTE PROCEDURE spawn_thing(drop_type, tx, ty, NULL, 0) RETURNING_VALUES dummy;
  END
  ELSE
  BEGIN
    UPDATE things t SET hp = :hp, reaction = 0, st = IIF(t.st = 'idle' AND t.kind = 'monster', 'chase', t.st) WHERE t.id = :tid;
    IF (pain_fr IS NOT NULL AND RAND() * 256 < pain_chance) THEN
    BEGIN
      UPDATE things SET st = 'pain', st_tics = 6, st_len = 6, frame = SUBSTRING(:pain_fr FROM 1 FOR 1)
       WHERE id = :tid;
      EXECUTE PROCEDURE play_sound(pain_snd, tid, tx, ty);
    END
  END
END^

-- ── sector movers ─────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE door_start (sec INTEGER, spd DOUBLE PRECISION, stay SMALLINT, mode VARCHAR(8))
AS
DECLARE fh DOUBLE PRECISION;
DECLARE ch DOUBLE PRECISION;
BEGIN
  IF (EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN EXIT;
  SELECT floor_h, ceil_h FROM sectors WHERE id = :sec INTO fh, ch;
  IF (mode = 'close') THEN
  BEGIN
    INSERT INTO movers (sector_id, kind, dir, speed, top_h, bottom_h, wait_tics, stay)
    VALUES (:sec, 'door', -1, :spd, :ch, :fh, 0, 1);
    EXECUTE PROCEDURE sector_sound(IIF(spd > 2, 'DSBDCLS', 'DSDORCLS'), sec);
  END
  ELSE
  BEGIN
    INSERT INTO movers (sector_id, kind, dir, speed, top_h, bottom_h, wait_tics, stay)
    VALUES (:sec, 'door', 1, :spd, COALESCE(neighbor_h(:sec, 'min_ceil'), :ch + 64) - 4, :fh, 150, :stay);
    EXECUTE PROCEDURE sector_sound(IIF(spd > 2, 'DSBDOPN', 'DSDOROPN'), sec);
  END
END^

CREATE OR ALTER PROCEDURE floor_start (sec INTEGER, target DOUBLE PRECISION, spd DOUBLE PRECISION)
AS
DECLARE fh DOUBLE PRECISION;
BEGIN
  IF (target IS NULL OR EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN EXIT;
  SELECT floor_h FROM sectors WHERE id = :sec INTO fh;
  IF (target = fh) THEN EXIT;
  INSERT INTO movers (sector_id, kind, dir, speed, top_h, bottom_h, wait_tics, stay)
  VALUES (:sec, 'floor', IIF(:target > :fh, 1, -1), :spd, :target, :target, 0, 1);
END^

-- EV_DoDoor / EV_DoPlat / EV_DoFloor / G_ExitLevel, dispatched on line special.
CREATE OR ALTER PROCEDURE activate_line (line_id INTEGER, how VARCHAR(5))
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
BEGIN
  SELECT special, tag, back_sector, front_side FROM linedefs WHERE id = :line_id
    INTO sp, tg, bsec, fside;
  IF (sp IS NULL OR sp = 0) THEN EXIT;

  need = CASE WHEN sp IN (26, 32, 99, 133) THEN 1
              WHEN sp IN (27, 34, 136, 137) THEN 2
              WHEN sp IN (28, 33, 134, 135) THEN 4 ELSE 0 END;
  act = CASE
          WHEN sp IN (1, 26, 27, 28, 117) THEN 'door_man'
          WHEN sp IN (31, 32, 33, 34, 118) THEN 'door_man1'
          WHEN sp IN (4, 90, 29, 63, 108, 105, 111, 114) THEN 'door_ow'
          WHEN sp IN (2, 86, 103, 61, 46, 109, 106, 112, 115, 133, 135, 137, 99, 134, 136) THEN 'door_o'
          WHEN sp IN (3, 75, 50, 42, 110, 107, 113, 116) THEN 'door_c'
          WHEN sp IN (10, 88, 21, 62, 121, 120, 122, 123) THEN 'lift'
          WHEN sp IN (38, 82, 23, 60) THEN 'fl_low'
          WHEN sp IN (19, 83, 102, 45) THEN 'fl_hi'
          WHEN sp IN (36, 98, 71, 70) THEN 'fl_hi8'
          WHEN sp IN (5, 91, 101, 64) THEN 'fl_ceil'
          WHEN sp IN (119, 128, 18, 69) THEN 'fl_next'
          WHEN sp IN (58, 92) THEN 'fl_24'
          WHEN sp IN (7, 8) THEN 'stairs'
          WHEN sp IN (11, 52) THEN 'exit'
          WHEN sp IN (51, 124) THEN 'secret'
          WHEN sp IN (39, 97) THEN 'teleport'
        END;
  trig = CASE
           WHEN sp IN (2, 3, 4, 5, 8, 10, 19, 36, 38, 39, 52, 58, 75, 82, 83, 86, 88, 90, 91, 92, 97, 98,
                       105, 106, 107, 108, 109, 110, 119, 120, 121, 124, 128) THEN 'walk'
           WHEN sp = 46 THEN 'shoot'
           ELSE 'use'
         END;
  repeatable = IIF(sp IN (1, 26, 27, 28, 117, 42, 45, 46, 60, 61, 62, 63, 64, 69, 70, 75, 82, 83, 86, 88,
                          90, 91, 92, 97, 98, 99, 105, 106, 107, 114, 115, 116, 120, 123, 128, 134, 136), 1, 0);
  IF (act IS NULL OR trig <> how) THEN EXIT;

  IF (need > 0) THEN
  BEGIN
    SELECT keycards FROM player WHERE id = 1 INTO keys;
    IF (BIN_AND(keys, need) = 0) THEN
    BEGIN
      UPDATE player SET msg_tics = 70,
             msg = 'You need a ' || CASE :need WHEN 1 THEN 'blue' WHEN 2 THEN 'yellow' ELSE 'red' END
                   || ' key to activate this'
       WHERE id = 1;
      EXIT;
    END
  END

  spd = IIF(sp IN (105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 120, 121, 122, 123), 8, 2);

  IF (act IN ('door_man', 'door_man1')) THEN
  BEGIN
    IF (bsec IS NULL) THEN EXIT;
    IF (EXISTS (SELECT 1 FROM movers WHERE sector_id = :bsec)) THEN
    BEGIN
      IF (act = 'door_man') THEN
      BEGIN
        UPDATE movers SET dir = IIF(dir = -1, 1, -1), wait_left = 0 WHERE sector_id = :bsec AND kind = 'door';
        SELECT IIF(m.dir = 1, 'DSDOROPN', 'DSDORCLS') FROM movers m WHERE m.sector_id = :bsec INTO act;
        EXECUTE PROCEDURE sector_sound(act, bsec);
      END
      EXIT;
    END
    EXECUTE PROCEDURE door_start(bsec, spd, IIF(act = 'door_man1', 1, 0), 'open');
    did = 1;
  END
  ELSE IF (act = 'teleport') THEN
  BEGIN
    -- EV_Teleport: to the destination thing in the sector tagged by the line
    SELECT FIRST 1 t.x, t.y, t.angle FROM things t JOIN sectors s ON s.id = t.sector_id
     WHERE t.thing_type = 14 AND s.tag = :tg
      INTO fh, ch, h;
    IF (fh IS NOT NULL) THEN
    BEGIN
      UPDATE things t
         SET x = :fh, y = :ch, angle = :h, momx = 0, momy = 0, sector_id = sector_at(:fh, :ch),
             z = (SELECT floor_h FROM sectors s WHERE s.id = sector_at(:fh, :ch))
       WHERE t.kind = 'player';
      EXECUTE PROCEDURE play_sound('DSTELEPT', 0, fh, ch);
      did = 1;
    END
  END
  ELSE IF (act IN ('exit', 'secret')) THEN
  BEGIN
    UPDATE game SET exit_kind = IIF(:act = 'exit', 1, 2) WHERE id = 1;
    did = 1;
  END
  ELSE IF (tg > 0) THEN
  BEGIN
    FOR SELECT id, floor_h, ceil_h, floor_flat FROM sectors WHERE tag = :tg INTO sec, fh, ch, flat DO
    BEGIN
      IF (NOT EXISTS (SELECT 1 FROM movers WHERE sector_id = :sec)) THEN
      BEGIN
        did = 1;
        IF (act = 'door_ow') THEN EXECUTE PROCEDURE door_start(sec, spd, 0, 'open');
        ELSE IF (act = 'door_o') THEN EXECUTE PROCEDURE door_start(sec, spd, 1, 'open');
        ELSE IF (act = 'door_c') THEN EXECUTE PROCEDURE door_start(sec, spd, 1, 'close');
        ELSE IF (act = 'lift') THEN
        BEGIN
          INSERT INTO movers (sector_id, kind, dir, speed, top_h, bottom_h, wait_tics, stay)
          VALUES (:sec, 'lift', -1, IIF(:spd > 2, 8, 4), :fh,
                  MINVALUE(:fh, COALESCE(neighbor_h(:sec, 'min_floor'), :fh)), 105, 0);
          EXECUTE PROCEDURE sector_sound('DSPSTART', sec);
        END
        ELSE IF (act = 'fl_low') THEN
          EXECUTE PROCEDURE floor_start(sec, MINVALUE(fh, COALESCE(neighbor_h(sec, 'min_floor'), fh)), 1);
        ELSE IF (act = 'fl_hi') THEN
          EXECUTE PROCEDURE floor_start(sec, neighbor_h(sec, 'max_floor'), 1);
        ELSE IF (act = 'fl_hi8') THEN
          EXECUTE PROCEDURE floor_start(sec, neighbor_h(sec, 'max_floor') + 8, 4);
        ELSE IF (act = 'fl_ceil') THEN
          EXECUTE PROCEDURE floor_start(sec, MINVALUE(ch, COALESCE(neighbor_h(sec, 'min_ceil'), ch)), 1);
        ELSE IF (act = 'fl_24') THEN
          EXECUTE PROCEDURE floor_start(sec, fh + 24, 1);
        ELSE IF (act = 'fl_next') THEN
        BEGIN
          SELECT MIN(s.floor_h)
            FROM linedefs l
            JOIN sectors s ON s.id = IIF(l.front_sector = :sec, l.back_sector, l.front_sector)
           WHERE (l.front_sector = :sec OR l.back_sector = :sec) AND l.back_sector IS NOT NULL
             AND s.floor_h > :fh
            INTO h;
          EXECUTE PROCEDURE floor_start(sec, h, 1);
        END
        ELSE IF (act = 'stairs') THEN
        BEGIN
          -- EV_BuildStairs: raise this sector by 8, then keep stepping into the
          -- neighbour behind each front-facing line that shares the floor flat.
          h = fh + 8;
          EXECUTE PROCEDURE floor_start(sec, h, 1);
          nxt = sec;
          WHILE (nxt IS NOT NULL) DO
          BEGIN
            sec = nxt;
            nxt = NULL;
            SELECT FIRST 1 l.back_sector
              FROM linedefs l JOIN sectors s ON s.id = l.back_sector
             WHERE l.front_sector = :sec AND s.floor_flat = :flat
               AND NOT EXISTS (SELECT 1 FROM movers m WHERE m.sector_id = l.back_sector)
              INTO nxt;
            IF (nxt IS NOT NULL) THEN
            BEGIN
              h = h + 8;
              EXECUTE PROCEDURE floor_start(nxt, h, 1);
            END
          END
        END
      END
    END
  END

  IF (did = 1 AND how = 'use') THEN
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
BEGIN
  FOR SELECT m.sector_id, m.kind, m.dir, m.speed, m.top_h, m.bottom_h, m.wait_tics, m.wait_left, m.stay,
             s.floor_h, s.ceil_h
        FROM movers m JOIN sectors s ON s.id = m.sector_id
        INTO sid, k, dir, spd, top_h, bottom_h, wait_tics, wait_left, stay, fh, ch
  DO
  BEGIN
    del = 0;
    IF (k = 'door') THEN
    BEGIN
      IF (dir = 1) THEN
      BEGIN
        ch = MINVALUE(ch + spd, top_h);
        IF (ch >= top_h) THEN
          IF (stay = 1) THEN del = 1; ELSE BEGIN dir = 0; wait_left = wait_tics; END
      END
      ELSE IF (dir = 0) THEN
      BEGIN
        wait_left = wait_left - 1;
        IF (wait_left <= 0) THEN
        BEGIN
          dir = -1;
          EXECUTE PROCEDURE sector_sound(IIF(spd > 2, 'DSBDCLS', 'DSDORCLS'), sid);
        END
      END
      ELSE
      BEGIN
        nh = MAXVALUE(ch - spd, fh);
        IF (EXISTS (SELECT 1 FROM things t WHERE t.sector_id = :sid AND t.solid = 1
                       AND t.z + t.height > :nh)) THEN
        BEGIN
          dir = 1;                         -- something is in the way: reopen
          EXECUTE PROCEDURE sector_sound(IIF(spd > 2, 'DSBDOPN', 'DSDOROPN'), sid);
        END
        ELSE
        BEGIN
          ch = nh;
          IF (ch <= fh) THEN del = 1;
        END
      END
      UPDATE sectors SET ceil_h = :ch WHERE id = :sid;
    END
    ELSE IF (k = 'lift') THEN
    BEGIN
      IF (dir = -1) THEN
      BEGIN
        fh = MAXVALUE(fh - spd, bottom_h);
        IF (fh <= bottom_h) THEN
        BEGIN
          dir = 0;
          wait_left = wait_tics;
          EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
        END
      END
      ELSE IF (dir = 0) THEN
      BEGIN
        wait_left = wait_left - 1;
        IF (wait_left <= 0) THEN
        BEGIN
          dir = 1;
          EXECUTE PROCEDURE sector_sound('DSPSTART', sid);
        END
      END
      ELSE
      BEGIN
        nh = MINVALUE(fh + spd, top_h);
        IF (EXISTS (SELECT 1 FROM things t WHERE t.sector_id = :sid AND t.solid = 1
                       AND :nh + t.height > :ch)) THEN
          dir = -1;
        ELSE
        BEGIN
          fh = nh;
          IF (fh >= top_h) THEN
          BEGIN
            del = 1;
            EXECUTE PROCEDURE sector_sound('DSPSTOP', sid);
          END
        END
      END
      UPDATE sectors SET floor_h = :fh WHERE id = :sid;
      UPDATE things t SET z = :fh WHERE t.sector_id = :sid AND t.kind NOT IN ('player', 'missile', 'fx', 'cube')
         AND NOT EXISTS (SELECT 1 FROM thing_types tt WHERE tt.thing_type = t.thing_type AND tt.hang = 1);
    END
    ELSE
    BEGIN
      -- plain floor mover: top_h is the target
      IF (dir = 1) THEN fh = MINVALUE(fh + spd, top_h); ELSE fh = MAXVALUE(fh - spd, top_h);
      IF (fh = top_h) THEN del = 1;
      UPDATE sectors SET floor_h = :fh WHERE id = :sid;
      UPDATE things t SET z = :fh WHERE t.sector_id = :sid AND t.kind NOT IN ('player', 'missile', 'fx', 'cube')
         AND NOT EXISTS (SELECT 1 FROM thing_types tt WHERE tt.thing_type = t.thing_type AND tt.hang = 1);
    END

    IF (del = 1) THEN
      DELETE FROM movers WHERE sector_id = :sid;
    ELSE
      UPDATE movers SET dir = :dir, wait_left = :wait_left WHERE sector_id = :sid;
  END
END^

-- ── weapons ───────────────────────────────────────────────────────────────
-- P_LineAttack for the player: nearest blocking wall vs nearest shootable thing.
CREATE OR ALTER PROCEDURE hitscan (
  sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION,
  ang DOUBLE PRECISION, rng DOUBLE PRECISION, dmg INTEGER, shooter INTEGER)
RETURNS (hit SMALLINT)
AS
DECLARE ddx DOUBLE PRECISION;
DECLARE ddy DOUBLE PRECISION;
DECLARE wall_s DOUBLE PRECISION;
DECLARE wall_line INTEGER;
DECLARE wall_sp INTEGER;
DECLARE tgt INTEGER;
DECLARE tgt_s DOUBLE PRECISION;
DECLARE dummy INTEGER;
BEGIN
  ddx = COS(ang) * rng;
  ddy = SIN(ang) * rng;
  SELECT FIRST 1 i.s, i.id, i.special
    FROM (SELECT q.id, q.special, q.back_sector, q.front_sector,
                 ((q.x1 - :sx) * q.dy - (q.y1 - :sy) * q.dx) / q.den s,
                 ((q.x1 - :sx) * :ddy - (q.y1 - :sy) * :ddx) / q.den u
            FROM (SELECT l.*, (:ddx * l.dy - :ddy * l.dx) den
                    FROM lines_in_box(MINVALUE(:sx, :sx + :ddx), MINVALUE(:sy, :sy + :ddy),
                                      MAXVALUE(:sx, :sx + :ddx), MAXVALUE(:sy, :sy + :ddy)) lb
                    LEFT JOIN linedefs l ON l.id = lb.line_id
                   WHERE l.minx <= MAXVALUE(:sx, :sx + :ddx) AND l.maxx >= MINVALUE(:sx, :sx + :ddx)
                     AND l.miny <= MAXVALUE(:sy, :sy + :ddy) AND l.maxy >= MINVALUE(:sy, :sy + :ddy)) q
           WHERE q.den <> 0) i
    LEFT JOIN sectors f ON f.id = i.front_sector
    LEFT JOIN sectors b ON b.id = i.back_sector
   WHERE i.s > 0 AND i.s < 1 AND i.u >= 0 AND i.u <= 1
     AND (i.back_sector IS NULL
          OR MINVALUE(f.ceil_h, b.ceil_h) <= MAXVALUE(f.floor_h, b.floor_h)
          OR MAXVALUE(f.floor_h, b.floor_h) > :sz
          OR MINVALUE(f.ceil_h, b.ceil_h) < :sz)
   ORDER BY i.s
    INTO wall_s, wall_line, wall_sp;
  wall_s = COALESCE(wall_s, 1);

  SELECT FIRST 1 q.id, q.along
    FROM (SELECT t.id, t.radius,
                 ((t.x - :sx) * :ddx + (t.y - :sy) * :ddy) / (:rng * :rng) along,
                 ABS((t.x - :sx) * :ddy - (t.y - :sy) * :ddx) / :rng perp
            FROM things t
           WHERE t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead') AND t.id <> :shooter) q
   WHERE q.along > 0 AND q.along < :wall_s AND q.perp < q.radius
   ORDER BY q.along
    INTO tgt, tgt_s;

  hit = IIF(tgt IS NOT NULL, 1, 0);
  IF (tgt IS NOT NULL) THEN
  BEGIN
    EXECUTE PROCEDURE damage_thing(tgt, dmg);
    EXECUTE PROCEDURE spawn_thing(9011, sx + ddx * tgt_s - COS(ang) * 8, sy + ddy * tgt_s - SIN(ang) * 8, sz - 8, 0)
      RETURNING_VALUES dummy;
  END
  ELSE IF (wall_s < 1) THEN
  BEGIN
    EXECUTE PROCEDURE spawn_thing(9010, sx + ddx * wall_s - COS(ang) * 4, sy + ddy * wall_s - SIN(ang) * 4, sz - 4, 0)
      RETURNING_VALUES dummy;
    IF (wall_sp = 46) THEN EXECUTE PROCEDURE activate_line(wall_line, 'shoot');
  END
END^

-- P_SpawnPlayerMissile: a projectile leaving the shooter at gun height.
CREATE OR ALTER PROCEDURE fire_missile (
  mtype INTEGER, owner INTEGER, sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION, ang DOUBLE PRECISION)
AS
DECLARE mid INTEGER;
DECLARE spd DOUBLE PRECISION;
BEGIN
  SELECT speed FROM thing_types WHERE thing_type = :mtype INTO spd;
  EXECUTE PROCEDURE spawn_thing(mtype, sx, sy, sz + 32, ang) RETURNING_VALUES mid;
  UPDATE things t SET momx = COS(:ang) * :spd, momy = SIN(:ang) * :spd, owner_id = :owner WHERE t.id = :mid;
END^

-- P_RadiusAttack: DMG at the centre, minus the distance (box distance less
-- the victim's radius, as DOOM measures it), to everything that can see it,
-- the shooter included.
CREATE OR ALTER PROCEDURE radius_attack (
  bx DOUBLE PRECISION, bdy DOUBLE PRECISION, bz DOUBLE PRECISION, dmg INTEGER, src INTEGER)
AS
DECLARE oid INTEGER;
DECLARE ok VARCHAR(10);
DECLARE od DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION;
DECLARE oy DOUBLE PRECISION;
DECLARE oz DOUBLE PRECISION;
BEGIN
  FOR SELECT t.id, t.kind, MAXVALUE(ABS(t.x - :bx), ABS(t.y - :bdy)) - t.radius, t.x, t.y, t.z
        FROM things t
       WHERE t.x BETWEEN :bx - :dmg - 32 AND :bx + :dmg + 32
         AND t.kind IN ('monster', 'barrel', 'keen', 'brain', 'player') AND t.st NOT IN ('dying', 'dead')
        INTO oid, ok, od, ox, oy, oz
  DO
  BEGIN
    od = MAXVALUE(0, od);
    IF (od < dmg AND check_sight(bx, bdy, bz + 8, ox, oy, oz + 32) = 1) THEN
      IF (ok = 'player') THEN EXECUTE PROCEDURE damage_player(CAST(dmg - od AS INTEGER));
      ELSE EXECUTE PROCEDURE damage_thing(oid, CAST(dmg - od AS INTEGER));
  END
END^

-- A_BFGSpray: 40 tracers fanned over 90° from the player who fired, along
-- the ball's heading; each hits the first monster in 1024 units that the
-- player can see, for 15 rolls of 1d8.
CREATE OR ALTER PROCEDURE bfg_spray (ang DOUBLE PRECISION, src INTEGER)
AS
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE sz DOUBLE PRECISION;
DECLARE a DOUBLE PRECISION;
DECLARE ddx DOUBLE PRECISION;
DECLARE ddy DOUBLE PRECISION;
DECLARE i INTEGER = 0;
DECLARE j INTEGER;
DECLARE dmg INTEGER;
DECLARE tgt INTEGER;
DECLARE tx DOUBLE PRECISION;
DECLARE ty DOUBLE PRECISION;
DECLARE tz DOUBLE PRECISION;
DECLARE dummy INTEGER;
BEGIN
  SELECT x, y, z FROM things WHERE id = :src INTO sx, sy, sz;
  IF (sx IS NULL) THEN EXIT;
  WHILE (i < 40) DO
  BEGIN
    a = ang - PI() / 4 + (PI() / 2) / 40 * i;
    ddx = COS(a) * 1024;
    ddy = SIN(a) * 1024;
    tgt = NULL;
    SELECT FIRST 1 q.id, q.x, q.y, q.z
      FROM (SELECT t.id, t.x, t.y, t.z, t.radius,
                   ((t.x - :sx) * :ddx + (t.y - :sy) * :ddy) / (1024e0 * 1024) along,
                   ABS((t.x - :sx) * :ddy - (t.y - :sy) * :ddx) / 1024 perp
              FROM things t
             WHERE t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead')) q
     WHERE q.along > 0 AND q.along < 1 AND q.perp < q.radius
     ORDER BY q.along
      INTO tgt, tx, ty, tz;
    IF (tgt IS NOT NULL AND check_sight(sx, sy, sz + 32, tx, ty, tz + 32) = 1) THEN
    BEGIN
      dmg = 0;
      j = 0;
      WHILE (j < 15) DO
      BEGIN
        dmg = dmg + 1 + CAST(FLOOR(RAND() * 8) AS INTEGER);
        j = j + 1;
      END
      EXECUTE PROCEDURE damage_thing(tgt, dmg);
      EXECUTE PROCEDURE spawn_thing(9012, tx, ty, tz + 16, 0) RETURNING_VALUES dummy;
    END
    i = i + 1;
  END
END^

-- ── the player ────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE player_think (
  fwd DOUBLE PRECISION, side DOUBLE PRECISION, turn DOUBLE PRECISION,
  fire SMALLINT, use_key SMALLINT, weapon_sel SMALLINT, run SMALLINT, tic INTEGER)
AS
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
DECLARE attack_tics INTEGER;
DECLARE attack_len INTEGER;
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
DECLARE lbl VARCHAR(40);
DECLARE took SMALLINT;
DECLARE health INTEGER;
DECLARE armor INTEGER;
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
BEGIN
  SELECT p.thing_id, t.x, t.y, t.z, t.angle, t.momx, t.momy, t.momz, p.dead, p.weapon, p.attack_tics, p.attack_len,
         p.bullets, p.shells, p.has_shotgun, p.has_chaingun, p.use_down, p.view_h,
         p.rockets, p.cells, p.has_launcher, p.has_plasma, p.has_bfg, p.has_chainsaw, p.has_ssg
    FROM player p JOIN things t ON t.id = p.thing_id
   WHERE p.id = 1
    INTO tid, x, y, z, ang, momx, momy, momz, is_dead, weapon, attack_tics, attack_len,
         bullets, shells, has_sg, has_cg, use_down, view_h,
         rockets, cells, has_rl, has_pl, has_bfg, has_saw, has_ssg;

  IF (is_dead = 1) THEN
  BEGIN
    -- P_DeathThink: sink to the floor, wait for USE
    view_h = MAXVALUE(6, view_h - 1);
    IF (use_key = 1 AND use_down = 0) THEN UPDATE game SET exit_kind = 3 WHERE id = 1;
    UPDATE player SET view_h = :view_h, view_z = :z + :view_h, use_down = :use_key, attack_tics = 0 WHERE id = 1;
    EXIT;
  END

  -- P_MovePlayer: turn, thrust, friction
  ang = ang + turn;
  ang = ang - 2 * PI() * FLOOR(ang / (2 * PI()));
  thrust = IIF(run = 1, 1.5625e0, 0.78125e0);
  momx = momx + thrust * (fwd * COS(ang) + side * SIN(ang));
  momy = momy + thrust * (fwd * SIN(ang) - side * COS(ang));
  spd = SQRT(momx * momx + momy * momy);
  IF (spd > 30) THEN BEGIN momx = momx * 30 / spd; momy = momy * 30 / spd; END

  -- P_XYMovement with wall sliding
  ox = x;
  oy = y;
  IF (momx <> 0 OR momy <> 0) THEN
  BEGIN
    nx = x + momx;
    ny = y + momy;
    EXECUTE PROCEDURE check_position(tid, nx, ny, z, 16, 56, 0) RETURNING_VALUES ok, fz, cz, dz, sec;
    IF (ok = 1) THEN
    BEGIN
      x = nx;
      y = ny;
    END
    ELSE
    BEGIN
      EXECUTE PROCEDURE check_position(tid, nx, y, z, 16, 56, 0) RETURNING_VALUES ok, fz, cz, dz, sec;
      IF (ok = 1) THEN
      BEGIN
        x = nx;
        momy = 0;
      END
      ELSE
      BEGIN
        EXECUTE PROCEDURE check_position(tid, x, ny, z, 16, 56, 0) RETURNING_VALUES ok, fz, cz, dz, sec;
        IF (ok = 1) THEN
        BEGIN
          y = ny;
          momx = 0;
        END
        ELSE
        BEGIN
          momx = 0;
          momy = 0;
        END
      END
    END
  END
  momx = momx * 0.90625e0;
  momy = momy * 0.90625e0;
  IF (ABS(momx) < 0.05) THEN momx = 0;
  IF (ABS(momy) < 0.05) THEN momy = 0;

  -- P_CrossSpecialLine: walk-over triggers between the old and new position
  IF (x <> ox OR y <> oy) THEN
  BEGIN
    UPDATE things SET x = :x, y = :y, angle = :ang, momx = :momx, momy = :momy WHERE id = :tid;
    FOR SELECT l.id
          FROM lines_in_box(MINVALUE(:ox, :x), MINVALUE(:oy, :y), MAXVALUE(:ox, :x), MAXVALUE(:oy, :y)) lb
          LEFT JOIN linedefs l ON l.id = lb.line_id
         WHERE l.special > 0
           AND l.minx <= MAXVALUE(:ox, :x) AND l.maxx >= MINVALUE(:ox, :x)
           AND l.miny <= MAXVALUE(:oy, :y) AND l.maxy >= MINVALUE(:oy, :y)
           AND SIGN(l.dx * (:oy - l.y1) - l.dy * (:ox - l.x1)) <> SIGN(l.dx * (:y - l.y1) - l.dy * (:x - l.x1))
           AND SIGN((:x - :ox) * (l.y1 - :oy) - (:y - :oy) * (l.x1 - :ox))
            <> SIGN((:x - :ox) * (l.y2 - :oy) - (:y - :oy) * (l.x2 - :ox))
           -- teleporters only work entered from the front
           AND (l.special NOT IN (39, 97) OR l.dx * (:oy - l.y1) - l.dy * (:ox - l.x1) < 0)
          INTO lid
    DO
      EXECUTE PROCEDURE activate_line(lid, 'walk');
    SELECT t.x, t.y, t.z, t.angle, t.momx, t.momy FROM things t WHERE t.id = :tid INTO x, y, z, ang, momx, momy;
  END

  -- P_ZMovement: snap up steps (smoothing the view), fall with gravity
  sec = sector_at(x, y);
  SELECT floor_h, ceil_h, special FROM sectors WHERE id = :sec INTO fz, cz, sspec;
  IF (z < fz) THEN
  BEGIN
    view_h = view_h - (fz - z);
    z = fz;
    momz = 0;
  END
  ELSE IF (z > fz) THEN
  BEGIN
    momz = momz - 1;
    z = MAXVALUE(fz, z + momz);
    IF (z = fz) THEN
    BEGIN
      IF (momz < -8) THEN
      BEGIN
        view_h = view_h + momz / 2;   -- landing squat
        EXECUTE PROCEDURE play_sound('DSOOF', 0, NULL, NULL);
      END
      momz = 0;
    END
  END
  view_h = MINVALUE(41, view_h + MAXVALUE(1, (41 - view_h) / 4));
  bob = MINVALUE(16, (momx * momx + momy * momy) / 4);
  view_z = z + view_h + bob / 2 * SIN(tic * 2 * PI() / 20);
  IF (view_z > cz - 4) THEN view_z = cz - 4;

  -- sector specials under the player
  IF (sspec = 9) THEN
  BEGIN
    UPDATE sectors SET special = 0 WHERE id = :sec;
    UPDATE player SET secrets = secrets + 1, msg = 'A secret is revealed!', msg_tics = 70 WHERE id = 1;
  END
  ELSE IF (sspec IN (4, 5, 7, 11, 16) AND z <= fz AND MOD(tic, 32) = 0) THEN
    EXECUTE PROCEDURE damage_player(CASE sspec WHEN 7 THEN 5 WHEN 5 THEN 10 ELSE 20 END);

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
    IF (lid IS NOT NULL AND lsp > 0) THEN EXECUTE PROCEDURE activate_line(lid, 'use');
    ELSE IF (lid IS NOT NULL) THEN EXECUTE PROCEDURE play_sound('DSNOWAY', 0, NULL, NULL);
  END

  -- weapon selection (only weapons we own)
  -- (1 cycles fist/chainsaw and 3 shotgun/super shotgun, as in DOOM II)
  old_weapon = weapon;
  IF (weapon_sel = 1) THEN
    weapon = IIF(has_saw = 1 AND weapon <> 8, 8, 1);
  ELSE IF (weapon_sel = 3 AND (has_sg = 1 OR has_ssg = 1)) THEN
    weapon = IIF(has_ssg = 1 AND weapon <> 9 AND shells >= 2, 9, IIF(has_sg = 1, 3, 9));
  ELSE IF (weapon_sel = 2 OR (weapon_sel = 4 AND has_cg = 1)
      OR (weapon_sel = 5 AND has_rl = 1) OR (weapon_sel = 6 AND has_pl = 1) OR (weapon_sel = 7 AND has_bfg = 1)) THEN
    weapon = weapon_sel;
  IF (weapon = 8 AND old_weapon <> 8) THEN EXECUTE PROCEDURE play_sound('DSSAWUP', 0, NULL, NULL);

  -- A_FirePistol / A_FireShotgun / A_FireCGun / A_Punch
  IF (attack_tics > 0) THEN attack_tics = attack_tics - 1;
  -- A_FireBFG: the ball leaves 20 tics after the trigger, once the gun has charged
  IF (weapon = 7 AND attack_len = 60 AND attack_tics = 40) THEN
    EXECUTE PROCEDURE fire_missile(9005, tid, x, y, z, ang);
  -- A_OpenShotgun2 / A_LoadShotgun2 / A_CloseShotgun2
  IF (weapon = 9 AND attack_len = 57) THEN
    EXECUTE PROCEDURE play_sound(CASE attack_tics WHEN 42 THEN 'DSDBOPN' WHEN 30 THEN 'DSDBLOAD'
                                                  WHEN 18 THEN 'DSDBCLS' END, 0, NULL, NULL);
  -- A_WeaponReady: the chainsaw idles noisily
  IF (weapon = 8 AND fire = 0 AND attack_tics = 0 AND MOD(tic, 8) = 0) THEN
    EXECUTE PROCEDURE play_sound('DSSAWIDL', 0, NULL, NULL);
  IF (fire = 1 AND attack_tics = 0) THEN
  BEGIN
    -- P_CheckAmmo: out of ammo, switch to the best weapon that has some
    IF ((weapon IN (2, 4) AND bullets = 0) OR (weapon = 3 AND shells = 0) OR (weapon = 5 AND rockets = 0)
        OR (weapon = 6 AND cells = 0) OR (weapon = 7 AND cells < 40) OR (weapon = 9 AND shells < 2)) THEN
      weapon = CASE WHEN has_pl = 1 AND cells > 0 THEN 6
                    WHEN has_ssg = 1 AND shells >= 2 THEN 9
                    WHEN has_cg = 1 AND bullets > 0 THEN 4
                    WHEN has_sg = 1 AND shells > 0 THEN 3
                    WHEN bullets > 0 THEN 2
                    WHEN has_saw = 1 THEN 8
                    WHEN has_rl = 1 AND rockets > 0 THEN 5
                    WHEN has_bfg = 1 AND cells >= 40 THEN 7
                    ELSE 1 END;
    pellets = 0;
    IF (weapon = 1) THEN
    BEGIN
      attack_len = 18;
      EXECUTE PROCEDURE hitscan(x, y, z + 32, ang, 64, 2 * (1 + CAST(FLOOR(RAND() * 10) AS INTEGER)), tid)
        RETURNING_VALUES shot_hit;
    END
    ELSE IF (weapon = 8) THEN
    BEGIN
      -- A_Saw: 2d10 × 2 at MELEERANGE + 1, every 4 tics
      attack_len = 4;
      EXECUTE PROCEDURE hitscan(x, y, z + 32, ang + (RAND() - RAND()) * 0.04, 65,
                                2 * (1 + CAST(FLOOR(RAND() * 10) AS INTEGER)), tid)
        RETURNING_VALUES shot_hit;
    END
    ELSE IF (weapon = 9) THEN
    BEGIN
      -- A_FireShotgun2: 20 pellets, two shells, a wide horizontal spread
      attack_len = 57;
      pellets = 20;
      spread = 0.196;
      shells = shells - 2;
    END
    ELSE IF (weapon = 2) THEN BEGIN attack_len = 14; pellets = 1; spread = 0.04; bullets = bullets - 1; END
    ELSE IF (weapon = 3) THEN BEGIN attack_len = 37; pellets = 7; spread = 0.10; shells = shells - 1; END
    ELSE IF (weapon = 4) THEN BEGIN attack_len = 4;  pellets = 1; spread = 0.06; bullets = bullets - 1; END
    ELSE IF (weapon = 5) THEN
    BEGIN
      attack_len = 20;
      rockets = rockets - 1;
      EXECUTE PROCEDURE fire_missile(9003, tid, x, y, z, ang);
    END
    ELSE IF (weapon = 6) THEN
    BEGIN
      attack_len = 3;
      cells = cells - 1;
      EXECUTE PROCEDURE fire_missile(9004, tid, x, y, z, ang);
    END
    ELSE IF (weapon = 7) THEN
    BEGIN
      attack_len = 60;
      cells = cells - 40;
    END
    attack_tics = attack_len;
    EXECUTE PROCEDURE play_sound(CASE weapon WHEN 1 THEN 'DSPUNCH' WHEN 3 THEN 'DSSHOTGN' WHEN 5 THEN 'DSRLAUNC'
                                             WHEN 6 THEN 'DSPLASMA' WHEN 7 THEN 'DSBFG'
                                             WHEN 8 THEN IIF(shot_hit = 1, 'DSSAWHIT', 'DSSAWFUL')
                                             WHEN 9 THEN 'DSDSHTGN' ELSE 'DSPISTOL' END,
                                 0, NULL, NULL);
    i = 0;
    WHILE (i < pellets) DO
    BEGIN
      EXECUTE PROCEDURE hitscan(x, y, z + 32, ang + (RAND() - RAND()) * spread, 2048,
                                5 * (1 + CAST(FLOOR(RAND() * 3) AS INTEGER)), tid)
        RETURNING_VALUES shot_hit;
      i = i + 1;
    END
    IF (weapon > 1) THEN UPDATE game SET noise_tic = :tic WHERE id = 1;   -- the chainsaw too
  END

  UPDATE things SET x = :x, y = :y, z = :z, angle = :ang, momx = :momx, momy = :momy, momz = :momz,
                    sector_id = :sec
   WHERE id = :tid;
  UPDATE player SET weapon = :weapon, attack_tics = :attack_tics, attack_len = :attack_len,
                    bullets = :bullets, shells = :shells, rockets = :rockets, cells = :cells, use_down = :use_key,
                    view_h = :view_h, view_z = :view_z
   WHERE id = 1;

  -- P_TouchSpecialThing: pick up anything we overlap
  FOR SELECT t.id, tt.pickup, tt.amount, tt.label
        FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
       WHERE t.kind = 'item' AND ABS(t.x - :x) < t.radius + 16 AND ABS(t.y - :y) < t.radius + 16
         AND t.z <= :z + 56 AND t.z + 16 >= :z
        INTO iid, pk, amt, lbl
  DO
  BEGIN
    SELECT p.health, p.armor, p.bullets, p.shells, p.max_bullets, p.max_shells, p.has_shotgun, p.has_chaingun,
           p.rockets, p.cells, p.max_rockets, p.max_cells, p.has_launcher, p.has_plasma, p.has_bfg
      FROM player p WHERE p.id = 1
      INTO health, armor, bullets, shells, maxb, maxs, has_sg, has_cg,
           rockets, cells, maxr, maxc, has_rl, has_pl, has_bfg;
    SELECT p.has_chainsaw, p.has_ssg FROM player p WHERE p.id = 1 INTO has_saw, has_ssg;
    took = 1;
    IF (pk = 'health') THEN
      IF (health >= 100) THEN took = 0; ELSE health = MINVALUE(100, health + amt);
    ELSE IF (pk = 'health+') THEN health = MINVALUE(200, health + amt);
    ELSE IF (pk = 'armor') THEN
      IF (armor >= amt) THEN took = 0; ELSE armor = amt;
    ELSE IF (pk = 'armor+') THEN armor = MINVALUE(200, armor + amt);
    ELSE IF (pk = 'bullets') THEN
      IF (bullets >= maxb) THEN took = 0; ELSE bullets = MINVALUE(maxb, bullets + amt);
    ELSE IF (pk = 'shells') THEN
      IF (shells >= maxs) THEN took = 0; ELSE shells = MINVALUE(maxs, shells + amt);
    ELSE IF (pk = 'shotgun') THEN
    BEGIN
      IF (has_sg = 0) THEN weapon = 3;
      has_sg = 1;
      shells = MINVALUE(maxs, shells + amt);
    END
    ELSE IF (pk = 'chaingun') THEN
    BEGIN
      IF (has_cg = 0) THEN weapon = 4;
      has_cg = 1;
      bullets = MINVALUE(maxb, bullets + amt);
    END
    ELSE IF (pk = 'rockets') THEN
      IF (rockets >= maxr) THEN took = 0; ELSE rockets = MINVALUE(maxr, rockets + amt);
    ELSE IF (pk = 'cells') THEN
      IF (cells >= maxc) THEN took = 0; ELSE cells = MINVALUE(maxc, cells + amt);
    ELSE IF (pk = 'launcher') THEN
    BEGIN
      IF (has_rl = 0) THEN weapon = 5;
      has_rl = 1;
      rockets = MINVALUE(maxr, rockets + amt);
    END
    ELSE IF (pk = 'plasma') THEN
    BEGIN
      IF (has_pl = 0) THEN weapon = 6;
      has_pl = 1;
      cells = MINVALUE(maxc, cells + amt);
    END
    ELSE IF (pk = 'bfg') THEN
    BEGIN
      IF (has_bfg = 0) THEN weapon = 7;
      has_bfg = 1;
      cells = MINVALUE(maxc, cells + amt);
    END
    ELSE IF (pk = 'chainsaw') THEN
    BEGIN
      IF (has_saw = 0) THEN weapon = 8;
      has_saw = 1;
    END
    ELSE IF (pk = 'ssg') THEN
    BEGIN
      IF (has_ssg = 0) THEN weapon = 9;
      has_ssg = 1;
      shells = MINVALUE(maxs, shells + amt);
    END
    ELSE IF (pk = 'mega') THEN
    BEGIN
      health = 200;
      armor = 200;
    END
    ELSE IF (pk = 'backpack') THEN
    BEGIN
      maxb = 400;
      maxs = 100;
      maxr = 100;
      maxc = 600;
      bullets = MINVALUE(maxb, bullets + amt);
      shells = MINVALUE(maxs, shells + 4);
      rockets = MINVALUE(maxr, rockets + 1);
      cells = MINVALUE(maxc, cells + 20);
    END
    IF (took = 1) THEN
    BEGIN
      DELETE FROM things WHERE id = :iid;
      UPDATE player
         SET health = :health, armor = :armor, bullets = :bullets, shells = :shells,
             max_bullets = :maxb, max_shells = :maxs, has_shotgun = :has_sg, has_chaingun = :has_cg,
             rockets = :rockets, cells = :cells, max_rockets = :maxr, max_cells = :maxc,
             has_launcher = :has_rl, has_plasma = :has_pl, has_bfg = :has_bfg,
             has_chainsaw = :has_saw, has_ssg = :has_ssg,
             weapon = :weapon, items = items + 1, bonus_count = 6,
             keycards = IIF(:pk = 'key', BIN_OR(keycards, :amt), keycards),
             msg = 'Picked up ' || :lbl || '.', msg_tics = 70
       WHERE id = 1;
      EXECUTE PROCEDURE play_sound(CASE WHEN pk IN ('shotgun', 'chaingun', 'launcher', 'plasma', 'bfg', 'chainsaw', 'ssg') THEN 'DSWPNUP'
                                        WHEN pk IN ('none', 'mega') THEN 'DSGETPOW' ELSE 'DSITEMUP' END, 0, NULL, NULL);
    END
  END
END^

-- P_SpawnMissile: a monster's projectile, from just in front of it at
-- chest height, flying along ANG.
CREATE OR ALTER PROCEDURE monster_missile (
  owner INTEGER, mtype INTEGER, sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION,
  rad DOUBLE PRECISION, ang DOUBLE PRECISION)
AS
DECLARE mid INTEGER;
DECLARE spd DOUBLE PRECISION;
BEGIN
  SELECT speed FROM thing_types WHERE thing_type = :mtype INTO spd;
  EXECUTE PROCEDURE spawn_thing(mtype, sx + COS(ang) * (rad + 8), sy + SIN(ang) * (rad + 8), sz + 32, ang)
    RETURNING_VALUES mid;
  UPDATE things t SET momx = COS(:ang) * :spd, momy = SIN(:ang) * :spd, owner_id = :owner WHERE t.id = :mid;
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
    FOR SELECT id, floor_h FROM sectors WHERE tag = 666 INTO sec, fh DO
      EXECUTE PROCEDURE floor_start(sec, MINVALUE(fh, COALESCE(neighbor_h(sec, 'min_floor'), fh)), 1);
  ELSE IF (mn = 'E4M6' AND ttype = 16) THEN
    -- blazeOpen, tag 666
    FOR SELECT id FROM sectors WHERE tag = 666 INTO sec DO
      EXECUTE PROCEDURE door_start(sec, 8, 1, 'open');
  ELSE IF (mn = 'MAP07' AND ttype = 68) THEN
    -- raiseToTexture, tag 667: by the height of the shortest lower texture around it
    FOR SELECT id, floor_h FROM sectors WHERE tag = 667 INTO sec, fh DO
    BEGIN
      SELECT MIN(tx.h) FROM linedefs l
        JOIN sidedefs sd ON sd.id IN (l.front_side, l.back_side)
        JOIN textures tx ON tx.id = sd.lower_tex
       WHERE l.front_sector = :sec OR l.back_sector = :sec
        INTO h;
      EXECUTE PROCEDURE floor_start(sec, fh + COALESCE(h, 24), 1);
    END
END^

-- A_KeenDie: the last Keen opens the doors tagged 666.
CREATE OR ALTER PROCEDURE keen_die
AS
DECLARE sec INTEGER;
BEGIN
  IF (EXISTS (SELECT 1 FROM things t WHERE t.kind = 'keen' AND t.st NOT IN ('dying', 'dead'))) THEN EXIT;
  FOR SELECT id FROM sectors WHERE tag = 666 INTO sec DO
    EXECUTE PROCEDURE door_start(sec, 2, 1, 'open');
END^

-- ── monsters, missiles, effects ───────────────────────────────────────────
-- A_Look / A_Chase / A_FaceTarget / A_PosAttack / A_TroopAttack / A_SargAttack,
-- collapsed into one state machine per thing.
CREATE OR ALTER PROCEDURE monsters_think (tic INTEGER)
AS
DECLARE px DOUBLE PRECISION;
DECLARE py DOUBLE PRECISION;
DECLARE pz DOUBLE PRECISION;
DECLARE pdead SMALLINT;
DECLARE noise_tic INTEGER;
DECLARE id INTEGER;
DECLARE k VARCHAR(10);
DECLARE x DOUBLE PRECISION;
DECLARE y DOUBLE PRECISION;
DECLARE z DOUBLE PRECISION;
DECLARE ang DOUBLE PRECISION;
DECLARE st VARCHAR(8);
DECLARE st_tics INTEGER;
DECLARE st_len INTEGER;
DECLARE step INTEGER;
DECLARE reaction INTEGER;
DECLARE rad DOUBLE PRECISION;
DECLARE hgt DOUBLE PRECISION;
DECLARE momx DOUBLE PRECISION;
DECLARE momy DOUBLE PRECISION;
DECLARE owner_id INTEGER;
DECLARE flags INTEGER;
DECLARE frame CHAR(1);
DECLARE spd DOUBLE PRECISION;
DECLARE walk_fr VARCHAR(16);
DECLARE atk_fr VARCHAR(16);
DECLARE death_fr VARCHAR(16);
DECLARE atk_kind VARCHAR(10);
DECLARE missile_type INTEGER;
DECLARE dmg_lo INTEGER;
DECLARE dmg_hi INTEGER;
DECLARE shots INTEGER;
DECLARE sec INTEGER;
DECLARE dist DOUBLE PRECISION;
DECLARE del SMALLINT;
DECLARE idx INTEGER;
DECLARE try_ang DOUBLE PRECISION;
DECLARE a0 DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION;
DECLARE ny DOUBLE PRECISION;
DECLARE ok SMALLINT;
DECLARE fz DOUBLE PRECISION;
DECLARE cz DOUBLE PRECISION;
DECLARE dz DOUBLE PRECISION;
DECLARE n INTEGER;
DECLARE mid INTEGER;
DECLARE melee_range DOUBLE PRECISION;
DECLARE see_snd VARCHAR(8);
DECLARE atk_snd VARCHAR(8);
DECLARE death_snd VARCHAR(8);
DECLARE ptid INTEGER;
DECLARE ttype INTEGER;
DECLARE hit INTEGER;
DECLARE mdmg INTEGER;
DECLARE spot INTEGER;
DECLARE sx DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION;
DECLARE r DOUBLE PRECISION;
BEGIN
  SELECT t.x, t.y, t.z, p.dead, p.thing_id FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1
    INTO px, py, pz, pdead, ptid;
  SELECT g.noise_tic FROM game g WHERE g.id = 1 INTO noise_tic;

  FOR SELECT t.id, t.kind, t.x, t.y, t.z, t.angle, t.st, t.st_tics, t.st_len, t.step, t.reaction,
             t.radius, t.height, t.momx, t.momy, t.owner_id, t.flags, t.frame,
             tt.speed, tt.walk_fr, tt.atk_fr, tt.death_fr, tt.atk_kind, tt.missile_type,
             tt.dmg_lo, tt.dmg_hi, tt.shots, t.sector_id, tt.see_snd, tt.atk_snd, tt.death_snd, t.thing_type
        FROM things t JOIN thing_types tt ON tt.thing_type = t.thing_type
       WHERE t.kind IN ('monster', 'barrel', 'missile', 'fx', 'keen', 'brain', 'shooter', 'cube')
         AND t.st NOT IN ('dead')
         AND NOT (t.kind = 'barrel' AND t.st = 'idle')
         AND NOT (t.st = 'idle' AND MOD(:tic + t.id, 8) <> 0)
        INTO id, k, x, y, z, ang, st, st_tics, st_len, step, reaction, rad, hgt, momx, momy, owner_id, flags, frame,
             spd, walk_fr, atk_fr, death_fr, atk_kind, missile_type, dmg_lo, dmg_hi, shots, sec,
             see_snd, atk_snd, death_snd, ttype
  DO
  BEGIN
    del = 0;
    dist = SQRT((px - x) * (px - x) + (py - y) * (py - y));

    IF (k = 'shooter') THEN
    BEGIN
      -- A_BrainSpit: every 150 tics, a cube towards a random target spot
      IF (st = 'idle') THEN
      BEGIN
        st = 'active';
        st_tics = 105;
      END
      ELSE
      BEGIN
        st_tics = st_tics - 1;
        IF (st_tics <= 0 AND pdead = 0) THEN
        BEGIN
          st_tics = 150;
          spot = NULL;
          SELECT FIRST 1 t.id, t.x, t.y FROM things t WHERE t.thing_type = 87 ORDER BY RAND() INTO spot, sx, sy;
          IF (spot IS NOT NULL) THEN
          BEGIN
            ang = ATAN2(sy - y, sx - x);
            EXECUTE PROCEDURE spawn_thing(9009, x, y, z, ang) RETURNING_VALUES mid;
            UPDATE things t SET momx = COS(:ang) * 10, momy = SIN(:ang) * 10, owner_id = :spot, st = 'fly'
             WHERE t.id = :mid;
            EXECUTE PROCEDURE play_sound('DSBOSPIT', 0, NULL, NULL);
          END
        END
      END
    END
    ELSE IF (k = 'cube') THEN
    BEGIN
      -- the cube flies through walls to its spot, then A_SpawnFly
      SELECT t.x, t.y FROM things t WHERE t.id = :owner_id INTO sx, sy;
      IF (sx IS NULL) THEN del = 1;
      ELSE IF (SQRT((sx - x) * (sx - x) + (sy - y) * (sy - y)) <= spd) THEN
      BEGIN
        del = 1;
        EXECUTE PROCEDURE spawn_thing(9014, sx, sy, NULL, 0) RETURNING_VALUES mid;
        r = RAND() * 256;
        EXECUTE PROCEDURE spawn_thing(
          CASE WHEN r < 50 THEN 3001 WHEN r < 90 THEN 3002 WHEN r < 120 THEN 58 WHEN r < 130 THEN 71
               WHEN r < 160 THEN 3005 WHEN r < 162 THEN 64 WHEN r < 172 THEN 66 WHEN r < 192 THEN 68
               WHEN r < 222 THEN 67 WHEN r < 246 THEN 69 ELSE 3003 END,
          sx, sy, NULL, ATAN2(py - sy, px - sx)) RETURNING_VALUES mid;
        UPDATE things t SET st = 'chase', reaction = 2 WHERE t.id = :mid;
        EXECUTE PROCEDURE play_sound('DSTELEPT', mid, sx, sy);
      END
      ELSE
      BEGIN
        x = x + momx;
        y = y + momy;
        sec = sector_at(x, y);
      END
    END
    ELSE IF (k = 'brain' AND st = 'dying') THEN
    BEGIN
      -- A_BrainScream: rockets bursting all along the wall, then the end
      st_tics = st_tics - 1;
      IF (MOD(st_tics, 5) = 0) THEN
      BEGIN
        EXECUTE PROCEDURE spawn_thing(9013, x - 320 + RAND() * 640, y - 320, z + 128 + RAND() * 384, 0) RETURNING_VALUES mid;
        IF (MOD(st_tics, 15) = 0) THEN EXECUTE PROCEDURE play_sound('DSBAREXP', 0, NULL, NULL);
      END
      IF (st_tics <= 0) THEN
      BEGIN
        st = 'dead';
        UPDATE game SET exit_kind = 1 WHERE id = 1;
      END
    END
    ELSE IF (k = 'fx') THEN
    BEGIN
      st_tics = st_tics - 1;
      IF (st_tics <= 0) THEN del = 1;
      ELSE frame = SUBSTRING(walk_fr FROM 1 + MINVALUE(CHAR_LENGTH(walk_fr) - 1, (st_len - st_tics) / 4) FOR 1);
    END
    ELSE IF (k = 'missile') THEN
    BEGIN
      IF (st = 'dying') THEN
      BEGIN
        st_tics = st_tics - 1;
        IF (st_tics <= 0) THEN del = 1;
        ELSE frame = SUBSTRING(death_fr FROM 1 + MINVALUE(CHAR_LENGTH(death_fr) - 1, (st_len - st_tics) / 4) FOR 1);
      END
      ELSE
      BEGIN
        -- A_Tracer: every 4 tics a revenant's missile turns towards the player
        -- by at most TRACEANGLE (16.875°) and leaves a puff of smoke
        IF (ttype = 9006 AND MOD(tic, 4) = 0 AND pdead = 0) THEN
        BEGIN
          a0 = ATAN2(py - y, px - x) - ang;
          a0 = a0 - 2 * PI() * FLOOR((a0 + PI()) / (2 * PI()));     -- into [-π, π)
          IF (ABS(a0) <= 0.29452e0) THEN ang = ang + a0;
          ELSE ang = ang + SIGN(a0) * 0.29452e0;
          momx = COS(ang) * spd;
          momy = SIN(ang) * spd;
          UPDATE things t SET momx = :momx, momy = :momy WHERE t.id = :id;
          EXECUTE PROCEDURE spawn_thing(9010, x - momx, y - momy, z, 0) RETURNING_VALUES mid;
        END
        nx = x + momx;
        ny = y + momy;
        frame = SUBSTRING(walk_fr FROM 1 + MOD(tic / 4, CHAR_LENGTH(walk_fr)) FOR 1);
        -- P_CheckMissileSpawn / PIT_CheckThing: what does it hit this tic?
        mdmg = dmg_lo * (1 + CAST(FLOOR(RAND() * 8) AS INTEGER));
        hit = NULL;
        IF (owner_id = ptid) THEN
          SELECT FIRST 1 t.id FROM things t
           WHERE t.x BETWEEN :nx - 64 AND :nx + 64
             AND t.kind IN ('monster', 'barrel', 'keen', 'brain') AND t.st NOT IN ('dying', 'dead')
             AND ABS(t.x - :nx) < t.radius + :rad AND ABS(t.y - :ny) < t.radius + :rad
            INTO hit;
        ELSE IF (SQRT((px - nx) * (px - nx) + (py - ny) * (py - ny)) < 16 + rad AND z >= pz - 8 AND z <= pz + 64) THEN
          hit = ptid;
        IF (hit = ptid) THEN
        BEGIN
          EXECUTE PROCEDURE damage_player(mdmg);
          st = 'dying';
        END
        ELSE IF (hit IS NOT NULL) THEN
        BEGIN
          EXECUTE PROCEDURE damage_thing(hit, mdmg);
          st = 'dying';
        END
        ELSE IF (check_sight(x, y, z, nx, ny, z) = 0) THEN
          st = 'dying';
        ELSE
        BEGIN
          x = nx;
          y = ny;
          sec = sector_at(x, y);
        END
        IF (st = 'dying') THEN
        BEGIN
          EXECUTE PROCEDURE play_sound(death_snd, id, x, y);
          st_len = CHAR_LENGTH(death_fr) * 4;
          st_tics = st_len;
          frame = SUBSTRING(death_fr FROM 1 FOR 1);
          UPDATE things t
             SET sprite = (SELECT tt.death_sprite FROM thing_types tt WHERE tt.thing_type = t.thing_type)
           WHERE t.id = :id;
          IF (ttype = 9003) THEN EXECUTE PROCEDURE radius_attack(x, y, z, 128, owner_id);   -- rocket
          IF (ttype = 9005) THEN EXECUTE PROCEDURE bfg_spray(ang, owner_id);               -- BFG
        END
      END
    END
    ELSE IF (st = 'dying') THEN
    BEGIN
      -- A_Fall / A_Explode
      st_tics = st_tics - 1;
      idx = MINVALUE(CHAR_LENGTH(death_fr) - 1, (st_len - st_tics) / 5);
      frame = SUBSTRING(death_fr FROM 1 + idx FOR 1);
      IF (k = 'barrel' AND st_tics = st_len - 10) THEN
      BEGIN
        -- A_Explode: 128 damage, falling off with distance
        EXECUTE PROCEDURE radius_attack(x, y, z, 128, id);
      END
      IF (st_tics <= 0) THEN
      BEGIN
        IF (k = 'barrel') THEN del = 1;
        ELSE
        BEGIN
          st = 'dead';
          IF (k = 'keen') THEN EXECUTE PROCEDURE keen_die;
          ELSE EXECUTE PROCEDURE boss_death(ttype);
        END
      END
    END
    ELSE IF (st = 'pain') THEN
    BEGIN
      st_tics = st_tics - 1;
      IF (st_tics <= 0) THEN BEGIN st = IIF(k = 'monster', 'chase', 'idle'); st_tics = 0; END
    END
    ELSE IF (st = 'idle') THEN
    BEGIN
      -- A_Look: sight, or gunfire within earshot (unless deaf/ambush)
      IF (k = 'monster' AND pdead = 0 AND dist < 2400
          AND ((BIN_AND(flags, 8) = 0 AND tic - noise_tic < 16 AND dist < 1200)
               OR check_sight(x, y, z + hgt * 0.75e0, px, py, pz + 41) = 1)) THEN
      BEGIN
        st = 'chase';
        st_tics = 0;
        reaction = 2;
        EXECUTE PROCEDURE play_sound(see_snd, id, x, y);
      END
    END
    ELSE IF (st = 'attack') THEN
    BEGIN
      st_tics = st_tics - 1;
      ang = ATAN2(py - y, px - x);
      idx = MINVALUE(CHAR_LENGTH(atk_fr) - 1, (st_len - st_tics) / 8);
      frame = SUBSTRING(atk_fr FROM 1 + idx FOR 1);
      -- A_FatAttack1/2/3: the mancubus fires three volleys of two fireballs,
      -- as each "H" frame of its GHI GHI GHI G attack begins. FATSPREAD is
      -- 11.25°: aimed + 1 spread, aimed − 2 spreads, then ± half a spread.
      IF (ttype = 67 AND pdead = 0 AND st_len - st_tics IN (8, 32, 56)) THEN
      BEGIN
        n = (st_len - st_tics - 8) / 24;                        -- volley 0, 1, 2
        EXECUTE PROCEDURE play_sound('DSFIRSHT', id, x, y);
        EXECUTE PROCEDURE monster_missile(id, missile_type, x, y, z, rad,
          ang + CASE n WHEN 2 THEN -0.09817e0 ELSE 0 END);
        EXECUTE PROCEDURE monster_missile(id, missile_type, x, y, z, rad,
          ang + CASE n WHEN 0 THEN 0.19635e0 WHEN 1 THEN -0.39270e0 ELSE 0.09817e0 END);
      END
      IF (st_tics = 7 AND pdead = 0 AND ttype <> 67) THEN
      BEGIN
        melee_range = 60 + rad / 2;
        EXECUTE PROCEDURE play_sound(IIF(atk_kind = 'missile' AND dist < melee_range, 'DSCLAW', atk_snd), id, x, y);
        IF (atk_kind = 'hitscan') THEN
        BEGIN
          IF (check_sight(x, y, z + hgt * 0.75e0, px, py, pz + 41) = 1) THEN
          BEGIN
            n = 0;
            WHILE (n < shots) DO
            BEGIN
              IF (RAND() < MAXVALUE(0.15e0, 0.85e0 - dist / 1500)) THEN
                EXECUTE PROCEDURE damage_player(3 * (1 + CAST(FLOOR(RAND() * 5) AS INTEGER)));
              n = n + 1;
            END
          END
        END
        ELSE IF (atk_kind = 'melee' OR (atk_kind = 'missile' AND dist < melee_range)) THEN
        BEGIN
          IF (dist < melee_range + 16) THEN
            EXECUTE PROCEDURE damage_player(dmg_lo + CAST(FLOOR(RAND() * (dmg_hi - dmg_lo + 1)) AS INTEGER));
        END
        ELSE IF (atk_kind = 'missile' AND NOT (missile_type = 3006 AND
                 (SELECT COUNT(*) FROM things s WHERE s.thing_type = 3006 AND s.st NOT IN ('dying', 'dead')) >= 20)) THEN
        BEGIN
          EXECUTE PROCEDURE monster_missile(id, missile_type, x, y, z, rad, ang);
        END
      END
      IF (st_tics <= 0) THEN
      BEGIN
        st = 'chase';
        st_tics = 0;
        reaction = 3;
      END
    END
    ELSE IF (st = 'chase') THEN
    BEGIN
      st_tics = st_tics - 1;
      IF (st_tics <= 0) THEN
      BEGIN
        st_tics = IIF(spd >= 10, 3, 4);
        step = step + 1;
        frame = SUBSTRING(walk_fr FROM 1 + MOD(step, CHAR_LENGTH(walk_fr)) FOR 1);
        IF (reaction > 0) THEN reaction = reaction - 1;
        melee_range = 60 + rad / 2;
        IF (pdead = 0 AND reaction = 0 AND dist < 2048
            AND ((atk_kind = 'melee' AND dist < melee_range)
                 OR (atk_kind IN ('hitscan', 'missile')
                     AND (dist < melee_range OR RAND() * 256 >= MINVALUE(200, MAXVALUE(0, dist - 192) / 2))))
            AND check_sight(x, y, z + hgt * 0.75e0, px, py, pz + 41) = 1) THEN
        BEGIN
          st = 'attack';
          st_len = CHAR_LENGTH(atk_fr) * 8;
          st_tics = st_len;
          frame = SUBSTRING(atk_fr FROM 1 FOR 1);
          ang = ATAN2(py - y, px - x);
          IF (ttype = 67) THEN EXECUTE PROCEDURE play_sound('DSMANATK', id, x, y);
        END
        ELSE IF (dist > melee_range - 8) THEN
        BEGIN
          -- P_NewChaseDir, simplified: straight at the player, then 45° and
          -- 90° either side, then a random heading.
          a0 = ATAN2(py - y, px - x);
          IF (pdead = 1) THEN a0 = ang;
          n = 0;
          ok = 0;
          WHILE (n < 6 AND ok = 0) DO
          BEGIN
            try_ang = CASE n WHEN 0 THEN a0 WHEN 1 THEN a0 + PI() / 4 WHEN 2 THEN a0 - PI() / 4
                             WHEN 3 THEN a0 + PI() / 2 WHEN 4 THEN a0 - PI() / 2
                             ELSE RAND() * 2 * PI() END;
            nx = x + COS(try_ang) * spd;
            ny = y + SIN(try_ang) * spd;
            EXECUTE PROCEDURE check_position(id, nx, ny, z, rad, hgt, 1) RETURNING_VALUES ok, fz, cz, dz, sec;
            n = n + 1;
          END
          IF (ok = 1) THEN
          BEGIN
            x = nx;
            y = ny;
            z = fz;
            ang = try_ang;
          END
        END
      END
    END

    IF (del = 1) THEN
      DELETE FROM things t WHERE t.id = :id;
    ELSE
      UPDATE things t
         SET x = :x, y = :y, z = :z, angle = :ang, st = :st, st_tics = :st_tics, st_len = :st_len,
             step = :step, reaction = :reaction, frame = :frame, sector_id = :sec
       WHERE t.id = :id;
  END
END^

-- Light specials: T_LightFlash, T_StrobeFlash, T_Glow, T_FireFlicker.
CREATE OR ALTER PROCEDURE lights_think (tic INTEGER)
AS
BEGIN
  UPDATE sectors
     SET light = CASE special
                   WHEN 1  THEN IIF(MOD(:tic + id * 13, 71) < 7, min_light, base_light)
                   WHEN 2  THEN IIF(MOD(:tic + id * 7, 20) < 5, base_light, min_light)
                   WHEN 12 THEN IIF(MOD(:tic, 20) < 5, base_light, min_light)
                   WHEN 3  THEN IIF(MOD(:tic + id * 7, 40) < 5, base_light, min_light)
                   WHEN 13 THEN IIF(MOD(:tic, 40) < 5, base_light, min_light)
                   WHEN 8  THEN min_light + ABS(MOD(:tic * 8, 2 * (base_light - min_light) + 1) - (base_light - min_light))
                   WHEN 17 THEN IIF(MOD(:tic, 4) = 0, base_light - 16 * CAST(FLOOR(RAND() * 4) AS INTEGER), light)
                   ELSE light
                 END
   WHERE special IN (1, 2, 3, 8, 12, 13, 17);
END^

-- ── the tic ───────────────────────────────────────────────────────────────
-- G_Ticker: called by the browser with the input held since the last frame;
-- runs `tics` 35 Hz game tics and returns the status bar.
CREATE OR ALTER PROCEDURE doom_tic (
  tics INTEGER, fwd DOUBLE PRECISION, side DOUBLE PRECISION, turn DOUBLE PRECISION,
  fire SMALLINT, use_key SMALLINT, weapon_sel SMALLINT, run SMALLINT)
RETURNS (
  tic INTEGER, health INTEGER, armor INTEGER, bullets INTEGER, shells INTEGER, weapon SMALLINT,
  has_shotgun SMALLINT, has_chaingun SMALLINT, keycards INTEGER,
  rockets INTEGER, cells INTEGER, has_launcher SMALLINT, has_plasma SMALLINT, has_bfg SMALLINT,
  has_chainsaw SMALLINT, has_ssg SMALLINT,
  max_bullets INTEGER, max_shells INTEGER, max_rockets INTEGER, max_cells INTEGER,
  attack_tics INTEGER, attack_len INTEGER, damage_count INTEGER, bonus_count INTEGER,
  msg VARCHAR(80), dead SMALLINT, exit_kind SMALLINT,
  kills INTEGER, total_kills INTEGER, items INTEGER, total_items INTEGER,
  secrets INTEGER, total_secrets INTEGER,
  px DOUBLE PRECISION, py DOUBLE PRECISION, pangle DOUBLE PRECISION, view_z DOUBLE PRECISION,
  sides_rev INTEGER, map_name VARCHAR(8))
AS
DECLARE i INTEGER = 0;
BEGIN
  DELETE FROM sound_events e
   WHERE e.tic < (SELECT g.tic FROM game g WHERE g.id = 1) - 70;
  WHILE (i < tics) DO
  BEGIN
    UPDATE game g SET tic = g.tic + 1 WHERE g.id = 1;
    SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
    EXECUTE PROCEDURE player_think(fwd, side, turn / tics, fire, use_key, IIF(i = 0, weapon_sel, 0), run, tic);
    EXECUTE PROCEDURE movers_think;
    EXECUTE PROCEDURE monsters_think(tic);
    IF (MOD(tic, 2) = 0) THEN EXECUTE PROCEDURE lights_think(tic);
    UPDATE player p
       SET damage_count = MAXVALUE(0, p.damage_count - 1),
           bonus_count = MAXVALUE(0, p.bonus_count - 1),
           msg_tics = MAXVALUE(0, p.msg_tics - 1)
     WHERE p.id = 1;
    i = i + 1;
  END
  SELECT g.tic, p.health, p.armor, p.bullets, p.shells, p.weapon, p.has_shotgun, p.has_chaingun, p.keycards,
         p.rockets, p.cells, p.has_launcher, p.has_plasma, p.has_bfg, p.has_chainsaw, p.has_ssg,
         p.max_bullets, p.max_shells, p.max_rockets, p.max_cells,
         p.attack_tics, p.attack_len, p.damage_count, p.bonus_count, IIF(p.msg_tics > 0, p.msg, NULL),
         p.dead, g.exit_kind, p.kills, g.total_kills, p.items, g.total_items, p.secrets, g.total_secrets,
         t.x, t.y, t.angle, p.view_z, g.sides_rev, g.map_name
    FROM player p JOIN things t ON t.id = p.thing_id CROSS JOIN game g
   WHERE p.id = 1 AND g.id = 1
    INTO tic, health, armor, bullets, shells, weapon, has_shotgun, has_chaingun, keycards,
         rockets, cells, has_launcher, has_plasma, has_bfg, has_chainsaw, has_ssg,
         max_bullets, max_shells, max_rockets, max_cells,
         attack_tics, attack_len, damage_count, bonus_count, msg, dead, exit_kind,
         kills, total_kills, items, total_items, secrets, total_secrets, px, py, pangle, view_z,
         sides_rev, map_name;
  SUSPEND;
END^

-- ── level setup ───────────────────────────────────────────────────────────
-- P_SetupLevel: derive everything the hot paths need from the raw lumps,
-- then P_SpawnMapThing for the chosen skill.
CREATE OR ALTER PROCEDURE init_map (map_name VARCHAR(8), skill_bit INTEGER, new_game SMALLINT)
AS
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
        light_delta = CASE WHEN s.ay = s.bby THEN -16 WHEN s.ax = s.bx THEN 16 ELSE 0 END;

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
          INSERT INTO line_blocks (bx, by_, line_id) VALUES (:cx, :cy, :lid);
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

  MERGE INTO ssectors ss
  USING (SELECT ss2.id, sd.sector_id
           FROM ssectors ss2
           JOIN segs sg ON sg.id = ss2.first_seg
           JOIN linedefs l ON l.id = sg.linedef
           JOIN sidedefs sd ON sd.id = IIF(sg.side_ = 0, l.front_side, l.back_side)) s
     ON ss.id = s.id
   WHEN MATCHED THEN UPDATE SET sector_id = s.sector_id;

  UPDATE game
     SET tic = 0, exit_kind = 0, noise_tic = -1000, map_name = :map_name,
         root_node = (SELECT MAX(id) FROM nodes)
   WHERE id = 1;

  UPDATE sectors s SET sky = IIF(EXISTS (SELECT 1 FROM flats f WHERE f.id = s.ceil_flat AND f.is_sky = 1), 1, 0);
  UPDATE sectors s
     SET min_light = (SELECT MIN(n.base_light)
                        FROM linedefs l
                        JOIN sectors n ON n.id = IIF(l.front_sector = s.id, l.back_sector, l.front_sector)
                       WHERE (l.front_sector = s.id OR l.back_sector = s.id)
                         AND l.back_sector IS NOT NULL AND n.id <> s.id);
  UPDATE sectors SET min_light = IIF(special IN (2, 3, 12, 13), 0, base_light)
   WHERE min_light IS NULL OR min_light >= base_light;

  -- things for this skill level, minus multiplayer-only ones
  INSERT INTO things (id, thing_type, kind, x, y, angle, flags, hp, radius, height, solid, st, frame)
  SELECT NEXT VALUE FOR thing_seq, m.ttype, tt.kind, m.x, m.y, m.angle * PI() / 180, m.flags,
         tt.hp, tt.radius, tt.height, tt.solid, 'idle',
         IIF(tt.kind = 'monster', SUBSTRING(tt.walk_fr FROM 1 FOR 1), NULL)
    FROM map_things m JOIN thing_types tt ON tt.thing_type = m.ttype
   WHERE BIN_AND(m.flags, 16) = 0 AND BIN_AND(m.flags, :skill_bit) <> 0 AND tt.kind <> 'player';

  -- the player
  SELECT FIRST 1 x, y, angle * PI() / 180 FROM map_things WHERE ttype = 1 INTO px, py, pa;
  tid = NEXT VALUE FOR thing_seq;
  INSERT INTO things (id, thing_type, kind, x, y, angle, hp, radius, height, solid, st)
  VALUES (:tid, 1, 'player', :px, :py, :pa, 100, 16, 56, 1, 'idle');

  -- Every thing's sector in one set-based pass: a recursive CTE walks the BSP
  -- tree for all of them at once.
  FOR WITH RECURSIVE walk (tid, px, py, node) AS (
        SELECT t.id, t.x, t.y, g.root_node FROM things t CROSS JOIN game g WHERE g.id = 1
        UNION ALL
        SELECT w.tid, w.px, w.py,
               IIF((w.py - n.y) * n.dx < n.dy * (w.px - n.x), n.right_child, n.left_child)
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

  UPDATE game g
     SET total_kills = (SELECT COUNT(*) FROM things WHERE kind IN ('monster', 'keen')),
         total_items = (SELECT COUNT(*) FROM things WHERE kind = 'item'),
         total_secrets = (SELECT COUNT(*) FROM sectors WHERE special = 9)
   WHERE id = 1;

  IF (new_game = 1) THEN
    UPDATE player
       SET health = 100, armor = 0, bullets = 50, shells = 0, max_bullets = 200, max_shells = 50,
           weapon = 2, has_shotgun = 0, has_chaingun = 0, has_launcher = 0, has_plasma = 0, has_bfg = 0,
           has_chainsaw = 0, has_ssg = 0,
           rockets = 0, cells = 0, max_rockets = 50, max_cells = 300
     WHERE id = 1;
  UPDATE player
     SET thing_id = (SELECT MAX(id) FROM things WHERE kind = 'player'),
         keycards = 0, kills = 0, items = 0, secrets = 0, dead = 0, attack_tics = 0,
         damage_count = 0, bonus_count = 0, view_h = 41, use_down = 0,
         msg = :map_name, msg_tics = 105
   WHERE id = 1;
  UPDATE player p SET view_z = (SELECT z FROM things t WHERE t.id = p.thing_id) + 41 WHERE id = 1;
END^

SET TERM ; ^
