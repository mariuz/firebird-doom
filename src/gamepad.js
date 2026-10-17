// gamepad.js – DOOM's joystick, from the browser's Gamepad API.
//
// Vanilla read one joystick: its X and Y as -1, 0 or 1 (a digital stick, past
// the calibrated centre), and four buttons, which default.cfg set to fire
// (joybfire 0), strafe (joybstrafe 1), speed (joybspeed 2) and use (joybuse 3).
// G_BuildTiccmd moves on them as it does on the arrow keys: Y forward and
// back, X turning, or strafing while the strafe button is held. M_Responder
// reads the same stick in the menus, and G_Responder opens the menu on the
// title when a button goes down.
//
// Here the first connected pad is the joystick: its left stick or its d-pad
// (in the standard mapping, buttons 12–15) is the stick, and its buttons 0–3
// (A, B, X, Y on most pads) are DOOM's buttons 0–3.

/** default.cfg's joystick buttons */
export const JOYB = { fire: 0, strafe: 1, speed: 2, use: 3 };
const DEAD = 0.5;   // (an analogue stick reads as pushed past halfway, as the calibrated DOS stick did)
const TIC_MS = 1000 / 35;

/** The joystick now: { x, y } each -1, 0 or 1 (y -1 is up), and buttons[0–3]; null without a pad. */
export function readJoystick(pads) {
  for (const p of pads ?? []) {
    if (!p || p.connected === false) continue;
    const pressed = (i) => !!p.buttons?.[i]?.pressed;
    const axis = (i) => (Math.abs(p.axes?.[i] ?? 0) > DEAD ? Math.sign(p.axes[i]) : 0);
    let x = axis(0);
    let y = axis(1);
    if (pressed(14)) x = -1;
    if (pressed(15)) x = 1;
    if (pressed(12)) y = -1;
    if (pressed(13)) y = 1;
    return { x, y, buttons: [0, 1, 2, 3].map(pressed) };
  }
  return null;
}

/**
 * M_Responder's joystick: a key for the menu now and then while the stick is
 * pushed or a button held (joywait: 5 tics up and down, 2 left and right, 5
 * for the buttons; a button wins over the stick, as it's read last).
 */
export class JoyMenu {
  constructor() { this.wait = 0; }

  /** the menu key for this moment (ArrowUp…, Enter, Backspace), or null */
  key(js, now) {
    if (!js || now < this.wait) return null;
    let k = null;
    let tics = 0;
    if (js.y < 0) { k = 'ArrowUp'; tics = 5; } else if (js.y > 0) { k = 'ArrowDown'; tics = 5; }
    if (js.x < 0) { k = 'ArrowLeft'; tics = 2; } else if (js.x > 0) { k = 'ArrowRight'; tics = 2; }
    if (js.buttons[0]) { k = 'Enter'; tics = 5; }
    if (js.buttons[1]) { k = 'Backspace'; tics = 5; }
    if (k) this.wait = now + tics * TIC_MS;
    return k;
  }

  /** hold off for a moment (the button that opened the menu isn't also its Enter) */
  holdOff(now) { this.wait = now + 5 * TIC_MS; }
}
