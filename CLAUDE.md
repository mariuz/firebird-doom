# CLAUDE.md: notes for the next agent

Firebird DOOM is DOOM running inside Firebird 6.0 SQL, compiled to WebAssembly, in the browser.
The repo is `mariuz/firebird-doom`, deployed to GitHub Pages by CI. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything and
[docs/ROADMAP.md](docs/ROADMAP.md) for what's missing. The README is the user-facing tour.

## The rule

**Firebird decides, JavaScript draws.** Game logic goes in PSQL (`sql/game.sql`). Visibility goes
in `sql/render.sql`. JS (`src/`) only rasterises, presents, plays audio and runs the non-3D screens
(intermission, endings, automap). The renderer works in **palette indices** lit through `COLORMAP`
(`renderer.cmap`). The `PLAYPAL` palette is applied only by the presenter (`src/present.js`).

## Commands

```bash
npm ci
npm run fetch-wad          # Freedoom 0.13.0 → public/wads/ (+ FREEDOOM-COPYING.txt); needed by everything
npm run test:all           # everything below that CI runs, side by side (scripts/test-all.mjs; JOBS=n)
npm test                   # SQL smoke test
WAD=public/wads/freedoom2.wad npm run test:weapons   # weapons/specials/physics take WAD=: run both WADs
npm run test:finale && npm run test:intermission && npm run test:menu
WAD=~/doom.wad npm run test:intermission   # (and test:finale; doom2.wad too) id's WADs, where one is to hand: never in the repo
WAD=public/wads/freedoom2.wad npm run test:savegame  # (and without WAD=); also loads every old save in scripts/fixtures/saves
npm run save-fixtures      # after a schema change: a save in the new shape (git worktrees of each schema commit)
npm run test:demo      # determinism (and without WAD=)
npm run test:attract       # the title loop's demos (public/demos/) replay to their checksums; npm run attract records them
npm run test:dehacked      # DeHackEd patches
npm run test:lmp           # .lmp demos: the format, and how long the port keeps step with vanilla (a ratchet: -- --update)
npm run oracle             # vanilla as a reference: Chocolate Doom built headless into oracle-build/ (needs SDL2 -dev packages)
npm run lmp-fixtures       # the .lmp fixtures and vanilla's trace of each (needs the oracle); -- NAME … for only those
npm run lmp-rnglog -- e1m1-walk 119 119   # every P_Random draw in those tics of a fixture, with the procedures that drew it
npm run test:pwad          # PWADs over the IWAD
npm run test:automap       # the automap's zoom, follow, grid, marks
npm run test:light         # light diminishing vs DOOM's fixed point
npm run test:statusbar     # the status bar face, the attacker, the death camera
npm run test:sound         # the 8 sound channels: priorities, distance, following the source
npm run test:music         # the emulated OPL2 and OPL3, DOOM's DMX music driver, songs from both WADs
WAD=public/wads/freedoom2.wad npm run test:netgame  # two players through NET_TIC, co-op and deathmatch (and without WAD=)
npm run test:browser       # the page in headless Chromium: title → game → intermission → next map
npm run test:coop          # co-op and deathmatch: two pages, a real WebRTC link, invite → reply → Start → lockstep; then four pages
npm run relay              # the netgame relay (worker/relay.js) under Node on :8787; open the page with ?relay=http://localhost:8787
npm run test:relay         # the relay: rooms, expiry, limits, origins, the TURN request (Cloudflare faked)
npm run test:states        # DOOM's state table in Firebird: whole, consistent, every thing type tied to its DOOM type
npm run gen-states         # regenerates src/states.js (GPL-2) from Chocolate Doom's info.c; never edit it by hand
BROWSER=firefox npm run test:browser   # (and webkit; test:coop too) CI's browsers.yml runs both in both; Chromium is the default
npm run test:visual        # the README's pictures, pixel for pixel against docs/screenshots.json
npm run test:renderers -- E1M1 E1M2 E1M3
node scripts/all-maps.mjs public/wads/freedoom2.wad  # every map (the WAD is an argument here, not WAD=)
npm run build              # dist/ (also writes dist/wads/freedoom-strings.json)
npm run build -- --serve   # dev server (the desktop app's launch config "firebird-doom" uses it)
npm run screenshots        # regenerates docs/screenshot-*.png and docs/screenshots.json
```

