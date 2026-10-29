// Generates the extension icons (icons/icon16.png, icon48.png, icon128.png):
// the console's blue rounded square with a white "Y" mark. No dependencies.
// Run with: node scripts/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BLUE = [54, 87, 232];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Signed distance helpers in unit coordinates (0..1).
function roundRectDist(x, y, r) {
  const qx = Math.abs(x - 0.5) - (0.5 - r), qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling
  const stroke = size <= 16 ? 0.085 : 0.065;
  const segs = [[0.3, 0.28, 0.5, 0.52], [0.7, 0.28, 0.5, 0.52], [0.5, 0.52, 0.5, 0.76]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) / size, uy = (y + (sy + 0.5) / ss) / size;
          if (roundRectDist(ux, uy, 0.22) <= 0) {
            bg++;
            if (Math.min(...segs.map((s) => segDist(ux, uy, ...s))) <= stroke) fg++;
          }
        }
      }
      const n = ss * ss, a = bg / n, w = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BLUE[c] * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

const dir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) fs.writeFileSync(path.join(dir, `icon${size}.png`), render(size));
console.log("icons written to", dir);
