import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve, PREFIX } from '../server/server.mjs';

const dev = process.argv.includes('--dev');
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
// fnOS supplies TRIM_PKGVAR. The local fallback keeps development data out of
// the repository's application payload and mirrors the packaged layout.
const root = process.env.TRIM_PKGVAR || (dev ? path.resolve('.local') : null);
if (!root) throw new Error('缺少飞牛 TRIM_PKGVAR 环境变量');
await mkdir(root, { recursive: true, mode: 0o700 });
const legacyHome = path.join(root, 'home');
// The declared data share is deliberately the DSH home: user workspaces,
// settings and plugins survive an application upgrade independently of runtime state.
const sharedHome = process.env.TRIM_DATA_SHARE_PATHS?.split(':').find(Boolean) || legacyHome;
const environment = {
  ...process.env,
  HOME: sharedHome,
  DSH_HOME: path.join(sharedHome, '.dsh'),
  DSH_LEGACY_HOME: legacyHome,
  npm_config_cache: path.join(root, 'npm-cache'),
  PNPM_HOME: path.join(root, 'pnpm'),
  PATH: `${path.join(appDirectory, 'tools/bin')}:${process.env.PATH}`,
};
const service = await serve({ root, environment, dev, socket: path.join(process.env.TRIM_APPDEST || appDirectory, 'app.sock') });
console.log(dev ? `启动页：http://127.0.0.1:3081${PREFIX}/；设置页：http://127.0.0.1:3081${PREFIX}/settings/` : 'DSH for fnOS 管理服务已启动');
// Production starts the managed instance immediately. Local development keeps
// downloads opt-in unless DSH_AUTO_START is explicitly requested.
if (!dev || process.env.DSH_AUTO_START === '1') service.manager.bootstrap().catch(() => console.error('DSH 初始化失败；请在设置页查看状态并重试'));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 15_000);
  await service.stop();
  clearTimeout(timeout);
  process.exit(0);
});
