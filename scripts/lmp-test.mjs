// lmp-test.mjs – DOOM's .lmp demos (src/lmp.js), and how long the port keeps step with
// vanilla on them (docs/ROADMAP.md, "Original .lmp demos").
//
// The format: v1.9 headers and ticcmds written and read back, angleturn's high byte as
// G_WriteDemoTiccmd rounds it, a v1.2 header, Chocolate Doom's longtics, the 0x80 end.
//
// The sync: each demo in scripts/fixtures/lmp plays in the port against vanilla's trace of it
// (npm run lmp-fixtures, from the oracle). It isn't in sync yet; this is a ratchet: for every
// demo and every field compared, the first tic the port differs mustn't come earlier than
// scripts/fixtures/lmp/baseline.json says. When a change brings the port closer, the test says
// so: `npm run test:lmp -- --update` writes the new baseline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseLmp, writeLmp, portCmd, lmpMapName, lmpProblem, LmpPlayer, BT_ATTACK, BT_USE, BT_CHANGE } from '../src/lmp.js';
import { wadFromEnv } from './wad-arg.mjs';
import { FIELDS, parseTrace, playAgainst, startDemo, restartDemo, nextDemoMap, exitPwad, EXIT_PWADS, parseMobjs, portThinkers, compareThinkers } from './lmp-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── the format ──
{
  const demo = { skill: 4, episode: 2, map: 3, deathmatch: 0, respawn: 1, fast: 1, nomonsters: 0, consoleplayer: 0,
    players: [true, false, false, false], tics: [[[25, -10, -640, BT_ATTACK]], [[-127, 127, 32767, BT_USE | BT_CHANGE | (3 << 3)]], [[0, 0, 0, 0]]] };
  const b = writeLmp(demo);
  const back = parseLmp(b);
  assert(b.length === 13 + 3 * 4 + 1 && b[0] === 109 && b[1] === 3 && b.at(-1) === 0x80
    && back.skill === 4 && back.episode === 2 && back.map === 3 && back.respawn === 1 && back.fast === 1 && back.tics.length === 3,
    `a v1.9 demo: a 13-byte header (version 109, skill ${b[1]} for the menu's ${demo.skill}), 4 bytes a tic, 0x80 at the end`);
  // G_WriteDemoTiccmd keeps (angleturn + 128) >> 8: -640 goes as -512, 32767 as -32768 (it wraps)
  assert(JSON.stringify(back.tics.map((t) => t[0])) === JSON.stringify([[25, -10, -512, 1], [-127, 127, -32768, 2 | 4 | 24], [0, 0, 0, 0]]),
    `ticcmds read back as G_ReadDemoTiccmd reads them: ${JSON.stringify(back.tics.map((t) => t[0]))}`);
  const old = parseLmp(Uint8Array.from([2, 1, 5, 1, 0, 0, 0, 10, 0, 0, 0, 0x80]));
  assert(old.version === 0 && old.skill === 3 && old.episode === 1 && old.map === 5 && old.tics.length === 1 && old.tics[0][0][0] === 10,
    'a v1.2 demo (no version byte): skill 3, E1M5, one tic');
  const long = parseLmp(writeLmp({ ...demo, longtics: true }));
  assert(long.version === 111 && long.tics[0][0][2] === -640, `Chocolate Doom's longtics (version 111): angleturn whole (${long.tics[0][0][2]})`);
  const [fwd, side, turn, fire, use, weapon] = portCmd([50, -25, 16384, BT_ATTACK | BT_CHANGE | (8 << 3)]);
  assert(fwd === 2 && side === -1 && Math.abs(turn - Math.PI / 2) < 1e-12 && fire === 1 && use === 0 && weapon === 1
    && lmpMapName({ episode: 1, map: 9 }, false) === 'E1M9' && lmpMapName({ map: 7 }, true) === 'MAP07',
    'as the port\'s ticcmd: forwardmove 50 is a run (2 × 25), angleturn 16384 a quarter turn; E1M9, MAP07');
  let threw = '';
  try { parseLmp(Uint8Array.from([200, 0, 1, 1])); } catch (e) { threw = e.message; }
  assert(/not a demo|version/.test(threw), `not a demo is refused ("${threw}")`);
}

