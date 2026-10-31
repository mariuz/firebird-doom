// lmp.js – DOOM's demo files (.lmp, and a WAD's DEMO1–4 lumps), as g_game.c's
// G_RecordDemo / G_DoPlayDemo / G_ReadDemoTiccmd / G_WriteDemoTiccmd lay them out.
//
//   v1.9 (version 109): version, skill (0–4), episode, map, deathmatch, respawn, fast,
//     nomonsters, consoleplayer, playeringame[4]; then each tic, for each player in the
//     game: forwardmove, sidemove (signed bytes), angleturn's high byte, buttons; then 0x80
//   v1.2 and earlier (first byte 0–4, the skill): skill, episode, map, playeringame[4]
//   longtics (Chocolate Doom's -longtics, version 111): angleturn in two bytes
//
// A ticcmd here is [forwardmove, sidemove, angleturn, buttons], angleturn as the game
// adds it to the angle (<< 16 gives a BAM). Buttons: BT_ATTACK 1, BT_USE 2, BT_CHANGE 4 with
// the weapon in bits 3–5, BT_SPECIAL 0x80 (pause, save).

export const DEMOMARKER = 0x80;
export const BT_ATTACK = 1;
export const BT_USE = 2;
export const BT_CHANGE = 4;

const signed = (b) => (b > 127 ? b - 256 : b);

/** Read a demo. → { version, skill (1–5, as the menu counts), episode, map, deathmatch, respawn,
 *  fast, nomonsters, consoleplayer, players: [bool × 4], longtics, tics: [[cmd per player in game]] } */
export function parseLmp(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (d.length < 7) throw new Error('not a demo: too short');
  let p = 0;
  const demo = { version: 0, deathmatch: 0, respawn: 0, fast: 0, nomonsters: 0, consoleplayer: 0, longtics: false };
  if (d[0] <= 4) {
    // (before v1.4: no version byte, and none of the options)
    demo.version = 0;
    demo.skill = d[p++] + 1;
    demo.episode = d[p++];
    demo.map = d[p++];
  } else {
    demo.version = d[p++];
    if (![104, 105, 106, 107, 108, 109, 111].includes(demo.version)) throw new Error(`a demo of version ${demo.version}, not DOOM's`);
    demo.longtics = demo.version === 111;
    demo.skill = d[p++] + 1;
    demo.episode = d[p++];
    demo.map = d[p++];
    demo.deathmatch = d[p++];
    demo.respawn = d[p++];
    demo.fast = d[p++];
    demo.nomonsters = d[p++];
    demo.consoleplayer = d[p++];
  }
  demo.players = [0, 1, 2, 3].map(() => d[p++] !== 0);
  const inGame = demo.players.filter(Boolean).length;
  if (!inGame) throw new Error('not a demo: no players');
  demo.tics = [];
  const size = demo.longtics ? 5 : 4;
  while (p < d.length && d[p] !== DEMOMARKER) {
    if (p + size * inGame > d.length) break;   // (a demo cut short: what's whole plays)
    const tic = [];
    for (let k = 0; k < inGame; k++) {
      const fwd = signed(d[p++]);
      const side = signed(d[p++]);
      let turn;
      if (demo.longtics) { turn = d[p] | (d[p + 1] << 8); p += 2; turn = turn > 32767 ? turn - 65536 : turn; }
      else turn = signed(d[p++]) << 8;   // (G_ReadDemoTiccmd: ((unsigned char) *demo_p++) << 8, as a short)
      tic.push([fwd, side, turn, d[p++]]);
    }
    demo.tics.push(tic);
  }
  return demo;
}

/** Write a demo (v1.9, or longtics), the same shape parseLmp returns. → Uint8Array */
export function writeLmp(demo) {
  const inGame = demo.players.filter(Boolean).length;
  const longtics = !!demo.longtics;
  const out = [longtics ? 111 : 109, demo.skill - 1, demo.episode, demo.map, demo.deathmatch ?? 0, demo.respawn ?? 0,
    demo.fast ?? 0, demo.nomonsters ?? 0, demo.consoleplayer ?? 0, ...demo.players.map((x) => (x ? 1 : 0))];
  for (const tic of demo.tics) {
    if (tic.length !== inGame) throw new Error('a tic without a command for every player');
    for (const [fwd, side, turn, buttons] of tic) {
      out.push(fwd & 0xff, side & 0xff);
      // (G_WriteDemoTiccmd keeps angleturn's high byte, rounded: (angleturn + 128) >> 8)
      if (longtics) out.push(turn & 0xff, (turn >> 8) & 0xff);
      else out.push(((turn + 128) >> 8) & 0xff);
      out.push(buttons & 0xff);
    }
  }
  out.push(DEMOMARKER);
  return Uint8Array.from(out);
}

/** The map a demo starts on: MAPxx in a commercial (DOOM II) IWAD, else ExMy */
export function lmpMapName(demo, commercial) {
  return commercial ? `MAP${String(demo.map).padStart(2, '0')}` : `E${demo.episode}M${demo.map}`;
}

/**
 * One of a demo's ticcmds as this port's DOOM_TIC takes it ([fwd, side, turn, fire, use,
 * weapon, run]): DOOM thrusts forwardmove × 2048 (fixed point, so forwardmove / 32 units),
 * which is the port's walking 25/32 × fwd; angleturn << 16 is a BAM (65536 to a circle);
 * BT_CHANGE's weapon (wp_fist 0 … wp_chainsaw 7) is the port's weapon number, one more
 * (P_PlayerThink in PLAYER_THINK decides from there: the fist's key reaching the chainsaw, the
 * shotgun's the super shotgun).
 */
export function portCmd([fwd, side, turn, buttons]) {
  let weapon = 0;
  if (buttons & BT_CHANGE && !(buttons & 0x80)) {
    const wp = (buttons >> 3) & 7;
    weapon = wp + 1;
  }
  return [fwd / 25, side / 25, (turn * 2 * Math.PI) / 65536, buttons & BT_ATTACK ? 1 : 0, buttons & BT_USE ? 1 : 0, weapon, 0];
}
