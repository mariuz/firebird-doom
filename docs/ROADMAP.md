# Roadmap: what's missing

What vanilla DOOM does that Firebird DOOM doesn't yet. Each open item says where it would go. For
how things fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Keep this list current: strike
items as they land, and add what you find missing.

## Still open

The vanilla features are all done, including those a second pass through `g_game.c`,
`d_main.c` and `m_misc.c` found missing. What's left is engineering, in the order it would be
noticed:

- **Performance** of `FRAME_WALLS` (Rendering): ~21 ms a frame now (from ~26), nothing at all
  while standing still. The plan's three steps are done or measured out; what's left is the
  engine's own work (~17 ms: the BSP walk, the projection, the clip), with the ideas tried
  written there.
- **A TURN relay** for multiplayer behind strict NATs (needs a server; the page has none): a
  Cloudflare Worker minting TURN credentials, with short room codes for the invites.
- **Run the id-WAD checks** (Screens): `WAD=/path/to/doom.wad npm run test:intermission` (and
  `test:finale`, and the same with `doom2.wad`) checks DOOM I's episode maps and the endings
  against id's own WADs; nobody has run it yet. Then decide whether DOOM I's endings should
  borrow Freedoom Phase 1's text, as DOOM II's borrow Phase 2's.
- **A WebAssembly trap in WebKit** (Engine): in a few co-op runs out of a dozen on CI, a page's engine stops
  with `Out of bounds memory access` while a second page starts; 30 paired starts didn't repeat it.
  A source-mapped build of `firebird-embedded-st` would say where; it may be WebKit's or the engine's.
  The co-op test reloads such a page once, with a warning.
- **Safari itself, pointer lock and touch** (Tooling): Firefox and WebKit are in CI now; a manual
  pass on a Mac and an iPhone would cover what headless engines can't.
- **A faster test suite** (Tooling): the pre-commit set takes about 25 minutes, one test after
  another; most of them could run side by side.
- **Declined extras**, noted where they come up: random sound pitch, the OPL3's rhythm mode and
  4-operator channels, a frag limit and obituaries (none of them vanilla 1.9).

Everything else below is done.

## Game flow and menus

- ~~**Pause and save in a netgame.**~~ Done: the ticcmd's ninth value is `BT_SPECIAL`
  (`SPECIAL_PAUSE`, or `SPECIAL_SAVE` + the slot, in `net.js`), with no fire, use or weapon change
  that tic; `netTics` acts on it as `G_Ticker` does. A pause stops the world on every peer while
  the tics go round; a save writes the same game into the same slot in every browser after that
  tic, the saver's description there and NETGAME elsewhere. F3 and F9 refuse, as in DOOM.
