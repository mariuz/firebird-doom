// progress.js – which map comes next (G_DoCompleted's wminfo.next).
//
// DOOM I: E?M8 ends the episode, so we carry on into the next one; a secret
// exit leads to E?M9, and E?M9 returns to the map after the one with the
// secret exit. DOOM II: MAP15's secret exit leads to MAP31 and MAP31's to
// MAP32; the normal exits of MAP31 and MAP32 return to MAP16; a secret exit
// anywhere else is a plain one. MAP30 ends the game (DOOM shows the finale),
// so it's back to MAP01. A map the WAD lacks falls back to its first map.

// the map whose secret exit leads to E?M9, per episode
const SECRET_FROM = { 1: 3, 2: 5, 3: 6, 4: 2 };

/**
 * @param name     the map just finished (E1M3, MAP15…)
 * @param secret   it was left by a secret exit
 * @param mapNames every map in the WAD, in order
 */
export function nextMap(name, secret, mapNames) {
  const have = (m) => (mapNames.includes(m) ? m : mapNames[0]);
  const ep = /^E(\d)M(\d)$/.exec(name);
  if (ep) {
    const e = Number(ep[1]);
    const n = Number(ep[2]);
    if (secret) return have(`E${e}M9`);
    if (n === 9) return have(`E${e}M${SECRET_FROM[e] + 1}`);
    if (n === 8) return have(`E${e + 1}M1`);
    return have(`E${e}M${n + 1}`);
  }
  const n = Number(name.slice(3));
  const map = (k) => have(`MAP${String(k).padStart(2, '0')}`);
  if (secret && n === 15) return map(31);
  if (secret && n === 31) return map(32);
  if (n === 31 || n === 32) return map(16);
  if (n === 30) return map(1);
  return map(n + 1);
}