// ── the sync, against vanilla's traces ──
const dir = path.join(root, 'scripts/fixtures/lmp');
const basePath = path.join(dir, 'baseline.json');
const update = process.argv.includes('--update');
const baseline = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath, 'utf8')) : {};
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://lmp', { transport: new DirectTransport({ threads: false }) });
await createSchema(db, sql);
const wads = new Map();
const results = {};
let better = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.lmp')).sort()) {
  const name = file.replace(/\.lmp$/, '');
  const demo = parseLmp(fs.readFileSync(path.join(dir, file)));
  const trace = parseTrace(fs.readFileSync(path.join(dir, `${name}.trace`), 'utf8'));
  const wadFile = name.startsWith('map') ? 'freedoom2.wad' : 'freedoom1.wad';
  if (!wads.has(wadFile)) {
    const wad = new Wad(fs.readFileSync(path.join(root, 'public/wads', wadFile)));
    wads.set(wadFile, { wad, res: null });
  }
  // (some on a PWAD over the IWAD: its map with an exit where the demo walks – EXIT_PWADS)
  const pw = EXIT_PWADS[name];
  const w = pw ? { wad: new Wad(wads.get(wadFile).wad.files[0].bytes, exitPwad(wads.get(wadFile).wad, pw[1], pw[2], pw[3])) } : wads.get(wadFile);
  w.res = await loadResources(db, w.wad);   // (each WAD's resources again: they share one database)
  await startDemo(db, w.wad, w.res, demo, loadMap);
  const r = await playAgainst(db, demo, trace, { restart: () => restartDemo(db, w.wad, w.res, demo, loadMap),
    worldDone: (secret) => nextDemoMap(db, w.wad, w.res, demo, loadMap, secret) });
  const firsts = Object.fromEntries(FIELDS.map((f) => [f, r.first[f]?.tic ?? null]));
  results[name] = { tics: r.tics, synced: r.synced, unplayed: r.unplayed, first: firsts, map: (await db.query('SELECT map_name FROM game WHERE id = 1')).rows[0].MAP_NAME.trim() };
  const was = baseline[name];
  const worse = [];
  const gained = [];
  if (was) {
    if (r.synced < was.synced) worse.push(`in step ${r.synced} tics, was ${was.synced}`);
    if (r.synced > was.synced) gained.push(`in step ${r.synced} tics, was ${was.synced}`);
    for (const f of FIELDS) {
      const a = firsts[f] ?? Infinity;
      const b = was.first[f] ?? Infinity;
      if (a < b) worse.push(`${f} now differs at tic ${a}${b === Infinity ? '' : `, was ${b}`} (port ${r.first[f].port}, vanilla ${r.first[f].vanilla})`);
      if (a > b) gained.push(`${f} ${a === Infinity ? 'agrees throughout' : `differs from tic ${a}`}, was ${b}`);
    }
  }
  if (gained.length) better++;
  const where = FIELDS.filter((f) => r.first[f]).map((f) => `${f}@${r.first[f].tic}`).join(' ');
  assert(update || (was && worse.length === 0),
    `${name} (${lmpMapName(demo, wadFile === 'freedoom2.wad')}, ${r.tics} tics): the player in step for ${r.synced}; first differences ${where || 'none'}`
    + `${!was && !update ? ' – no baseline yet (npm run test:lmp -- --update)' : ''}${worse.length ? `; worse than the baseline: ${worse.join('; ')}` : ''}${gained.length ? `; closer than the baseline: ${gained.join('; ')}` : ''}`);
}
// phase L3: the map as DOOM spawns it, and the thinkers in its order – every thinker one by one
// (NAME.mobjs: the oracle's list at a few leveltimes) in the same order, each mobj with the same
// position, angle, health, state and tics left – the shot's puff and blood too (phase L5)
const ALLOWED = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mobjs')).sort()) {
  const name = file.replace(/\.mobjs$/, '');
  const demo = parseLmp(fs.readFileSync(path.join(dir, `${name}.lmp`)));
  const van = parseMobjs(fs.readFileSync(path.join(dir, file), 'utf8'));
  const wadFile = name.startsWith('map') ? 'freedoom2.wad' : 'freedoom1.wad';
  const w = wads.get(wadFile);
  w.res = await loadResources(db, w.wad);
  await startDemo(db, w.wad, w.res, demo, loadMap);
  const tics = [...van.keys()].sort((a, b) => a - b);
  const bad = [];
  const seen = [];
  let done = 0;
  for (const t of tics) {
    for (; done < t; done++) {
      const [fwd, side, turn, fire, use, weapon, run] = portCmd(demo.tics[done][0]);
      await db.query('SELECT * FROM doom_tic(1, ?, ?, ?, ?, ?, ?, ?)', [fwd, side, turn, fire, use, weapon, run]);
    }
    const c = compareThinkers(van.get(t), await portThinkers(db));
    seen.push(`${t}: ${c.count[1]} thinkers`);
    if (c.order) bad.push(`at ${t} the order differs at ${c.order.at}: port ${c.order.port}, vanilla ${c.order.vanilla}`);
    for (const [f, l] of Object.entries(c.fields)) {
      const off = l.filter((d) => !ALLOWED[name]?.(f, d));
      if (off.length) bad.push(`at ${t} ${f} differs for ${off.length} (${off.slice(0, 3).map((d) => `#${d[0]} ${d[3]}: port ${d[1]}, vanilla ${d[2]}`).join('; ')})`);
    }
  }
  assert(bad.length === 0, `${name}, thinker by thinker against vanilla's list (${seen.join(', ')}): ${bad.length ? bad.slice(0, 4).join('; ') : 'the same order, and every mobj where it is, as it is'}`);
}

