// record-attract.mjs – the demos the title loop plays between its pages
// (D_DoAdvanceDemo's demo1–3, and DOOM II's demo4). DOOM's own .lmp files
// can't be played (see demo.js), so these are the port's own: a scripted
// player walks the first maps of each Freedoom WAD, shooting what it sees,
// and every DOOM_TIC call is recorded the way the page records a demo.
//
//   npm run attract              → public/demos/<wad>-demo<n>.json
//
// Each file carries the game's checksum at its end (NET_CHECKSUM), so
// `npm run test:attract` can tell when a change to the simulation has made a
// demo play out differently, and it's time to record them again – as the
// README's pictures are checked against docs/screenshots.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { DEMO_VERSION, attractDemoFile } from '../src/demo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/demos');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));

// which maps, how long (tics), from which seed
export const ATTRACT = {
  'freedoom1.wad': [['E1M1', 700, 1001], ['E1M2', 700, 1002], ['E1M3', 700, 1003]],
  'freedoom2.wad': [['MAP01', 700, 2001], ['MAP02', 700, 2002], ['MAP03', 700, 2003], ['MAP04', 700, 2004]],
};
export const TICS_PER_CALL = 2;   // (the page makes calls of one to six tics; two is a 60 Hz frame and a bit)
export const SKILL = 3;

/**
 * The scripted player. Each call it looks for the nearest monster it can see
 * within 1024 units: it turns to it and fires when nearly on it, backing off
 * when hurt. Otherwise it wanders: it looks 128 units ahead and to either
 * side (P_CheckSight, as a wall probe), runs where it's open, tries use on
 * what blocks the way (a door) before turning from it, and turns when it
 * gets nowhere. Its own little random generator keeps the recording the
 * same every time.
 */
export class Bot {
  constructor(db, seed) {
    this.db = db;
    this.s = seed;
    this.last = [];
    this.stuck = 0;
    this.blocked = 0;
    this.turning = 0;
    this.turnDir = 1;
  }

  rnd() { this.s = (this.s * 48271) % 2147483647; return this.s / 2147483647; }

  async look() {
    const one = async (q) => (await this.db.query(q)).rows[0];
    const me = await one(`SELECT t.id, t.x, t.y, t.z, t.angle, p.dead, p.health, p.damage_count,
      (SELECT a.x FROM things a WHERE a.id = p.attacker_id AND a.st NOT IN ('dying', 'dead')) ax,
      (SELECT a.y FROM things a WHERE a.id = p.attacker_id AND a.st NOT IN ('dying', 'dead')) ay
      FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1`);
    // what it can see (P_CheckSight from eye height to the monster's middle), the nearest first
    const target = await one(`SELECT FIRST 1 t.x, t.y, ((t.x - ${me.X}) * (t.x - ${me.X}) + (t.y - ${me.Y}) * (t.y - ${me.Y})) d
      FROM things t WHERE t.kind = 'monster' AND t.st NOT IN ('dying', 'dead')
       AND ABS(t.x - ${me.X}) < 1024 AND ABS(t.y - ${me.Y}) < 1024
       AND check_sight(${me.X}, ${me.Y}, ${me.Z + 41}, t.x, t.y, t.z + t.height / 2) = 1
     ORDER BY 3, t.id`);
    // the way ahead, left and right: a wall or a closed door stops the sight line
    const eye = me.Z + 41;
    const probe = (d) => `check_sight(${me.X}, ${me.Y}, ${eye}, ${me.X + 128 * Math.cos(me.ANGLE + d)}, ${me.Y + 128 * Math.sin(me.ANGLE + d)}, ${eye})`;
    const open = await one(`SELECT ${probe(0)} ahead, ${probe(0.7)} left_, ${probe(-0.7)} right_ FROM rdb$database`);
    return { me, target, open: { ahead: open.AHEAD === 1, left: open.LEFT_ === 1, right: open.RIGHT_ === 1 } };
  }

