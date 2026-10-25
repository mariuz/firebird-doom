// thinginfo.js – DOOM's mobjinfo, the parts this port keeps beside its frame tables.
//
// Loaded into the THING_TYPES table at startup; from then on only SQL reads
// it. Values follow info.c (hit points, speed, radius, pain chance, damage,
// sounds); every type's animation and behaviour are its states, in
// src/states.js (MOBJINFO's state columns: typeStates in the loader).

const M = (type, sprite, o) => ({ type, sprite, kind: 'monster', radius: 20, height: 56, solid: 1, ...o });
const D = (type, sprite, o = {}) => ({ type, sprite, kind: 'decor', radius: 16, height: 16, solid: 0, ...o });
const S = (type, sprite, o = {}) => D(type, sprite, { solid: 1, height: 48, ...o });
const I = (type, sprite, pickup, amount, o = {}) => ({ type, sprite, kind: 'item', radius: 20, height: 16, solid: 0, pickup, amount, ...o });

export const THING_TYPES = [
  // player start + projectiles + effects (spawned by SQL, never by maps)
  { type: 1, sprite: 'PLAY', kind: 'player', radius: 16, height: 56, solid: 1, hp: 100, painSnd: 'DSPLPAIN', deathSnd: 'DSPLDETH' },
  // (the projectiles' seeSnd is mobjinfo's seesound: the sound P_SpawnMissile and
  // P_SpawnPlayerMissile make as they fire it – the BFG's ball has none)
  { type: 9000, sprite: 'BAL1', kind: 'missile', radius: 6, height: 8, speed: 10, dmgLo: 3, deathSnd: 'DSFIRXPL', seeSnd: 'DSFIRSHT' },
  { type: 9001, sprite: 'BAL2', kind: 'missile', radius: 6, height: 8, speed: 10, dmgLo: 5, deathSnd: 'DSFIRXPL', seeSnd: 'DSFIRSHT' },
  { type: 9002, sprite: 'BAL7', kind: 'missile', radius: 6, height: 16, speed: 15, dmgLo: 8, deathSnd: 'DSFIRXPL', seeSnd: 'DSFIRSHT' },
  { type: 14, sprite: 'TFOG', kind: 'marker', radius: 1, height: 1 }, // teleport destination
  // the player's projectiles: damage is dmgLo × (1..8), like DOOM's ((P_Random()%8)+1)*damage
  { type: 9003, sprite: 'MISL', kind: 'missile', radius: 11, height: 8, speed: 20, dmgLo: 20, deathSnd: 'DSBAREXP', seeSnd: 'DSRLAUNC' },
  { type: 9004, sprite: 'PLSS', kind: 'missile', radius: 13, height: 8, speed: 25, dmgLo: 5, deathSnd: 'DSFIRXPL', seeSnd: 'DSPLASMA' },
  { type: 9005, sprite: 'BFS1', kind: 'missile', radius: 13, height: 8, speed: 25, dmgLo: 100, deathSnd: 'DSRXPLOD' },
  // DOOM II monsters' projectiles
  { type: 9006, sprite: 'FATB', kind: 'missile', radius: 11, height: 8, speed: 10, dmgLo: 10, deathSnd: 'DSBAREXP', seeSnd: 'DSSKEATK' },
  { type: 9007, sprite: 'MANF', kind: 'missile', radius: 6, height: 8, speed: 20, dmgLo: 8, deathSnd: 'DSFIRXPL', seeSnd: 'DSFIRSHT' },
  { type: 9008, sprite: 'APLS', kind: 'missile', radius: 13, height: 8, speed: 25, dmgLo: 5, deathSnd: 'DSFIRXPL', seeSnd: 'DSPLASMA' },
  // the arch-vile's fire (A_VileTarget / A_Fire)
  { type: 9015, sprite: 'FIRE', kind: 'flame', radius: 1, height: 1 },
  { type: 9012, sprite: 'BFE2', kind: 'fx', radius: 1, height: 1 },
  { type: 9010, sprite: 'PUFF', kind: 'fx', radius: 1, height: 1 },
  { type: 9011, sprite: 'BLUD', kind: 'fx', radius: 1, height: 1 },

  // monsters
  M(3004, 'POSS', { hp: 20, speed: 8, painChance: 200, drop: 2007, seeSnd: 'DSPOSIT1', atkSnd: 'DSPISTOL', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH1', activeSnd: 'DSPOSACT' }),
  M(9, 'SPOS', { hp: 30, speed: 8, painChance: 170, drop: 2001, seeSnd: 'DSPOSIT2', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH2', activeSnd: 'DSPOSACT' }),
  M(65, 'CPOS', { hp: 70, speed: 8, painChance: 170, drop: 2002, seeSnd: 'DSPOSIT2', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH2', activeSnd: 'DSPOSACT' }),
  M(3001, 'TROO', { hp: 60, speed: 8, painChance: 200, seeSnd: 'DSBGSIT1', painSnd: 'DSPOPAIN', deathSnd: 'DSBGDTH1', activeSnd: 'DSBGACT' }),
  M(3002, 'SARG', { hp: 150, speed: 10, radius: 30, painChance: 180, seeSnd: 'DSSGTSIT', atkSnd: 'DSSGTATK', painSnd: 'DSDMPAIN', deathSnd: 'DSSGTDTH', activeSnd: 'DSDMACT' }),
  M(58, 'SARG', { hp: 150, speed: 10, radius: 30, painChance: 180, seeSnd: 'DSSGTSIT', atkSnd: 'DSSGTATK', painSnd: 'DSDMPAIN', deathSnd: 'DSSGTDTH', activeSnd: 'DSDMACT' }),
  M(3006, 'SKUL', { hp: 100, speed: 8, radius: 16, painChance: 256, dmgLo: 3, atkSnd: 'DSSKLATK', painSnd: 'DSDMPAIN', deathSnd: 'DSFIRXPL', activeSnd: 'DSDMACT' }),
  M(3005, 'HEAD', { hp: 400, speed: 8, radius: 31, painChance: 128, seeSnd: 'DSCACSIT', painSnd: 'DSDMPAIN', deathSnd: 'DSCACDTH', activeSnd: 'DSDMACT' }),
  M(3003, 'BOSS', { hp: 1000, speed: 8, radius: 24, height: 64, painChance: 50, seeSnd: 'DSBRSSIT', painSnd: 'DSDMPAIN', deathSnd: 'DSBRSDTH', activeSnd: 'DSDMACT' }),
  M(69, 'BOS2', { hp: 500, speed: 8, radius: 24, height: 64, painChance: 50, seeSnd: 'DSKNTSIT', painSnd: 'DSDMPAIN', deathSnd: 'DSKNTDTH', activeSnd: 'DSDMACT' }),   // (MT_KNIGHT's own cries)
  // the bosses
  M(16, 'CYBR', { hp: 4000, speed: 16, radius: 40, height: 110, painChance: 20, seeSnd: 'DSCYBSIT', painSnd: 'DSDMPAIN', deathSnd: 'DSCYBDTH', activeSnd: 'DSDMACT' }),
  M(7, 'SPID', { hp: 3000, speed: 12, radius: 128, height: 100, painChance: 40, seeSnd: 'DSSPISIT', atkSnd: 'DSSHOTGN', painSnd: 'DSDMPAIN', deathSnd: 'DSSPIDTH', activeSnd: 'DSDMACT' }),
  // DOOM II's
  M(64, 'VILE', { hp: 700, speed: 15, painChance: 10, seeSnd: 'DSVILSIT', painSnd: 'DSVIPAIN', deathSnd: 'DSVILDTH', activeSnd: 'DSVILACT' }),
  M(66, 'SKEL', { hp: 300, speed: 10, painChance: 100, seeSnd: 'DSSKESIT', painSnd: 'DSPOPAIN', deathSnd: 'DSSKEDTH', activeSnd: 'DSSKEACT' }),
  M(67, 'FATT', { hp: 600, speed: 8, radius: 48, height: 64, painChance: 80, seeSnd: 'DSMANSIT', painSnd: 'DSMNPAIN', deathSnd: 'DSMANDTH', activeSnd: 'DSPOSACT' }),
  M(68, 'BSPI', { hp: 500, speed: 12, radius: 64, height: 64, painChance: 128, seeSnd: 'DSBSPSIT', painSnd: 'DSDMPAIN', deathSnd: 'DSBSPDTH', activeSnd: 'DSBSPACT' }),
  // the pain elemental's "missile" is a lost soul (A_PainAttack), capped at 20
  M(71, 'PAIN', { hp: 400, speed: 8, radius: 31, painChance: 128, seeSnd: 'DSPESIT', painSnd: 'DSPEPAIN', deathSnd: 'DSPEDTH', activeSnd: 'DSDMACT' }),
  M(84, 'SSWV', { hp: 50, speed: 8, painChance: 170, drop: 2007, seeSnd: 'DSSSSIT', painSnd: 'DSPOPAIN', deathSnd: 'DSSSDTH', activeSnd: 'DSPOSACT' }),
  // Commander Keen, hanging in MAP32: killing every Keen opens the sectors tagged 666
  { type: 72, sprite: 'KEEN', kind: 'keen', radius: 16, height: 72, solid: 1, hang: 1, hp: 100, painChance: 256, painSnd: 'DSKEENPN', deathSnd: 'DSKEENDT' },
  // the Icon of Sin: the brain (shoot it to win), the shooter that spits cubes
  // at the target spots, and the cube that turns into a monster where it lands
  { type: 88, sprite: 'BBRN', kind: 'brain', radius: 16, height: 16, solid: 1, hp: 250, painChance: 255, painSnd: 'DSBOSPN', deathSnd: 'DSBOSDTH' },
  { type: 89, sprite: 'BOSF', kind: 'shooter', radius: 20, height: 32 },
  { type: 87, sprite: 'BOSF', kind: 'marker', radius: 1, height: 1 },
  { type: 9009, sprite: 'BOSF', kind: 'cube', radius: 6, height: 32, speed: 10 },
  { type: 9013, sprite: 'MISL', kind: 'missile', radius: 11, height: 8, speed: 20, dmgLo: 20, deathSnd: 'DSBAREXP' },   // (A_BrainScream's rockets: MT_ROCKET)
  { type: 9014, sprite: 'FIRE', kind: 'fx', radius: 1, height: 1 },
  // teleport fog (MT_TFOG): a monster getting back up on Nightmare
  { type: 9016, sprite: 'TFOG', kind: 'fx', radius: 1, height: 1 },
  { type: 9017, sprite: 'IFOG', kind: 'fx', radius: 1, height: 1 },   // MT_IFOG: an item respawning
  { type: 9018, sprite: 'PUFF', kind: 'fx', radius: 1, height: 1 },   // MT_SMOKE: the revenant's missile's trail
  // shootable barrel – "dies" by exploding
  { type: 2035, sprite: 'BAR1', kind: 'barrel', radius: 10, height: 42, solid: 1, hp: 20, deathSnd: 'DSBAREXP' },

  // items: pickup kind + amount
  I(2011, 'STIM', 'health', 10), I(2012, 'MEDI', 'health', 25),
  I(2014, 'BON1', 'health+', 1), I(2013, 'SOUL', 'soul', 100),
  I(2015, 'BON2', 'armor+', 1),
  I(2018, 'ARM1', 'armor', 100), I(2019, 'ARM2', 'armor', 200),
  I(2007, 'CLIP', 'bullets', 10), I(2048, 'AMMO', 'bullets', 50),
  I(2008, 'SHEL', 'shells', 4), I(2049, 'SBOX', 'shells', 20),
  I(2001, 'SHOT', 'shotgun', 8), I(2002, 'MGUN', 'chaingun', 20),
  I(8, 'BPAK', 'backpack', 10),
  I(82, 'SGN2', 'ssg', 8), I(83, 'MEGA', 'mega', 200),
  I(5, 'BKEY', 'key', 1), I(6, 'YKEY', 'key', 2), I(13, 'RKEY', 'key', 4),
  I(40, 'BSKU', 'key', 1), I(39, 'YSKU', 'key', 2), I(38, 'RSKU', 'key', 4),
  I(2023, 'PSTR', 'berserk', 100), I(2026, 'PMAP', 'allmap', 1),
  I(2022, 'PINV', 'invuln', 1050), I(2024, 'PINS', 'invis', 2100),
  I(2025, 'SUIT', 'suit', 2100), I(2045, 'PVIS', 'goggles', 4200),
  I(2003, 'LAUN', 'launcher', 2), I(2004, 'PLAS', 'plasma', 40), I(2005, 'CSAW', 'chainsaw', 0), I(2006, 'BFUG', 'bfg', 40),
  I(2010, 'ROCK', 'rockets', 1), I(2046, 'BROK', 'rockets', 5), I(17, 'CELP', 'cells', 100), I(2047, 'CELL', 'cells', 20),

  // solid decorations
  S(2028, 'COLU'), S(48, 'ELEC'), S(30, 'COL1'), S(31, 'COL2'), S(32, 'COL3'), S(33, 'COL4'),
  S(36, 'COL5'), S(37, 'COL6'), S(35, 'CBRA'), S(41, 'CEYE'),
  S(42, 'FSKU'), S(43, 'TRE1'), S(54, 'TRE2', { radius: 32 }), S(47, 'SMIT'),
  S(44, 'TBLU'), S(45, 'TGRN'), S(46, 'TRED'),
  S(55, 'SMBT'), S(56, 'SMGT'), S(57, 'SMRT'),
  S(70, 'FCAN'), S(85, 'TLMP'), S(86, 'TLP2'),
  S(25, 'POL1'), S(26, 'POL6'), S(27, 'POL4'), S(28, 'POL2'), S(29, 'POL3'),
  // hanging from the ceiling (MF_SPAWNCEILING), at their DOOM heights
  S(49, 'GOR1', { height: 68, hang: 1 }), S(50, 'GOR2', { height: 84, hang: 1 }), S(51, 'GOR3', { height: 84, hang: 1 }),
  S(52, 'GOR4', { height: 68, hang: 1 }), S(53, 'GOR5', { height: 52, hang: 1 }),
  S(73, 'HDB1', { height: 88, hang: 1 }), S(74, 'HDB2', { height: 88, hang: 1 }), S(75, 'HDB3', { height: 64, hang: 1 }),
  S(76, 'HDB4', { height: 64, hang: 1 }), S(77, 'HDB5', { height: 64, hang: 1 }), S(78, 'HDB6', { height: 64, hang: 1 }),
  // non-solid decorations
  D(34, 'CAND'), D(59, 'GOR2', { height: 84, hang: 1 }), D(60, 'GOR4', { height: 68, hang: 1 }), D(61, 'GOR3', { height: 52, hang: 1 }),
  D(62, 'GOR5', { height: 52, hang: 1 }), D(63, 'GOR1', { height: 68, hang: 1 }),
  D(24, 'POL5'), D(79, 'POB1'), D(80, 'POB2'), D(81, 'BRS1'),
  D(15, 'PLAY'), D(10, 'PLAY'), D(12, 'PLAY'),
  D(18, 'POSS'), D(19, 'SPOS'), D(20, 'TROO'),
  D(21, 'SARG'), D(22, 'HEAD'), D(23, 'SKUL'),
];

// info.c's mass (everything else, the player and barrels included, is 100):
// the arch-vile's blast tosses its victim up at 1000 / mass units per tic.
const MASS = {
  3002: 400, 58: 400, 3006: 50, 3005: 400, 3003: 1000, 69: 1000, 16: 1000, 7: 1000,
  64: 500, 66: 500, 67: 1000, 68: 600, 71: 400, 72: 10000000,
};
// MF_FLOAT | MF_NOGRAVITY: cacodemons, lost souls and pain elementals fly
const FLOATERS = new Set([3005, 3006, 71]);
// MF_NOGRAVITY: the fliers, Keen, the projectiles and the effects but blood (P_ZMovement)
const NOGRAVITY = new Set([3005, 3006, 71, 72, 9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009,
  9010, 9012, 9013, 9014, 9015, 9016, 9017, 9018]);
// MF_SHADOW: the spectre is a demon drawn as a shimmer of fuzz
const SHADOWS = new Set([58]);
// MF_COUNTITEM: what the intermission's item tally counts – the bonuses and
// the powerups, but not the radiation suit, weapons, ammo, keys, health or armour
const COUNT_ITEMS = new Set([2014, 2015, 2013, 2022, 2023, 2024, 2026, 2045, 83]);
for (const t of THING_TYPES) {
  // MF_COUNTKILL: every monster and Commander Keen, but not the lost soul
  if ((t.kind === 'monster' && t.type !== 3006) || t.kind === 'keen') t.countKill = 1;
  if (COUNT_ITEMS.has(t.type)) t.countItem = 1;
  if (SHADOWS.has(t.type)) t.shadow = 1;
  if (MASS[t.type]) t.mass = MASS[t.type];
  if (FLOATERS.has(t.type)) t.floats = 1;
  if (NOGRAVITY.has(t.type) || t.hang) t.nogravity = 1;   // (MF_SPAWNCEILING things hang: MF_NOGRAVITY)
}

// DOOM's mobj type (states.js's MOBJINFO) for the types a map doesn't place, which
// DOOM spawned by type: the player, the projectiles and the effects. The others
// are found by their map number (doomednum).
export const MOBJ_TYPE = {
  1: 'MT_PLAYER', 9000: 'MT_TROOPSHOT', 9001: 'MT_HEADSHOT', 9002: 'MT_BRUISERSHOT', 9003: 'MT_ROCKET',
  9004: 'MT_PLASMA', 9005: 'MT_BFG', 9006: 'MT_TRACER', 9007: 'MT_FATSHOT', 9008: 'MT_ARACHPLAZ',
  9009: 'MT_SPAWNSHOT', 9010: 'MT_PUFF', 9011: 'MT_BLOOD', 9012: 'MT_EXTRABFG', 9013: 'MT_ROCKET',
  9014: 'MT_SPAWNFIRE', 9015: 'MT_FIRE', 9016: 'MT_TFOG', 9017: 'MT_IFOG', 9018: 'MT_SMOKE',
};
// …and where ours starts elsewhere than the type's spawnstate: A_BrainScream's
// explosions are rockets set straight to S_BRAINEXPLODE1
export const SPAWN_STATE = { 9013: 'S_BRAINEXPLODE1' };

// The types on DOOM's frame tables: every one but the markers DOOM never draws (the teleport
// destination and the boss brain's targets, which spawn in S_NULL). The monsters moved onto
// the tables family by family, then everything else (docs/ROADMAP.md).
export const ON_STATES = new Set(THING_TYPES.filter((t) => t.kind !== 'marker').map((t) => t.type));
