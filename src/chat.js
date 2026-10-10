// chat.js – netgame chat, after hu_stuff.c. Nothing here touches the game:
// what a player types goes into their ticcmds a character a tic (the
// chatchar that G_BuildTiccmd takes from HU_dequeueChatChar), travels with
// the lockstep like the rest of the command, and every peer puts the other
// players' lines together from it (HU_Ticker), showing a finished one that's
// meant for them as "g:HELLO" with a beep.

export const KEY_ENTER = 13;
export const KEY_ESCAPE = 27;
export const KEY_BACKSPACE = 127;
export const HU_BROADCAST = 5;            // a destination: everyone (1–4: that player alone)
const QUEUESIZE = 128;
const HU_MAXLINELENGTH = 80;
export const HU_MSGTIMEOUT = 4 * 35;

// HU_INPUTTOGGLE, and HUSTR_KEYGREEN…HUSTR_KEYRED (to one player, with more than two)
export const INPUT_TOGGLE = 't';
export const DESTINATION_KEYS = ['g', 'i', 'b', 'r'];

// player_names[]: Freedoom's DEHACKED (BSD) names them so; another WAD's
// DEHACKED may say otherwise
const PLAYER_NAMES = { HUSTR_PLRGREEN: 'g:', HUSTR_PLRINDIGO: 'i:', HUSTR_PLRBROWN: 'b:', HUSTR_PLRRED: 'r:' };
// chat_macros[] (Alt+0…9): DOOM's own defaults are id's text, so these are
// ours; a DEHACKED's HUSTR_CHATMACRO0…9 take their place
const CHAT_MACROS = ['No.', 'Ready when you are.', 'Over here!', 'I need health.', 'I need ammo.',
  'Watch your back!', 'Follow me.', 'Wait for me.', 'Got the key.', 'Good game!'];
// HUSTR_TALKTOSELF1…5 (pressing your own colour's key) and HUSTR_MSGU (the
// queue's full): ours too, unless a DEHACKED has them
const TALK_TO_SELF = ['You mutter to yourself.', 'Nobody else is listening.', 'Still talking to yourself.',
  'That really is your own colour.', 'Give it a rest.'];
const MSG_UNSENT = '[Message not sent]';

/** The texts chat uses, from a DEHACKED's [STRINGS] (a Map, as parseDehStrings gives) over ours. */
export function chatStrings(strings = new Map()) {
  return {
    names: Object.keys(PLAYER_NAMES).map((k) => strings.get(k) ?? PLAYER_NAMES[k]),
    macros: CHAT_MACROS.map((m, i) => strings.get(`HUSTR_CHATMACRO${i}`) ?? m),
    toSelf: TALK_TO_SELF.map((m, i) => strings.get(`HUSTR_TALKTOSELF${i + 1}`) ?? m),
    unsent: strings.get('HUSTR_MSGU') ?? MSG_UNSENT,
  };
}

/** HUlib_keyInIText: a printable character goes on the line, backspace takes one off, Enter is taken; true when it ate the key. */
function keyIn(line, ch) {
  if (ch >= 32 && ch <= 95) { if (line.text.length < HU_MAXLINELENGTH) line.text += String.fromCharCode(ch); }
  else if (ch === KEY_BACKSPACE) line.text = line.text.slice(0, -1);
  else if (ch !== KEY_ENTER) return false;
  return true;
}

/** a key as hu_stuff.c sees it: a character (shiftxform: a–z to upper case), Enter, Backspace or Escape; 0 for the rest */
export function chatChar(key) {
  if (key === 'Enter') return KEY_ENTER;
  if (key === 'Backspace') return KEY_BACKSPACE;
  if (key === 'Escape') return KEY_ESCAPE;
  if (key.length !== 1) return 0;
  const c = key.charCodeAt(0);
  return c >= 97 && c <= 122 ? c - 32 : c;
}

