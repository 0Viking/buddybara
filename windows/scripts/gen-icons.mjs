// Draws the buddy — a capybara with a mikan on its head — into the PNG/ICO set
// Tauri needs. No dependencies: the icons are rasterised here and encoded with
// node:zlib, so the app icon stays "drawn in code".
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── The capybara ──────────────────────────────────────────────────────────────
//
// Shapes in unit coordinates (0..1 across the icon), painted back to front. A
// thin dark rim around the silhouette keeps it readable on a light taskbar.

const SS = 4; // supersampling factor, per axis

const RIM = [43, 26, 16];
const EAR = [123, 75, 42];
const EAR_IN = [90, 52, 28];
const HEAD_TOP = [176, 127, 85];
const HEAD_BOTTOM = [148, 101, 63];
const MUZZLE = [120, 78, 48];
const NOSE = [58, 36, 24];
const INK = [30, 20, 16];
const WHITE = [255, 255, 255];
const BLUSH = [242, 140, 130];
const MIKAN_LIGHT = [255, 186, 74];
const MIKAN_DARK = [238, 118, 18];
const LEAF = [76, 175, 80];
const STEM = [93, 64, 55];

const RIM_W = 0.022;

const ellipse = (u, v, cx, cy, rx, ry) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
const circle = (u, v, cx, cy, r) => ellipse(u, v, cx, cy, r, r);

/** Boxy rounded head: a superellipse, the capybara's square face. */
const HEAD = { cx: 0.5, cy: 0.62, rx: 0.36, ry: 0.29, n: 3.2 };
function inHead(u, v, grow = 0) {
  const x = Math.abs(u - HEAD.cx) / (HEAD.rx + grow);
  const y = Math.abs(v - HEAD.cy) / (HEAD.ry + grow);
  return x ** HEAD.n + y ** HEAD.n <= 1;
}

const EARS = [0.2, 0.8].map((cx) => ({ cx, cy: 0.375, rx: 0.05, ry: 0.044 }));
const MIKAN = { cx: 0.5, cy: 0.255, r: 0.155 };

/** A leaf tilted up and to the right, on top of the mikan. */
function inLeaf(u, v) {
  const a = (-25 * Math.PI) / 180;
  const du = u - 0.575;
  const dv = v - 0.108;
  const x = du * Math.cos(a) + dv * Math.sin(a);
  const y = -du * Math.sin(a) + dv * Math.cos(a);
  return (x / 0.065) ** 2 + (y / 0.03) ** 2 <= 1;
}

/** The colour at one point, or null outside the drawing. */
function sample(u, v) {
  const silhouette =
    inHead(u, v, RIM_W) ||
    EARS.some((e) => ellipse(u, v, e.cx, e.cy, e.rx + RIM_W, e.ry + RIM_W)) ||
    circle(u, v, MIKAN.cx, MIKAN.cy, MIKAN.r + RIM_W) ||
    inLeaf(u, v);
  if (!silhouette) return null;

  let col = RIM;
  for (const e of EARS) {
    if (ellipse(u, v, e.cx, e.cy, e.rx, e.ry)) col = EAR;
    if (ellipse(u, v, e.cx, e.cy + 0.005, e.rx * 0.57, e.ry * 0.53)) col = EAR_IN;
  }
  if (inHead(u, v)) {
    const t = Math.min(1, Math.max(0, (v - (HEAD.cy - HEAD.ry)) / (2 * HEAD.ry)));
    col = HEAD_TOP.map((c, i) => c + (HEAD_BOTTOM[i] - c) * t);
    // The long, boxy snout that makes a capybara a capybara.
    const sx = Math.abs(u - 0.5) / 0.25;
    const sy = Math.abs(v - 0.715) / 0.165;
    if (sx ** 3 + sy ** 3 <= 1) col = MUZZLE;
    for (const cx of [0.25, 0.75]) {
      if (circle(u, v, cx, 0.6, 0.036)) col = col.map((c, i) => c * 0.45 + BLUSH[i] * 0.55);
    }
    for (const cx of [0.44, 0.56]) if (ellipse(u, v, cx, 0.645, 0.027, 0.019)) col = NOSE;
    if (ellipse(u, v, 0.5, 0.715, 0.007, 0.034)) col = NOSE;
    for (const cx of [0.33, 0.67]) {
      if (circle(u, v, cx, 0.5, 0.027)) col = INK;
      if (circle(u, v, cx - 0.008, 0.492, 0.009)) col = WHITE;
    }
  }
  if (circle(u, v, MIKAN.cx, MIKAN.cy, MIKAN.r)) {
    // Lit from the top left.
    const d = Math.hypot(u - (MIKAN.cx - 0.05), v - (MIKAN.cy - 0.05)) / (MIKAN.r * 1.4);
    const t = Math.min(1, d);
    col = MIKAN_LIGHT.map((c, i) => c + (MIKAN_DARK[i] - c) * t);
  }
  if (ellipse(u, v, 0.5, 0.105, 0.014, 0.026)) col = STEM;
  if (inLeaf(u, v)) col = LEAF;
  return col;
}

function renderCapybara(size) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      if (!hits) continue;
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / hits);
      px[o + 1] = Math.round(g / hits);
      px[o + 2] = Math.round(b / hits);
      px[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderCapybara(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
