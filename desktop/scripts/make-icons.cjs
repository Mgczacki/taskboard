// Draws the app icon (build/icon.icns) and the menu-bar icon (build/trayTemplate.png, @2x) without image libraries:
// pixels are computed here, written as PNG with zlib, resized with macOS `sips` and packed with `iconutil`.
// The picture is a small board: three columns of cards on a dark rounded square.
const { execFileSync } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const zlib = require('node:zlib');

const OUT = join(__dirname, '..', 'build');
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgba) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// coverage of a rounded rectangle at a point (1 inside, 0 outside, smooth over one pixel)
const rrect = (px, py, x, y, w, h, r) => {
  const cx = Math.max(x + r, Math.min(px, x + w - r)), cy = Math.max(y + r, Math.min(py, y + h - r));
  const d = Math.hypot(px - cx, py - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
};
function draw(size, shapes) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const s of shapes) {
      const cov = rrect(x + 0.5, y + 0.5, s.x, s.y, s.w, s.h, s.r); if (!cov) continue;
      const col = typeof s.color === 'function' ? s.color(y / size) : s.color, sa = cov * (col[3] ?? 1);
      r = col[0] * sa + r * (1 - sa); g = col[1] * sa + g * (1 - sa); b = col[2] * sa + b * (1 - sa); a = sa + a * (1 - sa);
    }
    const i = (y * size + x) * 4;
    buf[i] = a ? Math.round(r / a) : 0; buf[i + 1] = a ? Math.round(g / a) : 0; buf[i + 2] = a ? Math.round(b / a) : 0; buf[i + 3] = Math.round(a * 255);
  }
  return png(size, size, buf);
}

// app icon, 1024 px, following the macOS icon grid (824 px body with margins)
const S = 1024, m = 100, body = S - 2 * m;
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const cols = [[240, 168, 48], [88, 166, 255], [63, 185, 80]];     // amber, blue, green: waiting, working, done
const heights = [[150, 110, 130], [130, 150], [110, 150, 120, 100]];
const shapes = [{ x: m, y: m, w: body, h: body, r: 185, color: t => mix([40, 46, 58], [16, 20, 27], t) }];
const colW = 196, gap = 50, left = m + (body - (3 * colW + 2 * gap)) / 2, top = m + 150;
cols.forEach((c, i) => {
  const x = left + i * (colW + gap);
  shapes.push({ x, y: top - 70, w: colW, h: 34, r: 17, color: [...c, 1] });  // column header
  let y = top;
  for (const h of heights[i]) { shapes.push({ x, y, w: colW, h, r: 26, color: [...mix(c, [22, 27, 34], 0.55), 1] }); y += h + 26; }
});
writeFileSync(join(OUT, 'icon-1024.png'), draw(S, shapes));

// .icns from the 1024 px image
const set = join(OUT, 'icon.iconset'); rmSync(set, { recursive: true, force: true }); mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) {
  const px = s * k, name = `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`;
  execFileSync('sips', ['-z', String(px), String(px), join(OUT, 'icon-1024.png'), '--out', join(set, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(OUT, 'icon.icns')]);
rmSync(set, { recursive: true, force: true });

// menu-bar icon: black shapes on transparent ("Template" images are recoloured by macOS for light/dark menu bars)
function tray(size) {
  const u = size / 18, black = [0, 0, 0, 1];
  return draw(size, [
    { x: 2 * u, y: 3 * u, w: 4 * u, h: 12 * u, r: 1.2 * u, color: black },
    { x: 7 * u, y: 3 * u, w: 4 * u, h: 8 * u, r: 1.2 * u, color: black },
    { x: 12 * u, y: 3 * u, w: 4 * u, h: 10 * u, r: 1.2 * u, color: black },
  ]);
}
writeFileSync(join(OUT, 'trayTemplate.png'), tray(18));
writeFileSync(join(OUT, 'trayTemplate@2x.png'), tray(36));
console.log('icons written to', OUT);
