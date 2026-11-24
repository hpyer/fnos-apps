import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, chmod, readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { PrivilegeBroker } from '@fnos/privilege';
import { DEFAULT_SETTINGS, buildHostsSnippet, normalizeRecords, renderConfig, validateSettings } from './config.mjs';
import { fail } from './errors.mjs';
import { atomicJSON, atomicWrite, ensureDir, readJSON } from './storage.mjs';

const HELPER_NAMES = ['setup-privileges', 'dnsmasq-caps'];
const GETCAP_CANDIDATES = ['/usr/sbin/getcap', '/sbin/getcap', '/usr/bin/getcap', '/bin/getcap'];
const PERMISSION_HINT = /permission denied|operation not permitted|failed to set capabilities|cannot set capabilities/i;
const PORT_IN_USE = /address already in use/i;
const ADDRESS_UNAVAILABLE = /cannot assign requested address/i;
const STARTUP_MARKER = /started, version/i;
const HOSTS_MARKER = '# BEGIN dnsmasq-for-fnos hosts';
const HOSTS_SNIPPET = 'hosts.snippet';

export function command(binary, args, { timeout = 15000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('命令执行超时')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(Error(output.trim() || `命令退出状态 ${code}`)); });
  });
}

function localAddresses() { return new Set(Object.values(networkInterfaces()).flatMap(items => (items || []).map(item => item.address))); }

function redact(value, secret) {
  const text = String(value ?? '');
  return secret ? text.split(secret).join('***') : text;
}

function lastRelevantLine(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.filter(line => /dnsmasq/i.test(line)).slice(-1)[0] || lines.slice(-1)[0] || '';
}

/** Turn dnsmasq startup stderr into an actionable message. */
export function describeStartupFailure(output = '', code = 0) {
  const text = String(output || '');
  const detail = lastRelevantLine(text);
  if (PERMISSION_HINT.test(text)) {
    return { kind: 'permission', message: 'dnsmasq 无法绑定 53 端口：缺少 CAP_NET_BIND_SERVICE 权限，请在诊断中初始化运行权限。', detail };
  }
  if (PORT_IN_USE.test(text)) {
    return { kind: 'port', message: 'dnsmasq 无法启动：53 端口已被其他程序占用，请停止占用该端口的服务或调整监听地址。', detail };
  }
  if (ADDRESS_UNAVAILABLE.test(text)) {
    return { kind: 'address', message: 'dnsmasq 无法启动：监听地址不属于本机，请检查监听地址设置。', detail };
  }
  const status = Number.isInteger(code) && code !== 0 ? `（退出状态 ${code}）` : '';
  return { kind: 'other', message: `dnsmasq 启动失败${status}${detail ? `：${detail}` : ''}`, detail };
}

export class DnsmasqManager extends EventEmitter {
  constructor(root, { appRoot = '', binary, run = command, platform = process.platform, arch = process.arch, privilegedHelperDir = '/usr/local/lib/dnsmasq-for-fnos' } = {}) {
    super(); this.root = root; this.appRoot = appRoot; this.binary = binary; this.run = run; this.platform = platform; this.arch = arch; this.privilegedHelperDir = privilegedHelperDir;
    this.privilege = new PrivilegeBroker({ helperDir: privilegedHelperDir, run });
    this.stateFile = path.join(root, 'state.json'); this.recordsFile = path.join(root, 'records.json'); this.runtimeDir = path.join(root, 'runtime'); this.configFile = path.join(this.runtimeDir, 'dnsmasq.conf'); this.pidFile = path.join(this.runtimeDir, 'dnsmasq.pid'); this.hostsSnippetFile = path.join(this.runtimeDir, HOSTS_SNIPPET); this.logFile = path.join(root, 'logs/dnsmasq.log');
    this.settings = { ...DEFAULT_SETTINGS }; this.records = []; this.child = null; this.lastError = ''; this.lastOutput = ''; this.startedAt = 0; this.closed = false; this.stopping = false; this.queue = Promise.resolve();
    this.helperReady = false; this.capability = null; this.capabilityError = ''; this.hostsSyncActive = false; this.hostsSyncError = ''; this.binaryVersion = '';
  }
  async init() { await ensureDir(this.root); await ensureDir(this.runtimeDir); await ensureDir(path.join(this.root, 'logs')); this.settings = validateSettings({ ...DEFAULT_SETTINGS, ...(await readJSON(this.stateFile, {})) }); this.records = normalizeRecords(await readJSON(this.recordsFile, [])); this.binaryVersion = await this.readBundledVersion(); await this.writeRuntimeConfig(); await this.refreshPrivilegeState().catch(() => {}); await this.refreshHostsSyncState().catch(() => {}); if (this.settings.hostsSync) { await this.syncHostsSnippet().catch(error => { this.hostsSyncError = String(error.message || error).slice(0, 300); }); } }