// phase L4: the monsters' sight and walk – zombiemen see the player come into view and chase,
// and every column of the trace agrees with vanilla's to the end
{
  const w = results['e1m1-wake'];
  const off = w ? FIELDS.filter((f) => w.first[f] !== null) : ['no e1m1-wake'];
  assert(w && off.length === 0, `the monsters in fixed point: on e1m1-wake they wake, chase and stay in step with vanilla for all ${w?.tics} tics${off.length ? ` (but ${off.join(', ')})` : ''}`);
}

// phase L5: the attacks – hitscan (P_AimLineAttack, P_LineAttack, puffs and blood), P_DamageMobj's
// thrust and pain, a monster thrown back in its own turn, the player killed, turned to the killer
// and the level restarted; the missiles (P_SpawnMissile, their flight through P_TryMove and
// PIT_CheckThing), the lost souls' charge, a barrel's blast, pickups as a move touches them: the
// scripted shots, the barrel and the title demos agree in every column to the end.
for (const name of ['e1m1-shoot', 'e1m1-walk', 'e1m2-barrel', 'e1m1-attract', 'e1m2-attract', 'map01-attract', 'map02-attract', 'map03-attract', 'map04-attract']) {
  const w = results[name];
  const off = w ? FIELDS.filter((f) => w.first[f] !== null) : [`no ${name}`];
  assert(w && off.length === 0, `the attacks in fixed point: ${name} stays in step with vanilla in every column for all ${w?.tics} tics${off.length ? ` (but ${off.join(', ')})` : ''}`);
}

