// screenshot.mjs – render frames with the real SQL renderer + the page's
// rasteriser, headless, and save them as PNGs for the README.
//
//   node scripts/screenshot.mjs            → docs/screenshot-*.png, and their
//                                            pixels' hashes in docs/screenshots.json
//   node scripts/screenshot.mjs --check    the visual regression test: render
//                                            them all again, write nothing, and fail
//                                            if any picture's pixels differ (the new
//                                            ones go to screenshots-diff/ to look at)
//
// Same code path as the browser: DOOM_TIC, FRAME_WALLS, FRAME_SPRITES,
// FRAME_SECTORS, then src/renderer.js and src/hud.js into a 320×200 buffer of
// palette indices, coloured through PLAYPAL and scaled to 640×480 (DOOM's 4:3).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Wad } from '../src/wad.js';
import { createSchema, loadResources, loadMap } from '../src/loader.js';
import { Renderer } from '../src/renderer.js';
import { drawStatusBar, drawWeapon } from '../src/hud.js';
import { Finale } from '../src/finale.js';
import { Intermission } from '../src/intermission.js';
import { Menu, TitleLoop } from '../src/menu.js';
import { parseDehStrings } from '../src/finale.js';
import { THING_TYPES } from '../src/thinginfo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs');
const sql = Object.fromEntries(['schema', 'game', 'render'].map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://shot', { transport: new DirectTransport() });
await createSchema(db, sql);
const wad = new Wad(fs.readFileSync(process.env.WAD ?? path.join(root, 'public/wads/freedoom1.wad')));
const res = await loadResources(db, wad);
let renderer = new Renderer(wad, res);   // (no presenter: the PNGs come from toRGBA)
const arr = { rowMode: 'array' };

const CHECK = process.argv.includes('--check');
const HASHES = path.join(outDir, 'screenshots.json');
const DIFF = path.join(root, 'screenshots-diff');
const known = CHECK ? JSON.parse(fs.readFileSync(HASHES, 'utf8')) : {};
const hashes = {};
const changed = [];
/** The screen as it is now: saved as FILE, or (--check) compared with its hash. */
function emit(file) {
  const rgba = renderer.toRGBA(0);
  const hash = crypto.createHash('sha256').update(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)).digest('hex').slice(0, 16);
  hashes[file] = hash;
  if (!CHECK) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, file), png(rgba, 320, 200, 640, 480));
  } else if (known[file] !== hash) {
    changed.push(file);
    fs.mkdirSync(DIFF, { recursive: true });
    fs.writeFileSync(path.join(DIFF, file), png(rgba, 320, 200, 640, 480));
  }
}

async function mapState(name) {
  const m = /^E(\d)M/.exec(name);
  const map = { skyTex: res.texId.get(`SKY${m ? Math.min(4, Number(m[1])) : 1}`) ?? 0 };
  const lines = (await db.query('SELECT id, front_side, back_side, flags, light_delta, special FROM linedefs', [], arr)).rows;
  map.lines = new Map(lines.map((r) => [r[0], { fs: r[1], bs: r[2], flags: r[3], lightDelta: r[4], scroll: r[5] === 48 }]));
  const sides = (await db.query('SELECT id, xoff, yoff, upper_tex, lower_tex, mid_tex, sector_id FROM sidedefs', [], arr)).rows;
  map.sides = new Map(sides.map((r) => [r[0], { xoff: r[1], yoff: r[2], upper: r[3], lower: r[4], mid: r[5], sector: r[6] }]));
  return map;
}

async function shoot(map, file) {
  await db.exec('UPDATE player SET health = 100, dead = 0');
  const hud = (await db.query('SELECT * FROM doom_tic(1, 0, 0, 0, 0, 0, 0, 0)')).rows[0];
  const walls = (await db.query('SELECT * FROM frame_walls', [], arr)).rows;
  const sprites = (await db.query('SELECT * FROM frame_sprites', [], arr)).rows;
  const sectors = (await db.query('SELECT * FROM frame_sectors', [], arr)).rows;
  map.sectors = new Map(sectors.map((r) => [r[0], { floor: r[1], ceil: r[2], floorFlat: r[3], ceilFlat: r[4], light: r[5], sky: r[6] === 1 }]));
  renderer.drawView({ x: hud.PX, y: hud.PY, z: hud.VIEW_Z, angle: hud.PANGLE, tic: hud.TIC, palette: 0,
    fixedColormap: hud.INVULN_TICS > 0 ? 32 : hud.INFRA_TICS > 0 ? 1 : null }, walls, sprites, map);
  renderer.composeView();
  drawWeapon(renderer, hud, 0);
  drawStatusBar(renderer, hud, 0);
  emit(file);
  console.log(`docs/${file}  (${walls.length} wall slices, ${sprites.length} sprites)`);
}

