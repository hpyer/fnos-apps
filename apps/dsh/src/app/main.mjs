import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve, PREFIX } from '../server/server.mjs';

const dev = process.argv.includes('--dev');
// The launcher uses a private umask for app-owned state.  DSH profiles live
// in a user-granted fnOS directory and are reopened by DSH's web worker, so
// package files must retain normal read bits.  The user's private home ACL is
// the tenant isolation boundary.
process.umask(0o022);
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
// fnOS supplies TRIM_PKGVAR. The local fallback keeps development data out of
// the repository's application payload and mirrors the packaged layout.
const root = process.env.TRIM_PKGVAR || (dev ? path.resolve('.local') : null);
if (!root) throw new Error('缺少飞牛 TRIM_PKGVAR 环境变量');
await mkdir(root, { recursive: true, mode: 0o700 });
const legacyHome = path.join(root, 'home');
const sharedHome = process.env.TRIM_DATA_SHARE_PATHS?.split(':').find(Boolean) || legacyHome;
function userHomeRoot(dataShare) {
  if (dev) return path.resolve('.local/user-homes');
  const parent = path.dirname(dataShare);
  if (path.basename(parent) !== '@appshare') throw new Error('无法从飞牛数据共享目录识别用户主目录所在卷');
  return path.dirname(parent);
}
// DSH data belongs in each fnOS user's real home. The app-owned data share is
// retained only for legacy migration and must never become a tenant HOME again.
const homes = userHomeRoot(sharedHome);
const environment = {
  ...process.env,
  HOME: sharedHome,
  DSH_HOME: path.join(sharedHome, '.dsh'),
  DSH_LEGACY_HOME: legacyHome,
  DSH_USER_HOME_ROOT: homes,
  npm_config_cache: path.join(root, 'npm-cache'),
  PNPM_HOME: path.join(root, 'pnpm'),
  PATH: `${path.join(appDirectory, 'tools/bin')}:${process.env.PATH}`,
};
const service = await serve({ root, environment, dev, socket: path.join(process.env.TRIM_APPDEST || appDirectory, 'app.sock') });
console.log(dev ? `启动页：http://127.0.0.1:3081${PREFIX}/；设置页：http://127.0.0.1:3081${PREFIX}/settings/` : 'DSH for fnOS 管理服务已启动');
// Production prepares the shared default runtime immediately. Per-user DSH
// processes remain lazy and start only when that user opens the application.
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
