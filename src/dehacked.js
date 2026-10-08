// dehacked.js – DeHackEd patches (a WAD's DEHACKED lump, or a .deh file), as
// Chocolate Doom's deh_*.c read them, plus the BEX [PARS] table.
//
// What this port can take from a patch:
//   Thing N   hit points, speed, width, height, pain chance, mass, missile
//             damage, the five sounds, the map number (ID #) and the bits it
//             models (solid, float, shadow, spawn on the ceiling, and whether
//             it counts as a kill or an item)
//   Ammo N    max ammo and the clip size (which sets every pickup's amount)
//   Misc      starting health and bullets, the health and armour caps, the
//             armour classes, soulsphere and megasphere, the cheats' health
//             and armour, BFG cells per shot
//   Cheat     the cheat codes
//   [PARS]    par times
//   [STRINGS] text (read by finale.js)
// What it can't: Frame, Pointer, Weapon (it only re-points frames), Sound and
// Text blocks – the port has no state tables (each thing type is a state
// machine with frame letters), so they're listed in the report and skipped.

/** mobjinfo's order (info.h mobjtype_t, 1-based as DeHackEd counts) → this port's thing types. */
export const MOBJ_TYPES = [
  null,
  1, 3004, 9, 64, 9015, 66, 9006, null, 67, 9007,             // 1 player … 10 MT_FATSHOT
  65, 3001, 3002, 58, 3005, 3003, 9002, 69, 3006, 7,          // 11 MT_CHAINGUY … 20 MT_SPIDER
  68, 16, 71, 84, 72, 88, 89, 87, 9009, 9014,                 // 21 MT_BABY … 30 MT_SPAWNFIRE
  2035, 9000, 9001, 9003, 9004, 9005, 9008, 9010, 9011, 9016, // 31 MT_BARREL … 40 MT_TFOG
  null, 14, 9012, 2018, 2019, 2014, 2015, 5, 13, 6,           // 41 MT_IFOG … 50 yellow card
  39, 38, 40, 2011, 2012, 2013, 2022, 2023, 2024, 2025,       // 51 yellow skull … 60 suit
  2026, 2045, 83, 2007, 2048, 2010, 2046, 2047, 17, 2008,     // 61 map … 70 shells
  2049, 8, 2006, 2002, 2005, 2003, 2004, 2001, 82,            // 71 shell box … 79 super shotgun
];

/** sounds.h sfxenum_t: DeHackEd's sound numbers → lump names. */
export const SFX = [null, 'pistol', 'shotgn', 'sgcock', 'dshtgn', 'dbopn', 'dbcls', 'dbload', 'plasma', 'bfg',
  'sawup', 'sawidl', 'sawful', 'sawhit', 'rlaunc', 'rxplod', 'firsht', 'firxpl', 'pstart', 'pstop', 'doropn', 'dorcls',
  'stnmov', 'swtchn', 'swtchx', 'plpain', 'dmpain', 'popain', 'vipain', 'mnpain', 'pepain', 'slop', 'itemup', 'wpnup',
  'oof', 'telept', 'posit1', 'posit2', 'posit3', 'bgsit1', 'bgsit2', 'sgtsit', 'cacsit', 'brssit', 'cybsit', 'spisit',
  'bspsit', 'kntsit', 'vilsit', 'mansit', 'pesit', 'sklatk', 'sgtatk', 'skepch', 'vilatk', 'claw', 'skeswg', 'pldeth',
  'pdiehi', 'podth1', 'podth2', 'podth3', 'bgdth1', 'bgdth2', 'sgtdth', 'cacdth', 'skldth', 'brsdth', 'cybdth', 'spidth',
  'bspdth', 'vildth', 'kntdth', 'pedth', 'skedth', 'posact', 'bgact', 'dmact', 'bspact', 'bspwlk', 'vilact', 'noway',
  'barexp', 'punch', 'hoof', 'metal', 'chgun', 'tink', 'bdopn', 'bdcls', 'itmbk', 'flame', 'flamst', 'getpow', 'bospit',
  'boscub', 'bossit', 'bospn', 'bosdth', 'manatk', 'mandth', 'sssit', 'ssdth', 'keenpn', 'keendt', 'skeact', 'skesit',
  'skeatk', 'radio'].map((n) => (n ? `DS${n.toUpperCase()}` : null));

