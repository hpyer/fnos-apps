import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OfficialRepository, channelName } from './official.mjs';

const DEFAULTS = { notificationEnabled: false, notificationPath: '', intervalMinutes: 30, lastHandled: '', lastResult: '', channel: 'stable' };
const SITE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.conf$/;
const VERSION = /^[0-9][a-zA-Z0-9._-]{0,39}$/;
const TEMP_PATHS = [
  ['client_body_temp_path', 'client_body'],
  ['proxy_temp_path', 'proxy'],
  ['fastcgi_temp_path', 'fastcgi'],
  ['uwsgi_temp_path', 'uwsgi'],
  ['scgi_temp_path', 'scgi']
];

export function siteName(value) {
  if (typeof value !== 'string' || !SITE.test(value) || value.includes('..')) throw Error('站点文件名必须是安全的 .conf 文件名');
  return value;
}
export function versionName(value) {
  if (typeof value !== 'string' || !VERSION.test(value) || value.includes('..')) throw Error('版本号格式无效');
  return value;
}
function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some(x => !Number.isInteger(x))) return 0;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
export function notificationSettings(input) {
  if (!input || typeof input !== 'object') throw Error('通知设置无效');
  const notificationEnabled = input.notificationEnabled === true;
  const notificationPath = String(input.notificationPath || '').trim();
  const intervalMinutes = Number(input.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw Error('检查间隔须为 1–1440 分钟');
  if (notificationPath && (!path.isAbsolute(notificationPath) || notificationPath.includes('\0'))) throw Error('通知文件须使用绝对路径');
  if (notificationEnabled && !notificationPath) throw Error('启用通知前请填写文件路径');
  return { notificationEnabled, notificationPath, intervalMinutes };
}
// Only server blocks are accepted at the top level. nginx -t remains the
// authoritative syntax and capability check for the full configuration.
export function serverOnly(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 262144) throw Error('配置内容为空或超过 256 KiB');
  let clean = '', quote = '', comment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment) { if (c === '\n') { comment = false; clean += '\n'; } continue; }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = ''; continue; }
    if (c === '#') { comment = true; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    clean += c;
    if (c === '\\' && next) { clean += next; i++; }
  }
  let depth = 0, top = '', blocks = 0;
  for (const c of clean) {
    if (c === '{') {
      if (depth === 0) { if (top.trim() !== 'server') throw Error('站点文件顶层只能包含 server 块'); blocks++; top = ''; }
      depth++;
    } else if (c === '}') { if (--depth < 0) throw Error('配置大括号不匹配'); }
    else if (depth === 0) top += c;
  }
  if (quote || depth !== 0 || top.trim() || !blocks) throw Error('站点文件顶层只能包含完整的 server 块');
  return source;
}
async function atomic(file, data, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
function command(binary, args, { timeout = 15000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const collect = data => { output = (output + data.toString()).slice(-8192); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(Error(output.trim() || `${binary} 退出状态 ${code}`)); } });
  });
}
async function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function fileHash(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function openDirectory(file) { return open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }

export class NginxManager {
  constructor(root, { shareRoot = root, platform = process.platform, arch = process.arch, run = command, repository } = {}) {
    this.root = root;
    this.shareRoot = shareRoot; this.platform = platform; this.arch = arch; this.run = run; this.repository = repository || new OfficialRepository({ platform, arch });
    this.sites = path.join(shareRoot, 'sites'); this.versions = path.join(shareRoot, 'versions');
    this.runtimeVersions = path.join(root, 'runtime-versions');
    this.logs = path.join(shareRoot, 'logs'); this.temp = path.join(shareRoot, 'temp'); this.config = path.join(shareRoot, 'nginx.conf');
    this.stateFile = path.join(root, 'state.json'); this.pidFile = path.join(root, 'nginx.pid');
    this.state = { ...DEFAULTS, activeVersion: '', trustedVersions: {} }; this.child = null; this.busy = Promise.resolve(); this.timer = null;
  }
  exclusive(task) { const next = this.busy.then(task, task); this.busy = next.catch(() => {}); return next; }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.shareRoot, { recursive: true, mode: 0o755 });
    await mkdir(this.runtimeVersions, { recursive: true, mode: 0o700 });
    try { this.state = { ...this.state, ...JSON.parse(await readFile(this.stateFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!this.state.trustedVersions || typeof this.state.trustedVersions !== 'object' || Array.isArray(this.state.trustedVersions)) this.state.trustedVersions = {};
    await this.migrateLegacy();
    for (const directory of [this.sites, this.versions, this.logs]) await mkdir(directory, { recursive: true, mode: directory === this.versions ? 0o700 : 0o750 });
    await this.ensureTempDirectories();
    await this.prepareConfig();
    if (this.state.activeVersion) await this.start().catch(error => { this.state.lastResult = `启动失败：${error.message}`; });
    this.schedule();
  }
  async migrateLegacy() {
    if (path.resolve(this.root) === path.resolve(this.shareRoot)) return;
    const oldVersions = path.join(this.root, 'versions');
    if (await exists(oldVersions)) {
      for (const version of (await readdir(oldVersions)).filter(name => VERSION.test(name))) {
        const source = path.join(oldVersions, version, 'nginx');
        if (!await exists(source)) continue;
        if (!this.state.trustedVersions[version]) this.state.trustedVersions[version] = await fileHash(source);
      }
      await this.saveState();
    }
    for (const name of ['sites', 'versions', 'logs']) {
      const source = path.join(this.root, name), target = path.join(this.shareRoot, name);
      if (!await exists(source)) continue;
      if (!await exists(target)) { await rename(source, target); continue; }
      for (const entry of await readdir(source)) {
        if (!await exists(path.join(target, entry))) await rename(path.join(source, entry), path.join(target, entry));
      }
      try { await rmdir(source); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    }
    if (await exists(path.join(this.root, 'nginx.conf')) && !await exists(this.config)) await rename(path.join(this.root, 'nginx.conf'), this.config);
  }
  async saveState() { await atomic(this.stateFile, JSON.stringify(this.state, null, 2) + '\n'); }
  tempDirectives() { return TEMP_PATHS.map(([directive, name]) => `  ${directive} ${path.join(this.temp, name)};`); }
  async ensureTempDirectories() {
    await mkdir(this.temp, { recursive: true, mode: 0o711 });
    for (const [, name] of TEMP_PATHS) {
      const location = path.join(this.temp, name);
      await mkdir(location, { recursive: true, mode: 0o700 });
      const directory = await openDirectory(location);
      try {
        await directory.chmod(0o700);
      } finally { await directory.close(); }
    }
  }
  async prepareConfig() {
    let current;
    try { current = await readFile(this.config, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await this.writeConfig(this.config, this.sites); return; }
    let updated = current;
    if (path.resolve(this.root) !== path.resolve(this.shareRoot)) {
      updated = updated.replaceAll(`${this.root}/sites`, `${this.shareRoot}/sites`)
        .replaceAll(`${this.root}/logs`, `${this.shareRoot}/logs`);
    }
    // A non-root master cannot change worker identities; discard the old generated directive.
    updated = updated.replace(/^[ \t]*user[ \t]+[a-z_][a-z0-9_-]*(?:[ \t]+[a-z_][a-z0-9_-]*)?[ \t]*;[ \t]*\r?\n/, '');
    const uncommented = updated.split('\n').map(line => line.split('#', 1)[0]).join('\n');
    const missing = this.tempDirectives().filter(line => !new RegExp(`\\b${line.trim().split(' ', 1)[0]}\\s+`).test(uncommented));
    if (missing.length) {
      const http = updated.match(/(^|\n)[ \t]*http[ \t\r\n]*\{/);
      if (http) {
        const position = http.index + http[0].lastIndexOf('{') + 1;
        updated = `${updated.slice(0, position)}\n${missing.join('\n')}${updated.slice(position)}`;
      }
    }
    if (updated !== current) await atomic(this.config, updated);
  }
  async writeConfig(file, siteDirectory) {
    const conf = `pid ${this.pidFile};\nerror_log ${path.join(this.logs, 'error.log')} warn;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp {\n  access_log ${path.join(this.logs, 'access.log')};\n${this.tempDirectives().join('\n')}\n  include ${siteDirectory}/*.conf;\n}\n`;
    await atomic(file, conf);
  }
  async candidateConfig(siteDirectory, current) {
    if (current === undefined) current = await readFile(this.config, 'utf8');
    const managedInclude = `include ${this.sites}/*.conf;`;
    const lines = current.split('\n');
    const index = lines.findIndex(line => line.split('#', 1)[0].includes(managedInclude));
    if (index < 0) throw Error(`主配置须保留 ${managedInclude}，才能校验站点文件`);
    lines[index] = lines[index].replace(managedInclude, `include ${siteDirectory}/*.conf;`);
    return lines.join('\n');
  }
  binary(version = this.state.activeVersion) { if (!version) throw Error('请先安装并选择 Nginx 版本'); return path.join(this.runtimeVersions, versionName(version), 'nginx'); }
  async ensureRuntime(version) {
    versionName(version);
    const expected = this.state.trustedVersions[version];
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error(`版本 ${version} 缺少可信校验记录，请重新从官方下载安装`);
    const source = path.join(this.versions, version, 'nginx');
    if (await fileHash(source) !== expected) throw Error(`版本 ${version} 的文件已变化，请重新从官方下载安装`);
    const directory = path.join(this.runtimeVersions, version), target = path.join(directory, 'nginx');
    if (await exists(target) && await fileHash(target) === expected) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `nginx-${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary);
      if (await fileHash(temporary) !== expected) throw Error(`版本 ${version} 复制校验失败`);
      await chmod(temporary, 0o700);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  args(conf = this.config) { return ['-p', `${this.shareRoot}/`, '-e', path.join(this.logs, 'error.log'), '-c', conf]; }
  async validate(conf = this.config, version) { await this.ensureTempDirectories(); return this.run(this.binary(version), [...this.args(conf), '-t']); }
  async status() {
    const versions = await readdir(this.versions);
    const siteFiles = await readdir(this.sites);
    return { running: !!this.child && await processAlive(this.child.pid), activeVersion: this.state.activeVersion, versions: versions.filter(VERSION.test.bind(VERSION)).sort(), channel: this.state.channel,
      sites: siteFiles.filter(x => SITE.test(x)).sort(),
      disabledSites: siteFiles.filter(x => x.endsWith('.disabled') && SITE.test(x.slice(0, -9))).map(x => x.slice(0, -9)).sort(),
      settings: { notificationEnabled: this.state.notificationEnabled, notificationPath: this.state.notificationPath, intervalMinutes: this.state.intervalMinutes }, lastHandled: this.state.lastHandled, lastResult: this.state.lastResult };
  }
  async start() {
    if (this.child && await processAlive(this.child.pid)) return;
    await this.ensureRuntime(this.state.activeVersion);
    await this.validate();
    const binary = this.binary();
    const log = await open(path.join(this.logs, 'process.log'), 'a', 0o600);
    try {
      this.child = spawn(binary, [...this.args(), '-g', 'daemon off;'], { stdio: ['ignore', log.fd, log.fd], shell: false });
      const child = this.child;
      child.once('exit', () => { if (this.child === child) this.child = null; });
      await new Promise((resolve, reject) => { child.once('error', reject); setTimeout(() => processAlive(child.pid).then(alive => alive ? resolve() : reject(Error('Nginx 启动后立即退出'))), 800); });
      this.state.lastResult = 'Nginx 已启动'; await this.saveState();
    } finally { await log.close(); }
  }
  async stop() {
    const child = this.child; if (!child) return;
    child.kill('SIGQUIT');
    for (let i = 0; i < 50 && await processAlive(child.pid); i++) await new Promise(r => setTimeout(r, 100));
    if (await processAlive(child.pid)) child.kill('SIGTERM');
    if (this.child === child) this.child = null;
  }
  async reload() {
    await this.validate();
    if (!this.child || !await processAlive(this.child.pid)) throw Error('Nginx 未运行');
    if (!this.child.kill('SIGHUP')) throw Error('无法向 Nginx 发送重载信号');
    this.state.lastResult = `已发送平滑重载信号：${new Date().toISOString()}`;
    await this.saveState();
  }
  async readConfig() { return readFile(this.config, 'utf8'); }
  async saveConfig(source) { return this.exclusive(async () => {
    if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 262144) throw Error('主配置内容为空或超过 256 KiB');
    const previous = await this.readConfig();
    const candidate = path.join(this.root, `candidate-${randomUUID()}`);
    await mkdir(candidate, { mode: 0o700 });
    try {
      const candidateFile = path.join(candidate, 'nginx.conf');
      await atomic(candidateFile, await this.candidateConfig(this.sites, source));
      await this.validate(candidateFile);
      await atomic(this.config, source);
      try { if (this.child) await this.reload(); }
      catch (error) { await atomic(this.config, previous); throw error; }
      if (!this.child) { this.state.lastResult = '已保存主配置，Nginx 未运行'; await this.saveState(); }
      return { ok: true };
    } finally { await rm(candidate, { recursive: true, force: true }); }
  }); }
  async siteFiles(name) {
    const active = path.join(this.sites, siteName(name)), inactive = `${active}.disabled`;
    const enabled = await exists(active), disabled = await exists(inactive);
    if (enabled && disabled) throw Error(`站点 ${name} 同时存在启用和禁用文件`);
    return { active, inactive, enabled, disabled, current: enabled ? active : inactive };
  }
  async validateSiteCandidate(name, source) {
    const candidate = path.join(this.root, `candidate-${randomUUID()}`);
    await mkdir(path.join(candidate, 'sites'), { recursive: true });
    try {
      for (const file of (await readdir(this.sites)).filter(x => SITE.test(x))) await copyFile(path.join(this.sites, file), path.join(candidate, 'sites', file));
      await atomic(path.join(candidate, 'sites', name), source);
      await atomic(path.join(candidate, 'nginx.conf'), await this.candidateConfig(path.join(candidate, 'sites')));
      await this.validate(path.join(candidate, 'nginx.conf'));
    } finally { await rm(candidate, { recursive: true, force: true }); }
  }
  async listSite(name) {
    const files = await this.siteFiles(name);
    if (!files.enabled && !files.disabled) throw Error('站点不存在');
    return readFile(files.current, 'utf8');
  }
  async saveSite(name, source) { return this.exclusive(async () => {
    siteName(name); serverOnly(source);
    const files = await this.siteFiles(name);
    const target = files.disabled ? files.inactive : files.active;
    const previous = files.enabled || files.disabled ? await readFile(target, 'utf8') : null;
    await this.validateSiteCandidate(name, source);
    await atomic(target, source);
    try { if (!files.disabled && this.child) await this.reload(); }
    catch (error) {
      if (previous === null) await rm(target, { force: true });
      else await atomic(target, previous);
      throw error;
    }
    if (!this.child) { this.state.lastResult = `已保存 ${name}，Nginx 未运行`; await this.saveState(); }
    return { ok: true };
  }); }
  async deleteSite(name) { return this.exclusive(async () => {
    const files = await this.siteFiles(name);
    if (!files.enabled && !files.disabled) throw Error('站点不存在');
    const old = await readFile(files.current, 'utf8');
    await rm(files.current);
    try { if (files.enabled && this.child) await this.reload(); }
    catch (error) { await atomic(files.current, old); throw error; }
    return { ok: true };
  }); }
  async setSiteEnabled(name, enabled) { return this.exclusive(async () => {
    if (typeof enabled !== 'boolean') throw Error('站点状态无效');
    const files = await this.siteFiles(name);
    if (!files.enabled && !files.disabled) throw Error('站点不存在');
    if (files.enabled === enabled) return { ok: true, enabled };
    if (enabled) await this.validateSiteCandidate(name, serverOnly(await readFile(files.inactive, 'utf8')));
    const from = enabled ? files.inactive : files.active;
    const to = enabled ? files.active : files.inactive;
    await rename(from, to);
    try { if (this.child) await this.reload(); }
    catch (error) { await rename(to, from); throw error; }
    return { ok: true, enabled };
  }); }
  async checkOfficial(channel = this.state.channel) {
    channelName(channel);
    const entry = await this.repository.latest(channel);
    this.state.channel = channel; await this.saveState();
    const installed = await readdir(this.versions);
    return { version: entry.version, packageVersion: entry.packageVersion, channel, distribution: entry.distribution,
      installed: installed.includes(entry.version), updateAvailable: !this.state.activeVersion ||
        compareVersions(entry.version, this.state.activeVersion) > 0 };
  }
  async installOfficial(channel = this.state.channel) { return this.exclusive(async () => {
    channelName(channel);
    const entry = await this.repository.latest(channel);
    versionName(entry.version);
    const directory = path.join(this.versions, entry.version);
    try { await access(directory); throw Error('该版本已安装'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stage = path.join(this.root, `download-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
      const packageFile = path.join(stage, 'nginx.deb');
      await this.repository.download(entry, packageFile);
      const extracted = path.join(stage, 'extracted');
      await mkdir(extracted);
      await this.run('dpkg-deb', ['-x', packageFile, extracted], { timeout: 120000 });
      const source = path.join(extracted, 'usr/sbin/nginx');
      const fd = await open(source, 'r');
      try {
        const head = Buffer.alloc(20); await fd.read(head, 0, 20, 0);
        const expected = this.arch === 'x64' ? 62 : this.arch === 'arm64' ? 183 : -1;
        if (head.toString('hex', 0, 4) !== '7f454c46' || head[4] !== 2 || head[5] !== 1 || head.readUInt16LE(18) !== expected) throw Error('官方软件包中的二进制架构不匹配');
      } finally { await fd.close(); }
      await mkdir(directory, { mode: 0o700 });
      const target = path.join(directory, 'nginx');
      try {
        await copyFile(source, target); await chmod(target, 0o700);
        const actual = await this.run(target, ['-v']);
        if (!actual.includes(`nginx/${entry.version}`)) throw Error('下载的 Nginx 版本与仓库信息不符');
        const details = await this.run(target, ['-V']);
        await atomic(path.join(directory, 'build.txt'), `${entry.channel} · ${entry.packageVersion} · ${entry.distribution}\n${details}\n`);
        this.state.trustedVersions[entry.version] = await fileHash(target);
        await this.ensureRuntime(entry.version);
      } catch (error) {
        delete this.state.trustedVersions[entry.version];
        await rm(directory, { recursive: true, force: true });
        await rm(path.join(this.runtimeVersions, entry.version), { recursive: true, force: true });
        throw error;
      }
      this.state.channel = channel; await this.saveState();
      return { version: entry.version, channel };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }); }
  async activateVersion(version) { return this.exclusive(async () => {
    versionName(version); await this.ensureRuntime(version); await this.validate(this.config, version);
    const previous = this.state.activeVersion;
    await this.stop(); this.state.activeVersion = version;
    try { await this.start(); }
    catch (error) {
      this.state.activeVersion = previous; await this.saveState();
      if (previous) await this.start().catch(() => {});
      throw error;
    }
    return { activeVersion: version };
  }); }
  async removeVersion(version) { return this.exclusive(async () => {
    versionName(version); if (version === this.state.activeVersion) throw Error('不能删除正在使用的版本');
    await rm(path.join(this.versions, version), { recursive: true, force: true });
    await rm(path.join(this.runtimeVersions, version), { recursive: true, force: true });
    delete this.state.trustedVersions[version]; await this.saveState();
    return { ok: true };
  }); }
  async setNotification(input) { return this.exclusive(async () => {
    Object.assign(this.state, notificationSettings(input)); await this.saveState(); this.schedule();
    return { ok: true };
  }); }
  async testNotificationPath(file) {
    if (!path.isAbsolute(file) || file.includes('\0')) throw Error('请使用绝对路径');
    const parent = path.dirname(file), probe = path.join(parent, `.nginx-test-${randomUUID()}`);
    try {
      await writeFile(probe, 'test\n', { flag: 'wx', mode: 0o600 });
      if (await readFile(probe, 'utf8') !== 'test\n') throw Error('测试文件读取失败');
    } finally { await rm(probe, { force: true }); }
    try {
      const handle = await open(file, 'r+');
      try { if ((await handle.stat()).size > 4096) throw Error('通知文件过大'); await handle.readFile('utf8'); } finally { await handle.close(); }
      return { created: false, message: '目录及通知文件可读写' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const handle = await open(file, 'wx+', 0o664);
      const token = `test:${Date.now()}\n`;
      try { await handle.writeFile(token); await handle.sync(); }
      finally { await handle.close(); }
      if (await readFile(file, 'utf8') !== token) throw Error('通知文件写入后读回不一致');
      return { created: true, message: '已创建通知文件，读写测试通过' };
    }
  }
  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.state.notificationEnabled) return;
    const check = () => this.checkNotification().catch(error => { this.state.lastResult = `通知检查失败：${error.message}`; this.saveState().catch(() => {}); });
    this.timer = setInterval(check, this.state.intervalMinutes * 60000);
    this.timer.unref?.();
    check();
  }
  async checkNotification() { return this.exclusive(async () => {
    if (!this.state.notificationEnabled || !this.state.notificationPath) return { skipped: true };
    if ((await stat(this.state.notificationPath)).size > 4096) throw Error('通知文件过大');
    const token = (await readFile(this.state.notificationPath, 'utf8')).trim();
    if (!token || token.startsWith('test:') || token === this.state.lastHandled) return { skipped: true };
    if (!/^\d{8}T\d{6}Z-\d{1,12}$/.test(token)) throw Error('通知内容须为时间戳和进程号');
    await this.reload();
    this.state.lastHandled = token; await this.saveState();
    return { reloaded: true };
  }); }
  async close() { if (this.timer) clearInterval(this.timer); await this.stop(); }
}
