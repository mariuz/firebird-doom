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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
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
    `Synth OPL3: the music plays on from the OPL3 worklet (level ${music3.rms.toFixed(3)})`);
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
  await key('y', 0);
  await until(() => window.doom.melting);           // (G_DoLoadLevel: a load melts in)
  await until(() => !window.doom.melting);
  await page.waitForTimeout(300);
  const back = await pos();
  const moved = Math.hypot(walked.X - saved.X, walked.Y - saved.Y);
  const off = Math.hypot(back.X - saved.X, back.Y - saved.Y);
  assert(moved > 32 && off < moved / 2, `…and the player is back (walked ${moved.toFixed(0)} away, ${off.toFixed(0)} from the save after loading)`);

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
    await page.waitForTimeout(300);   // (a frame takes the last move before the button goes up: after, it would turn)
    await doom(() => window.doom.mouse.button(2, false));
    await page.waitForTimeout(300);
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
    await page.waitForTimeout(200);
    const a3 = await facing();
    if (process.env.DBG) console.log(JSON.stringify({ a0, a1, a2, a3, s1, s2 }));
    assert(s1.right > 8 && Math.abs(s1.fwd) < s1.right / 3 && a1.ANGLE === a0.ANGLE,
      `right button held, the mouse moved right: a strafe to the right (${s1.right.toFixed(0)} units), no turn`);
    assert(s2.fwd > 8 && Math.abs(s2.right) < s2.fwd / 3 && a2.ANGLE === a1.ANGLE, `middle button held: forward (${s2.fwd.toFixed(0)} units)`);
    assert(a3.ANGLE !== a2b.ANGLE && Math.hypot(a3.X - a2b.X, a3.Y - a2b.Y) < 2, 'no button: the mouse turns, as before');
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
  for (let i = 0; i < 6 && (await doom(() => window.doom.screen)) === 'intermission'; i++) await key('Space', 600);
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
  const a0 = await tic();
  await page.waitForTimeout(1000);
  const a1 = await tic();
  await key('x');
  const a2 = await tic();
  await page.waitForTimeout(1000);
  const menuUp = await doom(() => window.doom.menu.active && window.doom.demo.attract === 1);
  const a3 = await tic();
  assert(a1 > a0 && menuUp && a3 > a2, `the title loop plays DEMO1 (tic ${a0} → ${a1}); a key opens the menu over it, and it goes on (${a2} → ${a3})`);
  await key('Escape');
  await until(() => window.doom.screen === 'title', null, 60000);
  assert(await doom(() => window.doom.title.page === 'CREDIT' && !window.doom.demo.attract && !window.doom.demo.playing),
    `when the demo is over, the credits page (${await doom(() => window.doom.title.page)})`);

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
