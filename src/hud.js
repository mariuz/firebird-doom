// hud.js – status bar, weapon and messages, drawn from the WAD's own graphics
// onto the renderer's 320×200 screen buffer (palette indices; the palette is
// applied when the screen is presented). `hud` is a DOOM_TIC result row.
function drawNum(renderer, n, x, y, font, width = 3) {
  // right-aligned at x, like st_lib.c STlib_drawNum; a negative number (the
  // frags) fits its minus in: -9 at most in two digits, -99 in three
  const neg = n < 0;
  const v = neg ? Math.min(-n, width === 2 ? 9 : width === 3 ? 99 : -n) : n;
  const s = String(v).slice(-width);
  const digit = renderer.pictureByName(`${font}0`);
  if (!digit) return;
  let cx = x;
  for (let i = s.length - 1; i >= 0; i--) {
    cx -= digit.w;
    renderer.patch(renderer.pictureByName(`${font}${s[i]}`), cx, y);
  }
  if (neg) renderer.patch(renderer.pictureByName(`${font === 'STTNUM' ? 'STT' : font.slice(0, 3)}MINUS`), cx - 8, y);
}

// ── ST_updateFaceWidget ──────────────────────────────────────────────────
// Faces come in 5 pain levels of 8 (ST_FACESTRIDE): 3 straight, turn right,
// turn left, ouch, evil grin, rampage; then the god face (40) and dead (41).
const TICRATE = 35;
const FACESTRIDE = 8;
const TURNOFFSET = 3;
const OUCHOFFSET = 5;
const EVILGRINOFFSET = 6;
const RAMPAGEOFFSET = 7;
const GODFACE = 40;
const DEADFACE = 41;
const MUCHPAIN = 20;
const ANG45 = 0x20000000;
const ANG180 = 0x80000000;
const bam = (rad) => (Math.round((rad / (2 * Math.PI)) * 4294967296) >>> 0);   // radians → DOOM's 32-bit angle

/** The status bar face, tic by tic, as st_stuff.c keeps it (its own state, not the game's). */
export class FaceWidget {
  constructor(random = Math.random) {
    this.random = random;                 // M_Random: the menu's generator, not the game's
    this.priority = 0;
    this.index = 0;
    this.count = 0;
    this.oldHealth = -1;
    this.lastAttackDown = -1;
    this.oldWeapons = null;
  }

  /** ST_calcPainOffset: 8 × ((100 - health) × 5 / 101), health capped at 100. */
  static painOffset(health) {
    const h = Math.min(100, Math.max(0, health));
    return FACESTRIDE * Math.trunc(((100 - h) * 5) / 101);
  }

  /** ST_Ticker, `tics` times. fire: the attack button held (player->attackdown). */
  update(hud, tics = 1, fire = false) {
    const weapons = [hud.HAS_SHOTGUN, hud.HAS_CHAINGUN, hud.HAS_LAUNCHER, hud.HAS_PLASMA, hud.HAS_BFG, hud.HAS_CHAINSAW, hud.HAS_SSG].map((w) => w === 1);
    if (!this.oldWeapons) this.oldWeapons = weapons;
    const pain = FaceWidget.painOffset(hud.HEALTH);
    for (let t = 0; t < tics; t++) {
      const rnd = Math.floor(this.random() * 256);
      if (this.priority < 10 && hud.HEALTH <= 0) { this.priority = 9; this.index = DEADFACE; this.count = 1; }
      if (this.priority < 9 && hud.BONUS_COUNT) {
        // picking up a weapon you didn't have: the evil grin
        let grin = false;
        weapons.forEach((w, i) => { if (w !== this.oldWeapons[i]) { grin = true; this.oldWeapons[i] = w; } });
        if (grin) { this.priority = 8; this.count = 2 * TICRATE; this.index = pain + EVILGRINOFFSET; }
      }
      if (this.priority < 8 && hud.DAMAGE_COUNT && hud.ATTACKER_ANGLE != null) {
        // being attacked: look where it came from (vanilla's test for the ouch
        // face is backwards – health has to have gone *up* by 20 – and so kept)
        this.priority = 7;
        this.count = TICRATE;
        if (hud.HEALTH - this.oldHealth > MUCHPAIN) this.index = pain + OUCHOFFSET;
        else {
          const bad = bam(hud.ATTACKER_ANGLE);
          const me = bam(hud.PANGLE);
          let diff;
          let right;
          if (bad > me) { diff = bad - me; right = diff > ANG180; } else { diff = me - bad; right = diff <= ANG180; }
          this.index = pain + (diff < ANG45 ? RAMPAGEOFFSET : right ? TURNOFFSET : TURNOFFSET + 1);
        }
      }
      if (this.priority < 7 && hud.DAMAGE_COUNT) {
        // getting hurt because of your own damn stupidity (nukage, a barrel)
        if (hud.HEALTH - this.oldHealth > MUCHPAIN) { this.priority = 7; this.count = TICRATE; this.index = pain + OUCHOFFSET; }
        else { this.priority = 6; this.count = TICRATE; this.index = pain + RAMPAGEOFFSET; }
      }
      if (this.priority < 6) {
        // holding the trigger down for two seconds: the rampage face
        if (fire) {
          if (this.lastAttackDown === -1) this.lastAttackDown = 2 * TICRATE;
          else if (--this.lastAttackDown === 0) { this.priority = 5; this.index = pain + RAMPAGEOFFSET; this.count = 1; this.lastAttackDown = 1; }
        } else this.lastAttackDown = -1;
      }
      if (this.priority < 5 && (hud.GOD || hud.INVULN_TICS > 0)) { this.priority = 4; this.index = GODFACE; this.count = 1; }
      // time's up: look straight, left or right
      if (!this.count) { this.index = pain + (rnd % 3); this.count = TICRATE / 2; this.priority = 0; }
      this.count--;
      this.oldHealth = hud.HEALTH;
    }
    return this.lump();
  }

