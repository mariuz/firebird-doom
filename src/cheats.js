// cheats.js – m_cheat.c's cht_CheckCheat, plus IDCLEV's two digits.
//
// Feed each reader every key typed; it answers when its code is spelt.
// Case doesn't matter and keys that aren't characters (Shift, arrows…)
// are ignored, so they don't break a cheat being typed.

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
 * IDCLEV's digits → a map in this WAD, or null. DOOM I reads them as episode
 * and map (13 → E1M3), DOOM II as the map number (07 → MAP07).
 */
export function clevMap(digits, mapNames) {
  if (!/^\d\d$/.test(digits)) return null;
  const doom2 = mapNames.some((m) => m.startsWith('MAP'));
  const name = doom2 ? `MAP${digits}` : `E${digits[0]}M${digits[1]}`;
  return mapNames.includes(name) ? name : null;
}
