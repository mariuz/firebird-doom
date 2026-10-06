# Firebird DOOM

DOOM, simulated and rendered **inside the Firebird SQL database**, running entirely in your
browser on [Firebird 6 compiled to WebAssembly](https://github.com/mariuz/electric-firebird).

**▶ Play: https://mariuz.github.io/firebird-doom/**

Every game tic is a PSQL procedure call. Every frame is a `SELECT`. JavaScript only reads the
keyboard and paints the rows Firebird returns.

![E1M1 rendered by Firebird: the opening room, a dead zombieman and the status bar](docs/screenshot-e1m1.png)

| | |
|---|---|
| ![Two monsters, sprites picked and projected by FRAME_SPRITES](docs/screenshot-monster.png) | ![E1M2: pillars, steps and a lit doorway](docs/screenshot-e1m2.png) |
| ![Phase 2 MAP11: Commander Keen hanging in his alcove](docs/screenshot-keen.png) | ![Phase 2 MAP30: the Icon of Sin's brain](docs/screenshot-icon.png) |

<sub>These screenshots come from `npm run screenshots`, which runs the same SQL and
rasteriser as the page, headless in Node.</sub>

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
| `A_Tracer` (revenant), `A_FatAttack1/2/3` (mancubus) | homing and volleys in `MONSTERS_THINK`, `MONSTER_MISSILE` |
| `A_BossDeath`, `A_KeenDie` | `BOSS_DEATH`, `KEEN_DIE` |
| `A_BrainSpit`, `A_SpawnFly`, `A_BrainScream` (the Icon of Sin) | the `shooter`, `cube` and `brain` kinds in `MONSTERS_THINK` |
| `MF_SPAWNCEILING` (hanging bodies, Commander Keen) | `THING_TYPES.HANG`, placed in `INIT_MAP` |
| `P_LineAttack` (pistol, shotgun, chaingun, fist) | `HITSCAN` |
| `A_Saw`, `A_FireShotgun2` (chainsaw, super shotgun) | `HITSCAN` at melee range / 20 pellets; reload sounds timed in `PLAYER_THINK` |
| `P_SpawnPlayerMissile`, `P_RadiusAttack`, `A_BFGSpray` (rocket launcher, plasma gun, BFG) | `FIRE_MISSILE`, `RADIUS_ATTACK`, `BFG_SPRAY`; projectiles fly in `MONSTERS_THINK` |
| `P_TouchSpecialThing` | pickups in `PLAYER_THINK` |
| light flashes, strobes, glows | `LIGHTS_THINK` |
| `R_RenderBSPNode`, `R_CheckBBox`, `R_ClipSolidWallSegment` (solidsegs) | `RENDER_SLICES_BSP` ([sql/render.sql](sql/render.sql)) |
| `r_segs.c` clip arrays, `markceiling` / `markfloor` | `RENDER_WALLS` / `FRAME_WALLS` (or `FRAME_WALLS_WINDOWED`) |
| `r_plane.c` visplanes: `R_FindPlane`, `R_CheckPlane`, `R_MakeSpans`, `R_MapPlane` | `c_top`/`c_bot`/`f_top`/`f_bot` per slice, `FRAME_VISPLANES`; spans in [src/renderer.js](src/renderer.js) |
| `r_things.c` | `RENDER_SPRITES` / `FRAME_SPRITES` |
| `S_StartSound` (+ `sfxinfo` sounds per monster) | `PLAY_SOUND` / `SECTOR_SOUND` → `SOUND_EVENTS`; played by [src/audio.js](src/audio.js) |
| `I_PlaySong` with the OPL `GENMIDI` bank | [src/music.js](src/music.js): MUS + MIDI parser, FM synthesiser |

### The renderer

There are two wall renderers. You can switch between them under **Renderer** in the page's
settings; the choice is stored in `VIEWCFG.USE_BSP`.

**BSP front to back with solidsegs (the default).** `RENDER_SLICES_BSP` walks `NODES` from the
root like `R_RenderBSPNode`, nearer child first. Before entering the farther child it projects
that child's bounding box onto the screen (`R_CheckBBox`) and skips the whole subtree if
every column it covers is already hidden. In each subsector it projects the segs that face the
viewer (`R_AddLine`). When a seg is solid (one-sided, or a closed door) its columns are marked
as covered (`R_ClipSolidWallSegment`). PSQL has no arrays, so DOOM's `solidsegs` list is a
`VARCHAR` with one character per screen column, and the traversal stack is a string too. The walk
stops when no `'0'` is left in the coverage string. On Freedoom's 36 maps this is **about 3×
faster** than brute force, and it finds exactly the same visible walls. CI checks that.

**Brute force.** `RENDER_SLICES` projects every linedef in front of the camera, whether or not
anything hides it.

Both generators transform into view space, clip to the near plane, and intersect each screen
column's ray with the seg. That gives an exact depth, a texture column, and the vertical
opening the seg leaves (`open_top`/`open_bot`) for whatever is behind it. `RENDER_WALLS` then
plays the part of DOOM's `ceilingclip[]`/`floorclip[]` arrays: `ORDER BY col, depth` sorts each
column front to back, and the clip window is carried down the column. The same idea, stated
declaratively, is the `FRAME_WALLS_WINDOWED` view:

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

The smoke test checks that `FRAME_WALLS_WINDOWED` matches `FRAME_WALLS` slice for slice. The
game uses the procedural clip because Firebird's window sort costs about twice as much.

Two Firebird-specific performance lessons:

* **Derived tables are inlined.** Each reference to a computed CTE column re-evaluates its whole
  expression tree, so a five-deep chain of projections took seconds. Generator procedures
  compute each value once into a variable. A PSQL loop runs at about 0.2 µs per statement in
  WASM.
* **Pin the join order.** Joining a computed range to `SCREEN_COLS` took 65 s as an inner join,
  because the optimizer drove from the wrong side. With `CROSS JOIN LATERAL` or `LEFT JOIN` it
  took 0.2 s.

### Floors and ceilings: visplanes

DOOM doesn't texture floors column by column. While drawing walls it records, for each column,
which rows of the front sector's ceiling and floor the wall leaves visible (`markceiling` and
`markfloor` in `R_StoreWallRange`). It collects those rows into **visplanes**: one per distinct
height, flat and light level, with at most one span per column. Then it draws each visplane as
horizontal spans, because every pixel in a row of a flat surface is the same distance away.

Here `RENDER_WALLS` returns those rows with every slice: `c_top`/`c_bot` for the ceiling and
`f_top`/`f_bot` for the floor, computed from the same clip window it uses for the walls. The
browser does `R_FindPlane`/`R_CheckPlane`. It groups the spans by (height, flat, light), starts
a new plane when a column is already taken, and merges all sky into one plane. `R_MakeSpans`
then sweeps each plane left to right, turning column spans into row spans. `R_MapPlane`
draws each row span with one distance and light lookup, stepping the texture coordinates
linearly. `SELECT * FROM frame_visplanes` shows the current frame's planes in the SQL console,
and the stats line under the view counts them. Across Freedoom's maps the busiest frame
needs 42, comfortably under vanilla DOOM's `MAXVISPLANES` of 128.

### Sound and music

The simulation decides what you hear. `PLAY_SOUND` inserts a row into `SOUND_EVENTS` (sound
lump, origin, map position) for:

- the player: gunfire, pain and death, a hard landing, "oof" against a wall, pickups
- monsters: sighting, attacks, pain and death (per type, from `THING_TYPES`)
- the world: doors, lifts, switches, teleports, exploding fireballs and barrels

Each frame the browser reads the rows it hasn't seen, in the same pipelined batch as the
render queries. It plays the WAD's DMX sound lumps through Web Audio. Volume falls off between
200 and 1200 units and sound is panned by the angle to the listener, like
`S_AdjustSoundParams`. A new sound from the same origin cuts off the previous one, as DOOM's
channels do.

Music comes from the WAD's `D_*` lumps (MIDI in Freedoom, MUS in the original IWADs). It plays
through a small FM synthesiser built from the WAD's own `GENMIDI` lump, the OPL2 instrument
bank DOOM's Adlib/Sound Blaster driver used. Each voice is a modulator oscillator driving a
carrier's frequency (or both summed, for additive patches), with OPL-style envelopes and the
four OPL2 waveforms. Operator feedback is baked into the waveform. Percussion uses GENMIDI's
47 drum patches. Volumes are under the view, and audio starts after your first click or key
press (a browser rule). In the devtools console, `await doom.audio.renderLevel('D_E1M1')`
renders a few seconds offline and reports the level.

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

`npm run fetch-wad` downloads Freedoom and writes `public/wads/freedoom1.wad` and
`freedoom2.wad`, minus PC-speaker sounds and demos. The page's **Game** setting switches between
them. *Phase 1* plays like DOOM (E1M1–E4M9). *Phase 2* plays like DOOM II (MAP01–MAP32), with
the super shotgun, the megasphere and DOOM II's monsters. Phase 2 downloads only when you pick it. `npm test` runs the game SQL in the real WASM engine under Node. `npm run serve` builds
`dist/` and serves it on http://localhost:8080 **without** COOP/COEP headers, just like
GitHub Pages. That way the service worker is what makes the page cross-origin isolated
(Firebird's pthreads need `SharedArrayBuffer`).

You can also load your own `DOOM1.WAD` / `DOOM.WAD` / `DOOM2.WAD` with the file picker. Nothing
is uploaded anywhere.

`npm run test:all-maps` loads, plays and renders every map in the WAD, and fires each map's first
teleporter. `npm run test:weapons` fires the rocket launcher, plasma gun, BFG, chainsaw and, when the WAD
has it (`WAD=public/wads/freedoom2.wad`), the super shotgun at a monster. It checks ammo,
sounds, damage, splash and pickups. `npm run test:specials` checks that hanging decorations hang. It also checks that the boss-death
specials fire (E1M8, E2M8, E3M8, MAP07), that the last Commander Keen opens the 666 door, and that
the Icon of Sin spits cubes, spawns monsters and ends the game when its brain dies. Use
`WAD=public/wads/freedoom2.wad` for the Phase 2 parts. `npm run test:renderers` compares the BSP and brute-force renderers from several
spots and headings on every map, and reports the speed-up. `npm run screenshots` regenerates
`docs/*.png`. `node scripts/bench.mjs queries.sql` times SQL statements against a loaded map, with
statements separated by `-- @@` lines.

## Controls

Click the view to capture the mouse. <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the
arrow keys move, <kbd>Ctrl</kbd> or a click fires, <kbd>Space</kbd>/<kbd>E</kbd> uses,
<kbd>Shift</kbd> runs, <kbd>1</kbd>–<kbd>7</kbd> pick weapons (fist, pistol, shotgun, chaingun, rocket
launcher, plasma gun, BFG9000). As in DOOM II, pressing <kbd>1</kbd> again toggles the chainsaw and
<kbd>3</kbd> again the super shotgun. <kbd>Tab</kbd> shows the
automap, and <kbd>P</kbd> pauses. Under the view you can set **Detail** (320 or 160 columns) and
**Renderer** (BSP + solidsegs, or brute force), plus **Sound** and **Music** volume. These settings
are remembered in your browser. The SQL console under the game queries the live game
database. Try the `IDKFA` button.

## Deploying

[.github/workflows/pages.yml](.github/workflows/pages.yml) runs on every push to `main`. It
installs, fetches and caches Freedoom, runs the SQL smoke test and the BSP-vs-brute-force
renderer check, builds, and publishes `dist/` to
GitHub Pages. Pull requests run everything except the deploy.

## Simplifications

Monster movement, attack timing and accuracy follow DOOM's rules, not its exact frame tables.
Projectiles fly flat, and there are no crushers. Most DOOM II monsters reuse the existing
attack kinds. Two are faithful: revenant missiles home like `A_Tracer` (turning up to 16.875° every
4 tics and trailing smoke), and the mancubus fires DOOM's three volleys of two fireballs
(`A_FatAttack1/2/3`). The arch-vile's fire is still an instant hit, and the revenant has no
punch. Music is an approximation of OPL2
FM synthesis, not a cycle-exact emulator.
Large maps with many monsters awake at once can still drop below 10 fps. The *Low* detail setting (160
columns, like DOOM's own) halves the render cost.

## Credits

* Engine: [Electric Firebird](https://github.com/mariuz/electric-firebird) (`firebird-wasm`, Apache-2.0)
* Game data: [Freedoom](https://freedoom.github.io/) (BSD-3-Clause)
* DOOM © id Software. This is a clean-room SQL re-implementation that reads the WAD format.
* Inspired by [SQL DOOM / DOOMQL](https://github.com/cedardb/sqldoom) by CedarDB and
  [duckdb-doom](https://github.com/patricktrainer/duckdb-doom)

MIT licensed.
