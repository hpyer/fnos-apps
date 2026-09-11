import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseCli, resolveApp } from './app-config.mjs';

function changelogNotes(content, version) {
  const headings = [...content.matchAll(/^##\s+(?:\[v?([0-9][0-9A-Za-z.+-]*)\]|v?([0-9][0-9A-Za-z.+-]*))(?:\s+[-–—].*)?\s*$/gm)];
  const index = headings.findIndex(match => (match[1] || match[2]) === version);
  if (index < 0) throw new Error(`CHANGELOG.md 缺少版本 ${version} 的 ## [${version}] 条目`);
  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? content.length;
  const notes = content.slice(start, end).trim();
  if (!notes) throw new Error(`CHANGELOG.md 的版本 ${version} 条目不能为空`);
  return notes;
}

async function releaseNotes(app, version) {
  const changelogPath = path.join(app.dir, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8')
    .catch(() => { throw new Error(`缺少应用 CHANGELOG.md：${app.dir}/CHANGELOG.md`); });
  return changelogNotes(changelog, version);
}

const { options, positional } = parseCli(process.argv.slice(2));
const commands = new Set(['metadata', 'check', 'notes', 'tag']);
const command = commands.has(positional[0]) ? positional[0] : 'metadata';
const app = await resolveApp(options.app || (commands.has(positional[0]) ? positional[1] : positional[0]));
const version = options.version || app.version;
const expectedTag = `${app.tagPrefix}/v${version}`;

if (command === 'metadata') {
  console.log(JSON.stringify({ app: app.slug, appId: app.appId, version, tag: expectedTag, architectures: app.supportedArchitectures }, null, 2));
} else if (command === 'check') {
  if (options.version && options.version !== app.version) {
    throw new Error(`指定版本 ${options.version} 与 package.json 版本 ${app.version} 不一致`);
  }
  const tag = options.tag || process.env.GITHUB_REF_NAME || expectedTag;
  const escapedPrefix = app.tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`^${escapedPrefix}/v(.+?)(?:-r\\d+)?$`));
  const baseVersion = match?.[1];
  if (!baseVersion || baseVersion !== version) {
    throw new Error(`标签 ${tag} 与应用版本 ${version} 不匹配，期望 ${expectedTag}（可带 -rN 修订后缀）`);
  }
  const manifestVersion = app.manifestSource.match(/^\s*version\s*=\s*(.+?)\s*$/m)?.[1];
  if (manifestVersion && manifestVersion !== app.packageJson.version) {
    throw new Error(`package.json (${app.packageJson.version}) 与 manifest (${manifestVersion}) 版本不一致`);
  }
  await releaseNotes(app, version);
  console.log(`发布检查通过：${tag}`);
} else if (command === 'notes') {
  console.log(await releaseNotes(app, version));
} else if (command === 'tag') {
  const revision = options.revision ? `-r${String(options.revision).replace(/^r/, '')}` : '';
  const tag = `${app.tagPrefix}/v${version}${revision}`;
  if (options.create) {
    const result = spawnSync('git', ['tag', '-a', tag, '-m', `${app.displayName} ${version}`], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
  console.log(tag);
} else {
  throw new Error(`未知发布命令：${command}；可选 metadata、check、notes、tag`);
}
