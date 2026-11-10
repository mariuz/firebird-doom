// ticcmd.js – G_BuildTiccmd's movement: the keys, the joystick, the touch pad and the mouse's
// terms (mouse.js) summed in DOOM's units, then clamped to MAXPLMOVE, as g_game.c builds a ticcmd.
//
//   forwardmove[speed]  25 walking, 50 running (the move keys, the stick's Y, the pad)
//   sidemove[speed]     24, 40 (the strafe keys, and the turn keys or the stick's X while strafing)
//   angleturn[tspeed]   640, 1280, and 320 for the first SLOWTURNTICS tics a turn key is held
//                       (turnheld), whatever the speed: a tap turns a little, a hold turns fast
//
// The touch pad is the port's own (vanilla had none): a full slide is the move keys' worth.
import { FORWARDMOVE, moveCommand } from './mouse.js';

export const SIDEMOVE = [24, 40];
export const ANGLETURN = [640, 1280, 320];
export const SLOWTURNTICS = 6;
/** radians per unit of angleturn (a BAM >> 16) */
export const ANGLETURN_RAD = (2 * Math.PI) / 65536;

/** turnheld: how many tics the turn keys (or the stick's X) have been held */
export class TurnHeld {
  constructor() { this.tics = 0; }

  /**
   * TICS tics with the turn keys HELD (or not) at SPEED (0 walking, 1 running): the angleturn
   * one turn key gives over them, summed. turnheld counts first, then picks the speed, as
   * G_BuildTiccmd does: the first five tics are slow, the sixth on at SPEED's.
   */
  take(held, speed, tics) {
    if (!held) { this.tics = 0; return 0; }
    let units = 0;
    for (let i = 0; i < tics; i++) {
      this.tics++;
      units += ANGLETURN[this.tics < SLOWTURNTICS ? 2 : speed];
    }
    return units;
  }
}

/**
 * One ticcmd's movement over TICS tics. KEYS: { fwd, side, turn } of the bound keys, each -1, 0
 * or 1 (forward − back, right − left, left − right); JOY: the stick ({ x, y }, -1…1, or null);
 * PAD: the touch pad's { fwd, side } (or null; it stands in for the move keys); MOUSE: mouse.js's
 * take(); STRAFE: key_strafe, the mouse's button or the stick's (the turn keys and the stick's X
 * strafe); SPEED 0 or 1; TURNHELD: a TurnHeld; HELD: a turn key is down (both at once count too,
 * as gamekeydown does; by default KEYS.turn or the stick's X). Returns DOOM_TIC's { fwd, side, run, turn }:
 * fwd and side as fractions of forwardmove[run] (the SQL multiplies back), turn in radians.
 */
export function buildMove({ keys, joy = null, pad = null, mouse = null, strafe = false, speed = 0, tics = 1, turnheld, held = null }) {
  const jx = joy?.x ?? 0;
  const jy = joy?.y ?? 0;
  let forward = (keys.fwd - jy) * FORWARDMOVE[speed];
  let side = keys.side * SIDEMOVE[speed];
  if (pad) {
    forward = pad.fwd * FORWARDMOVE[speed];
    side = pad.side * SIDEMOVE[speed];
  }
  // (turnheld counts key_right, key_left and joyxmove, strafing or not)
  const units = turnheld.take(held ?? (keys.turn !== 0 || jx !== 0), speed, tics);
  let turn = 0;
  if (strafe) side += (jx - keys.turn) * SIDEMOVE[speed];
  else turn = (keys.turn - jx) * units * ANGLETURN_RAD;
  const m = moveCommand(forward + (mouse?.forward ?? 0), side + (mouse?.side ?? 0), speed);
  return { ...m, turn: turn + (mouse?.turn ?? 0) };
}