/** The rules a Misc or Ammo block can change, at their vanilla values (the RULES table). */
export const DEFAULT_RULES = {
  init_health: 100, init_bullets: 50, max_health: 200, max_armor: 200, green_class: 1, blue_class: 2,
  max_soul: 200, soul_health: 100, mega_health: 200, god_health: 100,
  idfa_armor: 200, idfa_class: 2, idkfa_armor: 200, idkfa_class: 2, bfg_cells: 40,
  max_bullets: 200, max_shells: 50, max_cells: 300, max_rockets: 50,
  clip_bullets: 10, clip_shells: 4, clip_cells: 20, clip_rockets: 1,
};

/** The cheats a Cheat block can rename: its names → the code the port's CHEAT procedure knows. */
export const CHEAT_NAMES = {
  'change music': 'idmus', chainsaw: 'idchoppers', 'god mode': 'iddqd', 'ammo & keys': 'idkfa', ammo: 'idfa',
  'no clipping 1': 'idspispopd', 'no clipping 2': 'idclip', invincibility: 'idbeholdv', berserk: 'idbeholds',
  invisibility: 'idbeholdi', 'radiation suit': 'idbeholdr', 'auto-map': 'idbeholda', 'lite-amp goggles': 'idbeholdl',
  'behold menu': 'idbehold', 'level warp': 'idclev', 'player position': 'idmypos', 'map cheat': 'iddt',
};

const MISC_FIELDS = {
  'initial health': 'init_health', 'initial bullets': 'init_bullets', 'max health': 'max_health',
  'max armor': 'max_armor', 'green armor class': 'green_class', 'blue armor class': 'blue_class',
  'max soulsphere': 'max_soul', 'soulsphere health': 'soul_health', 'megasphere health': 'mega_health',
  'god mode health': 'god_health', 'idfa armor': 'idfa_armor', 'idfa armor class': 'idfa_class',
  'idkfa armor': 'idkfa_armor', 'idkfa armor class': 'idkfa_class', 'bfg cells/shot': 'bfg_cells',
};
const AMMO = ['bullets', 'shells', 'cells', 'rockets'];   // am_clip, am_shell, am_cell, am_misl

// mobjflag_t bits the port models (by number, or by BEX name)
const BITS = { SOLID: 0x2, SPAWNCEILING: 0x100, FLOAT: 0x4000, SHADOW: 0x40000, COUNTKILL: 0x400000, COUNTITEM: 0x800000 };
const BIT_NAMES = ['SPECIAL', 'SOLID', 'SHOOTABLE', 'NOSECTOR', 'NOBLOCKMAP', 'AMBUSH', 'JUSTHIT', 'JUSTATTACKED',
  'SPAWNCEILING', 'NOGRAVITY', 'DROPOFF', 'PICKUP', 'NOCLIP', 'SLIDE', 'FLOAT', 'TELEPORT', 'MISSILE', 'DROPPED',
  'SHADOW', 'NOBLOOD', 'CORPSE', 'INFLOAT', 'COUNTKILL', 'COUNTITEM', 'SKULLFLY', 'NOTDMATCH',
  'TRANSLATION', 'TRANSLATION2'];

/**
 * Read a patch. Returns { things, ammo, misc, cheats, pars, cpars, skipped } –
 * things: Map(mobj number → { field: value }), ammo: Map(n → fields),
 * misc/cheats: { field: value }, pars: Map('E1M1' → seconds), skipped: what
 * can't be applied, one line each.
 */
