# Firebird DOOM: how it's built

This is the developer's guide: how a DOOM WAD becomes rows in Firebird, how a game tic and a frame
work, and where every piece lives. The [README](../README.md) is the tour for players and the
curious; [ROADMAP.md](ROADMAP.md) lists what's missing.

## The one rule

**Firebird decides; JavaScript draws.** The whole simulation (movement, monsters, weapons, doors,
lifts, sound propagation, damage) and the visibility half of the renderer (which wall slice is in
which column, at what depth, through which clip window, and which sprite frame faces the camera) are
SQL and PSQL running in Firebird 6.0, compiled to WebAssembly and running in a Web Worker in the
page. JavaScript turns the rows Firebird returns into pixels (texture lookups, colormap lighting,
the palette) and handles input, sound, music and the screens that aren't the 3D view (status bar,
automap, intermission, endings).

When adding a feature, put game logic in SQL. Only presentation goes in JS.

## Files

| Path | What it is |
| --- | --- |
| `sql/schema.sql` | Every table: the WAD as rows (`vertexes`, `linedefs`, `sidedefs`, `sectors`, `segs`, `ssectors`, `nodes`, `map_things`), the resource catalogue (`textures`, `flats`, `sprite_frames`, `thing_types`), live state (`game`, `player`, `things`, `movers`), and derived acceleration structures (`line_blocks`, `sound_links`, `sound_flood`, `screen_cols`, `viewcfg`). |
| `sql/game.sql` | The simulation, as PSQL procedures. `DOOM_TIC` is the entry point (see below). |
| `sql/render.sql` | The visibility half of the renderer: `RENDER_SLICES` (brute force), `RENDER_SLICES_BSP` (BSP walk with solidsegs), `RENDER_WALLS` (clipping and visplane rows), `RENDER_SPRITES`, and the views `FRAME_WALLS`, `FRAME_WALLS_WINDOWED`, `FRAME_SPRITES`, `FRAME_SECTORS`, `FRAME_VISPLANES`. |
| `src/main.js` | The page: boots Firebird, loads WADs and maps, reads input, runs the frame loop, and owns the intermission and finale objects, the settings and the cheats. |
| `src/loader.js` | WAD → Firebird: `createSchema`, `loadResources` (textures, flats, sprites, thing types), `loadMap` (one level's lumps plus `INIT_MAP`), `setView`, `setRenderer`. Inserts in chunks of 200 (see the gotchas). |
| `src/wad.js` | The WAD reader: lumps, maps, pictures (column-major `pix` plus `alpha`), texture composition, `COLORMAP`. |
| `src/thinginfo.js` | DOOM's `mobjinfo`, trimmed: every thing type's sprite, size, health, speed, frames, attacks, sounds, flags (`hang`, `floats`, `shadow`, `mass`). Loaded into `THING_TYPES`. |
| `src/renderer.js` | The rasteriser: walls, visplanes (`R_MakeSpans`/`R_MapPlane`), sky, masked middles and sprites, fuzz, HUD patches, automap lines. **Works in palette indices.** |
| `src/present.js` | The last step: palette indices → colours. `WebGLPresenter` (a fragment shader over a 256×14 palette texture) or `Canvas2DPresenter`. Smooth upscaling. |
| `src/hud.js` | The status bar, the weapon sprite (with fuzz and fixed colormaps), messages. |
| `src/automap.js` | The automap's colour rules (`AM_drawWalls`), as palette indices. |
| `src/intermission.js` | `wi_stuff.c`: stats, time and par, "Entering", the episode maps and their animations. |
| `src/finale.js` | `f_finale.c`: Doom I endings with their art and the bunny scroll, Doom II text screens, the cast call. DEHACKED string parsing and the Freedoom text fallback. |
| `src/progress.js` | `G_DoCompleted`'s next-map rules, secret exits included. |
| `src/savegame.js` | Save and load: `captureGame` (the live tables as JSON), `restoreGame` (written back over a freshly loaded map, `thing_seq` moved on), `saveStore` (IndexedDB, or memory). |
| `src/demo.js` | Demos: `DemoRecorder` (start + every `DOOM_TIC` call), `DemoPlayer`, `demoProblem`. Recording, playback and the buttons are wired in `main.js`. |
| `src/menu.js` | The title loop (`D_DoAdvanceDemo`) and the menus (`m_menu.c`): `Menu` (menus, cursor, messages, sliders; actions are callbacks) and `TitleLoop`. |
| `src/cheats.js` | `cht_CheckCheat`: readers for fixed cheats, IDCLEV/IDMUS digits, `clevMap`, `idmusMap`. |
| `src/audio.js` / `src/music.js` | Sound effects from `SOUND_EVENTS`, positioned like `S_AdjustSoundParams`; MUS/MIDI music on an OPL2-style FM synthesiser with the WAD's `GENMIDI`. |
| `public/` | `index.html`, `style.css`, `coi-serviceworker.js` (cross-origin isolation for the Worker), and `wads/` (fetched, not committed). |
| `scripts/` | The build (`build.mjs`, esbuild-wasm), `fetch-wad.mjs`, the tests, `screenshot.mjs`, `bench.mjs`. |

## Boot

1. `main.js` starts Firebird (`firebird-wasm`'s `FirebirdBrowser` with a Worker built from its
   `worker-entry.js`) on an in-memory database and runs `createSchema`, which executes the three SQL
   files.
2. `loadGame` fetches the chosen Freedoom IWAD (or the WAD picker supplies one). `useWad` copies its
   resources into Firebird with `loadResources` and creates a `Renderer` for it. The `Renderer`
   gets attached to the page's presenter.
3. `startMap` runs `loadMap`, which inserts the level's lumps and calls `INIT_MAP`. That derives
   denormalised line coordinates, the blockmap, the sound-link graph and the BSP child bounding
   boxes, spawns the things for the chosen skill (stored in `game.skill`), and resets the player (or only the per-level state, when
   not a new game).
4. The frame loop starts (`requestAnimationFrame`, with a timer as backstop), on the title loop:
   the first map is loaded underneath but doesn't tick until a game starts from the menu.

## A tic

`SELECT * FROM doom_tic(tics, fwd, side, turn, fire, use, weapon, run)` advances the game `tics`
tics (1–6, catching up to 35 Hz) and returns one row: everything the HUD needs, plus `exit_kind`.
Per tic, `DOOM_TIC` runs:

- `PLAYER_THINK`: turning, thrust and friction, wall sliding through `CHECK_POSITION` (blockmap
  lookup through `LINES_IN_BOX`), walk-over lines, gravity, sector specials, use lines, weapons
  (`HITSCAN` with `AIM_SLOPE`, `FIRE_MISSILE`), noise (`NOISE_ALERT`) and pickups.
- `MOVERS_THINK`: doors, lifts, floors, stairs and crushers (`movers` rows).
- `MONSTERS_THINK`: one stable cursor over the live things. It handles monsters (A_Look, A_Chase,
  attacks, pain, death, raising), missiles, effects, flames, the brain and its cubes, and vertical
  physics (`Z_RANGE`).
- `LIGHTS_THINK` every other tic.
- The countdowns: damage and bonus flashes, messages, power-ups.

**Determinism.** Every chance goes through `P_RANDOM()`, a linear congruential generator over
`GAME.RNG`. `loadMap` restarts `thing_seq` at 1. So the same map, skill, seed and `DOOM_TIC`
calls always give the same game, which is what demos rely on. Never call `RAND()` in the game
SQL, and never let a tic depend on wall-clock time or on the frame rate except through `tics`.
And never let it depend on physical row order: cursors whose order matters say `ORDER BY`
(`MONSTERS_THINK` runs in id order, like `P_RunThinkers` in spawn order), and `p_random()` is
never drawn inside a multi-row `UPDATE` (`LIGHTS_THINK` flickers one sector at a time).

Sounds are rows: `PLAY_SOUND` inserts into `SOUND_EVENTS`, and the page plays whatever is newer
than the last id it saw. Exits set `game.exit_kind` (1 normal, 2 secret, 3 restart after death).
The page sees it in the `DOOM_TIC` row and takes over with the intermission.

## A frame

After the tic, the page queries `FRAME_WALLS`, `FRAME_SECTORS`, `FRAME_SPRITES` and the new
`SOUND_EVENTS` together, so the Worker never idles between them.

- `FRAME_WALLS` reads `RENDER_WALLS`. That reads slices from `RENDER_SLICES_BSP` (or
  `RENDER_SLICES`, chosen by `viewcfg.use_bsp`), walks each column front to back carrying the
  open window, and emits one row per visible slice. A row carries depth, texture u, the line,
  the clip window, and the rows of ceiling and floor that slice uncovers (the visplane data).
- `FRAME_SPRITES` projects things in front of the camera and picks the rotation frame. It adds
  the light level, and the `fuzz` flag for `MF_SHADOW`.
- `renderer.drawView` draws walls column by column, groups the visplane rows into visplanes
  (`R_FindPlane`/`R_CheckPlane`), draws them as spans, then masked middles and sprites far to near,
  clipped by the walls in front.
- `composeView` scales the view into the 320×200 screen, the HUD goes on top, then
  `renderer.present(palette)` hands the screen to the presenter.

### Palette indices, all the way

The view (`fb`) and the screen (`sfb`) are `Uint8Array`s of **palette indices already lit through
`COLORMAP`**, as in DOOM. `cmap[level * 256 + index]` does all lighting. Level 0–31 is the light
level, 32 is the invulnerability greys and 6 is the fuzz darkening. The 14 `PLAYPAL` palettes (pain
red 1–8, pickup gold 9–12, radiation green 13) are applied only in `present`. Screenshots and
tests read colours through `renderer.toRGBA(palette)`.

The presenters are in `present.js`. WebGL uploads the screen as a 320×200 `LUMINANCE` texture,
and the fragment shader looks each index up in a 256×14 RGBA texture. Smooth upscaling is a
manual bilinear filter over four **colour** lookups, never over indices. Canvas 2D runs a palette
loop and `putImageData`, and smooths with CSS. A canvas keeps the first kind of context it gave
out, so switching presenter replaces the canvas element (`applyDisplay` in `main.js`, which
rebinds the input listeners).

## Screens outside the 3D view

The title loop and the menu come first in `frame()`. While either is up, nothing else ticks: the
menu draws over a snapshot of the screen taken when it opened, so the game waits behind it.

When an exit is seen, the page stops calling `DOOM_TIC` and runs one of these objects on its own
35 Hz clock, until it reports `done`:

1. `Intermission` (all exits except Doom I's E?M8): stats, then "Entering". It knows `fromName`
   and `secret`.
2. `Finale`, when `Finale.available(wad, map, secret)` says the exit has a screen: Doom II's text
   screens, the cast call, Doom I's endings.
3. `startMap(nextMap(...))`, keeping the inventory.

Each screen is split into a pure **state machine** (`IntermissionState`, `FinaleState`,
`BackAnims`, `bunnyFrame`) and a **drawing class** that paints palette indices into
`renderer.sfb`. Tests drive the state machines headless, and draw with a stub renderer that
records `patch` calls, or with the real renderer reading `toRGBA`.

### Story text and DEHACKED

Freedoom ships its story text, cast names and more in a `DEHACKED` lump in BEX format.
`parseDehStrings` handles the `[STRINGS]` section, with `\n` escapes and backslash continuation
lines. id's own IWADs keep the text in the executable, so:

- **Doom I endings** without text go straight to their art (`CREDIT`/`HELP2`, `VICTORY2`, the
  bunny, `ENDPIC`).
- **Doom II screens** borrow Freedoom Phase 2's `C1TEXT`–`C6TEXT`. `scripts/build.mjs` extracts
  them from the bundled `freedoom2.wad` into `dist/wads/freedoom-strings.json` (BSD-3-Clause, with
  `FREEDOOM-COPYING.txt` alongside). The page loads that file at boot and calls
  `setFallbackStrings`, and `Finale.borrowed` says when it was used. Without the file, the text
  screens are skipped, and MAP30 goes straight to the cast call.

id's text is never reproduced in this repository.

## Tests

All tests are plain Node scripts on the real engine (`DirectTransport` with `memory://`
databases), running real Freedoom maps. Run them after every change, on both WADs where they take
`WAD=`:

| Script | Covers |
| --- | --- |
| `sql-smoke.mjs` (`npm test`) | Schema, a map load, walking, firing, doors, frames, BSP vs window-function clipping, visplanes, spectre fuzz flag, sounds. |
| `weapons-test.mjs` | Rocket launcher, plasma, BFG, chainsaw, berserk, super shotgun, and the SQL cheats. |
| `specials-test.mjs` | Hanging bodies, boss deaths, Keen, MAP07, the Icon of Sin, arch-vile, pain elemental, revenant, mancubus. |
| `physics-test.mjs` | Crushers, 3D aiming, sound propagation, infighting, vertical physics, lost souls, power-ups, the automap rules, cheat parsing, map order, IDCLIP. |
| `finale-test.mjs` | Every text screen and ending, the cast call, the bunny scroll, the id-WAD layouts and the fallback text. |
| `intermission-test.mjs` | Pars, counting and sounds, skipping, the after-stats flow, the episode-map animations, the secret routes. |
| `savegame-test.mjs` | Plays, saves (through JSON), plays on, loads: every saved row comes back exactly; new ids don't collide; the game runs on; other versions are refused. |
| `demo-test.mjs` | A recorded demo (through JSON) replays into the same game, row for row; a third run too; another seed diverges; `P_RANDOM` is repeatable and even; thing ids repeat across loads. |
| `menu-test.mjs` | The title loop; menu navigation, remembered cursors, New Game → episode → skill, Nightmare's question, options and sliders, Load/Save, Quit, Read This!, coordinates, and every graphic present in both WADs. |
| `compare-renderers.mjs` | BSP and brute-force renderers agree, column by column. |
| `all-maps.mjs [wad]` | Loads, tics and renders every map, and checks a teleporter on each. |

CI (`.github/workflows/pages.yml`) runs all of them except `all-maps`, then builds and deploys to
GitHub Pages.

## Firebird gotchas (each one cost real time)

- **`db.exec` splits on `;`.** Wrap an `EXECUTE BLOCK` in `SET TERM ^ ;` … `SET TERM ; ^`, or send
  it with `db.query`.
- **256 contexts per statement.** One `EXECUTE BLOCK` can't hold more than about 256 `INSERT`s,
  hence the chunks of 200 in `insertRows`.
- **CTEs are inlined, not materialised.** A recursive or reused CTE gets recomputed per reference.
  Use PSQL generator procedures (`SUSPEND` in a loop) instead.
- **Join order matters.** A plain join to `screen_cols` once took 65 s. Pin the order with
  `LEFT JOIN` or `LATERAL`.
- **Name clashes.** PSQL variables and columns share a namespace in expressions: qualify columns
  (`t.x`) and prefix variables (`:x`) inside SQL statements.
- **`FOR SELECT` cursors are stable** (Firebird 3+): they don't see rows changed after they
  opened. `MONSTERS_THINK` re-reads each thing's live state at the top of the loop. Otherwise a
  monster killed earlier in the same tic walks on with negative health.
- **Idle things think every 8 tics** (`MOD(tic + id, 8)`). A thing that must act every tic needs a
  state other than `idle` (for example `burn` for the arch-vile's flame).
- **`CHAR(n)` comes back padded**, and `IIF` over two string literals of different lengths pads
  the shorter one (`TRIM` it). `MINVALUE`/`MAXVALUE` return `NULL` if any argument is `NULL`.
- **Evaluation order isn't guaranteed.** Guard divisions with `NULLIF` even when a `WHERE` "should"
  have filtered the zero.
- **A fractional double doesn't survive a trip through text.** Firebird can parse
  `216.47363339883418` back one bit off, as a literal or as a bound parameter, since
  `firebird-wasm` sends parameters as text. Where exactness matters (save and load), send a
  fraction as `m * POWER(2e0, e)`, with `m` a whole number of at most 53 bits. See
  `mantissaExponent` in `src/savegame.js`.
- **Procedure parameters can have defaults** (`src INTEGER = NULL`), which keeps old call sites
  working.

## Tooling gotchas

- The native `esbuild` binary can't spawn in some sandboxes, so the build uses `esbuild-wasm`.
- `.sql` files are imported as text by the build.
- The page needs cross-origin isolation for the Worker's shared memory. `coi-serviceworker.js`
  provides it on GitHub Pages, and the dev server (`npm run build -- --serve`) doesn't send
  COOP/COEP itself.
- The game loop pauses while `document.hidden`, which includes the desktop app's browser pane when
  it's hidden. Verify live behaviour with the pane visible, or drive the state machines headless.
