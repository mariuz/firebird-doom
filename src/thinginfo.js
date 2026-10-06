// thinginfo.js – DOOM's mobjinfo, trimmed to what this port simulates.
//
// Loaded into the THING_TYPES table at startup; from then on only SQL reads
// it. Values follow info.c from the DOOM source release where it matters
// (hit points, speed, radius, pain chance, damage); animation is reduced to
// frame-letter strings per state.

const M = (type, sprite, o) => ({ type, sprite, kind: 'monster', radius: 20, height: 56, solid: 1, ...o });
const D = (type, sprite, o = {}) => ({ type, sprite, kind: 'decor', radius: 16, height: 16, solid: 0, walk: 'A', ...o });
const S = (type, sprite, o = {}) => D(type, sprite, { solid: 1, height: 48, ...o });
const I = (type, sprite, pickup, amount, o = {}) => ({ type, sprite, kind: 'item', radius: 20, height: 16, solid: 0, walk: 'A', pickup, amount, ...o });

export const THING_TYPES = [
  // player start + projectiles + effects (spawned by SQL, never by maps)
  { type: 1, sprite: 'PLAY', kind: 'player', radius: 16, height: 56, solid: 1, hp: 100, walk: 'ABCD', pain: 'G', death: 'HIJKLMN' },
  { type: 9000, sprite: 'BAL1', kind: 'missile', radius: 6, height: 8, speed: 10, walk: 'AB', death: 'CDE', bright: 1, deathSnd: 'DSFIRXPL' },
  { type: 9001, sprite: 'BAL2', kind: 'missile', radius: 6, height: 8, speed: 10, walk: 'AB', death: 'CDE', bright: 1, deathSnd: 'DSFIRXPL' },
  { type: 9002, sprite: 'BAL7', kind: 'missile', radius: 6, height: 16, speed: 15, walk: 'AB', death: 'CDE', bright: 1, deathSnd: 'DSFIRXPL' },
  { type: 14, sprite: 'TFOG', kind: 'marker', radius: 1, height: 1, walk: 'A' }, // teleport destination
  { type: 9010, sprite: 'PUFF', kind: 'fx', radius: 1, height: 1, walk: 'ABCD', bright: 1 },
  { type: 9011, sprite: 'BLUD', kind: 'fx', radius: 1, height: 1, walk: 'CBA' },

  // monsters ─ attack: hitscan | missile | melee
  M(3004, 'POSS', { hp: 20, speed: 8, painChance: 200, walk: 'ABCD', attack: 'EF', pain: 'G', death: 'HIJKL', atk: 'hitscan', dmgLo: 3, dmgHi: 15, shots: 1, drop: 2007, seeSnd: 'DSPOSIT1', atkSnd: 'DSPISTOL', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH1' }),
  M(9, 'SPOS', { hp: 30, speed: 8, painChance: 170, walk: 'ABCD', attack: 'EF', pain: 'G', death: 'HIJKL', atk: 'hitscan', dmgLo: 3, dmgHi: 15, shots: 3, drop: 2001, seeSnd: 'DSPOSIT2', atkSnd: 'DSSHOTGN', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH2' }),
  M(65, 'CPOS', { hp: 70, speed: 8, painChance: 170, walk: 'ABCD', attack: 'EF', pain: 'G', death: 'HIJKLMN', atk: 'hitscan', dmgLo: 3, dmgHi: 15, shots: 1, drop: 2002, seeSnd: 'DSPOSIT2', atkSnd: 'DSSHOTGN', painSnd: 'DSPOPAIN', deathSnd: 'DSPODTH2' }),
  M(3001, 'TROO', { hp: 60, speed: 8, painChance: 200, walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLM', atk: 'missile', missile: 9000, dmgLo: 3, dmgHi: 24, seeSnd: 'DSBGSIT1', atkSnd: 'DSFIRSHT', painSnd: 'DSDMPAIN', deathSnd: 'DSBGDTH1' }),
  M(3002, 'SARG', { hp: 150, speed: 10, radius: 30, painChance: 180, walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMN', atk: 'melee', dmgLo: 4, dmgHi: 40, seeSnd: 'DSSGTSIT', atkSnd: 'DSSGTATK', painSnd: 'DSDMPAIN', deathSnd: 'DSSGTDTH' }),
  M(58, 'SARG', { hp: 150, speed: 10, radius: 30, painChance: 180, walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMN', atk: 'melee', dmgLo: 4, dmgHi: 40, seeSnd: 'DSSGTSIT', atkSnd: 'DSSGTATK', painSnd: 'DSDMPAIN', deathSnd: 'DSSGTDTH' }),
  M(3006, 'SKUL', { hp: 100, speed: 8, radius: 16, painChance: 256, walk: 'AB', attack: 'CD', pain: 'E', death: 'FGHIJK', atk: 'melee', dmgLo: 3, dmgHi: 24, bright: 1, atkSnd: 'DSSKLATK', painSnd: 'DSDMPAIN', deathSnd: 'DSFIRXPL' }),
  M(3005, 'HEAD', { hp: 400, speed: 8, radius: 31, painChance: 128, walk: 'A', attack: 'BCD', pain: 'EF', death: 'GHIJKL', atk: 'missile', missile: 9001, dmgLo: 5, dmgHi: 40, seeSnd: 'DSCACSIT', atkSnd: 'DSFIRSHT', painSnd: 'DSDMPAIN', deathSnd: 'DSCACDTH' }),
  M(3003, 'BOSS', { hp: 1000, speed: 8, radius: 24, height: 64, painChance: 50, walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMNO', atk: 'missile', missile: 9002, dmgLo: 8, dmgHi: 64, seeSnd: 'DSBRSSIT', atkSnd: 'DSFIRSHT', painSnd: 'DSDMPAIN', deathSnd: 'DSBRSDTH' }),
  M(69, 'BOS2', { hp: 500, speed: 8, radius: 24, height: 64, painChance: 50, walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMNO', atk: 'missile', missile: 9002, dmgLo: 8, dmgHi: 64, seeSnd: 'DSBRSSIT', atkSnd: 'DSFIRSHT', painSnd: 'DSDMPAIN', deathSnd: 'DSBRSDTH' }),
  // shootable barrel – "dies" by exploding
  { type: 2035, sprite: 'BAR1', kind: 'barrel', radius: 10, height: 42, solid: 1, hp: 20, walk: 'AB', death: 'ABCDE', deathSprite: 'BEXP', bright: 0, deathSnd: 'DSBAREXP' },

  // items: pickup kind + amount
  I(2011, 'STIM', 'health', 10), I(2012, 'MEDI', 'health', 25),
  I(2014, 'BON1', 'health+', 1, { walk: 'ABCDCB' }), I(2013, 'SOUL', 'health+', 100, { walk: 'ABCDCB', bright: 1 }),
  I(2015, 'BON2', 'armor+', 1, { walk: 'ABCDCB' }),
  I(2018, 'ARM1', 'armor', 100, { walk: 'AB' }), I(2019, 'ARM2', 'armor', 200, { walk: 'AB', bright: 1 }),
  I(2007, 'CLIP', 'bullets', 10), I(2048, 'AMMO', 'bullets', 50),
  I(2008, 'SHEL', 'shells', 4), I(2049, 'SBOX', 'shells', 20),
  I(2001, 'SHOT', 'shotgun', 8), I(2002, 'MGUN', 'chaingun', 20),
  I(8, 'BPAK', 'backpack', 10),
  I(5, 'BKEY', 'key', 1, { walk: 'AB' }), I(6, 'YKEY', 'key', 2, { walk: 'AB' }), I(13, 'RKEY', 'key', 4, { walk: 'AB' }),
  I(40, 'BSKU', 'key', 1, { walk: 'AB' }), I(39, 'YSKU', 'key', 2, { walk: 'AB' }), I(38, 'RSKU', 'key', 4, { walk: 'AB' }),
  I(2023, 'PSTR', 'health', 100, { bright: 1 }), I(2026, 'PMAP', 'none', 0, { walk: 'ABCDCB', bright: 1 }),
  I(2022, 'PINV', 'none', 0, { walk: 'ABCD', bright: 1 }), I(2024, 'PINS', 'none', 0, { walk: 'ABCD', bright: 1 }),
  I(2025, 'SUIT', 'none', 0, { bright: 1 }), I(2045, 'PVIS', 'none', 0, { walk: 'AB', bright: 1 }),
  I(2003, 'LAUN', 'none', 0), I(2004, 'PLAS', 'none', 0), I(2005, 'CSAW', 'none', 0), I(2006, 'BFUG', 'none', 0),
  I(2010, 'ROCK', 'none', 0), I(2046, 'BROK', 'none', 0), I(17, 'CELP', 'none', 0), I(2047, 'CELL', 'none', 0),

  // solid decorations
  S(2028, 'COLU', { bright: 1 }), S(48, 'ELEC'), S(30, 'COL1'), S(31, 'COL2'), S(32, 'COL3'), S(33, 'COL4'),
  S(36, 'COL5', { walk: 'AB' }), S(37, 'COL6'), S(35, 'CBRA', { bright: 1 }), S(41, 'CEYE', { walk: 'ABCB', bright: 1 }),
  S(42, 'FSKU', { walk: 'ABC', bright: 1 }), S(43, 'TRE1'), S(54, 'TRE2', { radius: 32 }), S(47, 'SMIT'),
  S(44, 'TBLU', { walk: 'ABCD', bright: 1 }), S(45, 'TGRN', { walk: 'ABCD', bright: 1 }), S(46, 'TRED', { walk: 'ABCD', bright: 1 }),
  S(55, 'SMBT', { walk: 'ABCD', bright: 1 }), S(56, 'SMGT', { walk: 'ABCD', bright: 1 }), S(57, 'SMRT', { walk: 'ABCD', bright: 1 }),
  S(70, 'FCAN', { walk: 'ABC', bright: 1 }), S(85, 'TLMP', { walk: 'ABCD', bright: 1 }), S(86, 'TLP2', { walk: 'ABCD', bright: 1 }),
  S(25, 'POL1'), S(26, 'POL6', { walk: 'AB' }), S(27, 'POL4'), S(28, 'POL2'), S(29, 'POL3', { walk: 'AB' }),
  S(49, 'GOR1', { walk: 'ABCB' }), S(50, 'GOR2'), S(51, 'GOR3'), S(52, 'GOR4'), S(53, 'GOR5'),
  // non-solid decorations
  D(34, 'CAND', { bright: 1 }), D(59, 'GOR2'), D(60, 'GOR4'), D(61, 'GOR3'), D(62, 'GOR5'), D(63, 'GOR1', { walk: 'ABCB' }),
  D(24, 'POL5'), D(79, 'POB1'), D(80, 'POB2'), D(81, 'BRS1'),
  D(15, 'PLAY', { walk: 'N' }), D(10, 'PLAY', { walk: 'W' }), D(12, 'PLAY', { walk: 'W' }),
  D(18, 'POSS', { walk: 'L' }), D(19, 'SPOS', { walk: 'L' }), D(20, 'TROO', { walk: 'M' }),
  D(21, 'SARG', { walk: 'N' }), D(22, 'HEAD', { walk: 'L' }), D(23, 'SKUL', { walk: 'K' }),
];
