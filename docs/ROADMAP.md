# Roadmap: what's missing

What vanilla DOOM does that Firebird DOOM doesn't yet. Each open item says where it would go. For
how things fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Keep this list current: strike
items as they land, and add what you find missing.

## Still open

In the order they'd be noticed. The vanilla features first:

- **The automap in netgames** (Rendering): every player's arrow in co-op, only your own in
  deathmatch.
- **Mouse buttons 2 and 3** (Game flow and menus): strafe and forward; mouse-Y movement as an
  option.

Then the engineering:

- **Performance** of `FRAME_WALLS` (Rendering): ~22–33 ms a frame, with outliers near 90 ms; a
  measured plan is written there.
- **Save compatibility** (Tooling): a fixture of older saves, loaded by the current code.
- **A TURN relay** for multiplayer behind strict NATs (needs a server; the page has none): a
  Cloudflare Worker minting TURN credentials, with short room codes for the invites.
- **Two checks that need id's WADs** (Screens): DOOM I's episode maps at the intermission, and
  whether its endings should borrow Freedoom's text – with a `WAD=` for the screen tests so they
  can be run against a real `doom.wad` where one is to hand.
- **A browser matrix** (Tooling): what's known to work outside Chromium.
- **Declined extras**, noted where they come up: random sound pitch, the OPL3's rhythm mode and
  4-operator channels, a frag limit and obituaries (none of them vanilla 1.9).

Everything else below is done.

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
- ~~**The function keys.**~~ Done: `M_Responder`'s F1 help, F2 save, F3 load, F4 sound volume,
  F5 detail, F7 end game, F8 messages, F10 quit and F11 gamma, each with its sound and message,
  through the menu's entry points (`openReadThis`, `openSave`, …).
- **Mouse buttons 2 and 3.** Vanilla's defaults: button 2 strafes (held: the mouse's X moves you
  sideways), button 3 moves forward; and the mouse's Y moved the player (`mousey`), which most
  people turned off (the "novert" hacks). The buttons are a line each in `readInput`; mouse-Y
  movement as a remembered setting, off by default, with a note that vanilla had it on.

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

- **Performance.** A plan, measurement first (the machine is noisy, so alternate runs): (a) count
  what `FRAME_WALLS` sends per row and derive what can be derived on the JS side – the JSON
  hand-off is a third of the time and costs per value; (b) prototype reusing the previous frame's
  visible set when the view hasn't moved much; (c) raise a binary result transfer with
  `firebird-wasm`, with a measurement of what it would save. Each with a number to beat; the
  bench below.
  Measure with `node scripts/frame-bench.mjs E1M1 E1M2 …` (every monster awake,
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
- **The automap in netgames.** `AM_drawPlayers`: in co-op every player's arrow, in their colour
  (green, grey, brown, red – the sprite translations), a dead player's grey; in deathmatch only
  your own (the others stay hidden unless you cheat). Today only your arrow is drawn
  (`drawAutomap` in `main.js`; the other players' positions come with `FRAME_SPRITES`).
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
  animations are implemented, but only tested with stubs, because Freedoom ships them as empty
  placeholders. Check them with a real `doom.wad`: `doom.intermission('E1M3', 'E1M4')` in the
  console. Better: let `intermission-test` and `finale-test` take `WAD=` pointing at an id WAD
  (never shipped), so whoever has one runs the check in a minute.
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
- **Save compatibility.** Every schema change can break a player's saved games (the frags table
  needed a guard in `restoreGame`, by hand). A fixture of saves written by earlier versions,
  loaded by the current code in `savegame-test`, would catch that on CI, and say what each
  version needs migrating.
- **A browser matrix.** Everything is verified in headless Chromium. Safari and Firefox differ on
  the AudioWorklet, WebGL and pointer lock: a short list in the README of what's known to work
  where, from a manual pass, and the fallbacks each needs.
- ~~**A test for the live frame loop.**~~ Done (`npm run test:browser`, in CI): headless
  Chromium plays through the title, the menus, a level, quicksave and quickload, the
  intermission, the next level, an ending, End Game and an attract demo; `npm run test:coop`
  connects two pages over WebRTC and plays co-op and deathmatch in lockstep.