// phase L6: the world – doors, lifts, floors and crushers as DOOM's thinkers move them (T_MovePlane,
// P_ChangeSector over the sector's blocks: a door closing on someone goes back up, what rides a lift
// rides it, a corpse is crunched), the blocks' things in DOOM's order (blocklinks: the newest moved
// first), sector specials, deaths and restarts: ten bot walks of 2100 tics, each in step to the end
for (const name of ['e1m3-attract', 'e1m1-bot', 'e1m2-bot', 'e1m3-bot', 'e1m4-bot', 'e1m5-bot', 'map01-bot', 'map02-bot', 'map03-bot', 'map04-bot', 'map05-bot']) {
  const w = results[name];
  const off = w ? FIELDS.filter((f) => w.first[f] !== null) : [`no ${name}`];
  assert(w && off.length === 0, `the world in step: ${name} agrees with vanilla in every column for all ${w?.tics} tics${off.length ? ` (but ${off.join(', ')})` : ''}`);
}

// phase L6: through a level's end – an exit walked over (a PWAD of Freedoom's map: EXIT_PWADS), the
// intermission's tics as WI_Ticker spends them (fire pressed hurries it on, the press and not the
// hold), the next level loaded as G_DoWorldDone loads it, the player carried over: in step to the end
for (const [name, next] of [['e1m1-exit', 'E1M2'], ['map01-exit', 'MAP02']]) {
  const w = results[name];
  const off = w ? FIELDS.filter((f) => w.first[f] !== null) : [`no ${name}`];
  assert(w && off.length === 0 && w.map === next && w.unplayed === 0,
    `through the level's end: ${name} plays on to ${w?.map} and agrees with vanilla in every column for all ${w?.tics} tics, every line of vanilla's trace (${w?.unplayed} left over)${off.length ? ` (but ${off.join(', ')})` : ''}`);
}

// phase L2: the scripted walk (turns, runs, strafes, a wall) keeps the player in step all the way
assert(results['e1m1-walk']?.synced === results['e1m1-walk']?.tics,
  `the player in fixed point: the scripted walk on E1M1 stays in step with vanilla for all ${results['e1m1-walk']?.tics} tics (${results['e1m1-walk']?.synced})`);

