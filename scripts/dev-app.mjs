import { spawnSync } from 'node:child_process';
import { parseCli, resolveApp } from './app-config.mjs';

const { options, positional } = parseCli(process.argv.slice(2));
const app = await resolveApp(options.app || positional[0]);
const result = spawnSync('pnpm', ['--filter', app.packageName, 'dev'], {
  cwd: app.dir,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