  /** The face's graphic. */
  lump() {
    if (this.index === GODFACE) return 'STFGOD0';
    if (this.index === DEADFACE) return 'STFDEAD0';
    const level = Math.trunc(this.index / FACESTRIDE);
    const k = this.index % FACESTRIDE;
    return k < 3 ? `STFST${level}${k}` : [`STFTR${level}0`, `STFTL${level}0`, `STFOUCH${level}`, `STFEVL${level}`, `STFKILL${level}`][k - 3];
  }
}

/**
 * ST_Drawer. In a netgame NETPLAYER (1–4) is this browser's player, whose
 * colour backs the face (STFB0–3, ST_refreshBackground); in deathmatch
 * (hud.DEATHMATCH) the frag count replaces the arms (st_fragson, st_armson).
 */
export function drawStatusBar(renderer, hud, face = null, netPlayer = 0) {
  const bar = renderer.pictureByName('STBAR');
  if (!bar) return;
  renderer.patch(bar, 0, 168);
  if (netPlayer) renderer.patch(renderer.pictureByName(`STFB${netPlayer - 1}`), 143, 168);   // ST_FX
  const ammo = { 1: null, 2: hud.BULLETS, 3: hud.SHELLS, 4: hud.BULLETS, 5: hud.ROCKETS, 6: hud.CELLS, 7: hud.CELLS, 8: null, 9: hud.SHELLS }[hud.WEAPON] ?? null;
  if (ammo !== null) drawNum(renderer, ammo, 44, 171, 'STTNUM');
  drawNum(renderer, hud.HEALTH, 90, 171, 'STTNUM');
  renderer.patch(renderer.pictureByName('STTPRCNT'), 90, 171);
  drawNum(renderer, hud.ARMOR, 221, 171, 'STTNUM');
  renderer.patch(renderer.pictureByName('STTPRCNT'), 221, 171);
  if (hud.DEATHMATCH) {
    // ST_FRAGSX/Y: the others you killed, less the times you killed yourself (ST_updateWidgets)
    drawNum(renderer, hud.FRAGS ?? 0, 138, 171, 'STTNUM', 2);
  } else {
    renderer.patch(renderer.pictureByName('STARMS'), 104, 168);
    // arms: weapons 2..7
    const owned = [true, hud.HAS_SHOTGUN === 1 || hud.HAS_SSG === 1, hud.HAS_CHAINGUN === 1, hud.HAS_LAUNCHER === 1, hud.HAS_PLASMA === 1, hud.HAS_BFG === 1];
    for (let i = 0; i < 6; i++) {
      renderer.patch(renderer.pictureByName(`${owned[i] ? 'STYSNUM' : 'STGNUM'}${i + 2}`), 111 + (i % 3) * 12, 172 + Math.floor(i / 3) * 10);
    }
  }
  // the face (FaceWidget's), or for a still picture the straight one of this pain level
  const level = FaceWidget.painOffset(hud.HEALTH) / 8;
  const lump = typeof face === 'string' ? face : hud.DEAD ? 'STFDEAD0' : `STFST${level}0`;
  renderer.patch(renderer.pictureByName(lump) ?? renderer.pictureByName(`STFST${level}0`), 143, 168);
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

// A_Light1 / A_Light2 in each flash state: the extralight while that frame shows
const FLASH_LIGHT = { PISFA0: 1, SHTFA0: 1, SHTFB0: 2, SHT2I0: 1, SHT2J0: 2, CHGFA0: 1, CHGFB0: 2,
  MISFA0: 1, MISFB0: 1, MISFC0: 2, MISFD0: 2, PLSFA0: 1, PLSFB0: 1, BFGFA0: 1, BFGFB0: 2 };

/** P_PlayerThink's player->extralight: 0, or 1–2 while the muzzle flash shows. */
export function extraLight(hud) {
  return FLASH_LIGHT[weaponFrames(hud).flash] ?? 0;
}

export function drawWeapon(renderer, hud) {
  const { gun, flash, bob } = weaponFrames(hud);
  // R_DrawPSprite: sx = 1, sy = WEAPONTOP (32), in the view (renderer.psprite).
  // Partially invisible, the weapon is fuzz too – flickering back in the
  // last four seconds (pw_invisibility > 4*32 || & 8)
  const inv = hud.INVIS_TICS ?? 0;
  // …and invulnerable, it takes the inverse colormap with the rest of the view
  const cmap = renderer.fixedCm ?? 0;
  const draw = inv > 4 * 32 || (inv & 8)
    ? (pic, x, y) => renderer.psprite(pic, x, y, 'fuzz')
    : (pic, x, y) => renderer.psprite(pic, x, y, cmap);
  const lowered = hud.WEAPON_Y ?? 0;
  const sy = 32 + lowered + Math.abs(Math.round(bob));
  if (flash) draw(renderer.pictureByName(flash), 1 + Math.round(bob), sy);
  draw(renderer.pictureByName(gun), 1 + Math.round(bob), sy);
}

/** Which weapon frame and flash frame show now, and the bob. */
function weaponFrames(hud) {
  const w = hud.WEAPON;
  const len = Math.max(1, hud.ATTACK_LEN);
  const p = hud.ATTACK_TICS > 0 ? 1 - hud.ATTACK_TICS / len : -1;
  // A_WeaponReady bobs it; lowered or raised (A_Lower/A_Raise) it just slides
  const lowered = hud.WEAPON_Y ?? 0;
  const bob = lowered ? 0 : Math.sin(hud.TIC * 0.2) * 2;
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
  return { gun, flash, bob };
}
