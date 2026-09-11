import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { parseCli, resolveApp } from './app-config.mjs';

const { options, positional } = parseCli(process.argv.slice(2));
const app = await resolveApp(options.app || positional[0]);

const result = spawnSync('pnpm', ['--filter', app.packageName, 'build'], {
  cwd: app.dir,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

await access(app.distDir);
await access(`${app.distDir}/manifest`);
console.log(`已构建 ${app.slug}：${app.distDir}`);
