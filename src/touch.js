// touch.js – playing on a phone or tablet: on-screen controls over the view, read into
// readInput as the keyboard, mouse and gamepad are (main.js).
//
//   in play   the left half is a move pad: where the thumb lands is its centre, and how far it
//             slides says how fast (past STICK_RUN of the radius, running); the right half turns
//             as it's dragged (a tap there fires once, as it did before). Down the right edge:
//             FIRE (held, as the fire key), USE, the next weapon, the automap and the menu.
//   in menus  the arrows, select and back – the keys M_Responder takes.
//   elsewhere the title, the endings: a tap is a key (the intermission takes taps as fire or use).
//
// Nothing here is DOOM's own: vanilla had no touch screen. The buttons give only what its keys
// give – the next weapon is the number key of the next slot that has one, so the fist's key
// still gives the chainsaw and the shotgun's the super shotgun, as P_PlayerThink picks (Chocolate
// Doom's own next-weapon key does the same) – so a touch game is a keyboard game to the
// simulation, demos and netgames included.

export const STICK_RADIUS = 40;   // (CSS pixels of slide for a full walk)
export const STICK_RUN = 1.5;     // (past this many radii, a run)

/** the move pad's slide (CSS pixels) → { fwd, side } each -1…1, and run past STICK_RUN radii */
export function stickCommand(dx, dy, radius = STICK_RADIUS) {
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  return { fwd: clamp(-dy / radius), side: clamp(dx / radius), run: Math.hypot(dx, dy) > STICK_RUN * radius ? 1 : 0 };
}

// the weapons the HUD names (PLAYER.WEAPON: 1 fist … 7 BFG, 8 chainsaw, 9 super shotgun) by slot
const SLOT_OF = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 1, 9: 3 };

/** the number key for the next slot with a weapon in it after the one in hand (from the HUD row) */
export function nextWeaponSlot(hud) {
  const owned = {
    1: true, 2: true, 3: !!(hud.HAS_SHOTGUN || hud.HAS_SSG), 4: !!hud.HAS_CHAINGUN, 5: !!hud.HAS_LAUNCHER,
    6: !!hud.HAS_PLASMA, 7: !!hud.HAS_BFG,
  };
  const now = SLOT_OF[hud.WEAPON] ?? 2;
  for (let k = 1; k <= 7; k++) {
    const slot = ((now - 1 + k) % 7) + 1;
    if (owned[slot]) return slot;
  }
  return now;
}

/** which set of controls a screen shows: 'play', 'menu' or 'screen' (a tap is a key) */
export function touchMode({ menu, title, intermission, finale }) {
  if (menu) return 'menu';
  if (title || intermission || finale) return 'screen';
  return 'play';
}

const BUTTONS = {
  play: [['fire', 'FIRE', 'hold'], ['use', 'USE'], ['weapon', 'WPN'], ['map', 'MAP'], ['menu', '☰']],
  menu: [['ArrowUp', '▲'], ['ArrowDown', '▼'], ['ArrowLeft', '◀'], ['ArrowRight', '▶'], ['Enter', 'OK'], ['Backspace', '↩']],
  screen: [],
};

/**
 * The overlay: buttons over the view's right edge and the move pad's ring, shown once the page
 * is touched (or on a coarse pointer). ON(name, down) is told of each press and release.
 */
export class TouchOverlay {
  constructor(wrap, on) {
    this.on = on;
    this.mode = null;
    this.el = document.createElement('div');
    this.el.className = 'touch-overlay';
    this.el.hidden = true;
    this.buttons = document.createElement('div');
    this.buttons.className = 'touch-buttons';
    this.pad = document.createElement('div');
    this.pad.className = 'touch-pad';
    this.pad.hidden = true;
    this.knob = document.createElement('div');
    this.knob.className = 'touch-knob';
    this.pad.append(this.knob);
    this.el.append(this.pad, this.buttons);
    wrap.append(this.el);
  }

  get shown() { return !this.el.hidden; }

  show() { this.el.hidden = false; }

  /** the controls for MODE ('play', 'menu', 'screen') */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.el.dataset.mode = mode;
    this.buttons.replaceChildren(...BUTTONS[mode].map(([name, label, kind]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'touch-button';
      b.dataset.touch = name;
      b.textContent = label;
      const on = this.on;
      const down = (e) => { e.preventDefault(); e.stopPropagation(); b.setPointerCapture?.(e.pointerId); b.classList.add('down'); on(name, true); };
      const up = (e) => { e.preventDefault(); e.stopPropagation(); if (!b.classList.contains('down')) return; b.classList.remove('down'); if (kind === 'hold') on(name, false); };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });   // (not the canvas's pad)
      return b;
    }));
  }

  /** the move pad's ring at (X, Y) in the overlay's pixels, its knob DX, DY off centre; null hides it */
  showPad(at) {
    this.pad.hidden = !at;
    if (!at) return;
    const r = this.el.getBoundingClientRect();
    this.pad.style.left = `${at.x - r.left}px`;
    this.pad.style.top = `${at.y - r.top}px`;
    const k = Math.min(1, STICK_RUN * STICK_RADIUS / Math.max(1, Math.hypot(at.dx, at.dy)));
    this.knob.style.transform = `translate(${at.dx * k}px, ${at.dy * k}px)`;
  }
}
