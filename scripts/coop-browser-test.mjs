// coop-browser-test.mjs – co-op in two real pages over a real WebRTC link, in
// headless Chromium: the host's invite and the guest's reply swapped through
// the Co-op panel, Start, both browsers in the same game (each through its
// own player's eyes), the guest's keys moving the guest on both screens, the
// consistency checks agreeing for hundreds of tics, and the host told when
// the guest leaves.
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
  const before = await players(host);
  await guest.click('#screen', { position: { x: 300, y: 200 } }).catch(() => {});
  await guest.keyboard.down('KeyW');
  await guest.waitForTimeout(1500);
  await guest.keyboard.up('KeyW');
  await guest.waitForTimeout(1500);
  const [a, b] = [await players(host), await players(guest)];
  const moved = Math.hypot(a[1].X - before[1].X, a[1].Y - before[1].Y);
  assert(moved > 64 && a[0].X === before[0].X && a[0].Y === before[0].Y,
    `the guest's W moves player 2 on the host's screen (${moved.toFixed(0)} units), and not player 1`);
  assert(JSON.stringify(a) === JSON.stringify(b), `…and both browsers have both players in the same places (${JSON.stringify(b)})`);

  // a while longer, both firing: the checksums every 35 tics still agree
  await host.keyboard.down('ControlLeft');
  await guest.keyboard.down('ControlLeft');
  await host.waitForTimeout(6000);
  await host.keyboard.up('ControlLeft');
  await guest.keyboard.up('ControlLeft');
  const nets = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net)));
  assert(nets.every((n) => !n.error) && Math.min(nets[0].tic, nets[1].tic) > 200,
    `${Math.min(nets[0].tic, nets[1].tic)} tics in lockstep, both firing, and every consistency check agrees`);

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
  for (const p of [host, guest]) await until(p, () => window.doom.net?.tic > 0 && window.doom.screen === 'level' && !window.doom.melting);
  const t1 = await Promise.all([host, guest].map((p) => p.evaluate(() => window.doom.net.tic)));
  await guest.keyboard.down('KeyW');
  await guest.waitForTimeout(1500);
  await guest.keyboard.up('KeyW');
  await guest.waitForTimeout(1500);
  const next = await Promise.all([host, guest].map((p) => p.evaluate(async () => ({
    net: window.doom.net, map: (await window.doom.sql('SELECT map_name FROM game'))[0].MAP_NAME.trim(),
    players: await window.doom.sql('SELECT p.id, CAST(t.x AS INTEGER) x, CAST(t.y AS INTEGER) y FROM player p JOIN things t ON t.id = p.thing_id ORDER BY p.id'),
  }))));
  assert(next.every((n) => n.map === 'E1M2' && !n.net.error && n.net.tic > Math.max(...t1)) && next[0].players.length === 2
    && JSON.stringify(next[0].players) === JSON.stringify(next[1].players),
    `…and both go on to ${next[0].map} together, two players, still in lockstep (tic ${next[0].net.tic}, ${JSON.stringify(next[0].players)})`);

  // the guest leaves: the host's game stops and says why
  await guest.evaluate(() => document.getElementById('net-leave').click());   // (the page reflows as it plays: no pointer)
  await until(host, () => window.doom.net?.error, null, 30000);
  assert(/player 2 left/.test((await host.evaluate(() => window.doom.net.error))), `the guest leaves: the host's game stops ("${await host.evaluate(() => window.doom.net.error)}")`);
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