  /** The packaged runtime version, replaced by the real startup banner once dnsmasq runs. */
  async readBundledVersion() {
    if (!this.appRoot) return '';
    return (await readFile(path.join(this.appRoot, 'dnsmasq-version'), 'utf8').catch(() => '')).trim().slice(0, 32);
  }
  exclusive(task) { const next = this.queue.then(task, task); this.queue = next.catch(() => {}); return next; }
  async writeRuntimeConfig() { await atomicWrite(this.configFile, renderConfig(this.settings, this.records, { pidFile: this.pidFile }), 0o600); }
  async saveSettings(input) { return this.exclusive(async () => { this.settings = validateSettings({ ...input, hostsSync: this.settings.hostsSync }); await atomicJSON(this.stateFile, this.settings); await this.writeRuntimeConfig(); if (this.running()) await this.restartInternal(); return this.status(); }); }
  async saveRecords(input) { return this.exclusive(async () => { this.records = normalizeRecords(input); await atomicJSON(this.recordsFile, this.records); await this.writeRuntimeConfig(); if (this.settings.hostsSync) await this.syncHostsSnippet().catch(() => false); if (this.running()) await this.restartInternal(); return this.status(); }); }
  async deleteRecord(index) { if (!Number.isInteger(index) || index < 0 || index >= this.records.length) fail('记录不存在', 404); const next = this.records.slice(); next.splice(index, 1); return this.saveRecords(next); }
  running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  platformSupported() { return this.platform === 'linux' && ['x64', 'arm64'].includes(this.arch); }
  async validateConfig() { await this.writeRuntimeConfig(); try { await this.run(this.binary, ['--test', `--conf-file=${this.configFile}`]); return { valid: true, path: this.configFile }; } catch (error) { return { valid: false, error: error.message }; } }

  async helperFileReady(name) {
    try {
      const info = await stat(path.join(this.privilegedHelperDir, name));
      return info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0;
    } catch { return false; }
  }

  async helperFilesReady() {
    for (const name of HELPER_NAMES) if (!(await this.helperFileReady(name))) return false;
    return true;
  }

  async hostsHelperReady() { return this.helperFileReady('hosts-sync'); }

  async refreshHostsSyncState() {
    const content = await readFile('/etc/hosts', 'utf8').catch(() => '');
    this.hostsSyncActive = content.includes(HOSTS_MARKER);
    return this.hostsSyncActive;
  }

  async writeHostsSnippet() { await atomicWrite(this.hostsSnippetFile, buildHostsSnippet(this.records), 0o600); }

  /** Apply the generated hosts block through the root helper. */
  async syncHostsSnippet({ password = '', user = '' } = {}) {
    await this.writeHostsSnippet();
    if (!(await this.hostsHelperReady().catch(() => false))) { this.hostsSyncError = 'hosts 同步 helper 未初始化'; return false; }
    try {
      await this.privilege.privilegedRun(path.join(this.privilegedHelperDir, 'hosts-sync'), ['apply', this.hostsSnippetFile], { password, user });
      this.hostsSyncActive = true; this.hostsSyncError = '';
      return true;
    } catch (error) {
      this.hostsSyncError = redact(error.message || 'hosts 同步失败', password).slice(0, 300);
      return false;
    }
  }

  /** Enable/disable the optional NAS hosts block. Does not touch resolv.conf. */
  async setHostsSync(enabled, options = {}) { return this.exclusive(() => this._setHostsSync(enabled, options)); }

  async _setHostsSync(enabled, { password = '', user = '' } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    if (!this.platformSupported()) fail('当前系统不支持写入 NAS hosts', 409);
    if (enabled) {
      await this.writeHostsSnippet();
      if (!(await this.hostsHelperReady().catch(() => false))) {
        if (!password) fail('运行权限未初始化，请输入管理员密码完成初始化', 403);
        await this._initializeServiceMode({ password, user });
      }
      if (!(await this.syncHostsSnippet({ password, user }))) fail(`同步 NAS hosts 失败：${this.hostsSyncError || '未知错误'}`, 403);
      this.settings.hostsSync = true;
    } else {
      if (await this.hostsHelperReady().catch(() => false)) {
        try { await this.privilege.privilegedRun(path.join(this.privilegedHelperDir, 'hosts-sync'), ['remove'], { password, user }); }
        catch (error) { fail(`移除 NAS hosts 同步失败：${redact(error.message, password)}`, Number.isInteger(error.status) ? error.status : 403); }
      }
      this.settings.hostsSync = false;
      await this.refreshHostsSyncState().catch(() => {});
    }
    await atomicJSON(this.stateFile, this.settings);
    return this.status();
  }

