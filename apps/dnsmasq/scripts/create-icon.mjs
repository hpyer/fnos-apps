import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const label = Buffer.from(type); const body = Buffer.concat([label, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, body, crc]); }
function png(size) {
  const rows = []; const pixel = (x, y) => { const center = size / 2; const radius = size * .2; const blue = [54, 88, 180, 255]; const light = [225, 238, 255, 255]; const cyan = [143, 224, 255, 255]; let color = blue;
    const points = [size * .28, size * .5, size * .72]; const line = Math.abs(y - size * .36) < size * .025 || Math.abs(y - size * .64) < size * .025; const vertical = points.some(x0 => Math.abs(x - x0) < size * .018 && y > size * .36 && y < size * .64); const top = points.some(x0 => Math.hypot(x - x0, y - size * .36) < size * .07); const bottom = points.some(x0 => Math.hypot(x - x0, y - size * .64) < size * .07);
    if (line || vertical || top) color = light; if (bottom) color = cyan; if (Math.hypot(x - center, y - center) < radius / 3) color = blue; return color; };
  for (let y = 0; y < size; y++) { const row = Buffer.alloc(1 + size * 4); for (let x = 0; x < size; x++) pixel(x, y).forEach((value, index) => { row[1 + x * 4 + index] = value; }); rows.push(row); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
await writeFile(path.join(root, 'native/ICON_256.PNG'), png(256)); await writeFile(path.join(root, 'native/ICON.PNG'), png(64));
await writeFile(path.join(root, 'native/app/ui/images/dnsmasq_256.png'), png(256)); await writeFile(path.join(root, 'native/app/ui/images/dnsmasq_64.png'), png(64));
