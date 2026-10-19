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
// CHROMIUM=/path/to/chrome to use another). BROWSER=firefox or webkit runs it
// in those instead (launch-browser.mjs).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, browserName } from './launch-browser.mjs';
import { MouseInput, moveCommand, mouseRate, MOUSEX_RAD } from '../src/mouse.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

// G_BuildTiccmd's mouse, before the page: DOOM's buttons from the browser's, the
// double click, the strafe, mousey, and the clamp to MAXPLMOVE
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const turnOnly = new MouseInput();
  turnOnly.move(10, 0);
  const t = turnOnly.take(1);
  assert(near(t.turn, -10 * 0.0035) && t.side === 0 && t.forward === 0 && near(mouseRate(5) * MOUSEX_RAD, 0.0035),
    `the mouse's X turns as it always did here (${t.turn.toFixed(4)} rad for 10 pixels at sensitivity 5)`);
  const st = new MouseInput();
  st.button(2, true);                  // (the browser's right button: DOOM's button 2)
  st.move(10, 0);
  const s1 = st.take(1);
  assert(s1.strafe && s1.turn === 0 && near(s1.side, 20 * mouseRate(5)), `button 2 held: the X strafes instead (side += mousex × 2: ${s1.side.toFixed(1)} units)`);
  const fw = new MouseInput();
  fw.button(1, true);                  // (the middle button: DOOM's button 3)
  const f1 = fw.take(1);
  const f2 = fw.take(1, { run: 1 });
  assert(f1.forward === 25 && f2.forward === 50 && !f1.fire, 'button 3 held: forwardmove, 25 walking and 50 running');
  const quick = new MouseInput();
  quick.button(0, true);
  quick.button(0, false);
  assert(quick.take(1).fire && !quick.take(1).fire, 'a click between two frames still fires once');
  const my = new MouseInput();
  my.move(0, -10);
  const off = my.take(1);
  my.move(0, -10);
  const on = my.take(1, { mousey: true });
  assert(off.forward === 0 && near(on.forward, 10 * mouseRate(5)), `the mouse's Y walks only with the option on (${on.forward.toFixed(1)} units for 10 pixels up)`);
  // a double click on button 3 is use (dclicktime > 1 between changes, both within 20 tics)
  const clicks = (gaps) => {
    const m = new MouseInput();
    let uses = 0;
    m.take(30);
    for (const [down, frames] of gaps) {
      m.button(1, down);
      for (let i = 0; i < frames; i++) if (m.take(2).use) uses++;
    }
    return uses;
  };
  const dbl = clicks([[true, 2], [false, 2], [true, 3], [false, 3]]);
  const slow = clicks([[true, 2], [false, 15], [true, 3], [false, 3]]);
  assert(dbl === 1 && slow === 0, `a double click on button 3 uses once (${dbl}); with half a second between, not at all (${slow})`);
  const c1 = moveCommand(50, 0, 0);
  const c2 = moveCommand(10, 0, 0);
  const c3 = moveCommand(100, -100, 0);
  assert(c1.fwd === 1 && c1.run === 1 && c2.fwd === 0.4 && c2.run === 0 && c3.fwd === 1 && c3.side === -1 && c3.run === 1,
    'past walking speed the ticcmd says running, and it all clamps to MAXPLMOVE (50)');
}

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

const browser = await launchBrowser();
/**
 * Go to URL (or reload, with none) and wait for READY. In WebKit on CI the engine has
 * now and then trapped while starting ("Out of bounds memory access"; docs/ROADMAP.md):
 * then the page is reloaded once, as a player would, with a warning. A page that still
 * doesn't get there says where it stopped.
 */
