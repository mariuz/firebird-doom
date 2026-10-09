// coop-browser-test.mjs – co-op in two real pages over a real WebRTC link, in
// headless Chromium: the host's invite and the guest's reply swapped through
// the Co-op panel, Start, both browsers in the same game (each through its
// own player's eyes), the guest's keys moving the guest on both screens, the
// consistency checks agreeing for hundreds of tics, and the host told when
// the guest leaves. Then a deathmatch: the mode and timer from the panel,
// the players at deathmatch starts with every key, a frag in both games.
//
//   npm run test:coop
//
// Like browser-test.mjs it serves dist/ itself. The two pages are separate
// browser contexts, as two players' browsers would be; ICE finds them on this
// machine (mDNS names off, so the host candidates are plain addresses).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const server = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--serve'], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('serving')) resolve(); });
  server.on('exit', (code) => reject(new Error(`the server exited (${code})`)));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const errors = [];
try {
  const open = async (who) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.setDefaultTimeout(120000);
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.doom?.title, null, { timeout: 120000, polling: 100 });
    await page.evaluate(() => { document.getElementById('net').open = true; });
    return page;
  };
  const [host, guest] = [await open('host'), await open('guest')];
  const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const value = (page, id) => page.evaluate((i) => document.getElementById(i).value, id);
  const status = (page) => page.evaluate(() => document.getElementById('net-status').textContent);

  // the handshake: invite → reply → connect
  await host.click('#net-host');
  await until(host, () => document.getElementById('net-out').value.length > 50);
  const invite = await value(host, 'net-out');
  await guest.click('#net-join');
  await guest.fill('#net-in', invite);
  await guest.click('#net-connect');
  await until(guest, () => document.getElementById('net-out').value.length > 50);
  const reply = await value(guest, 'net-out');
  assert(invite !== reply && /^[A-Za-z0-9+/=]+$/.test(invite + reply), `the invite and the reply are codes to copy and paste (${invite.length} and ${reply.length} characters)`);
  await host.fill('#net-in', reply);
  await host.click('#net-connect');
  await until(host, () => /^2 players/.test(document.getElementById('net-status').textContent), null, 30000);
  await until(guest, () => /^Connected/.test(document.getElementById('net-status').textContent), null, 30000);
  assert(true, `connected: the host says "${(await status(host)).slice(0, 40)}…", the guest "${(await status(guest)).slice(0, 40)}…"`);

  // Start: both into the host's map, the host player 1 and the guest player 2
  const mapName = await value(host, 'map');
  await host.click('#net-start');
  for (const p of [host, guest]) {
    // (the level is loaded once the melt is over and the netgame's first tics have run)
    await until(p, () => window.doom.net?.tic > 10 && window.doom.screen === 'level' && !window.doom.melting);
  }
  const who = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net)));
  const maps = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.sql('SELECT g.map_name, g.players, v.player_id FROM game g CROSS JOIN viewcfg v').then((r) => r[0]))));
  assert(who[0].me === 1 && who[1].me === 2 && who[0].players === 2 && who[1].players === 2
    && maps.every((m) => m.MAP_NAME.trim() === mapName && m.PLAYERS === 2) && maps[0].PLAYER_ID === 1 && maps[1].PLAYER_ID === 2,
    `Start: both browsers in ${mapName}, two players; the host sees through player 1, the guest through player 2`);

  // the guest walks: player 2 moves on both screens, player 1 doesn't
  const players = (p) => p.evaluate(() => window.doom.sql(
    "SELECT p.id, CAST(t.x AS INTEGER) x, CAST(t.y AS INTEGER) y FROM player p JOIN things t ON t.id = p.thing_id ORDER BY p.id"));
  /**
   * The guest holds W until player 2 has gone FAR units on the host's screen; if
   * that gets nowhere in 4 s (a wall ahead: E1M2's starts face one), S. How far it went.
   */
  const walk = async (far = 64) => {
    const from = (await players(host))[1];
    let moved = 0;
    for (const key of ['KeyW', 'KeyS']) {
      await guest.keyboard.down(key);
      for (let i = 0; i < (key === 'KeyW' ? 20 : 150) && moved <= far; i++) {
        await guest.waitForTimeout(200);
        const at = (await players(host))[1];
        moved = Math.hypot(at.X - from.X, at.Y - from.Y);
      }
      await guest.keyboard.up(key);
      if (moved > far) break;
    }
    return moved;
  };
  /**
   * The two games at the same tic: the next consistency checksum both pages have
   * made (every 35 tics) after now. (Reading the tables live would catch the
   * two at different tics: the lockstep lets one run a few tics ahead.)
   */
  const agree = async () => {
    const after = Math.max(...await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net.tic))));
    const common = (sums) => Object.keys(sums[0]).map(Number).filter((t) => t > after && t in sums[1]);
    for (let i = 0; i < 300; i++) {
      const sums = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net.sums)));
      const tics = common(sums);
      if (tics.length) return { tic: tics[0], same: sums[0][tics[0]] === sums[1][tics[0]] };
      await host.waitForTimeout(100);
    }
    return { tic: null, same: false };
  };
  const before = await players(host);
  await guest.click('#screen', { position: { x: 300, y: 200 } }).catch(() => {});
  const moved = await walk();
  const a = await players(host);
  assert(moved > 64 && a[0].X === before[0].X && a[0].Y === before[0].Y,
    `the guest's W moves player 2 on the host's screen (${moved.toFixed(0)} units), and not player 1`);
  const same = await agree();
  assert(same.same, `…and both browsers' games are the same at tic ${same.tic} (their checksums)`);

  // a while longer, both firing: the checksums every 35 tics still agree
  const tics = async () => Math.min(...await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net.tic))));
  const firing = await tics();
  await host.keyboard.down('ControlLeft');
  await guest.keyboard.down('ControlLeft');
  for (let i = 0; i < 600 && (await tics()) < firing + 175; i++) await host.waitForTimeout(100);   // (5 s of game, however slow the machine)
  await host.keyboard.up('ControlLeft');
  await guest.keyboard.up('ControlLeft');
  const nets = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net)));
  assert(nets.every((n) => !n.error) && Math.min(nets[0].tic, nets[1].tic) >= firing + 175,
    `${Math.min(nets[0].tic, nets[1].tic)} tics in lockstep, the last 175 both firing, and every consistency check agrees`);

  // a level exit: everyone to the intermission, then on to the next map together. (The
  // nearest line ahead of player 1 becomes a W1 exit on both pages, before anyone reaches it:
  // a change to the map that's the same in both games.)
  const line = await host.evaluate(async () => {
    const [p] = await window.doom.sql('SELECT t.x, t.y, t.angle FROM player p JOIN things t ON t.id = p.thing_id WHERE p.id = 1');
    const lines = await window.doom.sql('SELECT l.id, l.back_side, a.x x1, a.y y1, b.x x2, b.y y2 FROM linedefs l JOIN vertexes a ON a.id = l.v1 JOIN vertexes b ON b.id = l.v2');
    const dx = Math.cos(p.ANGLE), dy = Math.sin(p.ANGLE);
    let best = null;
    for (const l of lines) {
      const ex = l.X2 - l.X1, ey = l.Y2 - l.Y1, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((l.X1 - p.X) * ey - (l.Y1 - p.Y) * ex) / den;
      const u = ((l.X1 - p.X) * dy - (l.Y1 - p.Y) * dx) / den;
      if (t > 20 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { id: l.ID, t, two: l.BACK_SIDE != null };
    }
    return best;
  });
  assert(line?.two, `the nearest line ahead of player 1 is line ${line?.id}, ${Math.round(line?.t)} units off, and passable`);
  for (const p of [host, guest]) await p.evaluate((id) => window.doom.sql(`UPDATE linedefs SET special = 52 WHERE id = ${id}`), line.id);
  await host.keyboard.down('KeyW');
  for (const p of [host, guest]) await until(p, () => window.doom.screen === 'intermission', null, 30000);
  await host.keyboard.up('KeyW');
  assert(true, 'player 1 crosses the exit: both browsers go to the intermission');
  // each player hurries their own intermission along; the game waits for both
  const through = async (p) => {
    for (let i = 0; i < 60 && !(await p.evaluate(() => window.doom.screen === 'level' && !window.doom.melting)); i++) {
      await p.keyboard.press('Space');
      await p.waitForTimeout(400);
    }
  };
  await Promise.all([through(host), through(guest)]);
  // (SCREEN reads 'level' while the next map is still loading: wait for E1M2 in the
  // tables with both players, and the melt over)
  const onE1M2 = (p) => p.evaluate(async () => !window.doom.melting && window.doom.screen === 'level'
    && (await window.doom.sql("SELECT g.map_name, (SELECT COUNT(*) FROM player p JOIN things t ON t.id = p.thing_id) n FROM game g")
      .then((r) => r[0].MAP_NAME.trim() === 'E1M2' && r[0].N === 2)));
  for (const p of [host, guest]) {
    for (let i = 0; i < 600 && !(await onE1M2(p)); i++) await p.waitForTimeout(100);
  }
  const t1 = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net.tic)));
  const moved2 = await walk(8);   // (E1M2's player 2 start is a tight spot)
  const later = await agree();
  const next = await Promise.all([host, guest].map((p) => p.evaluate(async () => ({
    net: window.doom.net, map: (await window.doom.sql('SELECT map_name FROM game'))[0].MAP_NAME.trim(),
    players: (await window.doom.sql('SELECT COUNT(*) n FROM player'))[0].N,
  }))));
  assert(next.every((n) => n.map === 'E1M2' && n.players === 2 && !n.net.error && n.net.tic > Math.max(...t1)) && moved2 > 8 && later.same,
    `…and both go on to ${next[0].map} together: two players, player 2 walks (${moved2.toFixed(0)} units), the games agree at tic ${later.tic}`);

  // the guest leaves: the host's game stops and says why
  await guest.evaluate(() => document.getElementById('net-leave').click());   // (the page reflows as it plays: no pointer)
  await until(host, () => window.doom.net?.error, null, 30000);
  assert(/player 2 left/.test((await host.evaluate(() => window.doom.net.error))), `the guest leaves: the host's game stops ("${await host.evaluate(() => window.doom.net.error)}")`);

  // again, as a deathmatch with a timer: the host's choice reaches the guest
  await host.evaluate(() => document.getElementById('net-leave').click());
  await host.evaluate(() => document.getElementById('net-host').click());
  await until(host, () => document.getElementById('net-out').value.length > 50);
  await guest.evaluate(() => document.getElementById('net-join').click());
  await guest.fill('#net-in', await value(host, 'net-out'));
  await guest.evaluate(() => document.getElementById('net-connect').click());
  await until(guest, () => document.getElementById('net-out').value.length > 50);
  await host.fill('#net-in', await value(guest, 'net-out'));
  await host.evaluate(() => document.getElementById('net-connect').click());
  await until(host, () => /^2 players/.test(document.getElementById('net-status').textContent), null, 30000);
  await host.selectOption('#net-mode', '1');
  await host.fill('#net-timer', '5');
  await host.evaluate(() => document.getElementById('net-start').click());
  for (const p of [host, guest]) {
    await until(p, () => window.doom.net?.tic > 10 && window.doom.screen === 'level' && !window.doom.melting);
  }
  const dm = await Promise.all([host, guest].map((p) => p.evaluate(async () => ({
    net: window.doom.net,
    game: (await window.doom.sql('SELECT deathmatch, time_limit, map_name FROM game'))[0],
    players: await window.doom.sql('SELECT p.id, p.keycards, t.x, t.y FROM player p JOIN things t ON t.id = p.thing_id ORDER BY p.id'),
    starts: await window.doom.sql('SELECT x, y FROM map_things WHERE ttype = 11'),
    mode: document.getElementById('net-mode').value, timer: document.getElementById('net-timer').value,
  }))));
  const onStart = (d) => d.players.every((p) => d.starts.some((s) => s.X === p.X && s.Y === p.Y));
  assert(dm.every((d) => d.net.deathmatch === 1 && d.net.timer === 5 && d.game.DEATHMATCH === 1 && d.game.TIME_LIMIT === 5 && d.mode === '1' && d.timer === '5'
    && onStart(d) && d.players.every((p) => p.KEYCARDS === 7)) && JSON.stringify(dm[0].players) === JSON.stringify(dm[1].players),
    `a deathmatch with a 5-minute timer: both pages in it, the players on deathmatch starts with every key (${JSON.stringify(dm[0].players.map((p) => [p.X, p.Y]))})`);
  // the guest kills the host: a frag for player 2, on both status bars' numbers
  await guest.evaluate(() => window.doom.sql('EXECUTE PROCEDURE damage_player(1000, (SELECT thing_id FROM player WHERE id = 2), 1)'));
  await host.evaluate(() => window.doom.sql('EXECUTE PROCEDURE damage_player(1000, (SELECT thing_id FROM player WHERE id = 2), 1)'));
  await host.waitForTimeout(1500);
  const fr = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.sql('SELECT killer, victim, n FROM frags WHERE n > 0'))));
  assert(fr.every((f) => f.length === 1 && f[0].KILLER === 2 && f[0].VICTIM === 1 && f[0].N === 1),
    `player 2 kills player 1: frags[2][1] = 1 in both games`);
  await guest.evaluate(() => document.getElementById('net-leave').click());
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  server.kill();
}
assert(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('co-op ok');
