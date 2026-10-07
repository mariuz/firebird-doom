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
| ![After MAP30: Freedoom's story text typed over the RROCK17 flat](docs/screenshot-finale-text.png) | ![The cast call: each monster on BOSSBACK under its name](docs/screenshot-finale-cast.png) |
| ![The intermission after E1M2: kills, items, secrets, time and par (example numbers)](docs/screenshot-intermission.png) | |
| ![A spectre in E1M2: a shimmer of fuzz, darker than what's behind it](docs/screenshot-spectre.png) | ![The same view, invulnerable: COLORMAP 32, the inverse greys](docs/screenshot-invuln.png) |

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
| `G_DoCompleted`: which map comes next, secret exits included | [src/progress.js](src/progress.js) |
| `EV_DoCeiling` crushers, `EV_CeilingCrushStop`, `raiseFloorCrush`, `P_ChangeSector` | the `crush` mover kind, `CRUSH_THINGS` |
| `P_SpawnMissile` / `P_SpawnPlayerMissile` aiming, `P_AimLineAttack`, `P_ZMovement` for missiles | `MONSTER_MISSILE`, `FIRE_MISSILE`, `AIM_SLOPE`; 3D flight in `MONSTERS_THINK` |
| `A_Look` / `A_Chase` / attacks, pain, death, barrels | `MONSTERS_THINK` |
| `P_DamageMobj` retargeting, `PIT_CheckThing` species rule (infighting) | `DAMAGE_THING(..., src)`, `THINGS.TARGET_ID` / `THRESHOLD`, `HURT_TARGET` |
| `P_NoiseAlert`, `P_RecursiveSound` (gunfire wakes monsters) | `NOISE_ALERT` flooding `SOUND_LINKS`, `SECTORS.SOUND_HEARD` |
| `A_Tracer`, `A_SkelFist` (revenant), `A_FatAttack1/2/3` (mancubus), `A_VileTarget` / `A_Fire` / `A_VileAttack` / `A_VileChase` (arch-vile), `A_PainShootSkull` / `A_PainDie` | `MONSTERS_THINK` (the `melee`, `heal` and `raise` states, the `flame` kind), `MONSTER_MISSILE`, `PAIN_SHOOT_SKULL` |
| `A_BossDeath`, `A_KeenDie` | `BOSS_DEATH`, `KEEN_DIE` |
| `A_BrainSpit`, `A_SpawnFly`, `A_BrainScream` (the Icon of Sin) | the `shooter`, `cube` and `brain` kinds in `MONSTERS_THINK` |
| `MF_SPAWNCEILING` (hanging bodies, Commander Keen) | `THING_TYPES.HANG`, placed in `INIT_MAP` |
| `P_LineAttack`, `P_BulletSlope` (pistol, shotguns, chaingun, fist, chainsaw) | `HITSCAN` (in 3D, with a slope), `AIM_SLOPE` |
| `A_Saw`, `A_FireShotgun2` (chainsaw, super shotgun) | `HITSCAN` at melee range / 20 pellets; reload sounds timed in `PLAYER_THINK` |
| `P_SpawnPlayerMissile`, `P_RadiusAttack`, `A_BFGSpray` (rocket launcher, plasma gun, BFG) | `FIRE_MISSILE`, `RADIUS_ATTACK`, `BFG_SPRAY`; projectiles fly in `MONSTERS_THINK` |
| `P_TouchSpecialThing` | pickups in `PLAYER_THINK` |
| light flashes, strobes, glows | `LIGHTS_THINK` |
| `R_RenderBSPNode`, `R_CheckBBox`, `R_ClipSolidWallSegment` (solidsegs) | `RENDER_SLICES_BSP` ([sql/render.sql](sql/render.sql)) |
| `r_segs.c` clip arrays, `markceiling` / `markfloor` | `RENDER_WALLS` / `FRAME_WALLS` (or `FRAME_WALLS_WINDOWED`) |
| `r_plane.c` visplanes: `R_FindPlane`, `R_CheckPlane`, `R_MakeSpans`, `R_MapPlane` | `c_top`/`c_bot`/`f_top`/`f_bot` per slice, `FRAME_VISPLANES`; spans in [src/renderer.js](src/renderer.js) |
| `I_SetPalette` / `I_FinishUpdate`: palette indices to colours | [src/present.js](src/present.js): WebGL palette shader, Canvas 2D fallback |
| `r_things.c`, `R_DrawFuzzColumn` (`MF_SHADOW`) | `RENDER_SPRITES` / `FRAME_SPRITES` (its `fuzz` column); fuzz in [src/renderer.js](src/renderer.js) |
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

### Presenting: palette indices, a WebGL shader, or Canvas 2D

Like DOOM, the rasteriser works in palette indices. The 3D view and the 320×200 screen hold one
byte per pixel, already lit through `COLORMAP`: light levels, the invulnerability greys and
spectre fuzz. Which of the 14 `PLAYPAL` palettes colours them (normal, pain red, pickup gold,
radiation-suit green) is decided once per frame, when the screen is presented (`I_SetPalette`,
[src/present.js](src/present.js)):

- **WebGL (palette shader):** the screen is uploaded as a 320×200 `LUMINANCE` texture. A
  fragment shader looks each index up in a 256×14 texture holding every palette, drawing at
  the canvas's real display size.
- **Canvas 2D:** a palette loop into an `ImageData` and `putImageData`. It's used when chosen,
  or when WebGL can't be had.

**Display** in the settings picks one. A canvas keeps the kind of context it first gave out,
so switching swaps in a fresh canvas element. **Smooth upscaling** blends neighbouring pixels.
With WebGL that's bilinear filtering inside the shader on the colours, never on the indices,
since blending palette numbers would give nonsense colours. With Canvas 2D it's the browser's
own image smoothing. Off, every pixel stays a crisp 4:3 block. The automap draws into the
screen in DOOM's own palette colours (`am_map.c`'s `REDS`, `BROWNS`, `YELLOWS`, `GRAYS`,
`GREENS`, `WHITE`), over the view darkened through `COLORMAP` 24. Screenshots and tests read
the screen through `toRGBA`.

### Spectres: fuzz

The spectre (`MF_SHADOW`, the `shadow` flag in `THING_TYPES`) comes out of `FRAME_SPRITES` with
`fuzz = 1`, and the rasteriser draws it with `R_DrawFuzzColumn`. None of the sprite's own colours
reach the screen. Each opaque pixel copies the pixel one row above or below it, chosen by DOOM's
50-entry `fuzzoffset` table, and darkens it through `COLORMAP` 6. The table position carries
from pixel to pixel and from frame to frame, so the outline ripples as you watch. The screen
holds palette indices, as DOOM's did, so darkening is a single `COLORMAP` lookup. In a dim room a
spectre is as hard to see as in DOOM.

The partial invisibility sphere uses the same fuzz. Picking it up gives 60 seconds
(`INVISTICS`, 2100 tics in `PLAYER.INVIS_TICS`, cleared at the end of a level). Your weapon is
drawn as fuzz, and it flickers back in the last four seconds. Monsters aim the way they do at
any `MF_SHADOW` target, which includes a spectre they are fighting. `A_FaceTarget` turns up to
45° wide, so a zombie's volley lands only if that error still points at your body, and a lost
soul's charge goes astray. `P_SpawnMissile` sends projectiles up to 22.5° off. Melee attacks
still land. At 280 units a zombieman hits about 65% of the time when it can see you, and about
15% when you're partially invisible.

### Invulnerability

The invulnerability sphere gives 30 seconds (`INVULNTICS`, 1050 tics in `PLAYER.INVULN_TICS`).
`DAMAGE_PLAYER` ignores every hit below 1000, so a telefrag (10000) still kills. While it lasts, the
view uses a fixed colormap, as DOOM's `R_SetupFrame` does. `COLORMAP` 32, the inverse greys,
replaces every light level on walls, flats, sprites and your weapon, flickering off in the last
four seconds. The sky stays in colour, as in vanilla, and the status bar shows the god face.

### Radiation suit and light amplification goggles

The radiation suit (`pw_ironfeet`, 2100 tics in `PLAYER.IRON_TICS`) keeps out nukage and slime
(sector specials 7 and 5). The worst floors (4 and 16) still get through 5 times in 256, and
E1M8's exit floor (11) hurts regardless, as in `P_PlayerInSpecialSector`. While you wear it, the
screen takes palette 13 (`RADIATIONPAL`), the green tint, unless a pain or pickup flash is
showing (`ST_doPaletteStuff`). The light amplification goggles (`pw_infrared`, 4200 tics in
`PLAYER.INFRA_TICS`) set fixed colormap 1, nearly full bright everywhere. Invulnerability's
inverse greys win when both are on. Both effects flicker off in their last four seconds.

### Berserk

The berserk pack raises your health to 100 (`P_GiveBody`), puts the fist in your hand and sets
`pw_strength`. `PLAYER.STRENGTH_TICS` counts up from 1 and lasts until the level ends. While it
does, `A_Punch` multiplies the fist's 2d10 by ten. The screen flushes red and fades over 768 tics:
`ST_doPaletteStuff` treats `12 - (strength >> 6)` as pain whenever it's stronger than any real
pain flash.

### The automap and the computer area map

The automap (<kbd>Tab</kbd>) draws only the lines you've seen, as DOOM's does. Every line id that
`FRAME_WALLS` returns counts as seen (`ML_MAPPED`) for the rest of the level, and lines the map
pre-marks with flag 256 count too. Seen lines get `AM_drawWalls`' colours: red for walls, brown for
floor steps, yellow for ceiling steps, dark red for teleporters. Secret lines pass for plain walls
and `ML_DONTDRAW` lines never show. The computer area map sets `pw_allmap` (`PLAYER.ALLMAP`)
for the level, and every line you haven't seen yet then shows in grey. As with `P_GivePower`,
you can only carry one, so a second one stays on the floor. The colour rules live in
[src/automap.js](src/automap.js) and are tested headless.

Typing **IDDT** with the automap open cycles DOOM's `am_cheating`, as `AM_Responder` does. Once
shows every line, hidden (`ML_DONTDRAW`) and unseen ones included, with flat two-sided openings
in grey (`TSWALLCOLORS`). Twice also draws every thing in the level as a green triangle facing
its way (`AM_drawThings`), read live from `THINGS`. A third time turns it off. Like DOOM, the cheat
prints no message and isn't stored in the database.

### Level order

When you leave a level, [src/progress.js](src/progress.js) picks the next one, as `G_DoCompleted`
does. On DOOM I, a secret exit leads to E?M9, and E?M9 returns to the map after the one with the
secret exit. E?M8 carries on into the next episode, since there's no finale screen. On DOOM II,
MAP15's secret exit leads to MAP31 and MAP31's to MAP32, and the normal exits of both secret
levels return to MAP16. A secret exit on any other map counts as a normal one. MAP30 ends the
game with the finale below. Only a WAD without the finale's pictures goes back to MAP01.

### The intermission

Between levels comes `wi_stuff.c`'s screen ([src/intermission.js](src/intermission.js)), to `D_INTER`
(`D_DM2INT` on DOOM II). It shows the level's name patch with "Finished" under it. Then kills,
items and secrets count up as percentages, two points a tic, with a pistol shot every four tics
and a barrel explosion as each one settles. The time and par count up three seconds a tic.
Pars come from vanilla's tables, and episode 4 has none. Fire or use jumps to the final numbers,
and the next press moves on (`WI_checkForAccelerate`; only a new press counts, so the button
that hit the exit switch doesn't). DOOM I then shows the episode map: a splat on every level
done, the secret level's once you've been there, and a blinking "you are here" on the next,
under "Entering" and the next level's name. The episode maps come alive as well
(`WI_updateAnimatedBack`, vanilla's `anim_t` tables). Episodes 1 and 3 cycle their little
animations, three frames 11 tics apart from a random start. On episode 2, the part of the map
you're entering lights up and stays lit, restarting when "Entering" comes up. Freedoom's episode
pictures aren't maps, so it ships the splat, pointer and animation patches as empty 1×1
placeholders, and only "Entering" shows. Load id's `doom.wad` and they all appear. DOOM II says "Entering" for ten tics
and moves on. It skips this after MAP30, and on the way into MAP31, whose name stays a surprise, both
where vanilla's `wbs->next` is 30. The secret levels get their own names (`CWILV30`, `CWILV31`)
and pars (2:00 and 0:30), and their exits back to MAP16 announce it. Then comes any text screen, then the next level. As in vanilla,
E?M8 skips the stats and goes straight to the episode's ending. `npm run test:intermission`
checks the counting, the sounds, the skipping and the par table.

### DOOM II's text screens and finale

Finishing MAP06, MAP11 or MAP20 shows the story so far, as `G_WorldDone` does: `C1TEXT` over
`SLIME16`, `C2TEXT` over `RROCK14` and `C3TEXT` over `RROCK07`, typed out like the ending's
text below to `D_READ_M`. After 50 tics, fire or use goes on to the next map with your
inventory intact. The two secret levels get theirs on the way in: leaving MAP15 by its secret
exit shows `C5TEXT` over `RROCK13` before MAP31, and leaving MAP31 by its secret exit shows
`C6TEXT` over `RROCK19` before MAP32. Their normal exits show nothing. A WAD without the
words (DOOM II keeps them in its executable, not its WAD) just goes straight on.

DOOM I's episodes end the way `F_StartFinale` ends them. After E?M8 the episode's text types
itself out to `D_VICTOR`, and it can't be skipped. The flats are `FLOOR4_8`, `SFLR6_1`,
`MFLR8_4` and `MFLR8_3` for the four episodes. 250 tics after the last character (`TEXTWAIT`),
the episode's art screen follows (`F_Drawer`):

- **E1:** `CREDIT` on a four-episode WAD like Freedoom's, `HELP2` otherwise.
- **E2:** `VICTORY2`.
- **E3:** the bunny scroll (`F_BunnyScroll`), to `D_BUNNY`. `PFUB2` slides off to reveal
  `PFUB1`, then "THE END" stamps in letter by letter (`END0`–`END6`), each with a pistol shot.
- **E4:** `ENDPIC`.

DOOM ends the game there, but this port carries on: fire or use takes you into the next
episode, and after E4 back to E1M1.


Finishing MAP30 starts DOOM II's ending ([src/finale.js](src/finale.js), after `f_finale.c`). First
the story text types itself out a character every three tics over the tiled `RROCK17` flat, to
`D_READ_M` (`F_TextWrite`). After 50 tics, fire or use moves on. Then the cast call (`F_StartCast`)
plays to `D_EVIL`. Each monster in turn walks on the `BOSSBACK` backdrop under its name. It
attacks every twelve frames, and the revenant alternates punch and missile. Press a key and it
dies, playing its death sound and frames, then the next one comes on (`F_CastResponder`,
`F_CastTicker`). The cast ends with the player and starts over, as in DOOM. Choosing a map
starts a new game. The words come from the WAD's `DEHACKED` lump: Freedoom ships its own story
text (`C4TEXT`) and cast names (`CC_*`), so none of id's text is reproduced. Sprites whose
front view hides in the mirrored half of a lump name (`SKELA1D1` holds frame D flipped) are
found and drawn flipped. `npm run test:finale` checks all of this without a screen.

### Cheats

Type **IDDQD**, **IDKFA**, **IDFA**, **IDCLIP**, **IDCHOPPERS**, **IDBEHOLD**<i>x</i>, **IDMYPOS**, **IDMUS**<i>xy</i> or **IDCLEV**<i>xy</i> any time during
play (`ST_Responder`). The browser spots the letters
and calls `EXECUTE PROCEDURE cheat('iddqd')`. The SQL console has buttons for both.

- **IDDQD** toggles god mode (`PLAYER.GOD`, `CF_GODMODE`). It heals you to 100, and
  `DAMAGE_PLAYER` then ignores every hit below 1000, the same rule as invulnerability. The face
  turns gold. E1M8's exit floor switches it off, a new game clears it, and it carries over from
  level to level.
- **IDKFA** hands over every weapon, ammo up to your current maximums, 200 armour and all three
  keys. The super shotgun comes only on DOOM II maps. **IDFA** does the same without the keys
  ("Ammo (no keys) Added").
- **IDCLIP** (or DOOM I's **IDSPISPOPD**) toggles no clipping (`PLAYER.NOCLIP`, `CF_NOCLIP`).
  `P_CheckPosition` says yes before looking at a single line or thing, so you walk through walls
  and monsters. No lines are checked, so none trigger as you cross them. Your height still
  follows the floor beneath you.
- **IDCHOPPERS** hands over the chainsaw ("... doesn't suck - GM"). Like vanilla, it also sets
  invulnerability to `true`, which is one tic: it cancels a running invulnerability sphere.
- **IDBEHOLD** on its own lists the choices: "inVuln, Str, Inviso, Rad, Allmap, or Lite-amp".
  Followed by **v**, **s**, **i**, **r**, **a** or **l**, it toggles that power-up. Switching one
  on gives the full time `P_GivePower` would, and berserk also heals you to 100. Switching one
  off leaves it one tic to run, and berserk goes straight to 0. As in vanilla, the computer area
  map can't be taken back.
- **IDMYPOS** shows where you are the way DOOM printed it, `ang=0x…;x,y=(0x…,0x…)`: the
  angle in BAMs and x/y in 16.16 fixed point, as 32-bit hex. A small PSQL function, `HEX32`,
  does printf's `%x`.
- **IDMUS**<i>xy</i> changes the music ("Music Change"). DOOM I reads the digits as episode and
  map, up to vanilla's 32nd song (E4M5). DOOM II reads them as the song number, 1 to 35: 31 and 32
  are the secret levels' EVIL and ULTIMA, and 33–35 the story screens', title and intermission
  tunes. IDCLEV 31 and 32 reach MAP31 and MAP32.
  Anything else, or a song the WAD lacks, gets "IMPOSSIBLE SELECTION". It lives in the browser,
  next to the synthesiser.
- **IDCLEV**<i>xy</i> warps, as `G_DeferedInitNew` does: a new game on that map, inventory
  reset. DOOM I reads the digits as episode and map (`idclev13` is E1M3), DOOM II as the map
  number (`idclev07` is MAP07). Maps the WAD doesn't have are ignored. This cheat lives in the
  browser, because loading a map is the loader's job. [src/cheats.js](src/cheats.js) holds the
  cheat readers, tested headless.

The SQL cheats say what they did ("Degreelessness Mode On", "Very Happy Ammo Added", "No Clipping Mode ON"). A dead player can't
cheat.

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
teleporter. `npm run test:weapons` fires the rocket launcher, plasma gun, BFG, chainsaw and, when
the WAD has it (`WAD=public/wads/freedoom2.wad`), the super shotgun at a monster. It checks ammo,
sounds, damage, splash and pickups.

`npm run test:specials` checks:

- that hanging decorations hang
- that the boss-death specials fire (E1M8, E2M8, E3M8, MAP07)
- that the last Commander Keen opens the 666 door
- that the Icon of Sin spits cubes, spawns monsters and ends the game when its brain dies
- the DOOM II attacks: revenant missiles turn exactly 16.875° per update and find you, the
  revenant punches, a mancubus attack fires six fireballs at DOOM's spread angles, and the
  arch-vile's flame follows you before the blast throws you upwards, the arch-vile raises a
  corpse, and a dying pain elemental releases lost souls (but never past 20)

Use `WAD=public/wads/freedoom2.wad` for the Phase 2 parts. `npm run test:physics` drives real crushers (descent, damage, gibs, stop and resume, floor
crushers) and checks missile slopes, autoaim with its 5.625° fallback, floor impacts and the sky.
It checks infighting: a fireball turns a demon on an imp, which it then bites, and the demon
returns to you when the imp dies. A fireball bursts harmlessly on its own species, and a
zombieman's stray bullets provoke an imp in the way. An arch-vile is always provoked but never
provokes, and it flames the demon it's fighting instead of you. It checks that gunfire reaches open sectors but not past a closed door, that it wakes a monster
out of sight in earshot but not one out of earshot or in ambush. It also checks that a level
hitscan shot passes under a raised imp, that the right slope hits
it, and that the pistol finds that slope itself but not beyond DOOM's aiming window.
`npm run test:renderers` compares the
BSP and brute-force renderers from several spots and headings on every map, and reports the
speed-up. `npm run screenshots` regenerates
`docs/*.png`. `node scripts/bench.mjs queries.sql` times SQL statements against a loaded map, with
statements separated by `-- @@` lines.

## Controls

Click the view to capture the mouse. <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the
arrow keys move, <kbd>Ctrl</kbd> or a click fires, <kbd>Space</kbd>/<kbd>E</kbd> uses,
<kbd>Shift</kbd> runs, <kbd>1</kbd>–<kbd>7</kbd> pick weapons (fist, pistol, shotgun, chaingun, rocket
launcher, plasma gun, BFG9000). As in DOOM II, pressing <kbd>1</kbd> again toggles the chainsaw and
<kbd>3</kbd> again the super shotgun. <kbd>Tab</kbd> shows the
automap (type IDDT on it to reveal everything), and <kbd>P</kbd> pauses. Under the view you can set **Detail** (320 or 160 columns),
**Renderer** (BSP + solidsegs, or brute force), **Display** (WebGL palette shader or Canvas 2D),
**Smooth upscaling**, **Audio** on/off (<kbd>M</kbd>), and **Sound** and **Music** volume. These settings
are remembered in your browser. The SQL console under the game queries the live game
database. Try the `IDKFA` button.

## Deploying

[.github/workflows/pages.yml](.github/workflows/pages.yml) runs on every push to `main`. It
installs, fetches and caches Freedoom, runs the SQL smoke test and the BSP-vs-brute-force
renderer check, builds, and publishes `dist/` to
GitHub Pages. Pull requests run everything except the deploy.

## Simplifications

Monster movement, attack timing and accuracy follow DOOM's rules, not its exact frame tables.
Monsters hear gunfire the way DOOM does (`P_NoiseAlert`). Every shot, from any weapon, floods
out from your sector through every open two-sided line. A closed door stops it, and a line flagged
*sound block* lets it through once but never twice. Every sector it reaches remembers. Idle
monsters there wake up, even with no line of sight; ambush ("deaf") monsters still have to see
you. The flood is a breadth-first search in SQL: each pass is one `MERGE` over `SOUND_LINKS`, a
sector adjacency graph built at map load, and doors count live through the current sector
heights. A shot costs 3 ms on E1M1 and about 40 ms on the largest maps. It reruns at most once a
second from the same sector.

Monsters fight each other, as in DOOM. When one monster's attack hurts another, the victim turns
on the attacker and won't switch again for 100 chase steps (`BASETHRESHOLD`). After that, hurting
it yourself brings it back to you, and once its target dies it hunts you again. Monster projectiles
hit any monster in their way, except members of the shooter's own species, which they burst on
harmlessly (hell knights and barons count as one species). Zombie bullets hit whoever stands in the
line of fire, and splash damage remembers who caused it. Arch-viles follow DOOM's special rules:
their attacks provoke nobody, but an arch-vile that gets hurt always turns on the attacker,
grudge or not. Once it's fighting a monster, its flame dances on that monster and the blast lands
there, tossing its victim into the air.

Monsters have vertical physics (`P_ZMovement`). The arch-vile's blast throws its victim up at
1000 / mass units per tic, with DOOM's masses: 10 for you or an imp, which fly about 55 units
high, 2.5 for a demon and 1 for a baron. Gravity pulls things back at 1 unit/tic². They bump their
heads on low ceilings, and a monster killed in mid-air falls before it lies down. A thing's floor
and ceiling are the highest floor and lowest ceiling within its radius (`floorz`/`ceilingz`), so
one half over a step stays on it. Cacodemons, lost souls and pain elementals fly
(`MF_NOGRAVITY`): they don't fall, and they drift 4 units a tic towards their target's height
(`MF_FLOAT`) until they die, when all but the lost soul drop. Lifts carry what stands on them,
and push up what's in the air only if the floor catches it.

Crushers work. Ceiling crushers (types 6, 25, 49, 73, 77 and the silent 141) cycle between
their top and floor + 8. They deal 10 damage every 4 tics to whatever they squeeze, the slow ones
drop to ⅛ speed while crushing, and corpses turn to gibs. Types 57 and 74 stop them, and
triggering one again resumes it. Floor crushers (55, 56, 65, 94) rise to ceiling − 8, and type 44
lowers a ceiling once.

Projectiles fly in 3D. Monster missiles climb or dive towards your height, and revenant tracers
steer vertically too. Your rockets, plasma and BFG autoaim vertically at the first monster in line
(straight ahead, else 5.625° either side, as DOOM does). Missiles burst on floors and ceilings,
vanish into the sky, and only hit what they actually reach. Hitscan weapons aim the same way
(`P_BulletSlope`): bullets take the vertical slope to a monster straight ahead or 5.625° to
either side, and keep their own heading and spread. The fist and chainsaw aim at melee range.
The shot then travels in 3D (`P_LineAttack`). A two-sided line stops it only if the shot's height
where it crosses is outside the opening, a monster is hit only if the shot's height at its
distance is inside its body, and puffs appear where the shot actually strikes.

The DOOM II monsters' signature attacks follow DOOM's code:

- revenant missiles home like `A_Tracer`, turning up to 16.875° every 4 tics and trailing smoke
- the revenant punches at close range (`A_SkelFist`, 6 × 1d10)
- the mancubus fires three volleys of two fireballs (`A_FatAttack1/2/3`)
- the arch-vile conjures a flame on you that follows you while it can see you, then blasts you for
  20 and throws you upwards, while the flame explodes for 70 (`A_VileTarget`, `A_Fire`,
  `A_VileAttack`)

- the arch-vile raises corpses it walks past (`A_VileChase`): glowing hands, then the corpse plays
  its death backwards and gets up with full health; it won't raise lost souls, cyberdemons, spider
  masterminds or other arch-viles
- the pain elemental spits lost souls (`A_PainShootSkull`), and three more when it dies
  (`A_PainDie`), never past 20 and only where there's room
- lost souls charge (`A_SkullAttack`): 10 tics facing you, a scream, then a flight at 20 units a
  tic aimed at your middle. They keep flying until they hit something. Whatever they hit (you, a
  monster, a pillar) takes 3–24 damage, and a wall stops them too. Floors and ceilings bounce
  them, a shot in mid-flight stops them dead, and their range check counts half the distance, so
  they charge from far off. Souls spat out by a pain elemental charge at once

Large maps with many monsters awake at once can still drop below 10 fps. The *Low* detail setting
(160 columns, like DOOM's own) halves the render cost.

## Credits

* Engine: [Electric Firebird](https://github.com/mariuz/electric-firebird) (`firebird-wasm`, Apache-2.0)
* Game data: [Freedoom](https://freedoom.github.io/) (BSD-3-Clause)
* DOOM © id Software. This is a clean-room SQL re-implementation that reads the WAD format.
* Inspired by [SQL DOOM / DOOMQL](https://github.com/cedardb/sqldoom) by CedarDB and
  [duckdb-doom](https://github.com/patricktrainer/duckdb-doom)

MIT licensed.