async function load(pg, url, ready) {
  const crashed = () => /memory access|RuntimeError/i.test(document.getElementById('status')?.textContent ?? '');
  const go = async () => {
    await (url ? pg.goto(url) : pg.reload());
    await pg.waitForFunction(`(${ready})() || (${crashed})()`, null, { timeout: 120000, polling: 100 });
    return pg.evaluate(`!!(${ready})()`);
  };
  const status = () => pg.evaluate(() => document.getElementById('status')?.textContent).catch((e) => e.message);
  try {
    if (await go()) return;
    console.log(`WARNING: the page didn't start: its status "${await status()}"; reloading it once`);
    url = null;
    if (await go()) return;
  } catch (err) {
    throw new Error(`${err.message.split('\n')[0]}; the page: "${await status()}"`);
  }
  throw new Error(`the page didn't start, twice: "${await status()}"`);
}
console.log(`(in ${browserName} ${browser.version()})`);
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(120000);
  await page.goto(`http://localhost:${port}/`);
  const doom = (fn, arg) => page.evaluate(fn, arg);
  // (a wait that times out says where the page was)
  const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).catch(async (err) => {
    const at = await page.evaluate(() => ({ screen: window.doom?.screen, melting: window.doom?.melting, settled: window.doom?.settled,
      status: document.getElementById('status')?.textContent })).catch((e) => e.message);
    throw new Error(`${err.message.split('\n')[0]} waiting for ${String(fn).slice(0, 80)}; the page: ${JSON.stringify(at)}`);
  });
  const key = async (k, wait = 150) => { await page.keyboard.press(k); await page.waitForTimeout(wait); };
  // a game key held for a few tics: the frame loop reads which keys are down, as G_BuildTiccmd
  // does, so a press and release with no frame between (Firefox's and WebKit's press()) is missed
  const tap = async (k, wait = 150) => { await page.keyboard.down(k); await page.waitForTimeout(100); await page.keyboard.up(k); await page.waitForTimeout(wait); };
  const tic = () => doom(() => window.doom.sql('SELECT tic FROM game').then((r) => r[0].TIC));
  const pos = () => doom(() => window.doom.sql("SELECT x, y FROM things WHERE kind = 'player'").then((r) => r[0]));
  // N of the game's tics, however long they take (Firefox's frames on a CI runner are slow)
  const waitTics = async (n, read = tic) => { const t = await read(); for (let i = 0; i < 1000 && (await read()) < t + n; i++) await page.waitForTimeout(20); };

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

  // the music: DMX on the emulated OPL2, in its AudioWorklet, heard through the music volume
  const music = await doom(async () => {
    const a = window.doom.audio;
    if (!a.ctx || a.ctx.state !== 'running') return { state: a.ctx?.state ?? 'none' };
    await a.oplReady;
    const an = a.ctx.createAnalyser();
    a.musicGain.connect(an);
    const buf = new Float32Array(2048);
    let sum = 0;
    for (let k = 0; k < 10; k++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) sum += v * v;
    }
    a.musicGain.disconnect(an);
    return { state: a.ctx.state, song: a.currentMusic, worklet: !!a.opl, rms: Math.sqrt(sum / 20480) };
  });
  assert(music.worklet && music.song === 'D_E1M1' && music.rms > 0.003,
    `E1M1's music plays from the OPL2 worklet (${music.song ?? music.state}, level ${music.rms?.toFixed(3)})`);
  // the Synth setting: on the OPL3 the song starts over, in stereo, and still sounds
  await page.selectOption('#synth', 'opl3');
  await page.waitForTimeout(500);
  const music3 = await doom(async () => {
    const a = window.doom.audio;
    if (!a.opl) return { state: a.ctx?.state ?? 'none' };
    const an = a.ctx.createAnalyser();
    a.musicGain.connect(an);
    const buf = new Float32Array(2048);
    let sum = 0;
    for (let k = 0; k < 10; k++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) sum += v * v;
    }
    a.musicGain.disconnect(an);
    return { opl3: a.opl3, channels: a.opl.channelCount, rms: Math.sqrt(sum / 20480), song: a.currentMusic };
  });
  assert(music3.opl3 && music3.rms > 0.003 && music3.song === 'D_E1M1',
    `Synth OPL3: the music plays on from the OPL3 worklet (level ${music3.rms?.toFixed(3) ?? music3.state})`);
  await page.selectOption('#synth', 'opl2');

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
  // (G_DoLoadLevel: a load melts in. Watched from inside the page, every 10 ms: with every
  // test running beside this one, a whole melt has slipped between the test's own looks)
  await doom(() => { window.__melted = false; window.__meltWatch = setInterval(() => { if (window.doom.melting) window.__melted = true; }, 10); });
  await key('y', 0);
  const moved = Math.hypot(walked.X - saved.X, walked.Y - saved.Y);
  let back = walked;
  for (let i = 0; i < 600 && Math.hypot(back.X - saved.X, back.Y - saved.Y) >= moved / 2; i++) {
    await page.waitForTimeout(100);
    back = (await pos()) ?? back;   // (no player for a moment while the save goes back in)
  }
  await until(() => !window.doom.melting);
  const melted = await doom(() => { clearInterval(window.__meltWatch); return window.__melted; });
  const off = Math.hypot(back.X - saved.X, back.Y - saved.Y);
  assert(moved > 32 && off < moved / 2 && melted,
    `…and the player is back, melting in (walked ${moved.toFixed(0)} away, ${off.toFixed(0)} from the save after loading)`);

  // the other function keys (M_Responder): F1 help, F2 save, F3 load, F4 sound, F5 detail, F7 end game, F8 messages, F10 quit, F11 gamma
  if (!process.env.SKIP_FKEYS) {
  await key('F1');
  const f1 = await doom(() => window.doom.menu.page);
  await key('Escape');   // (back to the menu, as DOOM's Read This! does)
  await key('Escape');
  await key('F2');
  const f2 = await doom(() => window.doom.menu.current.name);
  await key('Escape');
  await key('F3');
  const f3 = await doom(() => window.doom.menu.current.name);
  await key('Escape');
  await key('F4');
  const f4 = await doom(() => [window.doom.menu.current.name, window.doom.menu.item.act].join(':'));
  await key('Escape');
  assert(f1 === 'HELP1' && f2 === 'save' && f3 === 'load' && f4 === 'sound:sfx', `F1 ${f1}, F2 ${f2}, F3 ${f3}, F4 ${f4}`);
  await key('F5');
  const f5 = await doom(() => [document.getElementById('detail').value, window.doom.message].join(' / '));
  await key('F5');
  await key('F8');
  const f8 = await doom(() => window.doom.message);
  await key('F8');
  assert(f5 === 'low / Detail: low' && f8 === 'Messages: off' && (await doom(() => document.getElementById('detail').value)) === 'high',
    `F5 toggles the detail (${f5}) and F8 the messages (${f8}), each saying so`);
  await key('F7');
  const f7 = await doom(() => window.doom.menu.message?.text ?? '');
  await key('n');
  await key('F10');
  const f10 = await doom(() => window.doom.menu.message?.yesno === true);
  await key('n');
  assert(/End this game/.test(f7) && f10 && (await doom(() => window.doom.screen)) === 'level', 'F7 asks to end the game, F10 to quit; N keeps playing');
  await key('F11');
  const g1 = await doom(() => [window.doom.gamma, window.doom.message].join(' / '));
  for (let i = 0; i < 4; i++) await key('F11');
  const g0 = await doom(() => [window.doom.gamma, window.doom.message].join(' / '));
  assert(g1 === '1 / Gamma: level 1' && g0 === '0 / Gamma: off', `F11 steps the gamma (${g1}; four more: ${g0})`);
  }

  // the screen size keys
  await key('Minus', 400);
  const small = await doom(() => window.doom.renderer.scaledW);
  await key('Equal', 400);
  assert(small === 288 && await doom(() => window.doom.renderer.scaledW) === 320, `- shrinks the view (${small} wide), = grows it back`);

  // the mouse in play (as under pointer lock): button 2 strafes, button 3 walks, the X turns
  {
    const facing = () => doom(() => window.doom.sql("SELECT x, y, angle FROM things WHERE kind = 'player'").then((r) => r[0]));
    const still = () => doom(() => window.doom.sql("UPDATE things SET momx = 0, momy = 0 WHERE kind = 'player'"));
    const along = (a, b) => {   // how far from A to B, forward and to the right of A's facing
      const dx = b.X - a.X;
      const dy = b.Y - a.Y;
      return { fwd: dx * Math.cos(a.ANGLE) + dy * Math.sin(a.ANGLE), right: dx * Math.sin(a.ANGLE) - dy * Math.cos(a.ANGLE) };
    };
    await doom(() => window.doom.sql("UPDATE things SET hp = 0, st = 'dead', solid = 0 WHERE kind = 'monster'"));
    await still();
    const a0 = await facing();
    await doom(() => window.doom.mouse.button(2, true));
    for (let i = 0; i < 6; i++) { await doom(() => window.doom.mouse.move(4, 0)); await page.waitForTimeout(50); }
    await waitTics(3);   // (a frame takes the last move before the button goes up: after, it would turn)
    await doom(() => window.doom.mouse.button(2, false));
    await waitTics(3);
    const a1 = await facing();
    const s1 = along(a0, a1);
    await doom((p) => window.doom.sql(`UPDATE things SET x = ${p.X}, y = ${p.Y}, momx = 0, momy = 0 WHERE kind = 'player'`), a0);   // (back to the open floor)
    await page.waitForTimeout(100);
    const a1b = await facing();
    const held = await tic();
    await doom(() => window.doom.mouse.button(1, true));
    for (let i = 0; i < 100 && (await tic()) < held + 8; i++) await page.waitForTimeout(20);
    await doom(() => window.doom.mouse.button(1, false));
    await page.waitForTimeout(300);
    const a2 = await facing();
    const s2 = along(a1b, a2);
    await still();
    await page.waitForTimeout(100);
    const a2b = await facing();
    await doom(() => window.doom.mouse.move(40, 0));
    await waitTics(3);
    const a3 = await facing();
    if (process.env.DBG) console.log(JSON.stringify({ a0, a1, a2, a3, s1, s2 }));
    assert(s1.right > 8 && Math.abs(s1.fwd) < s1.right / 3 && a1.ANGLE === a0.ANGLE,
      `right button held, the mouse moved right: a strafe to the right (${s1.right.toFixed(0)} units), no turn`);
    assert(s2.fwd > 8 && Math.abs(s2.right) < s2.fwd / 3 && a2.ANGLE === a1.ANGLE, `middle button held: forward (${s2.fwd.toFixed(0)} units)`);
    assert(a3.ANGLE !== a2b.ANGLE && Math.hypot(a3.X - a2b.X, a3.Y - a2b.Y) < 2, 'no button: the mouse turns, as before');
  }

  // standing still, FRAME_WALLS' last answer is drawn again; a ceiling that moves asks anew
  {
    await doom(() => window.doom.sql("UPDATE things SET momx = 0, momy = 0 WHERE kind = 'player'"));
    await page.waitForTimeout(1000);
    const r0 = await doom(() => window.doom.debug.wallsReused);
    await page.waitForTimeout(1000);
    const r1 = await doom(() => window.doom.debug.wallsReused);
    const same = await doom(() => window.doom.wallsMatch());
    await doom(() => window.doom.sql("UPDATE sectors SET ceil_h = ceil_h + 24 WHERE id = (SELECT t.sector_id FROM things t WHERE t.kind = 'player')"));
    await page.waitForTimeout(500);
    const moved = await doom(() => window.doom.wallsMatch());
    await doom(() => window.doom.sql("UPDATE sectors SET ceil_h = ceil_h - 24 WHERE id = (SELECT t.sector_id FROM things t WHERE t.kind = 'player')"));
    assert(r1 - r0 >= 3 && same && moved,
      `standing still the walls are drawn from the last answer (${r1 - r0} frames in a second), the same as asking again; the ceiling moved, they're asked anew`);
  }

  // key bindings (default.cfg's keys): Forward's first key set to I in the Keys panel walks, and W
  // no longer does; Alt, DOOM's strafe key, makes → strafe
  {
    const at = () => doom(() => window.doom.sql("SELECT x, y, angle FROM things WHERE kind = 'player'").then((r) => r[0]));
    const still = () => doom(() => window.doom.sql("UPDATE things SET momx = 0, momy = 0 WHERE kind = 'player'"));
    const along = (a, b) => ({ fwd: (b.X - a.X) * Math.cos(a.ANGLE) + (b.Y - a.Y) * Math.sin(a.ANGLE), right: (b.X - a.X) * Math.sin(a.ANGLE) - (b.Y - a.Y) * Math.cos(a.ANGLE) });
    const hold = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); await page.waitForTimeout(300); };
    await doom(() => document.getElementById('key-forward-0').click());
    const waiting = await doom(() => document.getElementById('key-forward-0').textContent);
    await page.keyboard.press('i');
    const bound = await doom(() => [window.doom.keys.forward.join(), document.getElementById('key-forward-0').textContent]);
    await still();
    const k0 = await at();
    await hold('i', 400);
    const k1 = await at();
    await still();
    await page.waitForTimeout(200);
    const k1b = await at();
    await hold('w', 400);
    const k2 = await at();
    await still();
    await page.waitForTimeout(200);
    const k2b = await at();
    await page.keyboard.down('Alt');
    await hold('ArrowRight', 400);
    await page.keyboard.up('Alt');
    const k3 = await at();
    await doom(() => document.getElementById('keys-defaults').click());
    const back = await doom(() => window.doom.keys.forward.join());
    const walked = along(k0, k1);
    const strafed = along(k2b, k3);
    assert(/press a key/.test(waiting) && bound[0] === 'KeyI,ArrowUp' && bound[1] === 'I' && walked.fwd > 8 && Math.hypot(k2.X - k1b.X, k2.Y - k1b.Y) < 2,
      `the Keys panel waits for a key, and Forward on I walks (${walked.fwd.toFixed(0)} units); W does nothing now`);
    assert(strafed.right > 8 && k3.ANGLE === k2b.ANGLE && back === 'KeyW,ArrowUp',
      `Alt held (key_strafe) makes → strafe (${strafed.right.toFixed(0)} units, no turn); Defaults puts W back`);
  }

  // the launch options in a game alone (-nomonsters, -fast): ticking one starts a new game on
  // this map with them; a demo keeps them in its header and plays them back, whatever's ticked then
  {
    const gameRow = () => doom(() => window.doom.sql("SELECT g.nomonsters, g.respawn, g.fast, (SELECT COUNT(*) FROM things t WHERE t.kind = 'monster') monsters FROM game g").then((r) => r[0]));
    const tick = async (id, on) => {
      await doom(({ id, on }) => { const b = document.getElementById(id); b.checked = on; b.dispatchEvent(new Event('change')); }, { id, on });
      await until(() => window.doom.melting);
      await until(() => window.doom.screen === 'level' && window.doom.settled);
    };
    await tick('opt-nomonsters', true);
    await tick('opt-fast', true);
    const ticked = await gameRow();
    await doom(() => window.doom.record());
    await until(() => window.doom.screen === 'level' && window.doom.settled);
    await page.waitForTimeout(1500);
    await doom(() => window.doom.stopDemo());
    const header = await doom(() => { const d = window.doom.demo.last; return { nomonsters: d.nomonsters, respawn: d.respawn, fast: d.fast, calls: d.calls.length }; });
    await tick('opt-nomonsters', false);
    await tick('opt-fast', false);
    const plain = await gameRow();
    await doom(() => window.doom.playDemo());   // (it resolves once the demo's map is loaded)
    const replay = await gameRow();
    await until(() => window.doom.settled);
    await doom(() => window.doom.stopDemo());
    assert(ticked.NOMONSTERS === 1 && ticked.FAST === 1 && ticked.RESPAWN === 0 && ticked.MONSTERS === 0 && plain.NOMONSTERS === 0 && plain.MONSTERS > 0,
      `No monsters and Fast ticked: a new game on this map with them (${ticked.MONSTERS} monsters); unticked, the monsters are back (${plain.MONSTERS})`);
    assert(header.nomonsters === 1 && header.fast === 1 && header.respawn === 0 && header.calls > 0 && replay.NOMONSTERS === 1 && replay.FAST === 1 && replay.MONSTERS === 0,
      'a demo recorded with them keeps them in its header, and plays back with them though the boxes are unticked');
  }

  // the automap
  await key('Tab', 300);
  assert(await doom(() => window.doom.automap.open), 'Tab opens the automap');
  await key('Tab', 300);

  // a level exit: the intermission, then the next map
  await doom(() => window.doom.sql('UPDATE game SET exit_kind = 1'));
  await until(() => window.doom.screen === 'intermission', null, 30000);
  assert(true, 'a level exit melts into the intermission');
  await until(() => !window.doom.melting);
  for (let i = 0; i < 6 && (await doom(() => window.doom.screen)) === 'intermission'; i++) await tap('Space', 600);
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

  // a demo across levels: recorded through E1M1's exit switch, the intermission and into E1M2,
  // then played back – it must take the same turns all the way (the menu held up while the
  // player is put before the switch, the same way both times: that's part of where it starts)
  const atSwitch = () => doom(() => window.doom.sql(`SELECT FIRST 1 x1, y1, x2, y2 FROM linedefs WHERE special = 11 ORDER BY id`).then(async ([l]) => {
    const len = Math.hypot(l.X2 - l.X1, l.Y2 - l.Y1);
    const nx = (l.Y2 - l.Y1) / len;
    const ny = -(l.X2 - l.X1) / len;
    const px = (l.X1 + l.X2) / 2 + nx * 24;
    const py = (l.Y1 + l.Y2) / 2 + ny * 24;
    await window.doom.sql(`UPDATE things SET x = ${px}, y = ${py}, angle = ${Math.atan2(-ny, -nx)}, sector_id = sector_at(${px}, ${py}),
      z = (SELECT s.floor_h FROM sectors s WHERE s.id = sector_at(${px}, ${py})), momx = 0, momy = 0 WHERE kind = 'player'`);
  }));
  const status = () => doom(() => document.getElementById('status')?.textContent ?? '');
  await doom(() => {                                      // (Map: a new game on E1M1, even if it already says E1M1)
    const sel = document.getElementById('map');
    sel.value = 'E1M1';
    sel.dispatchEvent(new Event('change'));
  });
  // (melts queue up – the title's, then this level's – so wait for the screen to settle on it)
  await until(() => window.doom.screen === 'level' && window.doom.settled, null, 60000);
  await doom(async () => { await window.doom.record(); window.doom.menu.open(); });   // (nothing ticks behind the menu)
  await atSwitch();
  await doom(() => window.doom.menu.close(true));
  await until(() => window.doom.settled, null, 60000);   // (keys pressed during a melt are dropped)
  await page.keyboard.down('Space'); await page.waitForTimeout(300); await page.keyboard.up('Space');
  try {
    if (process.env.DBG) {
      for (let i = 0; i < 15 && (await doom(() => window.doom.screen)) !== 'intermission'; i++) {
        await page.waitForTimeout(2000);
        console.log('trace', JSON.stringify(await doom(async () => ({ p: (await window.doom.sql("SELECT CAST(t.angle * 100 AS INTEGER) a, CAST(t.x AS INTEGER) x, CAST(t.y AS INTEGER) y, p.health h, p.dead d, p.attacker_id att, p.use_down u, CAST(t.momx * 10 AS INTEGER) mx FROM player p JOIN things t ON t.id = p.thing_id"))[0], g: (await window.doom.sql('SELECT tic, exit_kind FROM game'))[0], screen: window.doom.screen, rec: window.doom.demo.recording }))));
      }
    }
    await until(() => window.doom.screen === 'intermission', null, 30000);
  } catch (err) {
    console.log('no intermission:', JSON.stringify(await doom(async () => ({ debug: window.doom.debug, screen: window.doom.screen, demo: window.doom.demo, status: document.getElementById('status').textContent,
      player: await window.doom.sql("SELECT CAST(x AS INTEGER) x, CAST(y AS INTEGER) y, CAST(angle * 100 AS INTEGER) a FROM things WHERE kind = 'player'"), game: await window.doom.sql('SELECT tic, exit_kind, map_name FROM game') }))));
    throw err;
  }
  await until(() => !window.doom.melting);
  for (let i = 0; i < 6 && (await doom(() => window.doom.screen)) === 'intermission'; i++) await tap('Space', 600);
  await until(() => window.doom.melting, null, 60000);
  await until(() => !window.doom.melting);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(700); await page.keyboard.up('KeyW');
  await doom(() => window.doom.stopDemo());
  const recorded = await status();
  const demo = await doom(() => window.doom.demo.last);
  const kinds = [...new Set(demo.calls.map((c) => (typeof c[0] === 'number' ? 'tic' : c[0])))];
  assert(/E1M1 → E1M2/.test(recorded) && kinds.includes('wi') && kinds.includes('map'),
    `recording goes on through the exit and the intermission: "${recorded.trim()}" (${demo.calls.length} entries: ${kinds.join(', ')})`);
  await doom(async () => { await window.doom.playDemo(); window.doom.menu.open(); });
  await atSwitch();
  await doom(() => window.doom.menu.close(true));
  await until(() => !window.doom.demo.playing, null, 90000);
  const played = await status();
  const playedMap = (await doom(() => window.doom.sql('SELECT map_name FROM game').then((r) => r[0].MAP_NAME))).trim();
  assert(/the demo is over/.test(played) && playedMap === 'E1M2',
    `played back, it takes the same turns: through the intermission into ${playedMap}, to the end ("${played.trim()}")`);

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

  // D_DoAdvanceDemo: after TITLEPIC the first attract demo plays, through the
  // game loop; a key brings up the menu over it and it goes on; when it ends,
  // the credits page
  // (SCREEN reads 'level' while the demo's map still loads: wait for its first call to play)
  await until(() => window.doom.demo.attract === 1 && !window.doom.melting && window.doom.demo.played > 0, null, 40000);
  // (until the tic moves on, up to 10 s: a map's first frames can come a second late in Firefox on CI)
  const moves = async (from) => { for (let i = 0; i < 100 && (await tic()) <= from; i++) await page.waitForTimeout(100); };
  const a0 = await tic();
  await moves(a0);
  const a1 = await tic();
  await key('x');
  const a2 = await tic();
  await moves(a2);
  const menuUp = await doom(() => window.doom.menu.active && window.doom.demo.attract === 1);
  const a3 = await tic();
  assert(a1 > a0 && menuUp && a3 > a2, `the title loop plays DEMO1 (tic ${a0} → ${a1}); a key opens the menu over it, and it goes on (${a2} → ${a3})`);
  await key('Escape');
  await until(() => window.doom.screen === 'title', null, 60000);
  assert(await doom(() => window.doom.title.page === 'CREDIT' && !window.doom.demo.attract && !window.doom.demo.playing),
    `when the demo is over, the credits page (${await doom(() => window.doom.title.page)})`);

  // the command line: a link starts a game, as `doom -warp 1 3 -skill 4 -fast -nomusic` would
  {
    const p2 = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    p2.on('pageerror', (e) => errors.push(e.message));
    await load(p2, `http://localhost:${port}/?warp=1,3&skill=4&fast&nomusic`, () => window.doom?.screen === 'level' && window.doom.settled && !window.doom.title);
    const got = await p2.evaluate(async () => ({
      game: (await window.doom.sql('SELECT map_name, skill, fast, nomonsters FROM game'))[0],
      skill: document.getElementById('skill').value, fast: document.getElementById('opt-fast').checked, music: window.doom.commandLine.sound.music,
    }));
    assert(got.game.MAP_NAME.trim() === 'E1M3' && got.game.SKILL === 4 && got.game.FAST === 1 && got.game.NOMONSTERS === 0 && got.skill === '4' && got.fast && !got.music,
      `?warp=1,3&skill=4&fast&nomusic: straight into E1M3 on skill 4, fast, the music silent (${JSON.stringify(got.game)})`);
    // -timedemo: the title loop's DEMO1, a call a frame as fast as frames come, timed (stopped after a while: it's 700 tics)
    await load(p2, `http://localhost:${port}/?timedemo=demo1`, () => window.doom?.timedemo?.frames > 20);
    await p2.evaluate(() => window.doom.stopDemo());
    const td = await p2.evaluate(() => ({ ...window.doom.timedemo, status: document.getElementById('status').textContent }));
    assert(td.frames > 20 && td.tics >= td.frames && td.fps > 0 && td.ms > 0 && /Timedemo: \d+ game tics/.test(td.status),
      `?timedemo=demo1: ${td.tics} tics in ${td.frames} frames, ${td.fps} frames a second ("${td.status}")`);
    await p2.close();
  }

  // a gamepad as DOOM's joystick: a button on the title opens the menu, the stick and button 0
  // go through it to a new game; then the stick walks and turns, button 1 held makes it strafe,
  // button 0 fires (a stand-in pad: navigator.getGamepads answers with it)
  {
    const p3 = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    p3.on('pageerror', (e) => errors.push(e.message));
    await p3.addInitScript(() => {
      window.__pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
      navigator.getGamepads = () => [window.__pad];
    });
    await load(p3, `http://localhost:${port}/`, () => window.doom?.title && window.doom.screen === 'title');
    const pad = (change) => p3.evaluate((c) => {
      const pd = window.__pad;
      pd.axes = [c.x ?? 0, c.y ?? 0, 0, 0];
      pd.buttons.forEach((b, i) => { b.pressed = (c.buttons ?? []).includes(i); });
    }, change);
    const press = async (b) => { await pad({ buttons: [b] }); await p3.waitForTimeout(250); await pad({}); await p3.waitForTimeout(250); };
    await press(0);
    const opened = await p3.evaluate(() => window.doom.menu.active);
    for (let i = 0; i < 3; i++) await press(0);   // (New Game, the first episode, the skill on its cursor)
    await p3.waitForFunction(() => window.doom.screen === 'level' && window.doom.settled && !window.doom.menu.active, null, { timeout: 120000, polling: 100 });
    const at = () => p3.evaluate(() => window.doom.sql("SELECT x, y, angle FROM things WHERE kind = 'player'").then((r) => r[0]));
    const still = () => p3.evaluate(() => window.doom.sql("UPDATE things SET momx = 0, momy = 0 WHERE kind = 'player'"));
    await p3.evaluate(() => window.doom.sql("UPDATE things SET hp = 0, st = 'dead', solid = 0 WHERE kind = 'monster'"));
    const along = (a, b) => ({ fwd: (b.X - a.X) * Math.cos(a.ANGLE) + (b.Y - a.Y) * Math.sin(a.ANGLE), right: (b.X - a.X) * Math.sin(a.ANGLE) - (b.Y - a.Y) * Math.cos(a.ANGLE) });
    // (held for a number of the game's tics, not milliseconds: a slow runner's frames are long)
    const tic3 = () => p3.evaluate(() => window.doom.sql('SELECT tic FROM game').then((r) => r[0].TIC));
    const hold = async (change, n) => { await pad(change); await waitTics(n, tic3); await pad({}); await waitTics(3, tic3); };
    const s0 = await at();
    await hold({ y: -1 }, 14);
    const s1 = await at();
    await still();
    await hold({ x: 1 }, 10);
    const s2 = await at();
    await still();
    const s2b = await at();
    await hold({ x: 1, buttons: [1] }, 14);
    const s3 = await at();
    const shells0 = await p3.evaluate(() => window.doom.sql('SELECT bullets FROM player').then((r) => r[0].BULLETS));
    await hold({ buttons: [0] }, 10);
    const shells1 = await p3.evaluate(() => window.doom.sql('SELECT bullets FROM player').then((r) => r[0].BULLETS));
    const walk = along(s0, s1);
    const strafe = along(s2b, s3);
    assert(opened, 'a gamepad button on the title opens the menu (G_Responder)');
    assert(walk.fwd > 8 && s1.ANGLE === s0.ANGLE && s2.ANGLE !== s1.ANGLE && strafe.right > 8 && Math.abs(strafe.fwd) < strafe.right / 2 && s3.ANGLE === s2b.ANGLE && shells1 < shells0,
      `and through the menus into a game; the stick up walks (${walk.fwd.toFixed(0)}), right turns, with button 1 held strafes (${strafe.right.toFixed(0)}), button 0 fires (${shells0} → ${shells1} bullets)`);
    await p3.close();
  }

  // offline play (sw.js): a first visit leaves the page, the engine and the WAD it
  // played in the caches; offline, a reload still starts, and a game plays. A WAD
  // never downloaded says why it can't come. (Offline is the server stopped: Playwright's
  // setOffline doesn't reach a service worker's own fetches. So this goes last.)
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const p4 = await ctx.newPage();
    p4.on('pageerror', (e) => errors.push(e.message));
    await load(p4, `http://localhost:${port}/`, () => window.doom?.title);
    let ready = null;
    for (let i = 0; i < 200 && !(ready?.controlled && ready.page.length && ready.wads.includes('freedoom1.wad')); i++) {
      ready = await p4.evaluate(() => window.doom.offline());
      await p4.waitForTimeout(100);
    }
    assert(ready.controlled && ready.page.length === 1 && ready.wads.join() === 'freedoom1.wad',
      `a first visit leaves it ready to play offline (the page's files as version ${ready.page[0]}, and ${ready.wads.join(', ')})`);
    server.kill();
    await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
    await load(p4, null, () => window.doom?.title);
    const offTic = () => p4.evaluate(() => window.doom.sql('SELECT tic FROM game').then((r) => r[0].TIC));
    await p4.evaluate(() => { const m = document.getElementById('map'); m.value = 'E1M2'; m.dispatchEvent(new Event('change')); });
    await p4.waitForFunction(() => window.doom.screen === 'level' && window.doom.settled, null, { timeout: 120000, polling: 100 });
    const o0 = await offTic();
    for (let i = 0; i < 100 && (await offTic()) <= o0 + 10; i++) await p4.waitForTimeout(100);
    const offMap = (await p4.evaluate(() => window.doom.sql('SELECT map_name FROM game').then((r) => r[0].MAP_NAME))).trim();
    assert(offMap === 'E1M2' && (await offTic()) > o0 + 10, `with the server gone, a reload starts from the caches and ${offMap} plays`);
    await p4.selectOption('#game', 'freedoom2');
    await p4.waitForFunction(() => /could not fetch freedoom2\.wad/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30000, polling: 100 });
    const said = await p4.evaluate(() => document.getElementById('status').textContent);
    assert(/offline, and not played here before/.test(said), `…and Phase 2, never downloaded, says why it can't come ("${said}")`);
    await ctx.close();
  }

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
