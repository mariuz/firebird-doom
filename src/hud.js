// hud.js – status bar, weapon and messages, drawn from the WAD's own graphics
// onto the renderer's 320×200 screen buffer (palette indices; the palette is
// applied when the screen is presented). `hud` is a DOOM_TIC result row.
function drawNum(renderer, n, x, y, font, width = 3) {
  // right-aligned at x, like st_lib.c STlib_drawNum
  const s = String(Math.max(0, n)).slice(-width);
  const digit = renderer.pictureByName(`${font}0`);
  if (!digit) return;
  for (let i = s.length - 1, cx = x; i >= 0; i--) {
    cx -= digit.w;
    renderer.patch(renderer.pictureByName(`${font}${s[i]}`), cx, y);
  }
}

export function drawStatusBar(renderer, hud) {
  const bar = renderer.pictureByName('STBAR');
  if (!bar) return;
  renderer.patch(bar, 0, 168);
  const ammo = { 1: null, 2: hud.BULLETS, 3: hud.SHELLS, 4: hud.BULLETS, 5: hud.ROCKETS, 6: hud.CELLS, 7: hud.CELLS, 8: null, 9: hud.SHELLS }[hud.WEAPON] ?? null;
  if (ammo !== null) drawNum(renderer, ammo, 44, 171, 'STTNUM');
  drawNum(renderer, hud.HEALTH, 90, 171, 'STTNUM');
  renderer.patch(renderer.pictureByName('STTPRCNT'), 90, 171);
  drawNum(renderer, hud.ARMOR, 221, 171, 'STTNUM');
  renderer.patch(renderer.pictureByName('STTPRCNT'), 221, 171);
  renderer.patch(renderer.pictureByName('STARMS'), 104, 168);
  // arms: weapons 2..7
  const owned = [true, hud.HAS_SHOTGUN === 1 || hud.HAS_SSG === 1, hud.HAS_CHAINGUN === 1, hud.HAS_LAUNCHER === 1, hud.HAS_PLASMA === 1, hud.HAS_BFG === 1];
  for (let i = 0; i < 6; i++) {
    renderer.patch(renderer.pictureByName(`${owned[i] ? 'STYSNUM' : 'STGNUM'}${i + 2}`), 111 + (i % 3) * 12, 172 + Math.floor(i / 3) * 10);
  }
  // face: health band, glancing left/right with the tic, ouch when hurt
  const band = Math.min(4, Math.floor((100 - Math.min(100, hud.HEALTH)) / 20));
  let face = `STFST${band}${[0, 1, 2, 1][(hud.TIC >> 4) & 3]}`;
  if (hud.DEAD) face = 'STFDEAD0';
  else if (hud.INVULN_TICS > 0 || hud.GOD) face = 'STFGOD0';      // ST_GODFACE
  else if (hud.DAMAGE_COUNT > 10) face = `STFOUCH${band}`;
  else if (hud.ATTACK_TICS > 0 && hud.WEAPON > 1) face = `STFKILL${band}`;
  renderer.patch(renderer.pictureByName(face) ?? renderer.pictureByName(`STFST${band}0`), 143, 168);
  const kc = hud.KEYCARDS;
  if (kc & 1) renderer.patch(renderer.pictureByName('STKEYS0'), 239, 171);
  if (kc & 2) renderer.patch(renderer.pictureByName('STKEYS1'), 239, 181);
  if (kc & 4) renderer.patch(renderer.pictureByName('STKEYS2'), 239, 191);
  // ammo / max: bullets, shells, rockets, cells (ST_AMMO0Y..ST_AMMO3Y)
  const rows = [[hud.BULLETS, hud.MAX_BULLETS, 173], [hud.SHELLS, hud.MAX_SHELLS, 179],
    [hud.ROCKETS, hud.MAX_ROCKETS, 185], [hud.CELLS, hud.MAX_CELLS, 191]];
  for (const [n, max, y] of rows) {
    drawNum(renderer, n ?? 0, 288, y, 'STYSNUM');
    drawNum(renderer, max ?? 0, 314, y, 'STYSNUM');
  }
}

