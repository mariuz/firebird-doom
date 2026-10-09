// browser-test.mjs – the page itself, in headless Chromium: the hand-offs in
// main.js's frame loop that the headless tests can't reach. Title → menu →
// E1M1 (with the melt), quicksave and quickload, a level exit → the
// intermission → E1M2, the screen size keys, the automap, an ending, End Game → the
// title, and a patch remembered across a reload. Any page error fails it.
//
//   npm run test:browser
//
// It builds and serves dist/ itself (build.mjs --serve, on a free port) and needs
// Playwright's Chromium (npx playwright install chromium; set
// CHROMIUM=/path/to/chrome to use another).
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(120000);
  await page.goto(`http://localhost:${port}/`);
  const doom = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const key = async (k, wait = 150) => { await page.keyboard.press(k); await page.waitForTimeout(wait); };
  const tic = () => doom(() => window.doom.sql('SELECT tic FROM game').then((r) => r[0].TIC));
  const pos = () => doom(() => window.doom.sql("SELECT x, y FROM things WHERE kind = 'player'").then((r) => r[0]));

  // the title loop, then New Game through the menus
  await until(() => window.doom?.title);
  assert(await doom(() => window.doom.screen) === 'title', 'the page opens on the title loop');
  await page.mouse.click(500, 300);
  await key('x');
  assert(await doom(() => window.doom.menu.active), 'a key opens the menu');
  await key('Enter'); await key('Enter'); await key('Enter', 0);
  await until(() => window.doom.melting);
  await until(() => !window.doom.melting && window.doom.screen === 'level');
  const t0 = await tic();
  await page.waitForTimeout(1500);
  const map0 = (await doom(() => window.doom.sql('SELECT map_name FROM game').then((r) => r[0].MAP_NAME))).trim();
  assert(map0 === 'E1M1' && (await tic()) > t0, `New Game: the title melts into ${map0}, and the game ticks`);

  // F6 picks the quicksave slot; walk away; F9 brings the game back
  await key('F6');
  assert(await doom(() => window.doom.menu.current.name) === 'save', 'F6: Save Game, to pick the quicksave slot');
  await key('Enter');
  for (const c of 'BROWSER') await key(c, 30);
  await key('Enter', 1500);
  const saved = await pos();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1200); await page.keyboard.up('KeyW');
  await page.waitForTimeout(800);
  const walked = await pos();
  await key('F9', 300);
  assert(/BROWSER/.test(await doom(() => window.doom.menu.message?.text ?? '')), 'F9 asks to quickload BROWSER');
  await key('y', 0);
  await until(() => window.doom.melting);           // (G_DoLoadLevel: a load melts in)
  await until(() => !window.doom.melting);
  await page.waitForTimeout(300);
  const back = await pos();
  const moved = Math.hypot(walked.X - saved.X, walked.Y - saved.Y);
  const off = Math.hypot(back.X - saved.X, back.Y - saved.Y);
  assert(moved > 32 && off < moved / 2, `…and the player is back (walked ${moved.toFixed(0)} away, ${off.toFixed(0)} from the save after loading)`);

  // the screen size keys
  await key('Minus', 400);
  const small = await doom(() => window.doom.renderer.scaledW);
  await key('Equal', 400);
  assert(small === 288 && await doom(() => window.doom.renderer.scaledW) === 320, `- shrinks the view (${small} wide), = grows it back`);

  // the automap
  await key('Tab', 300);
  assert(await doom(() => window.doom.automap.open), 'Tab opens the automap');
  await key('Tab', 300);

  // a level exit: the intermission, then the next map
  await doom(() => window.doom.sql('UPDATE game SET exit_kind = 1'));
  await until(() => window.doom.screen === 'intermission', null, 30000);
  assert(true, 'a level exit melts into the intermission');
  await until(() => !window.doom.melting);
  for (let i = 0; i < 6 && (await doom(() => window.doom.screen)) === 'intermission'; i++) await key('Space', 600);
  await until(() => window.doom.melting, null, 60000);   // (the next map melts in once it's loaded)
  await until(() => !window.doom.melting);
  const map1 = (await doom(() => window.doom.sql('SELECT map_name FROM game').then((r) => r[0].MAP_NAME))).trim();
  assert(map1 === 'E1M2', `use skips the counting and goes on to ${map1}`);

  // an ending (doom.finale previews E1M8's): it melts in too
  await doom(() => window.doom.finale('E1M8'));
  await until(() => window.doom.melting, null, 10000);
  await until(() => !window.doom.melting);
  assert(await doom(() => window.doom.screen) === 'finale', "E1M8's ending melts in over the level");

  // End Game, from the Options menu: back to the title
  await key('Escape', 300);
  await key('ArrowDown'); await key('Enter');             // Options
  await key('Enter', 300);                                // End Game
  await key('y', 0);
  await until(() => window.doom.screen === 'title', null, 30000);
  assert(true, 'End Game asks, and Y goes back to the title');

  // a .deh patch over the main WAD is remembered across a reload, and forgotten when cleared
  await doom(() => window.doom.useDeh('Patch File for DeHackEd v3.0\n\n[STRINGS]\nGOTARMOR = Browser test armour.\n', 'test.deh'));
  await page.reload();
  await until(() => window.doom?.title);
  const kept = await doom(() => window.doom.files.deh);
  const label = await doom(() => window.doom.sql('SELECT label FROM thing_types WHERE thing_type = 2018').then((r) => r[0].LABEL));
  assert(kept === 'test.deh' && label === 'Browser test armour.', `after a reload the patch is back (${kept}: "${label}")`);
  await page.locator('#pwad-clear').dispatchEvent('click');
  await until(() => window.doom.files.deh === null);
  await page.waitForTimeout(500);
  await page.reload();
  await until(() => window.doom?.title);
  assert(await doom(() => window.doom.files.deh) === null, '…and once cleared, a reload leaves it off');

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (err) {
  console.log(`FAIL ${err.message}`);
  if (errors.length) console.log(`page errors: ${errors.join('; ')}`);
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} failure(s)` : 'browser ok');
process.exit(failures ? 1 : 0);