- ~~**Loading a netgame.**~~ Done (`-loadgame`): the panel's **Start from** picks one of the
  host's saves; it goes gzipped in the start message (`packSave`), each guest checks it and every
  peer restores it before the first tic (`startMap`'s `restore`). `restoreGame` now refuses a save
  whose tables or columns this version doesn't have, or whose rows aren't whole.
- ~~**The launch options in a game alone.**~~ Done: **No monsters**, **Respawn** and **Fast**
  beside Skill, for this visit (as a command line is for one run); a change starts a new game on
  the map, the game keeps them from level to level, and a demo records them in its header and
  plays back with them. The command line below can set them too.
- ~~**A command line.**~~ Done (`src/cmdline.js`): URL parameters for `-warp` (map names,
  DOOM's numbers or IDCLEV's digits), `-episode`, `-skill` (each starts a game, as autostart did),
  `-nomonsters`, `-respawn`, `-fast`, `-nomusic`, `-nosfx`, `-nosound`, `-iwad`, `-record`,
  `-playdemo`, `-timedemo` (a demo tic a frame, timed: the frames a second of the whole page) and
  the netgame panel's `-deathmatch`, `-altdeath`, `-timer`. `-file` and `-deh` stay with the
  file pickers: a URL can't hand the page a local file.
- ~~**Gamepads.**~~ Done (`src/gamepad.js`): the first pad's left stick or d-pad as DOOM's
  digital joystick, buttons 0–3 as `joybfire`, `joybstrafe`, `joybspeed`, `joybuse`; the menus
  step on it with `M_Responder`'s joywait (button 0 Enter, 1 Backspace), and a button on the
  title opens the menu. A second stick (turning on the right, as modern ports do) isn't
  vanilla, and would be asked about first.
- ~~**Key bindings.**~~ Done (`src/keys.js`): `default.cfg`'s ten keys, two slots each, set
  in the **Keys** panel (click, press; Esc leaves it, Backspace empties it), remembered; a key
  does one thing, and the page's own keys can't be taken. DOOM's strafe key (Alt) came with it:
  held, the turn keys and the mouse strafe.
- ~~**Skill levels.**~~ Done: the **Skill** setting, with spawn flags, half damage and double ammo
  on 1, and Nightmare's fast monsters, instant reactions, respawning and no cheats on 5.
  Dropped items give half (`MF_DROPPED`), as in vanilla.
- ~~**Main menu, new game and episode select.**~~ Done ([src/menu.js](../src/menu.js)): the
  title loop, the main menu, episode and skill select, Options, Read This!, Quit. Screen Size and
  Load/Save are done too, and the demos between the title pages (`D_DoAdvanceDemo`): DOOM's own
  `.lmp` files can't be replayed (see Demos), so the port plays its own, recorded by a scripted
  player (`npm run attract`) for the bundled WADs.
- ~~**Save and load.**~~ Done ([src/savegame.js](../src/savegame.js)): six IndexedDB slots per WAD
  from the menu. A save is a JSON snapshot of the live tables. Quicksave and quickload
  (F6/F9) too, and exporting and importing a WAD's saves as a file.
- ~~**Demos.**~~ Done ([src/demo.js](../src/demo.js)): record a level, play it back, download it
  or load it as a JSON file. The simulation is deterministic: `P_RANDOM` is seeded from
  `GAME.RNG`, and thing ids restart on every load. Not possible: DOOM's own `.lmp` demos. They
  need a bit-identical simulation (fixed point, the 256-entry random table consumed in the same
  order), and this is a re-implementation. The title loop plays the port's own demos instead.
  Demos go on from level to level, as DOOM's do.
- ~~**The end of the game.**~~ Done: as in vanilla, Doom I's E?M8 ending is the end of the game.
  Its picture stays until the menu starts a new game, and Doom II's cast call loops.
- ~~**The function keys.**~~ Done: `M_Responder`'s F1 help, F2 save, F3 load, F4 sound volume,
  F5 detail, F7 end game, F8 messages, F10 quit and F11 gamma, each with its sound and message,
  through the menu's entry points (`openReadThis`, `openSave`, …).
- ~~**Mouse buttons 2 and 3.**~~ Done (`src/mouse.js`): button 2 held strafes (the X, and the
  turn keys), button 3 walks, a double click on either uses, all clamped to `MAXPLMOVE`; the
  mouse's Y walking (`mousey`) is the **Mouse moves forward** setting, off by default.

## Simulation (`sql/game.sql`)

- ~~**Armour types.**~~ Done: green armour (type 1) absorbs ⅓, and blue armour, the megasphere
  and IDKFA (type 2) absorb ½. Bonuses keep the type, and used-up armour loses it.
- ~~**Weapon raise and lower.**~~ Done: `pendingweapon`, `A_Lower` and `A_Raise` at 6 units a tic
  (31 tics from one weapon to the next), `P_CheckAmmo` switching instead of firing, pickups and
  berserk bringing their weapon up, the weapon rising at each level start and dropping at death.
- ~~**Monster active sounds.**~~ Done: `A_Chase`'s `activesound` (`THING_TYPES.ACTIVE_SND`), 3 in
  256 per chase step that doesn't attack.
- ~~**Monster chase details.**~~ Done: `P_NewChaseDir`/`P_TryWalk`/`P_Move` with eight headings,
  `movecount` and turnaround avoidance, the 45° turn, `MF_JUSTATTACKED`, the `movecount` gate on
  missile attacks, `A_Look`'s 180° field of view, monsters opening doors they bump into
  (`P_Move`'s special lines), and fliers rising and sinking when only the height blocks them
  (`MF_FLOAT`, `MF_INFLOAT`), and `P_CheckSight`'s `REJECT` test before every monster's sight
  line (so `A_Look` sees as far as vanilla's).
- ~~**Sector specials.**~~ Done: 10 and 14's timed doors, 11's exit at 10 health, and type 4's
  strobe (it was only hurting). Every type `P_SpawnSpecials` knows is handled now.
- ~~**Linedef specials.**~~ Done: every special the player can trigger, the scrolling wall (48)
  included (see the README's list).
- ~~**Monsters crossing lines.**~~ Done: teleporters 39/97/125/126, door 4 and lifts 10/88 as they
  walk over, door 1 as they bump into it. A charging lost soul doesn't trigger lines (its flight
  isn't a `P_Move`).
- ~~**Telefrag.**~~ Done: the player's teleport kills what stands on the destination; monsters are
  blocked by it (except on MAP30). Teleports also leave fog at both ends and freeze the player
  for 18 tics.
- ~~**Multiplayer.**~~ Done ([src/net.js](../src/net.js), `NET_TIC`): co-op and deathmatch for
  up to four players, peer to peer over WebRTC with copy-paste invite codes, in lockstep with a
  checksum every 35 tics. The other players are animated (`S_PLAY…`) and coloured
  (`R_InitTranslationTables`); deathmatch has its starts, frags, `-altdeath`'s respawning items,
  `-timer`, the status bar's frag count and the frag matrix at the intermission; co-op the per-player
  intermission. Still missing: a TURN relay for players behind strict NATs.
- ~~**DEHACKED beyond `[STRINGS]`.**~~ Done ([src/dehacked.js](../src/dehacked.js)): Thing, Ammo,
  Misc, Cheat and BEX [PARS]. Not possible: Frame, Pointer, Weapon, Sound and Text blocks need
  state tables the port doesn't have. Loading a `.deh` file comes with PWADs (the loader already
  takes the text: `loadResources(db, wad, { dehacked })`).
- ~~**PWADs.**~~ Done: PWADs on top of the main WAD (`-file`, with flats and sprites merged as
  `-merge` does), and a `.deh` patch (`-deh`). They're remembered across reloads too (IndexedDB, with
  their main WAD).
- ~~**Netgame launch options.**~~ Done: `-nomonsters`, `-respawn` and `-fast` as three checkboxes
  in the panel, sent in the start message like the game type and timer, kept in `GAME` for
  `INIT_MAP` (no monsters), `WORLD_TIC` (the respawns) and `MONSTERS_THINK` (the Nightmare
  speed, which `-fast` now shares) to read.

## Rendering

- **Performance.** The plan was measurement first (the machine is noisy, so alternate runs):
  (a) count what `FRAME_WALLS` sends per row and derive what can be derived on the JS side;
  (b) reuse the previous frame's visible set when the view hasn't moved; (c) a binary result
  transfer in `firebird-wasm`. Measure with `node scripts/frame-bench.mjs E1M1 E1M2 …` (every
  monster awake, eight spots per map looking four ways, the fastest of three).
  - ~~(a)~~ Done: `FRAME_WALLS` sends 5 values a slice, not 14. The opening, the clip window and
    the visplane rows are worked out again in `renderer.js` (`expandWalls`, `visplaneMarks`),
    exactly: the smoke test compares them with `RENDER_WALLS`, and every map of both WADs (1,020
    views, 964,338 slices) agreed. Interleaved, E1M1–E1M3 and E2M2: 25.6 → 21.6 ms.
  - ~~(b)~~ Done, exactly: while the view and the sectors' heights are unchanged, the page draws
    the last answer again (0 ms standing still). Reusing it when the view has moved only a little
    would draw something Firebird didn't decide, so it isn't done.
  - ~~(c)~~ Measured and not worth doing. Timed inside `firebird-wasm` 0.4.1 (E1M1–E1M3 and
    E2M2, 32 views): of `FRAME_WALLS`' ~20 ms, the browser's side – copying the JSON out of the
    heap and parsing it – is ~0.5 ms; the rest is the engine. Returning rows at all costs ~1.3 µs
    a row whatever they hold (three integer columns: +1.5 ms over a bare `COUNT(*)`), and
    doubles cost no more than integers (two double columns +2.1 ms, the same cast to integers
    +2.2 ms), so formatting them isn't the cost either. A binary result encoding would remove
    the formatting and parsing, ~0.5–1 ms of the 20, and keep the per-row fetch. That agrees
    with `firebird-wasm`'s own plan (`docs/plans/typed-results.md` in `mariuz/electric-firebird`),
    which argues against replacing its JSON results. The page is on 0.7.0 and its build without
    threads (`firebird-embedded-st`), which measured faster than the threaded one: a tic
    15.4–15.9 ms against 17.9–18.1, `FRAME_WALLS` 23 against 25–28, a map load ~520 ms against
    ~715, the engine started in 1.3 s against 2.6, and no cross-origin isolation. It uses the binary
    parameters and `execBatch` (0.4) for loads and saves. Two later options measured within the
    noise here and are left off: 0.5.0's prepared-statement cache, and 0.6.0's `sharedReads`
    (autocommit reads in one shared read-only transaction; it played a 300-tic game to the same
    checksum, and a frame's cost is executing, not starting transactions). Results are still
    JSON.
  What's left is the work itself: the BSP walk and column projection ~10–11 ms, and
  `RENDER_WALLS`' sort and clip ~3 ms. `DOOM_TIC` was halved by keying the BLOCKMAP by cell (10 ms
  on average over E1M1–E1M3 and E2M2, from 22). Tried and measured no better: shaving statements
  off the per-column loop (the cost is per row, not per statement), folding the clipping into the
  BSP pass with per-column clip strings (`OVERLAY`/`SUBSTRING` cost more than the layer they
  save: 27 ms), `FOR SELECT` instead of the cursor, sending the clip values as whole rows. Ideas
  left: caching static per-map work. Moving the per-column stepping to JS (about 3× faster
  walls) was considered and turned down: Firebird decides, JavaScript draws.
- ~~**Automap.**~~ Done: zoom (= -), the whole-level view (0), follow mode and panning (F, arrows),
  the grid (G) and marks (M, C), as `AM_Responder` and `AM_Ticker` have them.
- ~~**The automap in netgames.**~~ Done: `AM_drawPlayers` (`automapPlayers` in `automap.js`):
  in co-op every player's arrow in their colour (green, grey, brown, red), near black while
  invisible; in deathmatch only your own, and no IDDT there (`AM_Responder`).
- ~~**Gamma correction.**~~ Done: `v_video.c`'s `gammatable` in `present.js`, over the
  presenter's palettes; F11 steps the level with its message, and the setting is remembered.
- ~~**Light diminishing and colormaps.**~~ Done: the exact `scalelight`/`zlight` tables and
  lookups, low detail's quirk, and the muzzle flash's `extralight`, checked against DOOM's fixed-point
  arithmetic by `npm run test:light`.
- ~~**Status bar.**~~ Done, frags in deathmatch included. The face is done:
  `ST_updateFaceWidget`'s priorities, turn faces and pain levels, plus `P_DeathThink`'s death camera.
- ~~**Messages.**~~ Done: each pickup shows the WAD's `DEHACKED` string (`GOTARMOR`,
  `GOTSHOTGUN`, …: Freedoom has them all, and a PWAD or `.deh` can replace them), else plain words
  of our own.

## Screens

- **Doom I episode maps with id's WADs.** The intermission's splats, "you are here" pointer and
  animations are drawn and checked pixel by pixel through the real renderer (`intermission-test`),
  with Freedoom's 1×1 placeholders lent a picture of its own. `intermission-test` and
  `finale-test` take `WAD=` (`scripts/wad-arg.mjs`): pointed at id's `doom.wad` they check
  that every episode-map picture is real and drawn where it belongs, and that each episode's end
  goes straight to its art. With `doom2.wad` they check the cast call and the borrowed text.
  What's left is for someone with the WADs to run it.
- ~~**Netgame chat.**~~ Done: `hu_stuff.c`'s T to everyone, G/I/B/R to one player (with three
  or more), Alt+0–9 the macros (our own defaults, a DEHACKED's `HUSTR_CHATMACRO`s over them), the
  sender named by the DEHACKED's `player_names[]`. The text goes a character a tic in the ticcmd's
  `chatchar`, as DOOM sent it (`src/chat.js`).
- ~~**Screen wipe.**~~ Done ([src/wipe.js](../src/wipe.js)): the column melt between the title,
  the game, the intermission and the endings, and on every level load.
- **Doom I endings' text with id's WADs.** They go straight to the art. They could borrow Freedoom
  Phase 1's `E1TEXT`–`E4TEXT` the way Doom II's screens borrow Phase 2's, if that's wanted.

## Audio

- ~~**Sound.**~~ Done ([src/channels.js](../src/channels.js)): 8 channels with `sounds.c`'s
  priorities, `P_AproxDistance` attenuation, map 8's floor, sounds that follow their source and
  stop with it. Not done: the chainsaw's and others' random pitch (vanilla 1.9 doesn't do it
  either).
- ~~**Music.**~~ Done: an emulated YM3812 (`src/opl.js`) driven by DMX's logic (`src/dmx.js`), in an
  AudioWorklet; and the YMF262 (OPL3) in stereo with 18 voices as DMX's `-opl3` option drove it,
  the **Synth** setting. Not done: the rhythm mode, the timers and 4-operator channels (DMX uses
  none of them).

## Tooling

- ~~**A visual regression test.**~~ Done (`npm run test:visual`, in CI): the README's thirteen
  pictures are rendered again and compared pixel for pixel with `docs/screenshots.json`. The
  simulation's `p_random()` makes them come out the same every time. The title loop's demos have
  the same guard (`npm run test:attract`): each replays to the checksum stored in it.
- ~~**Save compatibility.**~~ Done: `scripts/fixtures/saves/` holds a save in every shape the
  game has written (twelve, one per distinct set of tables and columns since the first save),
  made by `npm run save-fixtures` from git worktrees of each schema commit. `savegame-test`
  loads each with today's code: every saved value back, and 35 tics played on. None needed
  migrating; newer columns take their defaults.
- ~~**Four players over the network.**~~ Done: `npm run test:coop` ends with four pages, the host
  relaying for three guests: each one's keys move only their player, the four checksums agree
  while all fire, a chat to one player reaches only them, and a guest leaving stops the rest.
  It found the host keeping a guest's desync to itself (the others froze); `Lockstep.receive`
  now passes it on, and `netgame-test` checks that with four peers in a star.
- ~~**Offline play.**~~ Done ([public/sw.js](../public/sw.js)): the page's files are stored whole
  at install under a version the build stamps in, the WADs as the page downloads them
  (`keepWad`); network first, the caches when there's none. `openDatabase` now unregisters only
  the old `coi-serviceworker.js`. The browser test plays a level with the server stopped (Playwright's
  `setOffline` doesn't reach a service worker's own fetches, so stopping the server is the test).
- **A faster test suite.** The full pre-commit set runs one test after another and takes about
  25 minutes here. The SQL tests each open their own database, so most could run side by side
  (`npm run test:all`, with the browser tests on their own ports), and CI could split them
  across jobs.
- ~~**A browser matrix.**~~ Done (`.github/workflows/browsers.yml`, `scripts/launch-browser.mjs`):
  the browser and co-op tests run in Firefox and WebKit as well as Chromium, all passing; the
  README's **Browsers** lists what that covers. It found WebKit throwing on a send over a
  closing data channel (now the link closes). Left: Safari itself, pointer lock and touch, by hand.
- ~~**A test for the live frame loop.**~~ Done (`npm run test:browser`, in CI): headless
  Chromium plays through the title, the menus, a level, quicksave and quickload, the
  intermission, the next level, an ending, End Game and an attract demo; `npm run test:coop`
  connects two pages over WebRTC and plays co-op and deathmatch in lockstep.
