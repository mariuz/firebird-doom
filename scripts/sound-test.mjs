// sound-test.mjs – s_sound.c's channels without the audio: S_AdjustSoundParams,
// S_getChannel's eight channels and priorities, S_UpdateSounds.
import { Channels, adjust, aproxDistance, priorityOf, NUM_CHANNELS } from '../src/channels.js';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const me = { x: 0, y: 0, angle: 0, bossMap: false };

// S_AdjustSoundParams
const near = adjust(150, 0, me);
const mid = adjust(700, 0, me);
const far = adjust(1201, 0, me);
assert(near.vol === 1 && mid.vol === 63 / 127 && far === null,
  `volume: full within 200, ${Math.round(mid.vol * 127)}/127 at 700 (127 × 500 / 1000), nothing past 1200`);
const diag = adjust(800, 800, me);
assert(aproxDistance(800, 800) === 1200 && diag === null,
  'P_AproxDistance, not the true distance: (800, 800) counts as 1200 away, so it is silent (its true 1131 would not be)');
const left = adjust(0, 500, me);
const right = adjust(0, -500, me);
const ahead = adjust(500, 0, me);
assert(left.pan === -0.75 && right.pan === 0.75 && Math.abs(ahead.pan) < 1e-9 && adjust(null, null, me).vol === 1,
  `separation 128 − 96·sin: hard left ${left.pan}, hard right ${right.pan}, ahead centred; the listener's own sounds centred, full`);
const boss = adjust(5000, 0, { ...me, bossMap: true });
assert(boss?.vol === 15 / 127, `on map 8 a sound never fades below 15/127 (${Math.round(boss.vol * 127)} at 5000 away)`);

// S_getChannel
assert(priorityOf('DSPISTOL') === 64 && priorityOf('DSTELEPT') === 32 && priorityOf('DSPOSACT') === 120 && priorityOf('DSNOPE') === 64,
  "sounds.c's priorities by lump name (pistol 64, teleport 32, zombie growl 120; unknown 64)");
const stopped = [];
const ch = new Channels((h) => stopped.push(h));
for (let i = 1; i <= NUM_CHANNELS; i++) ch.start('DSPOSACT', i, 100, 0, me, `growl${i}`);
const full = ch.slots.every(Boolean);
const shot = ch.start('DSPISTOL', 0, null, null, me, 'pistol');
assert(full && shot === 0 && stopped.join() === 'growl1' && ch.slots[0].handle === 'pistol',
  'eight channels; a ninth sound takes the first channel whose sound matters no more (a growl, 120 ≥ 64)');
const tele = new Channels(() => {});
for (let i = 1; i <= NUM_CHANNELS; i++) tele.start('DSTELEPT', i, 100, 0, me, `t${i}`);
assert(tele.start('DSPISTOL', 0, null, null, me, 'p') === -1 && !tele.slots.some((s) => s.handle === 'p'),
  'with all eight playing more important sounds (teleports, 32), a pistol shot is lost');
stopped.length = 0;
const again = ch.start('DSPODTH1', 3, 100, 0, me, 'death3');
assert(stopped.includes('growl3') && ch.slots.filter((s) => s?.origin === 3).length === 1 && again === 2,
  'a new sound from an origin stops its old one first (S_StopSound), and takes its channel');
stopped.length = 0;
assert(ch.start('DSPODTH1', 4, 5000, 0, me, 'faraway') === -1 && stopped.length === 0,
  'a sound out of earshot is not started, and leaves its origin\'s old sound playing');
ch.ended('death3');
assert(ch.slots[2] === null, 'a sound that has finished frees its channel');

// S_UpdateSounds
const set = new Map();
const u = new Channels((h) => set.set(h, 'stopped'));
u.start('DSSKLATK', 7, 300, 0, me, 'soul');
u.start('DSBGACT', 8, 300, 0, me, 'imp');
u.start('DSDOROPN', -5, 400, 0, me, 'door');
assert(u.thingOrigins().join() === '7,8', 'the sounding things are the positive origins (sectors and the player are not things)');
u.update(me, new Map([[7, [0, 400]], [8, [1500, 0]]]), (h, vol, pan) => set.set(h, { vol, pan }));
assert(set.get('soul')?.pan === -0.75 && set.get('imp') === 'stopped' && set.get('door')?.vol > 0,
  'each tic a sound follows its thing (the lost soul swoops to the left), and stops out of earshot (the imp)');
u.update(me, new Map(), (h, vol, pan) => set.set(h, { vol, pan }));
assert(set.get('soul') === 'stopped' && typeof set.get('door') === 'object',
  "a removed thing takes its sound with it (P_RemoveMobj's S_StopSound); the door's sector stays where it is");

console.log(failures ? `${failures} failure(s)` : 'sound ok');
process.exit(failures ? 1 : 0);