Before every commit, run `npm run test:all`: the smoke test, weapons/specials/physics on **both** WADs, finale,
intermission, menu, automap, light, statusbar, sound, music, dehacked, pwad, and savegame, demo and netgame (both WADs), attract, the visual test, the renderers, the build, the browser test and the co-op test, as many at once as there are cores (about 9 minutes here; one after another it was 25). Each test's output is in `test-logs/`; `npm run test:all -- music pwad` runs only those. A change that
means to alter what's drawn fails the visual test: look at `screenshots-diff/`, then run `npm run
screenshots` and commit `docs/`. A change to the simulation fails the attract test: run `npm run
attract` and commit `public/demos/`. All of them must pass; CI runs the same set.

## How the user likes it

- **Vanilla fidelity first.** Follow id's source (`p_*.c`, `r_*.c`, `wi_stuff.c`, `f_finale.c`,
  `st_stuff.c`) and name the functions in comments (`A_SkullAttack`, `P_ZMovement`, …). When the
  port must deviate (no `.lmp` demos; Freedoom placeholders), say so in code and
  README. Ask before adding non-vanilla features: the user turned down an invented Doom II
  intermission animation.
- **Every feature lands with:** a test (extend the existing script that fits), a README section or
  paragraph, a commit on `main` with a descriptive message, a push, and a green CI run (`gh run
  watch`). End commit messages with the attribution line the harness gives you.
- **The browser test** (`scripts/browser-test.mjs`) drives the real page. Waiting for a new level:
  `doom.screen` reads `level` while the next map is still loading, and melts queue up (a level
  loaded behind another screen's melt gets its own after), so wait for `doom.settled` (the screen
  shown is the current one and no melt is running) before pressing keys – a melt drops them. Playwright is pinned to the version whose
  Chromium is installed here (`/opt/pw-browsers`); CI installs its own.
- **Check live when you can.** The desktop app's browser pane runs the dev server. The game loop
  pauses while the page is hidden (`document.hidden`), so if the pane is hidden, say so and verify
  headless: drive the state machines, render PNGs with `renderer.toRGBA`, use stub renderers. Never
  claim a live check you didn't do.
- **Copyright.** Never put id Software's text (story screens, messages, names) in the repo. Freedoom
  is BSD-3-Clause: its `DEHACKED` strings may be used, with `FREEDOOM-COPYING.txt` shipped
  alongside. id's WADs (`doom.wad`, `doom2.wad`) are not distributable. Test their layout by hiding
  lumps (see the id-style tests in `scripts/finale-test.mjs`). The one GPL file is `src/states.js`,
  DOOM's state table (the owner's choice: GPL-2 in a file of its own, the rest MIT); it comes from
  `npm run gen-states`. Don't copy id's code into any other file.

## Gotchas that cost time

- **Firebird indexes:** compare an INTEGER column with INTEGER values. A `FLOOR()` of a double
  against it keeps the index out, and a range on the first column of a composite index scans
  every row of that range: `LINES_IN_BOX` went from 480 to 38 µs with a single-key `CELL` column
  and exact lookups. When the optimizer picks the wrong index, `col + 0` hides a column from it.
  Time things with `scripts/frame-bench.mjs`, or a WHILE loop in an `EXECUTE BLOCK` around one
  call (there's no profiler plugin in the WASM build), and compare runs alternately: the machine
  is noisy.
- **Firebird:** `db.exec` splits on `;` (use `SET TERM` or `db.query` for `EXECUTE BLOCK`). About
  256 contexts per statement (an `EXECUTE BLOCK` of `INSERT`s; bulk inserts use `execBatch`). CTEs are inlined (use PSQL generators).
  Pin join order (`LEFT JOIN`/`LATERAL`). Qualify columns and use `:var`. `FOR SELECT` cursors are
  stable, so `STATES_THINK` re-checks a thing's state is still due before moving it on. `IIF`
  over two literals of different lengths pads the shorter, so `TRIM` it. `MINVALUE`/`MAXVALUE`
  propagate `NULL`. Guard divisions with `NULLIF`. `ATAN2(0, 0)` is an error: angles go through
  `atan2_safe` (0 there, as `R_PointToAngle2`). Fractional doubles written into SQL as
  text literals can come back one bit off (about one in ten). Bind them as parameters instead:
  since `firebird-wasm` 0.4 a number parameter is bound in binary and lands exactly. For many
  rows use `db.execBatch(sql, rows)`, one prepared statement for every row in one call
  (`insertRows`, `restoreGame`).
- **Editing from the shell:** backticks and `${…}` inside `node -e "…"` or unquoted heredocs get
  eaten by bash. Write a `.cjs` patch script with the file tool and run it, or use the Edit tool.
  Patch scripts should `throw` when an anchor is missing, so nothing half-applies.
- **Don't kill unknown `node` processes.** Port 8080 is often taken. The launch config has
  `autoPort`.
- **CI runs on `ubuntu-24.04`, not `-latest`.** On 26.04 the pinned Playwright (1.56, the version
  whose Chromium is installed here) can't install its browsers. Move both workflows on when
  Playwright is upgraded.
- **`git push` can 500 on GitHub.** Retry in a loop. Someone else (the user) may push to `main` too,
  so check `git status -sb` after pushing, then `git pull --ff-only`.
- **Freedoom specifics:** `WISPLAT`, `WIURH0/1` and all `WIA*` intermission lumps are empty 1×1
  placeholders, so those features are invisible with Freedoom by design. Freedoom 1 has E4 maps, so
  it counts as "retail" (E1 ending art is `CREDIT`). Map names in Phase 2 are `MAP01`–`MAP32`.
- **The page opens on the title loop.** A key opens the menu, and the map underneath doesn't tick
  until a game starts. Browser-driven checks must start a game first: any key, then Enter
  through the menus, or `startMap` via the **Map** selector. Menus remember their cursor
  (`lastOn`), so scripted key sequences must allow for it.
- **Determinism:** use `p_rand256()` (DOOM's P_Random: `rndtable` from `GAME.RNG`, the index) or
  `p_random()` (the same over 256), never `RAND()`, in game SQL. `P_Random() & n` is
  `p_rand_and(n)`: `BIN_AND(p_rand256(), n)` evaluates the call twice, two draws. Anything random or
  time-dependent outside `DOOM_TIC`'s inputs breaks demos (`npm run test:demo` catches it).
  `INIT_MAP` draws on `p_random()` too (deathmatch starts), so a seed goes in through `loadMap`'s
  `seed`, before the map loads, never with an `UPDATE` after it: two peers once spawned apart.
  Row order counts too: every `FOR SELECT` whose order affects state needs an `ORDER BY`, and
  never call `p_random()` in a multi-row `UPDATE`. Physical row order changes when a reload
  reuses pages, so a replay drifts only sometimes (it failed on CI, not locally).
- **Thinker order:** `WORLD_TIC` runs DOOM's thinkers in their list's order (`RUN_THINKERS`, keyed by
  `THINK_KEY`s; see ARCHITECTURE, *A tic*). A test that calls `PLAYER_THINK` directly, outside
  `DOOM_TIC`, should set `RDB$SET_CONTEXT('USER_TRANSACTION', 'THINK_KEY', -1)` first as `DOOM_TIC`
  does, or a state the player sets ends a tic late. New thinkers (a sector effect, a new kind of
  mobj movement) get a step procedure and a place in `RUN_THINKERS`, not a pass of their own.
- **Monsters look as DOOM's:** `P_LookForPlayers` starts from `THINGS.LASTLOOK` (P_SpawnMobj's
  random), and alone in the game a monster whose lastlook is 1 skips its first look. A test that
  wants a monster to see at once sets `lastlook = 0`. A monster's step (`P_MOVE_FX`) moves it in
  its row, and a solid thing where it steps blocks it, the player included.
- **A hit pushes** (`P_DamageMobj`'s thrust, L5): a test that measures from where the player or a
  monster stands must pin it after hits (`momx = 0, momy = 0`, and its `x`, `y` back), or the next
  tic carries it off; a corpse slides too.
- **Pickups happen only in a move** (`PIT_CheckThing`, from `CHECK_POSITION_FX`): an item spawned
  where the player stands isn't taken until they move. Tests give the player 1/65536 of a unit of
  momentum after the spawn (`momx = momx + 1 / 65536e0`). A charging lost soul stops at a pickup
  in its way too (DOOM's), so clear dropped clips from a test's path.
- **Tests:** physics-test and weapons-test share one database through many sections. A monster
  woken by an earlier section can hurt the player later, so read state right after the action,
  before another tic. Make statistical assertions robust (bigger samples, fixed bounds rather than
  ratios).

## Where to look

| Task | Start here |
| --- | --- |
| New monster behaviour, weapon, linedef or sector special | `sql/game.sql` (`STATE_ACTION` and the `A_*` procedures, `PSPRITE_ACTION`, `PLAYER_THINK`, `ACTIVATE_LINE`), `src/states.js` (generated) and `src/thinginfo.js` |
| New thing type or flag | `src/thinginfo.js`, `sql/schema.sql` (`thing_types`) and the column list in `src/loader.js` |
| Rendering bug | `sql/render.sql` (what's visible) vs `src/renderer.js` (how it's drawn); `compare-renderers.mjs` |
| Colours, palette, upscaling | `src/present.js` |
| Screens between levels | `src/intermission.js`, `src/finale.js`, `src/progress.js`; the hand-off is in `main.js`'s `frame()` |
| Cheats | SQL `CHEAT` procedure; readers in `src/cheats.js`; key handling in `main.js` |
| Save and load | `src/savegame.js` (what's saved: its `WHOLE`/`MOVING` lists; **add a column there if the simulation starts changing a new one**); after a schema change run `npm run save-fixtures`, and if an old save stops loading, migrate it in `restoreGame` (a dropped column goes in `RETIRED`, an old shape is mended in SQL's `ADOPT_STATES`); `saveToSlot`/`loadFromSlot` in `main.js` |
| DOOM's frame tables (states) | `src/states.js` (GPL-2, generated), the `states` table, `SET_STATE` / `STATE_ACTION` / `STATES_THINK` in `sql/game.sql`; the phases in `docs/ROADMAP.md` (Simulation) |
| DeHackEd, rules a patch can change | `src/dehacked.js`, the `RULES` table (SQL reads it instead of hard-coding those numbers) |
| Demos | `src/demo.js`; recording and playback in `main.js` (`startRecording`, `playDemo`, the frame loop); the title loop's in `scripts/record-attract.mjs` (`startAttract` in `main.js`) |
| Keys, mouse, gamepad | `readInput` in `main.js`, reading `src/keys.js` (the bindings), `src/mouse.js`, `src/gamepad.js` |
| Netgame chat | `src/chat.js` (`hu_stuff.c`'s responder, queue and ticker); the `chatchar` rides as the ticcmd's 8th field in `netTics` |
| Title screen, menus, options | `src/menu.js`; the actions (new game, settings) are wired in `main.js`'s `makeMenu` |
| Previewing screens in the browser | `doom.finale('E3M8')`, `doom.intermission('E2M3', 'E2M4')` in the console |