export class Chat {
  /**
   * @param me       this peer's player (consoleplayer), 1–4
   * @param players  how many are in the game
   * @param say      say(text, always): show a message; always (a chat line
   *                 for you) shows even with messages off and plays the beep
   * @param strings  chatStrings()
   */
  constructor({ me, players, say = () => {}, strings = chatStrings() }) {
    Object.assign(this, { me, players, say, strings });
    this.on = false;                         // chat_on
    this.line = { text: '' };                // w_chat
    this.queue = [];                         // chatchars[]
    this.inputs = Array.from({ length: players }, () => ({ text: '' }));   // w_inputbuffer[]
    this.dest = Array(players).fill(0);      // chat_dest[]
    this.nobrainers = 0;
  }

  /** HU_queueChatChar */
  enqueue(c) {
    if (this.queue.length >= QUEUESIZE - 1) this.say(this.strings.unsent);
    else this.queue.push(c);
  }

  /** HU_dequeueChatChar: the next character for this tic's command (0: none) */
  dequeue() { return this.queue.length ? this.queue.shift() : 0; }

  /**
   * HU_Responder: a key pressed (KEY as KeyboardEvent.key, ALT held). True
   * when chat ate it; otherwise it goes on to the game, as in DOOM (an arrow
   * key while you type still turns you).
   */
  key(key, alt = false) {
    if (!this.on) {
      const k = key.length === 1 ? key.toLowerCase() : '';
      if (k === INPUT_TOGGLE) {
        this.start(HU_BROADCAST);
        return true;
      }
      const i = DESTINATION_KEYS.indexOf(k);
      if (i < 0 || this.players <= 2) return false;
      if (i + 1 === this.me) {
        // (the key of your own colour)
        this.nobrainers++;
        const n = this.nobrainers;
        this.say(this.strings.toSelf[n < 3 ? 0 : n < 6 ? 1 : n < 9 ? 2 : n < 32 ? 3 : 4]);
        return false;
      }
      if (i + 1 > this.players) return false;
      this.start(i + 1);
      return true;
    }
    // Alt+0…9: a macro. A first Enter sends what was typed so far, then the
    // macro goes, to whoever the line was for
    if (alt) {
      const n = key.length === 1 ? key.charCodeAt(0) - 48 : -1;
      if (n < 0 || n > 9) return false;
      const text = this.strings.macros[n];
      this.enqueue(KEY_ENTER);
      for (const ch of text) this.enqueue(ch.charCodeAt(0));
      this.enqueue(KEY_ENTER);
      this.on = false;
      this.say(text);
      return true;
    }
    const c = chatChar(key);
    const ate = keyIn(this.line, c);
    if (ate) this.enqueue(c);
    if (c === KEY_ENTER) {
      this.on = false;
      if (this.line.text) this.say(this.line.text);
    } else if (c === KEY_ESCAPE) this.on = false;   // (not queued: the others keep what came so far, as in DOOM)
    return ate;
  }

  start(dest) {
    this.on = true;
    this.line.text = '';
    this.enqueue(dest);
  }

  /** HU_Ticker's chat half, for one tic: CHARS[player − 1] is each player's chatchar */
  ticker(chars) {
    for (let i = 0; i < this.players; i++) {
      let c = chars[i] | 0;
      if (i + 1 === this.me || !c) continue;
      if (c <= HU_BROADCAST) { this.dest[i] = c; continue; }
      if (c >= 97 && c <= 122) c -= 32;
      const line = this.inputs[i];
      if (keyIn(line, c) && c === KEY_ENTER) {
        if (line.text && (this.dest[i] === this.me || this.dest[i] === HU_BROADCAST)) {
          this.say(this.strings.names[i] + line.text, true);
        }
        line.text = '';
      }
    }
  }

  /** what HU_Drawer shows of w_chat: the line and its cursor, while typing */
  get shown() { return this.on ? `${this.line.text}_` : null; }
}
