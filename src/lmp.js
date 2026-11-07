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

/**
 * Why a parsed .lmp can't be played on the page, or null. A netgame's (two to four players,
 * co-op or deathmatch) plays through NET_TIC, every player's ticcmd each tic, seen as
 * consoleplayer saw it.
 */
export function lmpProblem(demo) {
  const n = demo.players.filter(Boolean).length;
  if (n < 1) return 'a demo with no players';
  if (!demo.players[demo.consoleplayer]) return `a demo whose consoleplayer (${demo.consoleplayer + 1}) isn't in the game`;
  if (!demo.tics.length) return 'an empty demo';
  return null;
}

/**
 * A .lmp played on the page: the same turns as the page's own demos (DemoPlayer's take), each
 * one of the demo's tics, as G_Ticker reads a ticcmd every tic whatever the game shows.
 *   take('tic')  a level's tic: DOOM_TIC's arguments, [1, fwd, side, turn, fire, use, weapon, run]
 *   take('wi')   an intermission's tic: ['wi', 1, held, pressed] – pressed is
 *                WI_checkForAccelerate's new press of fire or use (player->attackdown, usedown,
 *                carried over from the level: carry())
 *   take('fin')  a text screen's tic: ['fin', 1, held, 0]
 *   (a netgame's level tic: ['net', [[player, fwd, side, turn, fire, use, weapon, run] …]], every
 *   player's for NET_TIC; its intermission is pressed on by anyone's press)
 *   take('map')  the next level, or the restart after a death: ['map', '*', null, 0] – which
 *                one is the game's to say (G_DoWorldDone, G_DoReborn), and no seed: P_Random's
 *                index carries on
 * null when the demo is over (its 0x80: G_CheckDemoStatus).
 */
export class LmpPlayer {
  constructor(demo, commercial) {
    const problem = lmpProblem(demo);
    if (problem) throw new Error(problem);
    this.demo = demo;
    this.lmp = true;
    this.map = lmpMapName(demo, commercial);
    this.index = 0;
    // a netgame's: the players in it (1–4, as their tics list them), and whose view
    this.inGame = demo.players.map((x, i) => (x ? i + 1 : 0)).filter(Boolean);
    // each player's attackdown and usedown, [atk, use], as inGame lists them (the console player's alone, one player's demo)
    this.downs = this.inGame.map(() => [false, false]);
    this.net = this.inGame.length > 1 ? { players: this.inGame.length, deathmatch: demo.deathmatch, me: demo.consoleplayer + 1 } : null;
  }

  get done() { return this.index >= this.demo.tics.length; }

  /** the level's end: each player's attackdown and usedown as the level left them ([[atk, use]] by
   * player number, the players in the game), for WI_checkForAccelerate */
  carry(downs) {
    this.downs = this.net ? this.inGame.map((id) => (downs[id - 1] ?? [false, false]).map(Boolean)) : [(downs[0] ?? [false, false]).map(Boolean)];
  }

  /** [player number, attackdown, usedown] for each player, to set at the next level (G_DoWorldDone) */
  get carried() { return (this.net ? this.inGame : [1]).map((id, k) => [id, this.downs[k][0], this.downs[k][1]]); }

  take(kind) {
    if (this.done) return null;
    if (kind === 'map') return ['map', '*', null, 0];
    const tic = this.demo.tics[this.index++];
    // (a netgame's level tic: every player's, as NET_TIC's TICCMD rows)
    if (this.net && kind === 'tic') return ['net', tic.map((c, k) => [this.inGame[k], ...portCmd(c)])];
    const cmds = this.net ? tic : [tic[this.demo.consoleplayer] ?? tic[0]];
    if (kind === 'tic') return [1, ...portCmd(cmds[0])];
    const held = cmds.some((c) => (c[3] & (BT_ATTACK | BT_USE)) !== 0);
    if (kind === 'wi') {
      // WI_checkForAccelerate: anyone's new press of fire or use
      let pressed = false;
      cmds.forEach((c, k) => {
        const atk = (c[3] & BT_ATTACK) !== 0;
        const use = (c[3] & BT_USE) !== 0;
        if ((atk && !this.downs[k][0]) || (use && !this.downs[k][1])) pressed = true;
        this.downs[k] = [atk, use];
      });
      return ['wi', 1, held ? 1 : 0, pressed ? 1 : 0];
    }
    return ['fin', 1, held ? 1 : 0, 0];
  }
}
