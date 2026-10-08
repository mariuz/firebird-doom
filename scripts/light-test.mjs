// light-test.mjs – the renderer's light diminishing against DOOM's own
// arithmetic: R_InitLightTables, R_ExecuteSetViewSize, R_RenderSegLoop,
// R_ProjectSprite and R_MapPlane, re-done here in 16.16 fixed point.
import { Renderer, lightNum, scaleLight, zLight } from '../src/renderer.js';
import { extraLight } from '../src/hud.js';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── DOOM, independently ───────────────────────────────────────────────────
const FRACBITS = 16n;
const FRACUNIT = 1n << FRACBITS;
const FixedDiv = (a, b) => (a << FRACBITS) / b;          // (positive operands only here)
const LIGHTLEVELS = 16;
const NUMCOLORMAPS = 32;
const MAXLIGHTSCALE = 48;
const MAXLIGHTZ = 128;
const LIGHTSCALESHIFT = 12n;
const LIGHTZSHIFT = 20n;
const DISTMAP = 2;
const SCREENWIDTH = 320;
const clamp = (l) => Math.max(0, Math.min(NUMCOLORMAPS - 1, l));
const startmap = (i) => Math.trunc(((LIGHTLEVELS - 1 - i) * 2 * NUMCOLORMAPS) / LIGHTLEVELS);
const zlight = [];
for (let i = 0; i < LIGHTLEVELS; i++) {
  zlight.push([]);
  for (let j = 0; j < MAXLIGHTZ; j++) {
    let scale = FixedDiv(BigInt(SCREENWIDTH / 2) * FRACUNIT, BigInt(j + 1) << LIGHTZSHIFT);
    scale >>= LIGHTSCALESHIFT;
    zlight[i].push(clamp(startmap(i) - Math.trunc(Number(scale) / DISTMAP)));
  }
}
const scalelight = (detailshift) => {
  const viewwidth = SCREENWIDTH >> detailshift;
  return Array.from({ length: LIGHTLEVELS }, (_, i) => Array.from({ length: MAXLIGHTSCALE }, (__, j) =>
    clamp(startmap(i) - Math.trunc(Math.trunc((j * SCREENWIDTH) / (viewwidth << detailshift)) / DISTMAP))));
};
const toFixed = (x) => BigInt(Math.round(x * 65536));
// a wall column at distance d: rw_scale = projection / d (projection = centerxfrac = viewwidth/2)
const wallMap = (light, d, detailshift) => {
  const projection = BigInt(SCREENWIDTH >> detailshift >> 1) * FRACUNIT;
  let index = Number(FixedDiv(projection, toFixed(d)) >> LIGHTSCALESHIFT);
  if (index >= MAXLIGHTSCALE) index = MAXLIGHTSCALE - 1;
  return scalelight(detailshift)[Math.max(0, Math.min(15, light >> 4))][index];
};
// a sprite: xscale = projection / tz, index = xscale >> (LIGHTSCALESHIFT - detailshift)
const spriteMap = (light, d, detailshift) => {
  const projection = BigInt(SCREENWIDTH >> detailshift >> 1) * FRACUNIT;
  let index = Number(FixedDiv(projection, toFixed(d)) >> (LIGHTSCALESHIFT - BigInt(detailshift)));
  if (index >= MAXLIGHTSCALE) index = MAXLIGHTSCALE - 1;
  return scalelight(detailshift)[Math.max(0, Math.min(15, light >> 4))][index];
};
// a flat row at distance d: index = distance >> LIGHTZSHIFT
const flatMap = (light, d) => {
  let index = Number(toFixed(d) >> LIGHTZSHIFT);
  if (index >= MAXLIGHTZ) index = MAXLIGHTZ - 1;
  return zlight[Math.max(0, Math.min(15, light >> 4))][index];
};

