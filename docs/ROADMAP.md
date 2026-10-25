# Roadmap: what's missing

What vanilla DOOM does that Firebird DOOM doesn't yet. Each open item says where it would go. For
how things fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Keep this list current: strike
items as they land, and add what you find missing.

## Still open

The vanilla features are all done, including those a second pass through `g_game.c`,
`d_main.c` and `m_misc.c` found missing. What's left is engineering, two steps toward exact
fidelity (DOOM's frame tables, then its `.lmp` demos), and things for players around the game:

- **Performance** of `FRAME_WALLS` (Rendering): ~21 ms a frame now (from ~26), nothing at all
  while standing still. The plan's three steps are done or measured out; what's left is the
  engine's own work (~17 ms: the BSP walk, the projection, the clip), with the ideas tried
  written there.
- **Deploy the relay** (Multiplayer): `worker/relay.js` is written and tested (room codes, TURN
  credentials); it needs a Cloudflare account, a TURN key and `RELAY_URL` set for the site
  ([worker/README.md](../worker/README.md)). Then a check of TURN between two real networks.
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
- **DOOM's frame tables** (Simulation): *Done.* `info.c`'s states (`states[]`, each frame's sprite,
  tics, action and next state) in a table every thing and weapon steps through, as DOOM's do;
  DEHACKED Frame, Pointer and Weapon patches apply. It was the biggest gap to vanilla, done in
  seven phases (under **Simulation** below: *DOOM's frame tables, in phases*). The old per-mode
  rules are gone.
- **Original `.lmp` demos** (Simulation): playing id's and the community's demos needs the frame
  tables above (done) and DOOM's fixed-point physics, bit for bit. What stands in the way is in the
  README (*Simplifications*, "What's still not vanilla"): doubles and radians for 16.16 and BAMs,
  an LCG for `rndtable` (and its draws in DOOM's order everywhere), `P_SlideMove`, the blockmap's
  order, `P_DamageMobj`'s thrust. A stretch goal; it marks where full
  fidelity ends (the README lists "no `.lmp` demos" as a deviation).
- **An installable app** (Tooling): offline play is there (`sw.js`); a web manifest and icons
  would let the page install like an app, with its own window. Small.
- **Touch controls** (Input): on-screen move and turn pads and fire, use and weapon buttons for
  phones and tablets, reading into `readInput` like the gamepad does. Pairs with the iPhone pass.
- **Rejoining a netgame** (Multiplayer): a dropped player ends the game for everyone now. The
  host could send the current game to a player who comes back, the way a netgame starts from a
  save, and the lockstep go on from that tic.
- **Drawing off the main thread** (Rendering): the renderer and presenter in a Worker with an
  OffscreenCanvas, so input, sound and the page stay responsive when frames are slow (the browser
  test saw 3 frames a second with every test running beside it). The engine's ~17 ms of wall work
  doesn't shrink this way, but the page would stop waiting on it.
- **A debug build of firebird-wasm** (Engine): an engine build with source maps and assertions,
  made in `mariuz/electric-firebird`, to find where the WebKit trap above happens.
- **Splitting the browser test** (Tooling): it's the slowest CI job now (~4 minutes alone); two
  halves on runners side by side (`--part=browser` in two) would bring CI to about 3.
- **Rewind** (Showcase; not vanilla, ask first): the whole game is in tables, so a snapshot every
  second (as a save) would let a player step back in time, or open a past tic in the SQL console.
  Something only this port could do; DOOM never did it.
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

### DOOM's frame tables, in phases

**Where it stands.** A thing's behaviour is a mode, `things.st` (idle, chase, attack, pain, dying,
dead, and a few of its own: charge, heal, fly…), with a countdown (`st_tics`, `st_len`) and a
frame letter. Each mode's frames come from strings per type (`thing_types.walk_fr`, `atk_fr`,
`pain_fr`, `death_fr`; `src/thinginfo.js`), and the walking frames are animated by the renderer
(`render.sql`: a frame every 6 tics, offset by the thing's id), not by the simulation. The
movement, the aiming, the damage and the sounds follow `p_enemy.c` (38 of its action functions
are named in `game.sql`), but a zombieman's attack, say, isn't S_POSS_ATK1–3's 10 + 8 + 8 tics,
and the weapons run on the player's own timers (`attack_tics`). So DEHACKED's Frame, Pointer
and Weapon blocks are skipped (`dehacked.js` says so per block), and what an action does can't
be moved to another frame.

**Where it goes.** `info.c`'s two tables, as SQL: `states` (each frame's sprite, frame letter,
full-bright bit, tics, action and next state) and `mobjinfo`'s state columns on `thing_types`
(spawnstate, seestate, painstate, meleestate, missilestate, deathstate, xdeathstate,
raisestate). A thing holds its `state` and its `tics` left; `P_SetMobjState` and the thinker's
countdown (`P_MobjThinker`) run in SQL, and an action is called by name when its state is
entered, as in DOOM. The renderer draws the state's own sprite and frame.

**Phase 0: the licence, and the data.** *Done:* the table is kept in a file of its own under
GPL-2 (`src/states.js`, made by `npm run gen-states` from Chocolate Doom 3.1.0's `info.c` and
`info.h`); 967 states in the `states` table, each thing type's eight on `thing_types` (by map
number, or `MOBJ_TYPE` in `thinginfo.js` for the projectiles and effects), and `npm run
test:states` checking them. The plan as it was: The repo is MIT. `info.c` is id's code, GPL-2 since
1999; its ~967 states with their action names are a table of id's code, not a handful of facts
(the hit points and speeds already in `thinginfo.js` are). Before any of it lands, the owner
picks one: relicense the repo to GPL-2 (DOOM ports usually are); keep the table in a file of its
own under GPL-2 (`src/states.js`), which makes the site as a whole GPL when it ships; or
describe the states afresh from watching the game, which is slower and loses the exactness this
is for. Then: `states` and the mobjinfo state columns in `schema.sql`, loaded at startup like
`thing_types`. Test: the counts, every `next` a state that exists, every action one the port knows
or a no-op, and spot checks against the source (S_POSS_ATK1 is POSS E, 10 tics, A_FaceTarget).
Changes nothing that plays.