  async getcapBinary() {
    for (const candidate of GETCAP_CANDIDATES) {
      try { const info = await stat(candidate); if (info.isFile()) return candidate; } catch { /* try next */ }
    }
    return '';
  }

  async readCapability() {
    if (!this.platformSupported()) return null;
    try {
      const output = await this.run((await this.getcapBinary()) || 'getcap', [this.binary], { timeout: 5000 });
      return /cap_net_bind_service/.test(output);
    } catch { return null; }
  }

  async refreshPrivilegeState() {
    this.helperReady = await this.helperFilesReady();
    this.capability = await this.readCapability();
    return { helperReady: this.helperReady, capability: this.capability };
  }

  async privilegedRun(helper, args, options = {}) {
    try { return await this.privilege.privilegedRun(helper, args, options); }
    catch (error) { fail(String(error.message || '管理员授权失败').slice(0, 400), Number.isInteger(error.status) ? error.status : 403); }
  }

  /** One-time bootstrap: install the root-owned helpers and the sudoers rule. */
  async initializeServiceMode(options = {}) { return this.exclusive(() => this._initializeServiceMode(options)); }

  async _initializeServiceMode({ password = '', user = '' } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    const source = path.join(this.appRoot, 'bin', 'setup-privileges');
    try { const info = await stat(source); if (!info.isFile()) fail('应用包缺少运行权限初始化脚本', 500); } catch { fail('应用包缺少运行权限初始化脚本', 500); }
    try { await this.privilegedRun(source, [this.appRoot], { password, user, allowPackageOwned: true }); }
    catch (error) { fail(`运行权限初始化失败：${redact(error.message, password)}`, Number.isInteger(error.status) ? error.status : 403); }
    this.helperReady = await this.helperFilesReady();
    if (!this.helperReady) fail('运行权限初始化未生效：helper 未安装到系统目录，请检查管理员 sudo 权限', 403);
    const applied = await this.ensureCapability({ password, user });
    if (!applied) fail(`运行权限已初始化，但未能授予 53 端口能力${this.capabilityError ? `：${this.capabilityError}` : ''}`, 403);
    await this.refreshPrivilegeState().catch(() => {});
    if (this.settings.hostsSync) await this.syncHostsSnippet({ password, user }).catch(() => false);
    return this.status();
  }

  /** Apply CAP_NET_BIND_SERVICE. Uses the NOPASSWD sudoers rule when no password is supplied. */
  async ensureCapability({ password = '', user = '' } = {}) {
    if (!(await this.helperFilesReady().catch(() => false))) { this.capabilityError = '运行权限未初始化'; return false; }
    this.helperReady = true;
    try {
      await this.privilege.privilegedRun(path.join(this.privilegedHelperDir, 'dnsmasq-caps'), ['apply', this.binary], { password, user });
      this.capability = true; this.capabilityError = '';
      return true;
    } catch (error) {
      this.capabilityError = redact(error.message || '权限设置失败', password).slice(0, 300);
      return false;
    }
  }

  async applyCapability(options = {}) { return this.exclusive(() => this._applyCapability(options)); }

  async _applyCapability({ password = '', user = '' } = {}) {
    if (!(await this.helperFilesReady().catch(() => false))) {
      if (password) return this._initializeServiceMode({ password, user });
      fail('运行权限未初始化，请输入管理员密码完成初始化', 403);
    }
    if (!(await this.ensureCapability({ password, user }))) fail(`授予 53 端口权限失败：${this.capabilityError}`, 403);
    await this.refreshPrivilegeState().catch(() => {});
    return this.status();
  }

  async start() { return this.exclusive(() => this.startInternal()); }