/** Place the player `dist` units from a thing, facing it, where it can stand and see it. */
async function faceThing(kind, dist, aimZ = 40) {
  const cands = (await db.query(`SELECT t.id, t.x, t.y, t.z FROM things t WHERE t.kind = '${kind}' ORDER BY t.id`)).rows;
  for (const c of cands) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const x = c.X + Math.cos(a) * dist;
      const y = c.Y + Math.sin(a) * dist;
      const r = (await db.query(
        `EXECUTE BLOCK RETURNS (ok SMALLINT, floor_z DOUBLE PRECISION, seen SMALLINT) AS
         DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
         BEGIN
           EXECUTE PROCEDURE check_position(-1, ${x}, ${y},
             (SELECT floor_h FROM sectors WHERE id = sector_at(${x}, ${y})), 16, 56, 0)
             RETURNING_VALUES ok, floor_z, cz, dz, sec;
           seen = check_sight(${x}, ${y}, floor_z + 41, ${c.X}, ${c.Y}, ${c.Z} + ${aimZ});
           SUSPEND;
         END`)).rows[0];
      if (r.OK === 1 && r.SEEN === 1) {
        await db.exec(`UPDATE things t SET x = ${x}, y = ${y}, z = ${r.FLOOR_Z}, angle = ${a + Math.PI},
                       sector_id = sector_at(${x}, ${y}) WHERE t.kind = 'player'`);
        return true;
      }
    }
  }
  return false;
}

