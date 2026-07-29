// Renders the sirony-connect app icons as PNGs with no external dependencies.
// Supersamples 4x for antialiasing, then encodes RGBA -> PNG via zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SS = 4; // supersample factor

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Coverage helpers operate in unit space (0..1 across the icon).
function roundedRectCover(x, y, r) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.hypot(dx, dy) <= r ? 1 : 0;
}
const circleCover = (x, y, cx, cy, r) => (Math.hypot(x - cx, y - cy) <= r ? 1 : 0);

function capsuleCover(x, y, x1, y1, x2, y2, r) {
  const vx = x2 - x1, vy = y2 - y1;
  const t = clamp01(((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy));
  return Math.hypot(x - (x1 + vx * t), y - (y1 + vy * t)) <= r ? 1 : 0;
}

/**
 * Two nodes joined by a link — a connection, drawn as flat geometry so it
 * stays legible at 48px in a launcher.
 * `pad` insets the artwork for maskable icons, whose outer 10% can be cropped.
 */
function renderIcon(size, { maskable = false } = {}) {
  const W = size * SS;
  const out = Buffer.alloc(W * W * 4);
  const bgTop = [79, 70, 229];   // indigo-600
  const bgBot = [30, 27, 75];    // indigo-950
  const fg = [255, 255, 255];
  const corner = maskable ? 0.5 : 0.22; // full bleed circle-safe for maskable
  const s = maskable ? 0.78 : 1;        // shrink artwork inside the safe zone

  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) / W;
      const y = (py + 0.5) / W;
      const bgA = roundedRectCover(x, y, corner);
      let rgb = mix(bgTop, bgBot, y);

      // Artwork coordinates, scaled about the centre.
      const ax = (x - 0.5) / s + 0.5;
      const ay = (y - 0.5) / s + 0.5;

      const link = capsuleCover(ax, ay, 0.34, 0.63, 0.66, 0.37, 0.052);
      const nodeA = circleCover(ax, ay, 0.32, 0.65, 0.135);
      const nodeB = circleCover(ax, ay, 0.68, 0.35, 0.135);
      // Punch the link out from behind the nodes for a crisp joint.
      const ring = Math.max(
        circleCover(ax, ay, 0.32, 0.65, 0.135) - circleCover(ax, ay, 0.32, 0.65, 0.075),
        circleCover(ax, ay, 0.68, 0.35, 0.135) - circleCover(ax, ay, 0.68, 0.35, 0.075),
      );
      const art = Math.max(link * (1 - Math.max(nodeA, nodeB)), ring);

      if (art > 0) rgb = fg;
      const i = (py * W + px) * 4;
      out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2];
      out[i + 3] = Math.round(bgA * 255);
    }
  }

  // Box-downsample the supersampled buffer.
  const dst = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = out[i + 3] / 255;
          r += out[i] * al; g += out[i + 1] * al; b += out[i + 2] * al; a += al;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      dst[i] = a > 0 ? Math.round(r / a) : 0;
      dst[i + 1] = a > 0 ? Math.round(g / a) : 0;
      dst[i + 2] = a > 0 ? Math.round(b / a) : 0;
      dst[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, dst);
}

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(`${dir}/icon-${size}.png`, renderIcon(size));
}
writeFileSync(`${dir}/maskable-512.png`, renderIcon(512, { maskable: true }));
writeFileSync(`${dir}/apple-touch-icon.png`, renderIcon(180));
console.log('icons written to', dir);
