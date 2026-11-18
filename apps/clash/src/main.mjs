import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClashManager } from './manager.mjs';
import { PREFIX, serve } from './server.mjs';

const dev = process.argv.includes('--dev');
if (!dev && process.getuid?.() === 0) throw Error('Clash 管理服务必须以应用用户运行');
const root = process.env.TRIM_PKGVAR || (dev ? path.resolve('.local/clash') : null);
if (!root) throw Error('缺少 TRIM_PKGVAR');
await mkdir(root, { recursive: true, mode: 0o700 });
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const manager = new ClashManager(root, { appRoot });
await manager.init();
let credentialKey = '';
const service = await serve(manager, {
  assets: new URL('./web/', import.meta.url),
  socket: dev ? undefined : path.join(process.env.TRIM_APPDEST, 'app.sock'),
  devPort: dev ? 3085 : undefined,
  githubFetcher: (url, options) => manager.githubFetcher(url, options),
  getCredentialKey: () => credentialKey,
  setCredentialKey: value => { credentialKey = value; },
});
console.log(dev ? `Clash 管理页：http://127.0.0.1:3085${PREFIX}/` : 'Clash 管理服务已启动');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([service.close(), manager.close()]);
    process.exit(0);
  });
}
