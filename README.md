# Firebird DOOM

DOOM, simulated and rendered **inside the Firebird SQL database**, running entirely in your
browser on [Firebird 6 compiled to WebAssembly](https://github.com/mariuz/electric-firebird).

**▶ Play: https://mariuz.github.io/firebird-doom/**

Every game tic is a PSQL procedure call. Every frame is a `SELECT`. JavaScript only reads the
keyboard and paints the rows Firebird returns.

This project follows CedarDB's [SQL DOOM](https://cedardb.com/blog/sqldoom/) (the original WAD,
rendered by a database) and [DOOMQL](https://cedardb.com/blog/doomql/) (a DOOM-like game in pure
SQL), and [DuckDB-DOOM](https://www.hey.earth/posts/duckdb-doom) (a SQL raycaster in the browser
through DuckDB-WASM). This one is graphical, plays real DOOM maps, and runs Firebird in the tab.

## How it works

```
 keyboard ─▶ SELECT * FROM doom_tic(tics, fwd, side, turn, fire, use, weapon, run)   ← game logic
             SELECT * FROM frame_walls      ← which wall slice is visible in which column
             SELECT * FROM frame_sprites    ← which sprite frame, where, how bright
             SELECT * FROM frame_sectors    ← live floor/ceiling heights and light
         ─▶ JS looks up texels + colormaps ─▶ <canvas>
```

| DOOM source | Firebird |
|---|---|
| WAD lumps `VERTEXES` `LINEDEFS` `SIDEDEFS` `SECTORS` `SEGS` `SSECTORS` `NODES` `THINGS` | tables of the same names ([sql/schema.sql](sql/schema.sql)) |
| `info.c` mobjinfo | `THING_TYPES` rows ([src/thinginfo.js](src/thinginfo.js)) |
| `R_PointInSubsector` | `SECTOR_AT()` walks the BSP; `INIT_MAP` locates every thing in one recursive CTE |
| `BLOCKMAP` | `LINE_BLOCKS`, a 128×128 grid built by `INIT_MAP` |
| `P_CheckPosition`, `P_TryMove` | `CHECK_POSITION`, plus wall sliding in `PLAYER_THINK` |
| `P_CheckSight` | `CHECK_SIGHT()` walks the blockmap cells along the sight line |
| `P_UseLines`, `P_CrossSpecialLine`, `EV_DoDoor/Plat/Floor`, stairs, exits | `ACTIVATE_LINE`, `MOVERS`, `MOVERS_THINK` |
| `A_Look` / `A_Chase` / attacks, pain, death, barrels | `MONSTERS_THINK` |
| `P_LineAttack` (pistol, shotgun, chaingun, fist) | `HITSCAN` |
| `P_TouchSpecialThing` | pickups in `PLAYER_THINK` |
| light flashes, strobes, glows | `LIGHTS_THINK` |
| `r_bsp.c` / `r_segs.c` / `r_plane.c` | `RENDER_SLICES` → `RENDER_WALLS` / `FRAME_WALLS` ([sql/render.sql](sql/render.sql)) |
| `r_things.c` | `RENDER_SPRITES` / `FRAME_SPRITES` |

### The renderer

`RENDER_SLICES` transforms every linedef into view space, culls back faces, clips to the
near plane, projects the line onto a range of screen columns, and intersects each column's ray
with it. That gives an exact depth, a texture column, and the vertical opening the line
leaves (`open_top`/`open_bot`) for whatever is behind it.

DOOM keeps `ceilingclip[]`/`floorclip[]` arrays and walks the BSP front to back. Here an
`ORDER BY col, depth` does the ordering, and the clip window is carried down each column
(`RENDER_WALLS`). The same idea, stated declaratively, is the `FRAME_WALLS_WINDOWED` view:

```sql
SELECT *
  FROM (SELECT s.*,
               COALESCE(MAX(open_top) OVER (PARTITION BY col ORDER BY depth
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) clip_top,
               COALESCE(MIN(open_bot) OVER (PARTITION BY col ORDER BY depth
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 1e9) clip_bot
          FROM render_slices s)
 WHERE clip_top < clip_bot
```

The smoke test checks that both produce identical slices. The game uses the procedural one
because Firebird's window sort costs about twice as much.

Two Firebird-specific performance lessons:

* **Derived tables are inlined.** Each reference to a computed CTE column re-evaluates its whole
  expression tree, so a five-deep chain of projections took seconds. Generator procedures
  compute each value once into a variable. A PSQL loop runs at about 0.2 µs per statement in
  WASM.
* **Pin the join order.** Joining a computed range to `SCREEN_COLS` took 65 s as an inner join,
  because the optimizer drove from the wrong side. With `CROSS JOIN LATERAL` or `LEFT JOIN` it
  took 0.2 s.

## Running locally

```bash
npm install
```

```bash
npm run fetch-wad
```

```bash
npm test
```

```bash
npm run serve
```

`npm run fetch-wad` downloads Freedoom and writes `public/wads/freedoom1.wad`, minus sound and
music. `npm test` runs the game SQL in the real WASM engine under Node. `npm run serve` builds
`dist/` and serves it on http://localhost:8080 **without** COOP/COEP headers, just like
GitHub Pages. That way the service worker is what makes the page cross-origin isolated
(Firebird's pthreads need `SharedArrayBuffer`).

You can also load your own `DOOM1.WAD` / `DOOM.WAD` / `DOOM2.WAD` with the file picker. Nothing
is uploaded anywhere.

`npm run test:all-maps` loads, plays and renders every map in the WAD, and fires each map's first
teleporter. `node scripts/bench.mjs queries.sql` times SQL statements against a loaded map, with
statements separated by `-- @@` lines.

## Controls

Click the view to capture the mouse. <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the
arrow keys move, <kbd>Ctrl</kbd> or a click fires, <kbd>Space</kbd>/<kbd>E</kbd> uses,
<kbd>Shift</kbd> runs, <kbd>1</kbd>–<kbd>4</kbd> pick weapons, <kbd>Tab</kbd> shows the
automap, and <kbd>P</kbd> pauses. The SQL console under the game queries the live game
database. Try the `IDKFA` button.

## Deploying

[.github/workflows/pages.yml](.github/workflows/pages.yml) runs on every push to `main`. It
installs, fetches and caches Freedoom, runs the SQL smoke test, builds, and publishes `dist/` to
GitHub Pages. Pull requests run everything except the deploy.

## Simplifications

Monster movement, attack timing and accuracy follow DOOM's rules, not its exact frame tables.
Projectiles fly flat. There's no sound, no rocket launcher, plasma or BFG, and no crushers.
Rendering doesn't use the BSP for occlusion, so every linedef in the view frustum is
projected. Adding BSP front-to-back traversal with DOOM's `solidsegs` is the obvious next
speed-up. Large maps with many monsters awake at once can drop below 10 fps. The *Low* detail
setting (160 columns, like DOOM's own) halves the render cost.

## Credits

* Engine: [Electric Firebird](https://github.com/mariuz/electric-firebird) (`firebird-wasm`, Apache-2.0)
* Game data: [Freedoom](https://freedoom.github.io/) (BSD-3-Clause)
* DOOM © id Software. This is a clean-room SQL re-implementation that reads the WAD format.
* Inspired by [SQL DOOM / DOOMQL](https://github.com/cedardb/sqldoom) by CedarDB and
  [duckdb-doom](https://github.com/patricktrainer/duckdb-doom)

MIT licensed.