// ── tiny PNG encoder (RGBA, nearest-neighbour upscale) ─────────────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(src, sw, sh, w, h) {
  const px = new Uint8Array(src.buffer);
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * sh) / h);
    const o = y * (w * 4 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const s = (sy * sw + Math.floor((x * sw) / w)) * 4;
      raw.set(px.subarray(s, s + 4), o + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the shots ──────────────────────────────────────────────────────────
await loadMap(db, wad, res, 'E1M1');
let map = await mapState('E1M1');
await db.query('SELECT * FROM doom_tic(12, 1, 0, 0, 0, 0, 0, 0)');
await shoot(map, 'screenshot-e1m1.png');

if (await faceThing('monster', 180)) await shoot(map, 'screenshot-monster.png');

await loadMap(db, wad, res, 'E1M2');
map = await mapState('E1M2');
await db.query('SELECT * FROM doom_tic(20, 1, 0, 0.6, 0, 0, 0, 0)');
await shoot(map, 'screenshot-e1m2.png');

// a spectre (MF_SHADOW): just a shimmer of fuzz over whatever is behind it
{
  const p = (await db.query("SELECT t.x, t.y, t.angle FROM things t WHERE t.kind = 'player'")).rows[0];
  for (const d of [128, 112, 96, 80]) {
    const x = p.X + Math.cos(p.ANGLE) * d;
    const y = p.Y + Math.sin(p.ANGLE) * d;
    const ok = (await db.query(`EXECUTE BLOCK RETURNS (ok SMALLINT) AS
        DECLARE fz DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE sec INTEGER;
        BEGIN
          EXECUTE PROCEDURE check_position(-1, ${x}, ${y}, (SELECT floor_h FROM sectors WHERE id = sector_at(${x}, ${y})), 30, 56, 1)
            RETURNING_VALUES ok, fz, cz, dz, sec;
          SUSPEND;
        END`)).rows[0].OK;
    if (ok !== 1) continue;
    await db.query(`EXECUTE BLOCK AS DECLARE id INTEGER; BEGIN
        EXECUTE PROCEDURE spawn_thing(58, ${x}, ${y}, NULL, ${p.ANGLE + Math.PI}) RETURNING_VALUES id;
        UPDATE things SET st = 'pain', st_tics = 99, st_len = 99, frame = 'A' WHERE id = :id;   -- (hold still for the photo)
      END`);
    await shoot(map, 'screenshot-spectre.png');
    // the same view, invulnerable: COLORMAP 32 on everything but the sky
    await db.exec('UPDATE player SET invuln_tics = 1000');
    await shoot(map, 'screenshot-invuln.png');
    await db.exec('UPDATE player SET invuln_tics = 0');
    break;
  }
}

// the intermission after E1M2 (example numbers), fully counted
{
  const wi = new Intermission(renderer, { playMusic() {}, playEvents() {} }, wad, 'E1M2', 'E1M3',
    { kills: 17, totalKills: 20, items: 30, totalItems: 37, secrets: 2, totalSecrets: 3, time: 95 * 35 });
  for (let i = 0; i < 600; i++) wi.tick(false);
  wi.draw();
  emit('screenshot-intermission.png');
  console.log('docs/screenshot-intermission.png');
}

// the main menu over the title screen
{
  const strings = parseDehStrings(new TextDecoder('latin1').decode(wad.data(wad.lump('DEHACKED'))));
  const menu = new Menu({ episodes: 4, retail: true, strings, actions: { messages: true, detail: 'high', mouse: 5, sfx: 10, music: 7 } });
  new TitleLoop(false, true).draw(renderer);
  menu.open();
  menu.draw(renderer);
  emit('screenshot-menu.png');
  console.log('docs/screenshot-menu.png');
}

// Phase 2 extras: Commander Keen and the Icon of Sin
const wad2Path = path.join(root, 'public/wads/freedoom2.wad');
if (!process.env.WAD && fs.existsSync(wad2Path)) {
  const wad2 = new Wad(fs.readFileSync(wad2Path));
  const res2 = await loadResources(db, wad2);
  renderer = new Renderer(wad2, res2);
  const mapState2 = async (name) => {
    const m = await mapState(name);
    m.skyTex = res2.texId.get(Number(name.slice(3)) < 12 ? 'SKY1' : Number(name.slice(3)) < 21 ? 'SKY2' : 'SKY3') ?? 0;
    return m;
  };
  for (const [name, kind, file] of [['MAP11', 'keen', 'screenshot-keen.png'], ['MAP30', 'brain', 'screenshot-icon.png']]) {
    await loadMap(db, wad2, res2, name);
    const m = await mapState2(name);
    let placed = false;
    for (const d of [96, 128, 192, 256, 384, 512]) if ((placed = await faceThing(kind, d, kind === 'keen' ? 36 : 8))) break;
    if (!placed) { console.log(`(${name}: no clear view of the ${kind})`); continue; }
    await db.query('SELECT * FROM doom_tic(2, 0, 0, 0, 0, 0, 0, 0)');
    await shoot(m, file);
  }

  // the finale after MAP30: the story text, then the cast call
  const fin = new Finale(renderer, { playMusic() {}, playEvents() {} }, wad2, THING_TYPES);
  const save = (file) => {
    fin.draw();
    emit(file);
    console.log(`docs/${file}`);
  };
  for (let i = 0; i < 10 + fin.state.text.length * 3; i++) fin.tick(false);
  save('screenshot-finale-text.png');
  fin.tick(true);
  while (fin.state.castnum < 11) { fin.press(); for (let i = 0; i < 200 && fin.state.mode === 'death'; i++) fin.tick(false); }
  for (let i = 0; i < 6; i++) fin.tick(false);
  save('screenshot-finale-cast.png');
}

if (CHECK) {
  const missing = Object.keys(known).filter((f) => !(f in hashes));
  const extra = Object.keys(hashes).filter((f) => !(f in known));
  const n = Object.keys(hashes).length;
  if (changed.length || missing.length || extra.length) {
    if (changed.length) console.log(`FAIL changed: ${changed.join(', ')} (the new pictures are in screenshots-diff/)`);
    if (missing.length) console.log(`FAIL not rendered: ${missing.join(', ')}`);
    if (extra.length) console.log(`FAIL not in docs/screenshots.json: ${extra.join(', ')}`);
    console.log('If the change is meant, run npm run screenshots and commit docs/.');
    process.exit(1);
  }
  console.log(`visual ok: all ${n} pictures render pixel for pixel as in docs/screenshots.json`);
} else {
  fs.writeFileSync(HASHES, JSON.stringify(Object.fromEntries(Object.entries(hashes).sort()), null, 2) + '\n');
  console.log('docs/screenshots.json');
}
process.exit(0);
