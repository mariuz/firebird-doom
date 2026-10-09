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
npm test                   # SQL smoke test
WAD=public/wads/freedoom2.wad npm run test:weapons   # weapons/specials/physics take WAD=: run both WADs
npm run test:finale && npm run test:intermission && npm run test:menu
WAD=public/wads/freedoom2.wad npm run test:savegame  # (and without WAD=)
WAD=public/wads/freedoom2.wad npm run test:demo      # determinism (and without WAD=)
npm run test:dehacked      # DeHackEd patches
npm run test:pwad          # PWADs over the IWAD
npm run test:automap       # the automap's zoom, follow, grid, marks
npm run test:light         # light diminishing vs DOOM's fixed point
npm run test:statusbar     # the status bar face, the attacker, the death camera
npm run test:sound         # the 8 sound channels: priorities, distance, following the source
npm run test:renderers -- E1M1 E1M2 E1M3
node scripts/all-maps.mjs public/wads/freedoom2.wad  # every map (the WAD is an argument here, not WAD=)
npm run build              # dist/ (also writes dist/wads/freedoom-strings.json)
npm run build -- --serve   # dev server (the desktop app's launch config "firebird-doom" uses it)
npm run screenshots        # regenerates docs/screenshot-*.png
```

Before every commit, run the smoke test, weapons/specials/physics on **both** WADs, finale,
intermission, menu, automap, light, statusbar, sound, dehacked, pwad, savegame and demo (both WADs) and the build. All of them must pass; CI runs the same set.

## How the user likes it

- **Vanilla fidelity first.** Follow id's source (`p_*.c`, `r_*.c`, `wi_stuff.c`, `f_finale.c`,
  `st_stuff.c`) and name the functions in comments (`A_SkullAttack`, `P_ZMovement`, …). When the
  port must deviate (no `.lmp` demos; Freedoom placeholders), say so in code and
  README. Ask before adding non-vanilla features: the user turned down an invented Doom II
  intermission animation.
- **Every feature lands with:** a test (extend the existing script that fits), a README section or
  paragraph, a commit on `main` with a descriptive message, a push, and a green CI run (`gh run
  watch`). End commit messages with the attribution line the harness gives you.
- **Check live when you can.** The desktop app's browser pane runs the dev server. The game loop
  pauses while the page is hidden (`document.hidden`), so if the pane is hidden, say so and verify
  headless: drive the state machines, render PNGs with `renderer.toRGBA`, use stub renderers. Never
  claim a live check you didn't do.
- **Copyright.** Never put id Software's text (story screens, messages, names) in the repo. Freedoom
  is BSD-3-Clause: its `DEHACKED` strings may be used, with `FREEDOOM-COPYING.txt` shipped
  alongside. id's WADs (`doom.wad`, `doom2.wad`) are not distributable. Test their layout by hiding
  lumps (see the id-style tests in `scripts/finale-test.mjs`).

## Gotchas that cost time

- **Firebird indexes:** compare an INTEGER column with INTEGER values. A `FLOOR()` of a double
  against it keeps the index out, and a range on the first column of a composite index scans
  every row of that range: `LINES_IN_BOX` went from 480 to 38 µs with a single-key `CELL` column
  and exact lookups. When the optimizer picks the wrong index, `col + 0` hides a column from it.
  Time things with `scripts/frame-bench.mjs`, or a WHILE loop in an `EXECUTE BLOCK` around one
  call (there's no profiler plugin in the WASM build), and compare runs alternately: the machine
  is noisy.
- **Firebird:** `db.exec` splits on `;` (use `SET TERM` or `db.query` for `EXECUTE BLOCK`). About
  256 contexts per statement (insert in chunks of 200). CTEs are inlined (use PSQL generators).
  Pin join order (`LEFT JOIN`/`LATERAL`). Qualify columns and use `:var`. `FOR SELECT` cursors are
  stable, so `MONSTERS_THINK` re-reads live state per thing. Idle things think every 8 tics. `IIF`
  over two literals of different lengths pads the shorter, so `TRIM` it. `MINVALUE`/`MAXVALUE`
  propagate `NULL`. Guard divisions with `NULLIF`. Fractional doubles sent as text (literals, or
  parameters, which `firebird-wasm` passes as text) can come back one bit off: send them as
  `m * POWER(2e0, e)` when exactness matters (`src/savegame.js`).
- **Editing from the shell:** backticks and `${…}` inside `node -e "…"` or unquoted heredocs get
  eaten by bash. Write a `.cjs` patch script with the file tool and run it, or use the Edit tool.
  Patch scripts should `throw` when an anchor is missing, so nothing half-applies.
- **Don't kill unknown `node` processes.** Port 8080 is often taken. The launch config has
  `autoPort`.
- **`git push` can 500 on GitHub.** Retry in a loop. Someone else (the user) may push to `main` too,
  so check `git status -sb` after pushing, then `git pull --ff-only`.
- **Freedoom specifics:** `WISPLAT`, `WIURH0/1` and all `WIA*` intermission lumps are empty 1×1
  placeholders, so those features are invisible with Freedoom by design. Freedoom 1 has E4 maps, so
  it counts as "retail" (E1 ending art is `CREDIT`). Map names in Phase 2 are `MAP01`–`MAP32`.
- **The page opens on the title loop.** A key opens the menu, and the map underneath doesn't tick
  until a game starts. Browser-driven checks must start a game first: any key, then Enter
  through the menus, or `startMap` via the **Map** selector. Menus remember their cursor
  (`lastOn`), so scripted key sequences must allow for it.
- **Determinism:** use `p_random()`, never `RAND()`, in game SQL. Anything random or
  time-dependent outside `DOOM_TIC`'s inputs breaks demos (`npm run test:demo` catches it).
  Row order counts too: every `FOR SELECT` whose order affects state needs an `ORDER BY`, and
  never call `p_random()` in a multi-row `UPDATE`. Physical row order changes when a reload
  reuses pages, so a replay drifts only sometimes (it failed on CI, not locally).
- **Tests:** physics-test and weapons-test share one database through many sections. A monster
  woken by an earlier section can hurt the player later, so read state right after the action,
  before another tic. Make statistical assertions robust (bigger samples, fixed bounds rather than
  ratios).

## Where to look

| Task | Start here |
| --- | --- |
| New monster behaviour, weapon, linedef or sector special | `sql/game.sql` (`MONSTERS_THINK`, `PLAYER_THINK`, `ACTIVATE_LINE`) and `src/thinginfo.js` |
| New thing type or flag | `src/thinginfo.js`, `sql/schema.sql` (`thing_types`) and the column list in `src/loader.js` |
| Rendering bug | `sql/render.sql` (what's visible) vs `src/renderer.js` (how it's drawn); `compare-renderers.mjs` |
| Colours, palette, upscaling | `src/present.js` |
| Screens between levels | `src/intermission.js`, `src/finale.js`, `src/progress.js`; the hand-off is in `main.js`'s `frame()` |
| Cheats | SQL `CHEAT` procedure; readers in `src/cheats.js`; key handling in `main.js` |
| Save and load | `src/savegame.js` (what's saved: its `WHOLE`/`MOVING` lists; **add a column there if the simulation starts changing a new one**), `saveToSlot`/`loadFromSlot` in `main.js` |
| DeHackEd, rules a patch can change | `src/dehacked.js`, the `RULES` table (SQL reads it instead of hard-coding those numbers) |
| Demos | `src/demo.js`; recording and playback in `main.js` (`startRecording`, `playDemo`, the frame loop) |
| Title screen, menus, options | `src/menu.js`; the actions (new game, settings) are wired in `main.js`'s `makeMenu` |
| Previewing screens in the browser | `doom.finale('E3M8')`, `doom.intermission('E2M3', 'E2M4')` in the console |
