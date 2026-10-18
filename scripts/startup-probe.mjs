// (trial only) open the page N times in BROWSER and time each start to the title
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, browserName } from './launch-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const server = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--serve'], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('serving')) resolve(); }));
const browser = await launchBrowser();
const N = Number(process.env.N || 10);
// (MODE=pair: a second page starts while the first plays its title loop, as in the co-op test)
const pair = process.env.MODE === 'pair';
let bad = 0;
const start = async (label) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = [];
  page.on('console', (m) => log.push(`${m.type()}: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}\n${e.stack}`));
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  try {
    await page.waitForFunction(() => window.doom?.title, null, { timeout: 60000, polling: 100 });
    console.log(`${browserName} ${label}: ${Date.now() - t0} ms`);
  } catch {
    bad++;
    const status = await page.evaluate(() => document.getElementById('status')?.textContent).catch((e) => e.message);
    console.log(`${browserName} ${label}: STUCK after 60 s at "${status}"\n  ${log.slice(-15).join('\n  ')}`);
  }
  return ctx;
};
for (let i = 0; i < N; i++) {
  if (pair) {
    const a = await start(`pair ${i} first`);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await start(`pair ${i} second`);
    await a.close();
    await b.close();
  } else await (await start(`start ${i}`)).close();
}
console.log(`${browserName}: ${bad} of ${pair ? 2 * N : N} starts stuck`);
await browser.close();
server.kill();
