# Roadmap: what's missing

What vanilla DOOM does that Firebird DOOM doesn't yet, roughly in order of how much a player would
notice. Each item says where it would go. For how things fit together, see
[ARCHITECTURE.md](ARCHITECTURE.md). Keep this list current: strike items as they land, and add what
you find missing.

## Game flow and menus

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

## Rendering

- **Performance.** Measure with `node scripts/frame-bench.mjs E1M1 E1M2 …` (every monster awake,
  eight spots per map looking four ways, the fastest of three). `DOOM_TIC` was halved by keying
  the BLOCKMAP by cell (10 ms on average over E1M1–E1M3 and E2M2, from 22; E1M2 15 ms, from 42).
  `FRAME_WALLS` is still about 22 ms on average, with outliers near 90 ms. About 9 ms of a typical
  frame is the BSP walk and the solid coverage; the rest is per column: each visible column of each
  seg is a `SUSPEND`ed row (about 1000–2000 a frame), sorted and clipped again by `RENDER_WALLS`.
  Shaving statements off the per-column loop (hoisting the closed-seg opening, skipping covered
  runs with `POSITION`) measured no better: the cost is per row, not per statement.
  Where `FRAME_WALLS`' ~23 ms goes (E1M1–E1M3, 24 views, ~990 rows): the BSP walk and column
  projection ~10–11 ms; `RENDER_WALLS`' sort and clip ~3 ms; and handing the rows to JavaScript
  ~9–10 ms. `firebird-wasm` sends results as JSON, and the cost is per value (~0.4 µs), so short
  integers cost as much as 17-digit doubles. Tried and measured no better: folding the clipping
  into the BSP pass with per-column clip strings (`OVERLAY`/`SUBSTRING` cost more than the layer
  they save: 27 ms), `FOR SELECT` instead of the cursor (the same), sending the clip values as
  whole rows (the same). Ideas left: fewer values per row (some of the 14 could be derived), a
  binary result transfer in `firebird-wasm` (outside this repo), caching static per-map work,
  reusing the previous frame's visible set. Moving the per-column stepping to JS (about 3× faster
  walls) was considered and turned down: Firebird decides, JavaScript draws.
- ~~**Automap.**~~ Done: zoom (= -), the whole-level view (0), follow mode and panning (F, arrows),
  the grid (G) and marks (M, C), as `AM_Responder` and `AM_Ticker` have them.
- ~~**Light diminishing and colormaps.**~~ Done: the exact `scalelight`/`zlight` tables and
  lookups, low detail's quirk, and the muzzle flash's `extralight`, checked against DOOM's fixed-point
  arithmetic by `npm run test:light`.
- **Status bar.** Done, frags in deathmatch included. The face is done:
  `ST_updateFaceWidget`'s priorities, turn faces and pain levels, plus `P_DeathThink`'s death camera.
- ~~**Messages.**~~ Done: each pickup shows the WAD's `DEHACKED` string (`GOTARMOR`,
  `GOTSHOTGUN`, …: Freedoom has them all, and a PWAD or `.deh` can replace them), else plain words
  of our own.

## Screens

- **Doom I episode maps with id's WADs.** The intermission's splats, "you are here" pointer and
  animations are implemented, but only tested with stubs, because Freedoom ships them as empty
  placeholders. Check them with a real `doom.wad`: `doom.intermission('E1M3', 'E1M4')` in the
  console.
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
  AudioWorklet. Not done: OPL3 mode with stereo (DMX ran the OPL2 in mono; Chocolate Doom's OPL3
  option is an extra), the rhythm mode and the timers (DMX uses neither).

## Tooling

- ~~**A visual regression test.**~~ Done (`npm run test:visual`, in CI): the README's eleven
  pictures are rendered again and compared pixel for pixel with `docs/screenshots.json`. The
  simulation's `p_random()` makes them come out the same every time.
- ~~**A test for the live frame loop.**~~ Done (`npm run test:browser`, in CI): headless
  Chromium plays through the title, the menus, a level, quicksave and quickload, the
  intermission, the next level, an ending and End Game.
