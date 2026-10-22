import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { FFmpegManager } from './manager.mjs';
import { serve, PREFIX } from './server.mjs';

const dev = process.argv.includes('--dev');
if (!dev && process.getuid?.() === 0) throw Error('FFmpeg 管理服务必须以应用用户运行');
const root = process.env.TRIM_PKGVAR || (dev ? path.resolve('.local/ffmpeg') : null);
if (!root) throw Error('缺少 TRIM_PKGVAR');
await mkdir(root, { recursive: true, mode: 0o755 });
const manager = new FFmpegManager(root);
await manager.init();
const service = await serve(manager, { assets: new URL('./web/', import.meta.url), socket: dev ? undefined : path.join(process.env.TRIM_APPDEST, 'app.sock'), devPort: dev ? 3084 : undefined });
console.log(dev ? `版本管理页：http://127.0.0.1:3084${PREFIX}/` : 'FFmpeg 管理服务已启动');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await Promise.all([service.close(), manager.close()]); process.exit(0);
});