export function parseDehacked(text) {
  const out = { things: new Map(), ammo: new Map(), misc: {}, cheats: {}, pars: new Map(), skipped: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = /^\[(\w+)\]/.exec(line))) {
      block = { kind: m[1].toUpperCase() };
      if (!['STRINGS', 'PARS'].includes(block.kind)) out.skipped.push(`[${block.kind}]`);
      continue;
    }
    if ((m = /^(Thing|Frame|Weapon|Ammo|Sound|Sprite|Pointer)\s+(\d+)/i.exec(line))) {
      block = { kind: m[1].toLowerCase(), n: Number(m[2]) };
      if (block.kind === 'thing' && !out.things.has(block.n)) out.things.set(block.n, {});
      if (block.kind === 'ammo' && !out.ammo.has(block.n)) out.ammo.set(block.n, {});
      if (!['thing', 'ammo'].includes(block.kind)) out.skipped.push(`${m[1]} ${m[2]}`);
      continue;
    }
    if ((m = /^Text\s+(\d+)\s+(\d+)/i.exec(line))) {
      // the old and new text follow, len1 + len2 characters, newlines included
      const rest = lines.slice(i + 1).join('\n');
      const total = Number(m[1]) + Number(m[2]);
      const body = rest.slice(0, total);
      out.skipped.push(`Text "${body.slice(0, Number(m[1])).replace(/\n/g, '\\n').slice(0, 24)}"`);
      i += body.split('\n').length - 1 + (rest.length > total && rest[total] === '\n' ? 1 : 0);
      block = null;
      continue;
    }
    if (/^Misc\b/i.test(line)) { block = { kind: 'misc' }; continue; }
    if (/^Cheat\b/i.test(line)) { block = { kind: 'cheat' }; continue; }
    if (!block) continue;   // (the header: Doom version, Patch format)
    if (block.kind === 'PARS') {
      const p = line.split('#')[0].trim().split(/\s+/);
      if (p[0]?.toLowerCase() !== 'par') continue;
      if (p.length >= 4) out.pars.set(`E${Number(p[1])}M${Number(p[2])}`, Number(p[3]));
      else if (p.length === 3) out.pars.set(`MAP${String(Number(p[1])).padStart(2, '0')}`, Number(p[2]));
      continue;
    }
    if (block.kind === 'STRINGS') continue;   // (finale.js reads those)
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (block.kind === 'thing') out.things.get(block.n)[key] = value;
    else if (block.kind === 'ammo') out.ammo.get(block.n)[key] = value;
    else if (block.kind === 'misc') out.misc[key] = value;
    else if (block.kind === 'cheat') out.cheats[key] = value;
  }
  return out;
}

function bitsOf(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  // BEX: SOLID+SHOOTABLE, or separated by | , or spaces
  return value.toUpperCase().split(/[+|,\s]+/).reduce((b, name) => {
    const k = BIT_NAMES.indexOf(name.replace(/^MF_/, ''));
    return k < 0 ? b : b | (1 << k);
  }, 0);
}

/**
 * Apply a parsed patch to THING_TYPES (copied, not changed) and to the rules.
 * Returns { types, rules, cheats: { code: typed }, pars, report: [lines] }.
 */
