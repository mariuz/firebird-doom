// keys.js – default.cfg's key bindings: the ten keys DOOM let you change (in
// SETUP.EXE, kept in default.cfg as key_right, key_left, key_up, key_down,
// key_strafeleft, key_straferight, key_fire, key_use, key_strafe, key_speed).
// Each action has two slots here (the page always had two keys for most of
// them); the defaults are the keys the page already used, plus DOOM's Alt
// as the strafe key. A key does one thing: binding it to an action takes it
// from any other, as SETUP did. Left and right Ctrl, Shift and Alt count as
// one key each, as DOS saw them.

/** [action, what it's called, default.cfg's name] */
export const ACTIONS = [
  ['forward', 'Forward', 'key_up'],
  ['back', 'Back', 'key_down'],
  ['left', 'Turn left', 'key_left'],
  ['right', 'Turn right', 'key_right'],
  ['strafeleft', 'Strafe left', 'key_strafeleft'],
  ['straferight', 'Strafe right', 'key_straferight'],
  ['fire', 'Fire', 'key_fire'],
  ['use', 'Use', 'key_use'],
  ['speed', 'Run', 'key_speed'],
  ['strafe', 'Strafe (held: the turn keys and the mouse strafe)', 'key_strafe'],
];

export const DEFAULT_KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['ArrowLeft', null],
  right: ['ArrowRight', null],
  strafeleft: ['KeyA', 'Comma'],
  straferight: ['KeyD', 'Period'],
  fire: ['Control', 'KeyF'],
  use: ['Space', 'KeyE'],
  speed: ['Shift', null],
  strafe: ['Alt', null],
};

/**
 * Keys the page keeps for itself: the menu, the automap, the weapons, the
 * screen size, pause, chat, audio and the function keys.
 */
const RESERVED = new Set(['Escape', 'Tab', 'Minus', 'Equal', 'KeyP', 'KeyM', 'KeyT', 'Pause', 'Backspace', 'Enter',
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);

/** a KeyboardEvent.code as a binding: ControlLeft and ControlRight are both Control, and so on */
export function bindingCode(code) {
  return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code) ? code.replace(/(Left|Right)$/, '') : code;
}

/** why CODE can't be bound, or null */
export function reservedKey(code) {
  return RESERVED.has(code) ? 'the page uses that key itself' : null;
}

/** saved bindings (or nothing) made whole: every action, two slots, nothing reserved or bound twice */
export function keysFrom(saved) {
  const out = Object.fromEntries(ACTIONS.map(([a]) => [a, [...DEFAULT_KEYS[a]]]));
  if (!saved || typeof saved !== 'object') return out;
  const used = new Set();
  for (const [a] of ACTIONS) {
    const slots = Array.isArray(saved[a]) ? saved[a].slice(0, 2) : DEFAULT_KEYS[a];
    out[a] = [0, 1].map((i) => {
      const c = typeof slots[i] === 'string' ? bindingCode(slots[i]) : null;
      if (!c || reservedKey(c) || used.has(c)) return null;
      used.add(c);
      return c;
    });
  }
  return out;
}

/** KEYS with CODE in ACTION's SLOT (null clears it), taken from wherever else it was */
export function bindKey(keys, action, slot, code) {
  const c = code === null ? null : bindingCode(code);
  const out = Object.fromEntries(Object.entries(keys).map(([a, s]) => [a, s.map((k) => (c && k === c ? null : k))]));
  out[action][slot] = c;
  return out;
}

/** whether ACTION's key is down, given the codes held */
export function actionDown(keys, action, held, skip = () => false) {
  return keys[action].some((c) => c && !skip(c) && (held.has(c) || held.has(`${c}Left`) || held.has(`${c}Right`)));
}

/** every KeyboardEvent.code that's bound (the page keeps their browser defaults from them) */
export function boundCodes(keys) {
  const out = new Set();
  for (const s of Object.values(keys)) {
    for (const c of s) {
      if (!c) continue;
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(c)) { out.add(`${c}Left`); out.add(`${c}Right`); } else out.add(c);
    }
  }
  return out;
}

/** a binding as a person would say it */
export function keyName(code) {
  if (!code) return '—';
  const named = { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Meta', Space: 'Space', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Insert: 'Ins', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn' };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Numpad/.test(code)) return `Keypad ${code.slice(6)}`;
  return code;
}
