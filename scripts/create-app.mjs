import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseCli, root } from './app-config.mjs';

const { options, positional } = parseCli(process.argv.slice(2));
const slug = options.app || positional[0];
const displayName = options.name || positional[1];
const port = options.port || positional[2] || '8080';
if (!slug || !displayName) throw new Error('用法：pnpm run create <slug> <显示名称> [默认端口]');
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('app-slug 只能包含小写字母、数字和连字符');
if (!/^\d{2,5}$/.test(port)) throw new Error('默认端口必须是数字');

const appDir = path.join(root, 'apps', slug);
const metaDir = path.join(root, 'scripts', 'apps', slug);
await access(appDir).then(() => { throw new Error(`应用目录已存在：${appDir}`); }).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
await Promise.all([
  mkdir(path.join(appDir, 'src'), { recursive: true }),
  mkdir(path.join(appDir, 'native', 'cmd'), { recursive: true }),
  mkdir(path.join(appDir, 'native', 'config'), { recursive: true }),
  mkdir(path.join(appDir, 'native', 'ui'), { recursive: true }),
  mkdir(metaDir, { recursive: true }),
]);

async function write(relativePath, content, mode) {
  const target = path.join(appDir, relativePath);
  await writeFile(target, content);
  if (mode) await chmod(target, mode);
}

await write('package.json', JSON.stringify({ name: `@fnos/${slug}`, version: '0.1.0', private: true, type: 'module', scripts: { dev: 'node build.mjs && node src/main.mjs', build: 'node build.mjs', test: 'node --test' } }, null, 2) + '\n');
await write('build.mjs', `import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.join(root, 'dist', '${slug}');
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await cp(path.join(source, 'src', 'main.mjs'), path.join(target, 'main.mjs'));
await cp(path.join(source, 'src', 'index.html'), path.join(target, 'ui', 'index.html'));
console.log('已构建 ${slug}：' + target);
`);
await write('src/main.mjs', `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(root, 'ui', 'index.html'));
const port = Number(process.env.APP_PORT || ${port});
createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}).listen(port, '127.0.0.1', () => console.log('${slug} listening on ' + port));
`);
await write('src/index.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${displayName}</title><body><h1>${displayName}</h1><p>这是一个 fnOS 应用模板。</p></body></html>\n`);
await write('CHANGELOG.md', `# Changelog\n\n此文件记录 ${displayName} 面向用户的发布变更。每次发布都必须新增与应用版本一致的 \`## [版本]\` 条目；GitHub Release 会直接使用该条目的内容。\n\n## [0.1.0]\n\n### Added\n\n- 初始 fnOS 应用版本。\n`);

await write('native/manifest', `appname = ${slug}
version = 0.1.0
display_name = ${displayName}
desc = ${displayName}
platform = x86
source = thirdparty
maintainer = hpyer
distributor = hpyer
desktop_uidir = ui
desktop_applaunchname = ${slug}.Application
checkport = false
micro_app = true
`);
await write('native/config/privilege', '{"defaults":{"run-as":"package"}}\n');
await write('native/config/resource', '{"data-share":{"shares":[]}}\n');
await write('native/cmd/main', `#!/bin/sh
set -eu
export PATH="/var/apps/nodejs_v24/target/bin:$PATH"
PID_FILE="\${TRIM_PKGVAR}/app.pid"
case "\${1:-}" in
  start) mkdir -p "\${TRIM_PKGVAR}"; nohup node "\${TRIM_APPDEST}/main.mjs" >>"\${TRIM_PKGVAR}/app.log" 2>&1 & echo $! >"$PID_FILE" ;;
  stop) [ -r "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE" ;;
  status) [ -r "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null ;;
  *) exit 1 ;;
esac
`, 0o755);
await write('native/wizard/install', `[{
  "stepTitle": "${displayName}",
  "items": [{ "type": "text", "field": "app_port", "label": "访问端口", "initValue": "${port}" }]
}]\n`);
await write('README.md', `# ${displayName}\n\n构建：pnpm run build ${slug}\n打包：pnpm run pack ${slug} --all\n`);
await writeFile(path.join(metaDir, 'meta.env'), `APP_ID=${slug}\nPACKAGE_NAME=@fnos/${slug}\nDISPLAY_NAME="${displayName}"\nTAG_PREFIX=${slug}\nFILE_PREFIX=${slug}\nRELEASE_TITLE="${displayName}"\nSUPPORTED_ARCH="x86 arm"\n`);
const install = spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
if (install.error) throw install.error;
if ((install.status ?? 1) !== 0) process.exit(install.status ?? 1);
console.log(`已创建应用 ${slug}：${appDir}`);
console.log(`下一步：pnpm run build ${slug} && pnpm run pack ${slug} --all`);