// ── the tables ────────────────────────────────────────────────────────────
let zBad = 0;
for (let i = 0; i < LIGHTLEVELS; i++) for (let j = 0; j < MAXLIGHTZ; j++) if (zLight(i, j) !== zlight[i][j]) zBad++;
const sl = scalelight(0);
let sBad = 0;
for (let i = 0; i < LIGHTLEVELS; i++) for (let j = 0; j < MAXLIGHTSCALE; j++) if (scaleLight(i, j) !== sl[i][j] || scaleLight(i, j) !== scalelight(1)[i][j]) sBad++;
assert(zBad === 0 && sBad === 0, `zlight (16 × 128) and scalelight (16 × 48, both details) match R_InitLightTables / R_ExecuteSetViewSize entry for entry`);

// ── per pixel, over a sweep of distances and light levels ────────────────
const depths = [];
for (let d = 4; d < 3000; d *= 1.013) depths.push(d);
const lights = [0, 15, 16, 47, 96, 128, 144, 160, 192, 208, 255];
const walls = (detail) => {
  const proto = { proj: (SCREENWIDTH >> detail) / 2, extralight: 0, fixedCm: null };
  let bad = 0;
  for (const l of lights) for (const d of depths) if (Renderer.prototype.lightIndex.call(proto, l, d) !== wallMap(l, d, detail)) bad++;
  return bad;
};
const sprites = (detail) => {
  const proto = { proj: (SCREENWIDTH >> detail) / 2, extralight: 0, fixedCm: null };
  let bad = 0;
  for (const l of lights) for (const d of depths) if (Renderer.prototype.spriteLightIndex.call(proto, l, d) !== spriteMap(l, d, detail)) bad++;
  return bad;
};
let flats = 0;
for (const l of lights) for (const d of depths) if (zLight(lightNum(l), Math.floor(d / 16)) !== flatMap(l, d)) flats++;
const n = lights.length * depths.length;
assert(walls(0) === 0 && walls(1) === 0, `walls: the same colormap as R_RenderSegLoop at all ${n} light × distance samples, in high and low detail`);
assert(sprites(0) === 0 && sprites(1) === 0, `sprites: the same as R_ProjectSprite (detail doesn't change them), ${n} samples each`);
assert(flats === 0, `flats: the same as R_MapPlane's zlight, ${n} samples`);

// low detail's quirk: walls come out darker at a distance (their scale index halves), sprites don't
const lowWall = Renderer.prototype.lightIndex.call({ proj: 80, extralight: 0, fixedCm: null }, 160, 200);
const highWall = Renderer.prototype.lightIndex.call({ proj: 160, extralight: 0, fixedCm: null }, 160, 200);
assert(lowWall === highWall + 3 && wallMap(160, 200, 1) === lowWall,
  `in low detail a wall 200 away is darker (colormap ${lowWall} against ${highWall}), as vanilla's rw_scale halves while scalelight doesn't`);

// extralight: the muzzle flash lifts every light level, up to 15
const hud = (w, p, len) => ({ WEAPON: w, ATTACK_LEN: len, ATTACK_TICS: Math.round((1 - p) * len), TIC: 0, WEAPON_Y: 0 });
const flashes = [extraLight(hud(2, 0.1, 14)), extraLight(hud(3, 0.02, 37)), extraLight(hud(3, 0.1, 37)), extraLight(hud(1, 0.1, 18)),
  extraLight({ WEAPON: 2, ATTACK_LEN: 14, ATTACK_TICS: 0, TIC: 0 })];
const lit = Renderer.prototype.lightIndex.call({ proj: 160, extralight: 2, fixedCm: null }, 160, 300);
const dark = Renderer.prototype.lightIndex.call({ proj: 160, extralight: 0, fixedCm: null }, 160, 300);
assert(flashes.join() === '1,1,2,0,0' && lit === dark - 8 && lightNum(250, 2) === 15,
  `extralight: pistol flash 1, shotgun 1 then 2, fist and idle 0; two steps make a wall 8 colormaps brighter (${dark} → ${lit}); never past 15`);

console.log(failures ? `${failures} failure(s)` : 'light ok');
process.exit(failures ? 1 : 0);