// ── DOOM's fixed point in SQL (m_fixed.c, tables.c, p_maputl.c, r_main.c), and the BLOCKMAP ──
{
  const v = async (expr) => Number((await db.query(`SELECT ${expr} AS v FROM rdb$database`)).rows[0].V);
  const U = 65536;
  const fx = [await v('fx_mul(-1, 1)'), await v(`fx_mul(${51200}, fine_cosine(0))`), await v(`fx_mul(${51199}, ${0xe800})`),
    await v(`fx_div(${U}, ${3 * U})`), await v(`fx_div(${-5 * U}, 0)`), await v(`fx_div(${200 * U}, 1)`), await v('fx32(2147483648)')];
  assert(JSON.stringify(fx) === JSON.stringify([-1, 51199, 46399, 21845, -2147483648, 2147483647, -2147483648]),
    `FixedMul rounds down (-1 × 1/65536 → ${fx[0]}); a walk's first thrust and friction, 51200 × finecosine[0] → ${fx[1]}, × FRICTION → ${fx[2]} (vanilla's 46399); FixedDiv ${fx[3]}, and past its range the largest of its sign (${fx[4]}, ${fx[5]}); a 32-bit wrap (${fx[6]})`);
  const ang = [await v(`point_to_angle2(0, 0, ${U}, 0)`), await v(`point_to_angle2(0, 0, ${U}, ${U})`), await v(`point_to_angle2(0, 0, 0, ${U})`),
    await v(`point_to_angle2(0, 0, ${-U}, 0)`), await v(`point_to_angle2(0, 0, 0, ${-U})`), await v(`point_to_angle2(${U}, ${U}, ${U}, ${U})`)];
  assert(JSON.stringify(ang) === JSON.stringify([0, 0x1fffffff, 0x3fffffff, 0x7fffffff, 0xc0000000, 0]),
    `R_PointToAngle2 by octant and tantoangle: east 0, north-east 0x1fffffff, north 0x3fffffff, west 0x7fffffff, south 0xc0000000, a point to itself 0 (${ang.map((a) => `0x${a.toString(16)}`).join(' ')})`);
  // a line from (0, 0) to (64, 64): what's left of it is behind (1); a box across it straddles (-1)
  const side = [await v(`point_on_line_side(0, ${10 * U}, 0, 0, ${64 * U}, ${64 * U})`), await v(`point_on_line_side(${10 * U}, 0, 0, 0, ${64 * U}, ${64 * U})`),
    await v(`box_on_line_side(${40 * U}, ${20 * U}, ${20 * U}, ${40 * U}, 0, 0, ${64 * U}, ${64 * U}, 2)`), await v(`point_on_divline_side(0, ${10 * U}, 0, 0, ${64 * U}, ${64 * U})`),
    await v(`intercept_vector(0, ${32 * U}, ${64 * U}, 0, 0, 0, ${64 * U}, ${64 * U})`), await v(`aprox_distance(${3 * U}, ${4 * U})`)];
  assert(JSON.stringify(side) === JSON.stringify([1, 0, -1, 1, 32768, 5 * U + U / 2]),
    `P_PointOnLineSide (${side[0]}, ${side[1]}), P_BoxOnLineSide (${side[2]}), P_PointOnDivlineSide (${side[3]}), P_InterceptVector (a trace crossing halfway: ${side[4]}), P_AproxDistance (3, 4 → ${side[5] / U})`);
  // every thing's sector by R_PointInSubsector in 16.16 is the one the map loaded it in
  const off = Number((await db.query('SELECT COUNT(*) n FROM things t WHERE t.sector_id IS DISTINCT FROM sector_at_fx(fx_of(t.x), fx_of(t.y))')).rows[0].N);
  const bm = (await db.query("SELECT (SELECT COUNT(*) FROM blockmap) n, (SELECT COUNT(*) FROM blockmap WHERE seq = 0 AND line_id = 0) z, b.w * b.h cells FROM blockmap_info b")).rows[0];
  assert(off === 0 && Number(bm.Z) === Number(bm.CELLS) && Number(bm.N) > Number(bm.CELLS),
    `R_PointInSubsector in 16.16 puts every thing where the map did (${off} elsewhere); the BLOCKMAP lump: ${bm.N} entries over ${bm.CELLS} blocks, every list starting with linedef 0 (${bm.Z})`);
}

if (update) {
  fs.writeFileSync(basePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`(wrote ${path.relative(root, basePath)})`);
} else if (better) {
  console.log(`(${better} demo(s) closer to vanilla than the baseline: npm run test:lmp -- --update to keep it)`);
}
// ── phase L7: the page's player (LmpPlayer: the turns main.js takes, as the harness plays them) ──
{
  const demo = parseLmp(fs.readFileSync(path.join(dir, 'e1m1-exit.lmp')));
  const pl = new LmpPlayer(demo, false);
  const tic = pl.take('tic');
  pl.index = 29;
  pl.carry(false, false);
  // (WI_checkForAccelerate: the fixture's fire pressed a tic at a time, 46 and 67 tics into the
  // screen – a press each, the tic after none)
  const wi = [];
  for (let i = 0; i < 70; i++) wi.push(pl.take('wi'));
  const presses = wi.filter((c) => c[3] === 1).length;
  pl.index = demo.tics.length - 1;
  const last = pl.take('tic');
  assert(pl.map === 'E1M1' && tic.length === 8 && tic[0] === 1 && tic[1] === 1 && JSON.stringify(pl.take('map')) === 'null' && last && pl.done
    && presses === 2 && wi[46][3] === 1 && wi[47][3] === 0 && wi[67][3] === 1 && pl.take('tic') === null,
    `LmpPlayer: DOOM_TIC's arguments a tic (${JSON.stringify(tic)}), the intermission's presses as WI_checkForAccelerate sees them (${presses} in its first 70 tics), null at the demo's end`);
  const two = { ...demo, players: [true, true, false, false] };
  assert(/2-player/.test(lmpProblem(two) ?? '') && /deathmatch/.test(lmpProblem({ ...demo, deathmatch: 1 }) ?? '') && lmpProblem(demo) === null,
    `the page plays one player's demos: a netgame's is refused ("${lmpProblem(two)}")`);
}