export function drawText(renderer, text, x, y) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (ch === ' ' || c < 33 || c > 95) { cx += 4; continue; }
    const pic = renderer.pictureByName(`STCFN${String(c).padStart(3, '0')}`);
    if (!pic) { cx += 4; continue; }
    renderer.patch(pic, cx, y);
    cx += pic.w;
  }
}

export function drawWeapon(renderer, hud) {
  const w = hud.WEAPON;
  const len = Math.max(1, hud.ATTACK_LEN);
  const p = hud.ATTACK_TICS > 0 ? 1 - hud.ATTACK_TICS / len : -1;
  const bob = Math.sin(hud.TIC * 0.2) * 2;
  let gun;
  let flash = null;
  if (w === 1) {
    gun = p < 0 ? 'PUNGA0' : `PUNG${'BCDCB'[Math.min(4, Math.floor(p * 5))]}0`;
  } else if (w === 2) {
    gun = p < 0 ? 'PISGA0' : `PISG${'ABCB'[Math.min(3, Math.floor(p * 4))]}0`;
    if (p >= 0 && p < 0.25) flash = 'PISFA0';
  } else if (w === 3) {
    gun = p < 0 ? 'SHTGA0' : `SHTG${'AABCDCBA'[Math.min(7, Math.floor(p * 8))]}0`;
    if (p >= 0 && p < 0.08) flash = 'SHTFA0';
    else if (p >= 0.08 && p < 0.16) flash = 'SHTFB0';
  } else if (w === 8) {
    // the chainsaw: SAWG C/D while idling, A/B while cutting
    gun = p < 0 ? `SAWG${(hud.TIC >> 2) & 1 ? 'D' : 'C'}0` : `SAWG${(hud.TIC >> 1) & 1 ? 'B' : 'A'}0`;
  } else if (w === 9) {
    // A_FireShotgun2, then open, load and close: SHT2 A–H, muzzle flash I/J
    gun = p < 0 ? 'SHT2A0' : `SHT2${'AABCDEFGHA'[Math.min(9, Math.floor(p * 10))]}0`;
    if (p >= 0 && p < 0.05) flash = 'SHT2I0';
    else if (p >= 0.05 && p < 0.1) flash = 'SHT2J0';
  } else if (w === 4) {
    gun = p < 0 ? 'CHGGA0' : `CHGG${(hud.TIC >> 1) & 1 ? 'B' : 'A'}0`;
    if (p >= 0) flash = `CHGF${(hud.TIC >> 1) & 1 ? 'B' : 'A'}0`;
  } else if (w === 5) {
    // A_FireMissile: recoil frame B while the exhaust flash burns through MISF A–D
    gun = p >= 0 && p < 0.6 ? 'MISGB0' : 'MISGA0';
    if (p >= 0 && p < 0.5) flash = `MISF${'ABCD'[Math.min(3, Math.floor(p * 8))]}0`;
  } else if (w === 6) {
    gun = 'PLSGA0';
    if (p >= 0) flash = `PLSF${(hud.TIC >> 1) & 1 ? 'B' : 'A'}0`;
  } else {
    // A_BFGsound, charge (BFGG A + flash A), then the shot (BFGG B + flash B)
    gun = p >= 0.33 && p < 0.5 ? 'BFGGB0' : 'BFGGA0';
    if (p >= 0 && p < 0.33) flash = 'BFGFA0';
    else if (p >= 0.33 && p < 0.45) flash = 'BFGFB0';
  }
  // R_DrawPSprite: sx = 1, sy = WEAPONTOP (32), against a 320×200 screen.
  // Partially invisible, the weapon is fuzz too – flickering back in the
  // last four seconds (pw_invisibility > 4*32 || & 8)
  const inv = hud.INVIS_TICS ?? 0;
  // …and invulnerable, it takes the inverse colormap with the rest of the view
  const cmap = renderer.fixedCm ?? 0;
  const draw = inv > 4 * 32 || (inv & 8)
    ? (pic, x, y) => renderer.patchFuzz(pic, x, y)
    : (pic, x, y) => renderer.patch(pic, x, y, cmap);
  if (flash) draw(renderer.pictureByName(flash), 1 + Math.round(bob), 32 + Math.abs(Math.round(bob)));
  draw(renderer.pictureByName(gun), 1 + Math.round(bob), 32 + Math.abs(Math.round(bob)));
}
