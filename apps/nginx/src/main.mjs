import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NginxManager } from './manager.mjs';
import { serve, PREFIX } from './server.mjs';

const dev = process.argv.includes('--dev');
if (!dev && process.getuid?.() !== 0) throw Error('Nginx 原生应用需要 root 生命周期权限以绑定 80/443');
const root = process.env.TRIM_PKGVAR || (dev ? path.resolve('.local/nginx') : null);
if (!root) throw Error('缺少 TRIM_PKGVAR');
await mkdir(root, { recursive: true, mode: 0o700 });
const declaredShare = process.env.TRIM_DATA_SHARE_PATHS?.split(':').find(value => path.basename(value) === 'nginx-for-fnos');
const shareRoot = dev ? path.resolve('.local/nginx-share') : declaredShare ||
  (path.basename(root) === 'nginx-for-fnos' && path.basename(path.dirname(root)) === '@appdata'
    ? path.join(path.dirname(path.dirname(root)), '@appshare/nginx-for-fnos') : null);
if (!shareRoot || (!dev && path.basename(path.dirname(shareRoot)) !== '@appshare')) throw Error('无法确定 nginx-for-fnos 的应用共享目录');
const appUser = process.env.TRIM_USERNAME || 'nginx_for_fnos';
const manager = new NginxManager(root, { shareRoot, workerUser: appUser });
await manager.init();
const service = await serve(manager, { assets: new URL('./web/', import.meta.url), socket: dev ? undefined : path.join(process.env.TRIM_APPDEST, 'app.sock'), devPort: dev ? 3083 : undefined });
console.log(dev ? `Nginx 管理页：http://127.0.0.1:3083${PREFIX}/` : 'Nginx 管理服务已启动');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await service.close(); await manager.close(); process.exit(0);
});
