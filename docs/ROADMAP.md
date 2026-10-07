# Roadmap: what's missing

What vanilla DOOM does that Firebird DOOM doesn't yet, roughly in order of how much a player would
notice. Each item says where it would go. For how things fit together, see
[ARCHITECTURE.md](ARCHITECTURE.md). Keep this list current: strike items as they land, and add what
you find missing.

## Game flow and menus

- ~~**Skill levels.**~~ Done: the **Skill** setting, with spawn flags, half damage and double ammo
  on 1, and Nightmare's fast monsters, instant reactions, respawning and no cheats on 5.
  Still missing: DOOM's dropped clips giving half ammo (`MF_DROPPED`), on any skill.
- ~~**Main menu, new game and episode select.**~~ Done ([src/menu.js](../src/menu.js)): the
  title loop, the main menu, episode and skill select, Options, Read This!, Quit. Still missing:
  the demo loop between the title pages (needs demo playback), the Screen Size option, and
  Load/Save, since done.
- ~~**Save and load.**~~ Done ([src/savegame.js](../src/savegame.js)): six IndexedDB slots per WAD
  from the menu. A save is a JSON snapshot of the live tables. Still missing: quicksave and
  quickload (F6/F9), and exporting or importing saves as files.
- ~~**Demos.**~~ Done ([src/demo.js](../src/demo.js)): record a level, play it back, download it
  or load it as a JSON file. The simulation is deterministic: `P_RANDOM` is seeded from
  `GAME.RNG`, and thing ids restart on every load. Not possible: DOOM's own `.lmp` demos. They
  need a bit-identical simulation (fixed point, the 256-entry random table consumed in the same
  order), and this is a re-implementation. That also means the title loop has no attract demos.
  Still missing: demos that span several levels, and multiplayer.
- **The end of the game.** After Doom I's E?M8 ending the port carries on into the next episode,
  and after E4 into E1M1. After Doom II's cast call it loops, as in vanilla. Vanilla ends the game
  after each episode. An option for vanilla behaviour may be wanted.

## Simulation (`sql/game.sql`)

- **Armour types.** All armour absorbs a third of the damage. DOOM's green armour (type 1) takes
  ⅓, and blue armour and the megasphere (type 2) take ½. Needs a `player.armor_type`.
- **Weapon raise and lower.** Switching weapons is instant. DOOM lowers one and raises the other
  (`A_Lower`/`A_Raise`, about half a second), and you can't fire meanwhile.
- **Monster active sounds.** Monsters don't make their idle growls while chasing (`activesound`,
  for example `DSPOSACT`, `DSDMACT`, `DSBGACT`, 3/256 per chase step).
- **Monster chase details.** `P_NewChaseDir` is simplified: straight at the target, then 45° and
  90° either side, then random. DOOM's eight-direction choice with turnaround avoidance and
  `movecount` makes monsters wander more convincingly. `A_Look`'s 180° field of view (monsters
  behind you don't see you until they hear you) needs checking.
- **Sector specials.** Missing: 10 (door closes after 30 s), 14 (door opens after 5 minutes), and
  11's exit: E1M8's floor ends the level when your health drops to 10 or below (only its damage and
  its cancelling of god mode are done). Also check the lighting types against `P_SpawnSpecials`:
  1, 2, 3, 8, 12, 13 and 17 are done.
- **Linedef specials.** Missing: scrolling walls (48), and the less common door, lift and floor
  variants. `ACTIVATE_LINE` maps specials to actions in one `CASE`, so a missing number does
  nothing.
- **Telefrag.** A teleport onto a monster should kill it (10000 damage).
- **Multiplayer and deathmatch.** Single player only. Co-op and deathmatch starts and things are
  skipped.
- **DEHACKED beyond `[STRINGS]`.** Thing, frame, weapon, ammo and pointer patches aren't applied,
  so mods that rely on them won't behave.
- **PWADs.** The WAD picker loads one IWAD. Loading a PWAD on top (replacing maps and resources by
  lump name) is missing.

## Rendering

- **Performance.** `FRAME_WALLS` costs about 40–160 ms a frame, so large maps with many awake
  monsters can drop below 10 fps. *Low* detail halves it. Ideas: cache static per-map work, cut
  `RENDER_SLICES_BSP`'s per-column overhead, reuse the previous frame's visible set.
- **Automap.** It follows you at one fixed scale. DOOM's automap zooms, pans when not following,
  and has a grid and marks.
- **Light diminishing and colormaps.** Close to DOOM's `scalelight`/`zlight` but not
  pixel-identical. A side-by-side check against a reference port would settle it.
- **Status bar.** No arms/frags switch for deathmatch, and the face doesn't look towards where
  damage came from (`ST_updateFaceWidget`'s turn faces).
- **Messages.** Pickup messages say "Picked up …". DOOM's own texts are mostly in the executable,
  but Freedoom's `DEHACKED` has replacements (`GOTARMOR`, `GOTSHOTGUN`, …) that could be used,
  as the story text already is.

## Screens

- **Doom I episode maps with id's WADs.** The intermission's splats, "you are here" pointer and
  animations are implemented, but only tested with stubs, because Freedoom ships them as empty
  placeholders. Check them with a real `doom.wad`: `doom.intermission('E1M3', 'E1M4')` in the
  console.
- **Screen wipe.** DOOM melts the old screen into the new (`wipe_StartScreen`, the column melt)
  between the game, the intermission and the endings. Cuts are instant here.
- **Doom I endings' text with id's WADs.** They go straight to the art. They could borrow Freedoom
  Phase 1's `E1TEXT`–`E4TEXT` the way Doom II's screens borrow Phase 2's, if that's wanted.

## Audio

- **Sound.** One channel per origin and no channel limit. DOOM mixes 8 channels with priorities.
  Sounds don't follow a moving source after they start.
- **Music.** The OPL2-style synth is an approximation of DMX's OPL playback (no OPL3, simplified
  envelopes). A real OPL emulator (for example a port of Nuked-OPL3) would sound right.

## Tooling

- **A visual regression test.** Compare `docs/screenshot-*.png` renders against stored hashes in
  CI, so rendering changes are noticed. Monster movement makes some shots non-deterministic, so it
  needs a fixed seed for `RAND()`.
- **A test for the live frame loop.** The hand-offs between game, intermission and finale in
  `main.js` are only checked by hand. A headless browser test, such as Playwright in CI, would
  cover them.
