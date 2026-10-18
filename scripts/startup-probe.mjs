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
let bad = 0;
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = [];
  page.on('console', (m) => log.push(`${m.type()}: ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  try {
    await page.waitForFunction(() => window.doom?.title, null, { timeout: 60000, polling: 100 });
    console.log(`${browserName} start ${i}: ${Date.now() - t0} ms`);
  } catch {
    bad++;
    const status = await page.evaluate(() => document.getElementById('status')?.textContent).catch((e) => e.message);
    console.log(`${browserName} start ${i}: STUCK after 60 s at "${status}"\n  ${log.slice(-15).join('\n  ')}`);
  }
  await ctx.close();
}
console.log(`${browserName}: ${bad} of ${N} starts stuck`);
await browser.close();
server.kill();
