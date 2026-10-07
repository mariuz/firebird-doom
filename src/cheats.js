// cheats.js – m_cheat.c's cht_CheckCheat, plus IDCLEV's two digits.
//
// Feed each reader every key typed; it answers when its code is spelt.
// Case doesn't matter and keys that aren't characters (Shift, arrows…)
// are ignored, so they don't break a cheat being typed.

/** The codes, as DOOM spells them (a DeHackEd Cheat block can respell them; dehacked.js). */
export const CHEAT_CODES = {
  iddqd: 'iddqd', idkfa: 'idkfa', idfa: 'idfa', idclip: 'idclip', idspispopd: 'idspispopd', idchoppers: 'idchoppers',
  idbehold: 'idbehold', idmypos: 'idmypos', idbeholdv: 'idbeholdv', idbeholds: 'idbeholds', idbeholdi: 'idbeholdi',
  idbeholdr: 'idbeholdr', idbeholda: 'idbeholda', idbeholdl: 'idbeholdl', iddt: 'iddt', idmus: 'idmus', idclev: 'idclev',
};

/**
 * Every reader, for these spellings: `fixed` is [code the CHEAT procedure
 * knows, reader] (the six IDBEHOLD powers are fixed codes too, as in
 * m_cheat.c); iddt, idmus and idclev on their own.
 */
export function cheatReaders(codes = CHEAT_CODES) {
  const c = { ...CHEAT_CODES, ...codes };
  const fixed = ['iddqd', 'idkfa', 'idfa', 'idclip', 'idspispopd', 'idchoppers', 'idbehold', 'idmypos',
    'idbeholdv', 'idbeholds', 'idbeholdi', 'idbeholdr', 'idbeholda', 'idbeholdl']
    .map((k) => [k, makeCheatReader(c[k])]);
  return { fixed, iddt: makeCheatReader(c.iddt), idmus: makeParamCheatReader(c.idmus, 2), idclev: makeParamCheatReader(c.idclev, 2) };
}

/** A fixed code (IDDQD, IDKFA, IDCLIP, IDDT…): true once it has been typed. */
export function makeCheatReader(code) {
  let typed = '';
  return (key) => {
    if (key.length !== 1) return false;
    typed = (typed + key.toLowerCase()).slice(-code.length);
    if (typed !== code) return false;
    typed = '';
    return true;
  };
}

/** A code followed by N characters (IDCLEV + two digits): the characters once complete, else null. */
export function makeParamCheatReader(code, n) {
  const spot = makeCheatReader(code);
  let param = null;   // null: waiting for the code; a string: collecting the digits
  return (key) => {
    if (key.length !== 1) return null;
    if (param !== null) {
      param += key;
      if (param.length < n) return null;
      const done = param;
      param = null;
      return done;
    }
    if (spot(key)) param = '';
    return null;
  };
}

/**
 * IDMUS's digits → the map whose music to play, or null for vanilla's
 * "IMPOSSIBLE SELECTION". DOOM I: episode and map, each 1–9, no further than
 * the 32nd song (E4M5); DOOM II: songs 1–35.
 */
export function idmusMap(digits, doom2) {
  if (!/^\d\d$/.test(digits)) return null;
  if (doom2) {
    const n = Number(digits);
    return n >= 1 && n <= 35 ? `MAP${digits}` : null;
  }
  const e = Number(digits[0]);
  const m = Number(digits[1]);
  if (e < 1 || m < 1 || (e - 1) * 9 + (m - 1) > 31) return null;
  return `E${e}M${m}`;
}

/**
 * IDCLEV's digits → a map in this WAD, or null. DOOM I reads them as episode
 * and map (13 → E1M3), DOOM II as the map number (07 → MAP07).
 */
export function clevMap(digits, mapNames) {
  if (!/^\d\d$/.test(digits)) return null;
  const doom2 = mapNames.some((m) => m.startsWith('MAP'));
  const name = doom2 ? `MAP${digits}` : `E${digits[0]}M${digits[1]}`;
  return mapNames.includes(name) ? name : null;
}