// ── phase L7: a WAD's own demos. WAD=/path/to/doom.wad (id's, never in the repo; PWAD= adds files
// over it, separated by the path delimiter): each DEMOn the WAD has, played against vanilla's trace
// of it – the oracle's, made here (npm run oracle first) – through deaths and level ends, every
// column in step to its end ──
{
  const w = wadFromEnv();
  const extra = (process.env.PWAD ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  const oracle = process.env.ORACLE ?? path.join(root, 'oracle-build/build/src/chocolate-doom');
  if (!w) console.log("(WAD= not set: a WAD's own demos aren't played; WAD=/path/to/doom.wad npm run test:lmp plays id's)");
  else if (!fs.existsSync(oracle)) console.log(`(WAD=${w.name}: no oracle at ${oracle} to make vanilla's traces – npm run oracle first)`);
  else {
    const wad = extra.length ? new Wad(fs.readFileSync(w.path), ...extra.map((p) => fs.readFileSync(p))) : w.wad;
    const res = await loadResources(db, wad);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-home-'));
    let played = 0;
    for (let n = 1; n <= 4; n++) {
      const lump = wad.lump(`DEMO${n}`);
      if (!lump) continue;
      const demo = parseLmp(wad.data(lump));
      const problem = lmpProblem(demo);
      if (problem) { console.log(`(DEMO${n}: ${problem})`); continue; }
      const tracePath = path.join(home, `demo${n}.trace`);
      try {
        execFileSync(oracle, ['-iwad', w.path, ...(extra.length ? ['-file', ...extra] : []), '-timedemo', `DEMO${n}`, '-nodraw', '-nosound', '-nomusic'],
          { env: { ...process.env, HOME: home, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', ORACLE_TRACE: tracePath }, stdio: 'pipe', timeout: 600000 });
      } catch { /* (-timedemo ends with I_Error's report) */ }
      const trace = parseTrace(fs.readFileSync(tracePath, 'utf8'));
      await startDemo(db, wad, res, demo, loadMap);
      const r = await playAgainst(db, demo, trace, { restart: () => restartDemo(db, wad, res, demo, loadMap),
        worldDone: (secret) => nextDemoMap(db, wad, res, demo, loadMap, secret) });
      const off = FIELDS.filter((f) => r.first[f]);
      const map = (await db.query('SELECT map_name FROM game WHERE id = 1')).rows[0].MAP_NAME.trim();
      assert(off.length === 0 && r.unplayed === 0 && r.tics === demo.tics.length,
        `${w.name}${extra.length ? ` + ${extra.map((p) => path.basename(p)).join(' + ')}` : ''}'s DEMO${n} (${lmpMapName(demo, w.doom2)}, skill ${demo.skill}, version ${demo.version}): ${r.tics} of ${demo.tics.length} tics, ending on ${map}, `
        + (off.length ? `out of step: ${off.map((f) => `${f} at tic ${r.first[f].tic} (port ${r.first[f].port}, vanilla ${r.first[f].vanilla})`).slice(0, 4).join('; ')}` : 'in step with vanilla in every column')
        + (r.unplayed ? `; ${r.unplayed} lines of vanilla's trace left over` : ''));
      played++;
    }
    if (!played) console.log(`(WAD=${w.name}: no demo lumps to play)`);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

await db.close();
console.log(failures ? `${failures} failure(s)` : 'lmp ok');
process.exit(failures ? 1 : 0);
