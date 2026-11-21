import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, chmod, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { PrivilegeBroker } from '@fnos/privilege';
import { DEFAULT_SETTINGS, normalizeRecords, renderConfig, validateSettings } from './config.mjs';
import { fail } from './errors.mjs';
import { atomicJSON, atomicWrite, ensureDir, readJSON } from './storage.mjs';

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

export class DnsmasqManager extends EventEmitter {
  constructor(root, { appRoot = '', binary, run = command, platform = process.platform, arch = process.arch, privilegedHelperDir = '/usr/local/lib/dnsmasq' } = {}) {
    super(); this.root = root; this.appRoot = appRoot; this.binary = binary; this.run = run; this.platform = platform; this.arch = arch; this.privilegedHelperDir = privilegedHelperDir;
    this.privilege = new PrivilegeBroker({ helperDir: privilegedHelperDir, run });
    this.stateFile = path.join(root, 'state.json'); this.recordsFile = path.join(root, 'records.json'); this.runtimeDir = path.join(root, 'runtime'); this.configFile = path.join(this.runtimeDir, 'dnsmasq.conf'); this.logFile = path.join(root, 'logs/dnsmasq.log');
    this.settings = { ...DEFAULT_SETTINGS }; this.records = []; this.child = null; this.lastError = ''; this.startedAt = 0; this.closed = false; this.queue = Promise.resolve();
  }
  async init() { await ensureDir(this.root); await ensureDir(this.runtimeDir); await ensureDir(path.join(this.root, 'logs')); this.settings = validateSettings({ ...DEFAULT_SETTINGS, ...(await readJSON(this.stateFile, {})) }); this.records = normalizeRecords(await readJSON(this.recordsFile, [])); await this.writeRuntimeConfig(); }
  exclusive(task) { const next = this.queue.then(task, task); this.queue = next.catch(() => {}); return next; }
  async writeRuntimeConfig() { await atomicWrite(this.configFile, renderConfig(this.settings, this.records), 0o600); }
  async saveSettings(input) { return this.exclusive(async () => { this.settings = validateSettings(input); await atomicJSON(this.stateFile, this.settings); await this.writeRuntimeConfig(); if (this.running()) await this.restartInternal(); return this.status(); }); }
  async saveRecords(input) { return this.exclusive(async () => { this.records = normalizeRecords(input); await atomicJSON(this.recordsFile, this.records); await this.writeRuntimeConfig(); if (this.running()) await this.restartInternal(); return this.status(); }); }
  async deleteRecord(index) { if (!Number.isInteger(index) || index < 0 || index >= this.records.length) fail('记录不存在', 404); const next = this.records.slice(); next.splice(index, 1); return this.saveRecords(next); }
  running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  platformSupported() { return this.platform === 'linux' && ['x64', 'arm64'].includes(this.arch); }
  async validateConfig() { await this.writeRuntimeConfig(); try { await this.run(this.binary, ['--test', `--conf-file=${this.configFile}`]); return { valid: true, path: this.configFile }; } catch (error) { return { valid: false, error: error.message }; } }
  async start() { return this.exclusive(() => this.startInternal()); }
  async startInternal() {
    if (this.running()) return this.status(); if (!this.platformSupported()) fail('当前系统或 CPU 架构不在支持范围内，请在 Linux x86_64/arm64 fnOS 上运行', 409);
    const validation = await this.validateConfig(); if (!validation.valid) fail(`dnsmasq 配置校验失败：${validation.error}`, 400);
    const child = spawn(this.binary, ['--no-daemon', '--keep-in-foreground', `--conf-file=${this.configFile}`], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child; this.startedAt = Date.now(); this.lastError = '';
    const log = chunk => { appendFile(this.logFile, chunk.toString(), { mode: 0o600 }).then(() => chmod(this.logFile, 0o600)).catch(() => {}); this.emit('log', chunk.toString()); };
    child.stdout.on('data', log); child.stderr.on('data', log); child.once('error', error => { this.lastError = error.message; this.emit('status'); }); child.once('close', code => { if (this.child === child) this.child = null; if (code !== 0 && !this.closed) this.lastError = `dnsmasq 退出状态 ${code}`; this.emit('status'); });
    await new Promise(resolve => setTimeout(resolve, 80)); if (child.exitCode !== null) fail(this.lastError || 'dnsmasq 启动失败', 500); this.emit('status'); return this.status();
  }
  async stopInternal() { if (!this.running()) return; const child = this.child; child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('close', () => { clearTimeout(timer); resolve(); }); }); this.child = null; }
  async stop() { return this.exclusive(async () => { await this.stopInternal(); this.emit('status'); return this.status(); }); }
  async restartInternal() { await this.stopInternal(); return this.startInternal(); }
  async restart() { return this.exclusive(() => this.restartInternal()); }
  async close() { this.closed = true; await this.stopInternal(); }
  async applyCapability({ password = '', user = '' } = {}) {
    const helper = path.join(this.privilegedHelperDir, 'dnsmasq-caps');
    return this.privilege.privilegedRun(helper, ['apply', this.binary], { password, user });
  }
  status() { return { running: this.running(), pid: this.child?.pid || 0, startedAt: this.startedAt, lastError: this.lastError, settings: this.settings, records: this.records, platformSupported: this.platformSupported(), localAddresses: [...localAddresses()] }; }
  async diagnostics() { return { ...this.status(), binary: this.binary, config: await readFile(this.configFile, 'utf8').catch(() => ''), helperDir: this.privilegedHelperDir, privilegeComponent: Boolean(this.privilege) }; }
  async config() { return { settings: this.settings, records: this.records, source: await readFile(this.configFile, 'utf8').catch(() => '') }; }
}
