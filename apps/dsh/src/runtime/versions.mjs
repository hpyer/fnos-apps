import { mkdir, readdir, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import semver from 'semver';
import { readJson, writeJson } from '../shared/config.mjs';
import { run } from '../shared/command.mjs';

export const PACKAGE = '@deepseek-ai/dsh';

// Downloads and install requests always use a complete semver, never a tag.
// Tags are resolved to a precise version before this layer mutates disk state.
export function exactVersion(version) {
  if (typeof version !== 'string' || semver.valid(version) !== version) throw new Error('必须使用完整的 DSH 精确版本号');
  return version;
}
export class Versions {
  constructor(root, environment, { execute = run, fetcher = fetch, signal } = {}) {
    this.root = root;
    this.directory = path.join(root, 'runtimes', 'versions');
    this.environment = environment;
    this.execute = execute;
    this.fetcher = fetcher;
    this.signal = signal;
  }
  location(version) { return path.join(this.directory, exactVersion(version)); }
  entry(version) { return path.join(this.location(version), 'node_modules', PACKAGE, 'lib/bin.js'); }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const items = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || semver.valid(entry.name) !== entry.name) continue;
      const item = await readJson(path.join(this.directory, entry.name, 'installed.json'), null);
      if (item?.version === entry.name) items.push(item);
    }
    return items.sort((a, b) => semver.rcompare(a.version, b.version));
  }
  async metadata(config, selector) {
    const timeout = AbortSignal.timeout(30_000);
    const response = await this.fetcher(`${config.registry}/${encodeURIComponent(PACKAGE)}/${encodeURIComponent(selector)}`, { signal: this.signal ? AbortSignal.any([timeout, this.signal]) : timeout });
    if (!response.ok) throw new Error(`标签/版本 ${selector} 查询失败：HTTP ${response.status}`);
    const data = await response.json();
    exactVersion(data.version);
    if (data.name !== PACKAGE || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(data.dist?.integrity ?? '')) throw new Error('registry 返回了无效的包名或完整性信息');
    return { version: data.version, integrity: data.dist.integrity };
  }
  async check(config) {
    return Promise.all(config.channels.map(async channel => {
      try { return { channel, ...await this.metadata(config, channel) }; }
      catch (error) { return { channel, error: error.message }; }
    }));
  }
  async install(config, version, onProgress = () => {}) {
    const report = progress => { try { onProgress(progress); } catch { /* UI progress must never fail an install */ } };
    exactVersion(version);
    report({ step: 1, total: 4, stage: '解析版本信息' });
    if ((await this.list()).some(x => x.version === version)) {
      report({ step: 4, total: 4, stage: '版本已下载' });
      return;
    }
    const release = await this.metadata(config, version);
    if (release.version !== version) throw new Error('精确版本解析不一致');
    // Install into a private staging directory. Nothing in versions/ is
    // replaced until package metadata, lockfile integrity and entrypoint pass.
    const staging = path.join(this.root, 'runtimes', `staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeJson(path.join(staging, 'package.json'), { name: 'managed-dsh-runtime', private: true, dependencies: { [PACKAGE]: version } });
      report({ step: 2, total: 4, stage: '下载并安装运行时' });
      await this.execute('npm', ['install', '--prefix', staging, '--omit=dev', '--no-audit', '--no-fund', '--registry', config.registry], {
        cwd: staging, env: { ...this.environment, npm_config_registry: config.registry }, timeout: 900_000, signal: this.signal,
      });
      report({ step: 3, total: 4, stage: '校验运行时完整性' });
      const installed = await readJson(path.join(staging, 'node_modules', PACKAGE, 'package.json'));
      const lock = await readJson(path.join(staging, 'package-lock.json'));
      if (installed.name !== PACKAGE || installed.version !== version || lock.packages?.[`node_modules/${PACKAGE}`]?.integrity !== release.integrity) throw new Error('安装后的包名、版本或 integrity 校验失败');
      await readFile(path.join(staging, 'node_modules', PACKAGE, 'lib/bin.js'));
      await writeJson(path.join(staging, 'installed.json'), { ...release, installedAt: new Date().toISOString() });
      report({ step: 4, total: 4, stage: '保存已安装版本' });
      await rename(staging, this.location(version));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async remove(version) {
    exactVersion(version);
    if (!(await this.list()).some(item => item.version === version)) throw new Error('该版本尚未安装');
    await rm(this.location(version), { recursive: true });
  }
}