export function applyDehacked(baseTypes, patch) {
  const types = baseTypes.map((t) => ({ ...t }));
  const byType = new Map(types.map((t) => [t.type, t]));
  const rules = { ...DEFAULT_RULES };
  const report = [];
  for (const [n, f] of patch.things) {
    const t = byType.get(MOBJ_TYPES[n] ?? NaN);
    if (!t) { report.push(`Thing ${n}: not one this port has`); continue; }
    const num = (k) => Number(f[k]);
    const fixed = (k) => num(k) / 65536;
    const done = [];
    const set = (k, field, v) => { if (k in f && Number.isFinite(v)) { t[field] = v; done.push(k); } };
    set('hit points', 'hp', num('hit points'));
    set('speed', 'speed', t.kind === 'missile' || t.kind === 'cube' ? fixed('speed') : num('speed'));
    set('width', 'radius', fixed('width'));
    set('height', 'height', fixed('height'));
    set('pain chance', 'painChance', num('pain chance'));
    set('mass', 'mass', num('mass'));
    if ('missile damage' in f) { t.dmgLo = num('missile damage'); t.dmgHi = 8 * num('missile damage'); done.push('missile damage'); }
    for (const [k, field] of [['alert sound', 'seeSnd'], ['attack sound', 'atkSnd'], ['pain sound', 'painSnd'],
      ['death sound', 'deathSnd'], ['action sound', 'activeSnd']]) {
      if (k in f) { t[field] = SFX[num(k)] ?? null; done.push(k); }
    }
    if ('bits' in f) {
      const b = bitsOf(f.bits);
      t.solid = b & BITS.SOLID ? 1 : 0;
      t.floats = b & BITS.FLOAT ? 1 : 0;
      t.shadow = b & BITS.SHADOW ? 1 : 0;
      t.hang = b & BITS.SPAWNCEILING ? 1 : 0;
      t.countKill = b & BITS.COUNTKILL ? 1 : 0;
      t.countItem = b & BITS.COUNTITEM ? 1 : 0;
      done.push('bits');
    }
    if ('id #' in f && num('id #') > 0 && t.type < 9000 && t.type !== 1) {
      byType.delete(t.type);
      t.type = num('id #');
      byType.set(t.type, t);
      done.push('id #');
    }
    const rest = Object.keys(f).filter((k) => !done.includes(k));
    if (rest.length) report.push(`Thing ${n}: ${rest.join(', ')} not applied`);
  }
  for (const [k, v] of Object.entries(patch.misc)) {
    if (MISC_FIELDS[k] && Number.isFinite(Number(v))) rules[MISC_FIELDS[k]] = Number(v);
    else report.push(`Misc: ${k} not applied`);
  }
  for (const [n, f] of patch.ammo) {
    const name = AMMO[n];
    if (!name) { report.push(`Ammo ${n}: no such ammo`); continue; }
    if ('max ammo' in f) rules[`max_${name}`] = Number(f['max ammo']);
    if ('per ammo' in f) rules[`clip_${name}`] = Number(f['per ammo']);
  }
  // every pickup's amount follows the clip sizes and armour classes (P_GiveAmmo: clips; P_GiveWeapon: two)
  const amount = { 2007: rules.clip_bullets, 2048: 5 * rules.clip_bullets, 2008: rules.clip_shells, 2049: 5 * rules.clip_shells,
    2047: rules.clip_cells, 17: 5 * rules.clip_cells, 2010: rules.clip_rockets, 2046: 5 * rules.clip_rockets,
    2001: 2 * rules.clip_shells, 82: 2 * rules.clip_shells, 2002: 2 * rules.clip_bullets, 2003: 2 * rules.clip_rockets,
    2004: 2 * rules.clip_cells, 2006: 2 * rules.clip_cells, 8: rules.clip_bullets,
    2018: 100 * rules.green_class, 2019: 100 * rules.blue_class, 2013: rules.soul_health, 83: rules.mega_health };
  types.forEach((t, i) => {
    const base = baseTypes[i].type;   // (by what it was, even if ID # moved it)
    if (base in amount && t.kind === 'item') t.amount = amount[base];
  });
  const cheats = {};
  for (const [k, v] of Object.entries(patch.cheats)) {
    if (CHEAT_NAMES[k] && v) cheats[CHEAT_NAMES[k]] = v.toLowerCase();
    else report.push(`Cheat: ${k} not applied`);
  }
  for (const s of patch.skipped) report.push(`${s}: not applied (no state tables in this port)`);
  return { types, rules, cheats, pars: patch.pars, report };
}