**Phase 1: the machine.** *Done:* `things.state` and `state_tic` (indexed), `SET_STATE`,
`STATE_ACTION` (A_Scream and A_Fall so far) and `STATES_THINK` in `WORLD_TIC`; `MONSTERS_THINK` skips a
stated thing, and `FRAME_SPRITES` draws its state's frame. ~5 µs a tic with nothing due. One thing
for phase 2: `MONSTERS_THINK` also moves things (momentum, falling), so a stated thing stands still
until that part runs for it too. The plan as it was: `things.state`, `things.tics` and an indexed `things.state_tic` (the
tic its state ends, so a tic touches only the things whose state ends then, as the "idle things
think every 8 tics" rule does now: per-thing countdowns in PSQL would cost every tic). A
`SET_STATE` procedure follows `next` through 0-tic states and calls the actions; a thing with a
NULL state keeps today's rules, so nothing moves yet. `FRAME_SPRITES` draws a stated thing's
state. Test: a thing set to a state walks the table's chain with the table's timings, tic by
tic, and a frame-bench run shows what it costs.

**Phase 2: the monsters, family by family.** *Under way.* The first families are done: the zombieman,
the shotgun guy and the chaingunner, then the imp (A_TroopAttack, `A_MELEE_MISSILE`, which A_HeadAttack and
A_BruisAttack will share), then the demon and the spectre (A_SargAttack; `states.fast` marks
S_SARG_RUN1–S_SARG_PAIN2, whose tics `SET_STATE` halves with -fast or on Nightmare), then the lost soul (A_SkullAttack;
`SKULLS_THINK` is P_XYMovement for MF_SKULLFLY, 262144 in `things.flags`; `STATES_THINK`'s
P_ZMovement floats fliers and bounces a charging skull; `P_CheckMissileRange`'s per-type rules),
then the cacodemon (A_HeadAttack). The loader works a state's mode out from the death chains first:
a corpse's last frame is also the spawn state of the map's dead-monster decorations, and was
'idle' until the cacodemon's test found it (corpses that could be shot, and that the arch-vile and
Nightmare passed over); `ADOPT_STATES` mends such corpses in a save; then the barons (A_BruisAttack; the baron's A_BossDeath in S_BOSS_DIE7), then the cyberdemon and the spider mastermind (A_CyberAttack, A_Hoof, A_Metal, A_SpidRefire; their A_BossDeath at the end of 110 and 130 tics of dying), then the SS guard, Keen (A_KeenDie), the pain elemental (A_PainAttack, A_PainDie; souls spat in the state pass fly their first step that tic, as a new thinker does), the mancubus (A_FatRaise, A_FatAttack1–3) and the arachnotron (A_BspiAttack, A_BabyMetal), then the revenant (A_SkelWhoosh, A_SkelFist, A_SkelMissile) and the arch-vile (A_VileChase with PIT_VileCheck's reach and room, A_VileStart, A_VileTarget, A_VileAttack; its fire, MT_FIRE, stays on the old rules until phase 3) (`thinginfo.js`'s `ON_STATES`; `thing_types.on_states`) spawn
into their spawn state, partway in, with mobjinfo's reaction time, and run on A_Look, A_Chase,
A_FaceTarget, A_PosAttack, A_SPosAttack, A_CPosAttack, A_CPosRefire, A_Pain, A_Scream (the random
cries), A_XScream and A_Fall, each a procedure of its own; `DAMAGE_THING` sends them into their
pain, death and xdeath states (MF_JUSTHIT, the `&3` tic cut), and the arch-vile raises them through
their raise state. Each state carries a `mode` the loader works out from mobjinfo's chains (idle,
chase, attack, pain, dying, dead, raise), copied into `things.st`, so the code that asks "can it be
shot, is it a corpse" works for both kinds. `STATES_THINK` lets a stated walker tossed into the
air fall (P_ZMovement). `ADOPT_STATES` moves an old save's zombies onto the table. Phase 2 is done. The plan as
it was: zombieman, sergeant and chaingunner first
(A_Look, A_Chase, A_FaceTarget, A_PosAttack, A_SPosAttack, A_CPosAttack, A_CPosRefire, A_Pain,
A_Scream, A_XScream, A_Fall), then the imp, the demons, the lost soul, the cacodemon, the barons,
the bosses, and DOOM II's. Each action's body is the code already in `MONSTERS_THINK`
(`look_for_player`, `new_chase_dir`, `p_move`, `hitscan`, `monster_missile`), moved under its
name; each family leaves its mode code behind when it moves. Test (a `states-test`, or in
`physics-test`): a monster woken in front of the player goes through the table's states with
its timings (the zombieman's 10 + 8 + 8 tics to fire), pain and death take its painstate and
deathstate (xdeath when gibbed), and the existing behaviour tests still pass.

**Phase 3: everything else that animates.** *Done.* The projectiles are done (ON_STATES 9000–9008):
`MISSILE_CHECK` (PIT_CheckLine for a missile, with the ceilingline's sky), `MISSILE_TRY` (PIT_CheckThing and
the move), `EXPLODE_MISSILE` (P_ExplodeMissile), `CHECK_MISSILE_SPAWN` (P_CheckMissileSpawn), `MISSILES_THINK`
(P_XYMovement's half moves, P_ZMovement), A_Explode, A_BFGSpray and A_Tracer; a missile spawned in the state
pass moves that tic. Two changes from the old rules: a missile bursts on a sky ceiling (DOOM's P_ZMovement)
instead of vanishing, and starts at its shooter rather than a body's width ahead. Then the boss brain (88), its spitter (89), its cubes (9009, MF_NOCLIP: MISSILES_THINK flies them through walls)
and its explosions (9013, MT_ROCKETs): A_BrainAwake, A_BrainSpit (braintargeton and easy in `game.brain_on`,
`brain_easy`), A_SpawnSound, A_SpawnFly, A_BrainPain, A_BrainScream, A_BrainExplode, A_BrainDie. Then the effects:
puffs (`SPAWN_PUFF`), blood (`SPAWN_BLOOD`), MT_SMOKE (a new type, 9018), the fogs, the BFG's hits, the spawn
fire and the arch-vile's fire (A_Fire, A_StartFire, A_FireCrackle), with `thing_types.nogravity` for
MF_NOGRAVITY and P_ZMovement's 2-from-rest gravity. Then barrels (S_BAR, S_BEXP; the target a non-lethal hit sets credited with A_Explode). Then the items and
decorations (all of them: `thinginfo.js` adds every 'item' and 'decor' type to ON_STATES; the hanging ones
are MF_NOGRAVITY). Their frames cost about 1.2 ms a tic in `STATES_THINK` on a big map (MAP11: some 200 more
things cycling); a bulk MERGE of the plain frame changes and a fast path in the loop measured no better.
P_ZMovement's "off the floor" is now the top of a toss, marked MF_INAIR (1048576 in `things.flags`), not a
per-tic look at every thing's floor. Last, the player's body (type 1 in ON_STATES, MT_PLAYER's reaction time 0):
P_MovePlayer's S_PLAY_RUN1, P_XYMovement's S_PLAY, P_FireWeapon's S_PLAY_ATK1 and the flash's S_PLAY_ATK2 (with the
shot until phase 4 gives the weapons their frames), P_DamageMobj's S_PLAY_PAIN (painchance 255; the pain ends a
teleport's freeze) and P_KillMobj's death or xdeath (not solid; A_PlayerScream, DSPDIEHI in DOOM II below -50).
`PLAYER_ANIM` and `DAMAGE_PLAYER`'s immediate cries are gone; the body moves in `PLAYER_THINK`, so
`STATES_THINK`'s P_ZMovement passes it by. The plan as it was: Projectiles (and their explosions), the player's
own sprite (S_PLAY…), puffs and blood, barrels, the decorations and items, the teleport fog, the
arch-vile's fire and the boss brain's cubes and spawn fire. Then the renderer's own walking
animation and the frame strings in `thinginfo.js` go.

**Phase 4: the weapons.** *Done.* The player's two psprites (`ps_weapon`, `ps_flash`) as states:
A_WeaponReady, A_ReFire, A_Lower, A_Raise, A_GunFlash and each weapon's fire action at the
frames `info.c` gives them, the bobbing, and the renderer's psprite drawn from the state.
`attack_tics` goes. Test: `weapons-test` (both WADs) gains each weapon's fire cycle in tics
(the pistol's 4 + 6 + 4 + 5, the super shotgun's long reload).

How it landed:
- **Data:** `gen-states` also reads `d_items.c`: `WEAPONINFO` in `src/states.js`, the
  `weapon_info` table.
- **The player's psprites:** in `player` (`psp_state`, `psp_tics`, `psp_sx`, `psp_sy`,
  `flash_state`, `flash_tics`, plus `refire`, `attack_down`, `buttons`, `extralight` and `bob`).
- **The machine:** `SET_PSPRITE` (P_SetPsprite), `MOVE_PSPRITES` (P_MovePsprites, at the end of
  `PLAYER_THINK` and in P_DeathThink), `PSPRITE_ACTION` and the actions.
- **Firing and changing:** `CHECK_AMMO`, `FIRE_WEAPON`, `BRING_UP_WEAPON`, `SETUP_PSPRITES` (in
  `INIT_MAP` and `REBORN_PLAYER`), and `DAMAGE_PLAYER`'s P_DropWeapon.
- **The shots:** P_BulletSlope, P_GunShot and the P_SubRandom spreads; `AIM_TARGET` gives A_Punch
  and A_Saw their linetarget.
- **The HUD:** `HUD_ROW` returns the two pictures and the place. `hud.js` draws them, weapon
  then flash, and the view's light comes from the flash states' A_Light.
- **Old saves:** their retired columns (`attack_tics`, `attack_len`, `weapon_y`,
  `weapon_down`) are dropped as they load (`savegame.js`'s `RETIRED`), and `ADOPT_STATES` puts
  the weapon up and ready.
- **Not changed:** the weapon keys still choose as before (1 toggles the fist and chainsaw;
  3 picks the super shotgun only with 2 shells). DOOM's own rules in `P_PlayerThink` differ
  slightly and could follow.

**Phase 5: DEHACKED.** *Done.* Frame blocks (sprite, frame, tics, next state, bright), Pointer blocks
(an action moved to another frame), Weapon blocks' states and Thing blocks' state fields, in
`dehacked.js`, into the same tables. Freedoom's own Frame patches then apply (the log's "not
applied (no state tables in this port)" lines go). Test: `dehacked-test` gains a patch that
gives the imp a faster attack and another that moves an action, and checks both play out.

How it landed:
- **Applying:** `applyDehacked` patches copies of `src/states.js`'s tables (`STATES`,
  `WEAPONINFO`, `MOBJINFO`'s state columns) and returns them. The loader writes them into
  `states`, `weapon_info` and `thing_types`, and works out the states' modes from the patched
  chains.
- **What's read:**
  - Frame: Sprite number (`SPRITES`, now generated too), Sprite subnumber, Duration, Next
    frame, Unknown 1/2, and frame 966's overflow into weaponinfo[0];
  - Pointer: Codep Frame, from the actions as the game shipped;
  - Weapon: Ammo type and the five frames;
  - Thing: the eight frames and Reaction time (a new `thing_types.reaction_time`, which
    `SPAWN_THING` and `INIT_MAP` now read).
- **Map numbers:** a type moved by `ID #` keeps its base type's states.
- **Moved actions:** so they play as DOOM's, A_TroopAttack, A_HeadAttack, A_BruisAttack,
  A_CyberAttack, A_BspiAttack, A_SkelMissile and A_FatAttack1–3 name their own projectile
  (no longer the caller's type's), and play its seesound (`seeSnd` on the projectile types). The
  player's rocket and plasma do the same.
- **A fix it found:** two things in one spot made Firebird's ATAN2 refuse (0, 0). `ATAN2_SAFE`
  gives 0 there, as R_PointToAngle2 does, and every angle in `game.sql` goes through it.
- **Not supported:** Sound, Sprite and Text blocks, and BEX's [CODEPTR] (Chocolate Doom doesn't
  read it either).

**Phase 6: the cleanup.** *Done.* `st`, `st_tics`, `st_len`, `step`, the frame strings and the
per-mode code go; the README's "frame tables" deviation goes; what's still not vanilla (the
fixed-point arithmetic, P_Random's call order) is said, for the `.lmp` item after this.

How it landed:
- **The old rules:** `MONSTERS_THINK` (some 900 lines), WORLD_TIC's chase countdown, and
  DAMAGE_THING's and A_PainShootSkull's old-rules branches are gone; RENDER's frame-letter fallback
  too.
- **Old columns:** `things.st_tics`, `st_len`, `step`, `frame`, `sprite`, `think_tic` and
  `thing_types`' frame strings and old attack fields (`walk_fr`, `atk_fr`, `pain_fr`,
  `death_fr`, `death_sprite`, `bright`, `atk_kind`, `missile_type`, `dmg_hi`, `shots`, the
  revenant's `melee_*`) are dropped, and so are their fields in `thinginfo.js`.
- **Old saves:** they lose those columns as they load (`savegame.js`'s RETIRED).
- **`ON_STATES`:** every type but the markers.
- **`st` stays,** with a new meaning: SET_STATE's copy of the state's mode, kept for the many
  queries that ask "can it be shot, is it a corpse" without a join. It's written only by SET_STATE,
  SPAWN_THING and the respawns.
- **What DOOM checks by type, now by type:** the arch-vile's rules check MT_VILE (64), not an
  attack kind.
- **`atkSnd` is mobjinfo's attacksound:** A_Chase plays it before a melee attack, and
  A_SkullAttack as it charges. The shots' sounds are the actions' and the projectiles' own.
- **The lost soul's charge** does (P_Random() % 8 + 1) × its damage (DeHackEd's Missile damage).
- **The finale's cast call** plays from the state table: F_StartCast, F_CastTicker with its sound
  hacks, F_CastResponder, as a WAD's DEHACKED left the tables. It used to play frame strings.
- **A fidelity fix:** a Nightmare respawn's new body waits 18 tics (P_NightmareRespawn's
  reactiontime), as DOOM's does.

**Every phase**, because the simulation changes: the attract demos are recorded again (`npm run
attract`) and `DEMO_VERSION`, `NET_VERSION` and the save version go up; `npm run save-fixtures`
adds a save in the new shape, and `restoreGame` migrates the older ones (an old `st` mapped to
the type's spawn, see or death state). `p_random()` only, and an `ORDER BY` on every loop
whose order counts (CLAUDE.md, *Determinism*). The visual test's pictures change in phase 3
(the walking frames), and are taken again then.

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
  intermission. The relay ([worker/relay.js](../worker/relay.js), a Cloudflare Worker): six-letter
  room codes instead of pasted replies, and TURN servers with short-lived credentials for players
  behind strict NATs; tested locally (`npm run test:relay`, and the co-op test through
  `scripts/relay-dev.mjs`), deployed once someone has the Cloudflare account.
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
- ~~**A faster test suite.**~~ Done (`npm run test:all`, `scripts/test-all.mjs`): the 28 tests run
  as many at once as there are cores, the longest first, after one build that the two browser
  tests serve (`NO_BUILD=1`). About 9 minutes here against 25 one after another. CI runs it in
  three jobs side by side (`--part=sql|browser|coop`): in one job on a 4-core runner the browser
  tests took 12–16 minutes beside the rest, longer than the old steps one at a time. The
  browser tests are the critical path; splitting the browser test itself would be the next step.
- ~~**A browser matrix.**~~ Done (`.github/workflows/browsers.yml`, `scripts/launch-browser.mjs`):
  the browser and co-op tests run in Firefox and WebKit as well as Chromium, all passing; the
  README's **Browsers** lists what that covers. It found WebKit throwing on a send over a
  closing data channel (now the link closes). Left: Safari itself, pointer lock and touch, by hand.
- ~~**A test for the live frame loop.**~~ Done (`npm run test:browser`, in CI): headless
  Chromium plays through the title, the menus, a level, quicksave and quickload, the
  intermission, the next level, an ending, End Game and an attract demo; `npm run test:coop`
  connects two pages over WebRTC and plays co-op and deathmatch in lockstep.