  /** the next call's arguments: [tics, fwd, side, turn, fire, use, weapon, run] */
  async next(tics) {
    const { me, target, open } = await this.look();
    if (me.DEAD) return [tics, 0, 0, 0, 0, 0, 0, 0];
    const towards = (x, y) => {
      let diff = Math.atan2(y - me.Y, x - me.X) - me.ANGLE;
      return diff - 2 * Math.PI * Math.floor((diff + Math.PI) / (2 * Math.PI));
    };
    let fwd = 0;
    let side = 0;
    let turn = 0;
    let fire = 0;
    let use = 0;
    let run = 0;
    const moved = this.last.length < 4 ? 64 : Math.hypot(me.X - this.last[0][0], me.Y - this.last[0][1]);
    if (target) {
      // face it, 0.25 rad a call at most; shoot within 6°; close in, or back off when hurt
      const diff = towards(target.X, target.Y);
      turn = Math.max(-0.25, Math.min(0.25, diff));
      fire = Math.abs(diff) < 0.1 ? 1 : 0;
      fwd = me.HEALTH < 50 ? -1 : target.D > 400 * 400 && open.ahead ? 1 : 0;
      side = this.rnd() < 0.3 ? (this.rnd() < 0.5 ? 1 : -1) : 0;
      this.turning = 0;
      this.blocked = 0;
    } else if (me.DAMAGE_COUNT > 0 && me.AX != null) {
      // hurt by something out of sight: turn towards it, still moving
      turn = Math.max(-0.3, Math.min(0.3, towards(me.AX, me.AY)));
      fwd = open.ahead ? 1 : 0;
    } else if (this.turning > 0) {
      turn = 0.3 * this.turnDir;
      this.turning--;
      if (open.ahead && this.turning < 2) this.turning = 0;
    } else if (!open.ahead) {
      // a wall or a door: use (a door opens), and after a moment turn to where it's open
      this.blocked++;
      use = this.blocked % 2 ? 1 : 0;
      fwd = 1;
      if (this.blocked > 5) {
        this.turnDir = open.left && !open.right ? 1 : open.right && !open.left ? -1 : this.rnd() < 0.5 ? 1 : -1;
        this.turning = 2 + Math.floor(this.rnd() * 4);
        this.blocked = 0;
      }
    } else {
      // the open: run on, drifting a little, and turn away from a wall
      // that's near on one side; stuck anyway (a ledge): use, then turn
      fwd = 1;
      run = 1;
      this.blocked = 0;
      turn = (this.rnd() - 0.5) * 0.08 + (!open.left && open.right ? -0.12 : !open.right && open.left ? 0.12 : 0);
      if (moved < 8) {
        this.stuck++;
        use = this.stuck % 2 ? 1 : 0;
        if (this.stuck > 3) {
          this.turnDir = this.rnd() < 0.5 ? 1 : -1;
          this.turning = 3 + Math.floor(this.rnd() * 4);
          this.stuck = 0;
        }
      } else this.stuck = 0;
    }
    this.last.push([me.X, me.Y]);
    if (this.last.length > 4) this.last.shift();
    return [tics, fwd, side, turn, fire, use, 0, run];
  }
}

/** Record one demo: MAP for TICS tics from SEED; returns { demo (with its checksum), stats }. */
export async function record(db, wad, res, label, map, tics, seed) {
  await loadMap(db, wad, res, map, { skill: SKILL, newGame: true, seed });
  const bot = new Bot(db, seed);
  const calls = [];
  for (let t = 0; t < tics; t += TICS_PER_CALL) {
    const c = await bot.next(TICS_PER_CALL);
    calls.push(c);
    // (the same call the page makes, parameters and all: what's recorded is what replays)
    const hud = (await db.query('SELECT * FROM doom_tic(?, ?, ?, ?, ?, ?, ?, ?)', c)).rows[0];
    if (hud.EXIT_KIND) break;   // (an exit, or a death's restart: the demo ends here)
  }
  const csum = (await db.query('SELECT csum FROM net_checksum')).rows[0].CSUM;
  const end = (await db.query('SELECT p.kills, p.dead, t.x, t.y, (SELECT m.x FROM map_things m WHERE m.ttype = 1) sx, (SELECT m.y FROM map_things m WHERE m.ttype = 1) sy FROM player p JOIN things t ON t.id = p.thing_id')).rows[0];
  const stats = { kills: end.KILLS, dead: end.DEAD, shots: calls.filter((c) => c[4] === 1).length, away: Math.round(Math.hypot(end.X - end.SX, end.Y - end.SY)) };
  return { demo: { version: DEMO_VERSION, wad: `${label}|${wad.mapNames().length}`, map, skill: SKILL, seed, date: new Date().toISOString(), calls, checksum: csum }, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [label, list] of Object.entries(ATTRACT)) {
    const file = path.join(root, 'public/wads', label);
    if (!fs.existsSync(file)) { console.log(`(no ${label})`); continue; }
    const db = new FirebirdBrowser(`memory://attract-${label}`, { transport: new DirectTransport() });
    await createSchema(db, sql);
    const wad = new Wad(fs.readFileSync(file));
    const res = await loadResources(db, wad);
    for (const [i, [map, tics, seed]] of list.entries()) {
      // a few seeds, the liveliest run kept: alive, with kills, having gone somewhere
      let best = null;
      for (let k = 0; k < 6; k++) {
        const r = await record(db, wad, res, label, map, tics, seed + k);
        r.score = (r.stats.dead ? -1000 : 0) + r.stats.kills * 100 + Math.min(r.stats.away, 800) / 4 + r.demo.calls.length * TICS_PER_CALL / 20;
        if (!best || r.score > best.score) best = r;
        if (!r.stats.dead && r.stats.kills >= 2 && r.stats.away >= 400) break;
      }
      const { demo, stats } = best;
      const out = path.join(outDir, attractDemoFile(label, i + 1));
      fs.writeFileSync(out, JSON.stringify(demo));
      console.log(`${path.relative(root, out)}: ${map} from seed ${demo.seed}, ${demo.calls.length * TICS_PER_CALL} tics, ${stats.kills} kills, ${stats.shots} shots, ${stats.away} units from the start${stats.dead ? ', DEAD' : ''}, checksum ${demo.checksum}`);
    }
    await db.close();
  }
}