  async launch() {
    const child = spawn(this.binary, ['--keep-in-foreground', `--conf-file=${this.configFile}`], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; this.startedAt = Date.now(); this.lastError = ''; this.lastOutput = '';
    let buffer = '';
    let settle = () => {};
    const onOutput = chunk => {
      const text = chunk.toString();
      this.lastOutput = (this.lastOutput + text).slice(-8192);
      buffer = (buffer + text).slice(-8192);
      appendFile(this.logFile, text, { mode: 0o600 }).then(() => chmod(this.logFile, 0o600)).catch(() => {});
      this.emit('log', text);
      const version = /started, version\s+([^\s,]+)/i.exec(buffer)?.[1];
      if (version) this.binaryVersion = version.slice(0, 32);
      if (STARTUP_MARKER.test(buffer)) settle({ ok: true });
    };
    child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
    child.once('error', error => { this.lastError = `dnsmasq 启动失败：${error.message}`; this.lastOutput = (this.lastOutput + `\ndnsmasq: ${error.message}\n`).slice(-8192); settle({ ok: false, error }); });
    child.once('close', code => {
      if (this.child === child) this.child = null;
      if (!this.closed && !this.stopping && code !== 0) {
        this.lastError = describeStartupFailure(this.lastOutput, code).message;
        this.emit('status');
      }
      settle({ ok: false, code });
    });
    const result = await new Promise(resolve => {
      let done = false;
      settle = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => settle(child.exitCode === null ? { ok: true } : { ok: false, code: child.exitCode }), 2000);
    });
    if (result.ok) { this.lastError = ''; return result; }
    return { ...result, failure: describeStartupFailure(this.lastOutput, result.code) };
  }

  async startInternal() {
    if (this.running()) return this.status(); if (!this.platformSupported()) fail('当前系统或 CPU 架构不在支持范围内，请在 Linux x86_64/arm64 fnOS 上运行', 409);
    const validation = await this.validateConfig(); if (!validation.valid) fail(`dnsmasq 配置校验失败：${validation.error}`, 400);
    await this.refreshPrivilegeState().catch(() => {});
    if (this.helperReady && this.capability !== true) await this.ensureCapability().catch(() => false);
    const first = await this.launch();
    if (first.ok) { this.emit('status'); return this.status(); }
    // A lost file capability (for example after an upgrade) is recoverable:
    // re-apply it and retry once before reporting an error.
    if (first.failure.kind === 'permission' && this.helperReady) {
      const applied = await this.ensureCapability().catch(() => false);
      if (applied) {
        const retry = await this.launch();
        if (retry.ok) { this.emit('status'); return this.status(); }
        this.lastError = retry.failure.message;
        fail(retry.failure.message, 500);
      }
    }
    this.lastError = first.failure.message;
    fail(this.lastError, 500);
  }

  async stopInternal() {
    if (!this.running()) { this.child = null; return; }
    const child = this.child; this.stopping = true;
    try {
      if (child.exitCode === null) {
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill('SIGTERM');
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
      }
    } finally { this.child = null; this.stopping = false; }
  }

  async stop() { return this.exclusive(async () => { await this.stopInternal(); this.emit('status'); return this.status(); }); }
  async restartInternal() { await this.stopInternal(); return this.startInternal(); }
  async restart() { return this.exclusive(() => this.restartInternal()); }
  async close() { this.closed = true; await this.stopInternal(); this.emit('status'); }
  status() { return { running: this.running(), pid: this.child?.pid || 0, startedAt: this.startedAt, lastError: this.lastError, dnsmasqVersion: this.binaryVersion, settings: this.settings, records: this.records, platformSupported: this.platformSupported(), localAddresses: [...localAddresses()], helperReady: this.helperReady, capability: this.capability, capabilityError: this.capabilityError, hostsSyncActive: this.hostsSyncActive, hostsSyncError: this.hostsSyncError }; }

  async diagnostics() {
    await this.refreshPrivilegeState().catch(() => {});
    const [binaryExists, log, config, hostsSnippet] = await Promise.all([
      stat(this.binary).then(info => info.isFile()).catch(() => false),
      readFile(this.logFile, 'utf8').catch(() => ''),
      readFile(this.configFile, 'utf8').catch(() => ''),
      readFile(this.hostsSnippetFile, 'utf8').catch(() => ''),
    ]);
    return { ...this.status(), binary: this.binary, binaryExists, configPath: this.configFile, config, helperDir: this.privilegedHelperDir, helperReady: this.helperReady, capability: this.capability, capabilityError: this.capabilityError, platform: `${this.platform}/${this.arch}`, node: process.version, logTail: log.slice(-4000), lastOutput: this.lastOutput.slice(-4000), hostsSnippet };
  }

  async config() { return { settings: this.settings, records: this.records, source: await readFile(this.configFile, 'utf8').catch(() => '') }; }
}
