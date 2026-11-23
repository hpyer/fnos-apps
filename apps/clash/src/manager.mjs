import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { access, chmod, copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { extractGzip } from './archive.mjs';
import { elfArchitecture, parseCoreVersion, coreFlavor } from './binary.mjs';
import { ConfigService } from './config-service.mjs';
import { ControllerClient } from './controller-client.mjs';
import { CoreProcess } from './core-process.mjs';
import { AppError, fail } from './errors.mjs';
import { LogHub } from './log-hub.mjs';
import { redact } from './redact.mjs';
import { CHANNELS, CoreRepository, channelConfig } from './repository.mjs';
import { augmentSubscriptionConfig } from './config-template.mjs';
import { DATASETS, DATASET_KEYS, MODEL_LABELS, MODEL_URLS, datasetDefaults, normalizeDatasetUrls } from './datasets.mjs';
import { PreparationProgress } from './progress.mjs';
import { mirrorGithubUrl, normalizeMirror, unmirrorGithubUrl } from './mirror.mjs';
import { configInfo, directProxies, ensureTunDns, injectController, proxyProviders, setTunEnabled, topLevelValue } from './yaml.mjs';
import { atomicJSON, atomicWrite, ensureDir, hashFile, pathExists, randomSecret, readJSON, removePath, safeId } from './storage.mjs';
import { PrivilegeBroker, PrivilegeError } from '@fnos/privilege';

const VERSION_OUTPUT_MAX = 32768;
const PRIVILEGED_HELPER_DIR = '/usr/local/lib/clash-for-fnos';
const HEALTH_TIMEOUT = 15000;
const MAX_RESTART_ATTEMPTS = 5;
const AVAILABLE_TTL = 12 * 60 * 60 * 1000;
const CORE_LEVELS = new Set(['debug', 'info', 'warning', 'error', 'silent']);
const DEFAULT_USER_AGENT_SUFFIX = 'clash.meta; clash';
const USER_AGENT_SUFFIX_MAX = 200;

/** The custom part after the generated "Mihomo/...; ClashForFNOS/..." prefix. */
export function normalizeUserAgentSuffix(value) {
  const text = String(value ?? '').trim();
  if (text.length > USER_AGENT_SUFFIX_MAX) fail(`User-Agent 自定义部分不能超过 ${USER_AGENT_SUFFIX_MAX} 个字符`);
  if (!/^[\x20-\x7e]*$/.test(text)) fail('User-Agent 自定义部分只能包含 ASCII 可见字符');
  return text;
}

// Step plans for the preparation progress shown in the page. Keys are shared by
// startInternal()/validateConfig()/ensureCoreData() so nested calls map onto
// whichever plan the current operation started with.
const START_STEPS = [
  { key: 'core', label: '校验内核' },
  { key: 'data', label: '准备外部数据' },
  { key: 'verify', label: '校验配置' },
  { key: 'launch', label: '启动内核' },
];
const APPLY_STEPS = [
  { key: 'data', label: '准备外部数据' },
  { key: 'verify', label: '校验配置' },
  { key: 'save', label: '保存配置' },
  { key: 'launch', label: '应用配置' },
];
const VALIDATE_STEPS = [
  { key: 'data', label: '准备外部数据' },
  { key: 'verify', label: '校验配置' },
];

export function command(binary, args, { timeout = 20000, signal, cwd, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    let output = '', timedOut = false, settled = false;
    const child = spawn(binary, args, { shell: false, cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const collect = data => { output = (output + data.toString()).slice(-VERSION_OUTPUT_MAX); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) reject(Error('命令执行超时'));
      else if (code !== 0) reject(Error(output.trim() || `命令退出状态 ${code}`));
      else resolve(output.trim());
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function architectureName(arch) {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'arm64';
  return '';
}

function coreTypeLabel(channel) {
  if (channel === 'smart') return 'Smart版';
  if (channel === 'metacubex-test') return '测试版';
  return '稳定版';
}

function listenerCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

export class ClashManager extends EventEmitter {
  constructor(root, { appRoot, platform = process.platform, arch = process.arch, fetcher = globalThis.fetch, run = command, now = Date.now, resolver, extract = extractGzip, systemEnvironmentFile = '/etc/environment', privilegedHelperDir = PRIVILEGED_HELPER_DIR, bootstrapData = true } = {}) {
    super();
    this.root = root;
    this.appRoot = appRoot || path.dirname(new URL(import.meta.url).pathname);
    this.platform = platform;
    this.arch = arch;
    this.fetcher = fetcher;
    this.userAgentPrefix = '';
    const fetchWithAgent = (url, options) => this.fetcher(url, this.withUserAgent(options));
    this.run = run;
    this.now = now;
    this.extract = extract;
    this.systemEnvironmentFile = systemEnvironmentFile;
    this.privilegedHelperDir = privilegedHelperDir;
    this.privilege = new PrivilegeBroker({
      helperDir: privilegedHelperDir,
      run,
      redact: (value, secrets) => redact(value, [this.state?.controllerSecret, ...secrets]),
      getSecrets: () => [this.state?.controllerSecret],
    });
    this.bootstrapData = bootstrapData !== false;
    this.preparation = new PreparationProgress({ now });
    this.capabilityError = '';
    this.resolver = resolver;
    this.repository = new CoreRepository({ fetcher: fetchWithAgent, now, mirror: url => mirrorGithubUrl(url, this.state.githubMirror), unmirror: url => unmirrorGithubUrl(url, this.state.githubMirror) });
    this.runtimeDir = path.join(root, 'runtime');
    this.socketPath = path.join(this.runtimeDir, 'controller.sock');
    this.runtimeConfigPath = path.join(this.runtimeDir, 'config.yaml');
    this.coresDir = path.join(root, 'cores');
    this.installedDir = path.join(this.coresDir, 'installed');
    this.embeddedDir = path.join(this.coresDir, 'embedded');
    this.stateFile = path.join(root, 'state.json');
    this.activeFile = path.join(this.coresDir, 'active.json');
    this.availableFile = path.join(root, 'available.json');
    this.logFile = path.join(root, 'logs/manager.log');
    this.state = {
      autoStart: true, autoRestart: true, logLevel: 'info', channel: 'metacubex-stable', controllerSecret: '',
      mixedPort: 0, httpPort: 0, socksPort: 0, allowLan: null, networkManaged: false, autoSystemProxy: false,
      githubMirror: 'https://ghfast.top/',
      delayIntervalMinutes: 30, delayTestUrl: 'https://www.gstatic.com/generate_204', delayConcurrency: 5, unifiedDelay: true, tcpConcurrent: true,
      userAgentSuffix: DEFAULT_USER_AGENT_SUFFIX,
      dataAutoUpdate: false, dataIntervalHours: 24, dataModel: 'standard', dataUrls: datasetDefaults(), dataUpdatedAt: {},
    };
    this.activeId = ''; this.previousId = '';
    this.core = null; this.coreState = 'stopped'; this.lastError = '';
    this.coreVersion = ''; this.coreFlavor = ''; this.runtimeMode = ''; this.startedAt = 0;
    this.traffic = { up: 0, down: 0, at: 0 };
    this.totals = { up: 0, down: 0 };
    this.memory = 0; this.connectionCount = 0;
    this.available = { channel: 'metacubex-stable', entries: [], checkedAt: '', error: '', fallback: false };
    this.job = { state: 'idle', action: '', id: '', message: '尚无操作', received: 0, total: 0 };
    this.jobTask = null; this.jobController = null; this.checking = false;
    this.dataBootstrapTask = null;
    this.queue = Promise.resolve();
    this.closed = false; this.stoppingIntent = false;
    this.restartAttempts = 0; this.restartTimer = null; this.schedulerTimer = null; this.schedulerBusy = false; this.autoStartTask = null;
    this.streamAbort = null; this.streamRestartTimer = null; this.summaryAt = 0; this.configCache = null;
    this.version = '0.1.0';
  }

  exclusive(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Run `task` while publishing multi-step progress. Nested calls (a config apply
   * that restarts the core, a data download inside a test) reuse the active plan
   * instead of replacing it.
   */
  async withPreparation(label, steps, task) {
    if (this.preparation.active) return task();
    this.preparation.start(label, steps);
    this.emit('status');
    try {
      const result = await task();
      this.preparation.done();
      return result;
    } catch (error) {
      this.preparation.fail(error?.message || '操作失败');
      throw error;
    } finally {
      this.emit('status');
    }
  }

  preparationSnapshot() {
    return this.preparation.snapshot();
  }

  /** e.g. "Mihomo/v1.19.34; ClashForFNOS/v1.0.1" */
  userAgentPrefixText() {
    return this.userAgentPrefix || `Mihomo/unknown; ClashForFNOS/v${this.version}`;
  }

  /** Generated prefix plus the user-defined suffix. */
  userAgent() {
    const suffix = this.state.userAgentSuffix || '';
    const prefix = this.userAgentPrefixText();
    return suffix ? `${prefix}; ${suffix}` : prefix;
  }

  /** Rebuild the generated half after the active core or app version changes. */
  async refreshUserAgentPrefix() {
    let version = '';
    try {
      const entry = this.activeId ? await this.findEntry(this.activeId) : null;
      version = entry?.version || '';
    } catch { /* metadata unavailable */ }
    if (!version) version = this.coreVersion;
    const normalized = String(version || '').replace(/^v/i, '').trim();
    this.userAgentPrefix = `Mihomo/${normalized ? `v${normalized}` : 'unknown'}; ClashForFNOS/v${this.version}`;
    return this.userAgentPrefix;
  }

  /** Force the composed User-Agent on an outgoing request, keeping other headers. */
  withUserAgent(options = {}) {
    const headers = {};
    const source = options?.headers;
    if (source && typeof source.forEach === 'function' && typeof source.get === 'function') {
      source.forEach((value, key) => { headers[key] = value; });
    } else if (source && typeof source === 'object') {
      Object.assign(headers, source);
    }
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'user-agent') delete headers[key];
    headers['user-agent'] = this.userAgent();
    return { ...options, headers };
  }

  log(level, message, source = 'app') {
    return this.logs?.add({ level, message, source });
  }

  controller() {
    return new ControllerClient({ socketPath: this.socketPath });
  }

  requireController() {
    if (this.coreState !== 'running' || !this.core) fail('Core 未运行，请先启动 Core', 409);
    return this.controller();
  }

  platformSupported() {
    return this.platform === 'linux' && ['x64', 'arm64'].includes(this.arch);
  }

  async init() {
    await ensureDir(this.root, 0o700);
    await ensureDir(this.runtimeDir, 0o700);
    await ensureDir(this.coresDir, 0o700);
    await ensureDir(this.installedDir, 0o700);
    await ensureDir(this.embeddedDir, 0o700);
    await ensureDir(path.join(this.root, 'logs'), 0o700);
    await ensureDir(path.join(this.runtimeDir, 'staging'), 0o700);
    this.logs = new LogHub({ file: this.logFile, secrets: () => [this.state.controllerSecret] });
    await this.logs.init();

    this.version = await this.readVersion();
    this.state = { ...this.state, ...(await readJSON(this.stateFile, {})) };
    this.state.dataUrls = normalizeDatasetUrls(this.state.dataUrls);
    this.state.dataUpdatedAt = this.state.dataUpdatedAt && typeof this.state.dataUpdatedAt === 'object' ? this.state.dataUpdatedAt : {};
    if (!Object.hasOwn(MODEL_URLS, this.state.dataModel)) this.state.dataModel = 'standard';
    if (!normalizeMirror(this.state.githubMirror)) this.state.githubMirror = 'https://ghfast.top/';
    if (!Number.isInteger(this.state.delayIntervalMinutes) || this.state.delayIntervalMinutes < 0 || this.state.delayIntervalMinutes > 1440) this.state.delayIntervalMinutes = 30;
    if (!Number.isInteger(this.state.delayConcurrency) || this.state.delayConcurrency < 1 || this.state.delayConcurrency > 20) this.state.delayConcurrency = 5;
    if (!/^[a-f0-9]{48}$/.test(this.state.controllerSecret || '')) {
      this.state.controllerSecret = randomSecret(24);
      await this.saveState();
    }
    for (const name of await readdir(path.join(this.runtimeDir, 'staging'))) await removePath(path.join(this.runtimeDir, 'staging', name));
    if (typeof this.state.autoSystemProxy !== 'boolean') this.state.autoSystemProxy = false;
    if (!Object.hasOwn(CHANNELS, this.state.channel)) this.state.channel = 'metacubex-stable';
    if (!CORE_LEVELS.has(this.state.logLevel)) this.state.logLevel = 'info';
    try { this.state.userAgentSuffix = normalizeUserAgentSuffix(this.state.userAgentSuffix ?? DEFAULT_USER_AGENT_SUFFIX); }
    catch { this.state.userAgentSuffix = DEFAULT_USER_AGENT_SUFFIX; }

    this.config = new ConfigService({ root: this.root, socketPath: this.socketPath, secret: this.state.controllerSecret, logLevel: this.state.logLevel, fetcher: (url, options) => this.githubFetcher(url, options), resolver: this.resolver });
    await this.config.init();
    try {
      const existingProxy = await this.systemProxyState();
      if (existingProxy.enabled && this.state.autoSystemProxy !== true) {
        this.state.autoSystemProxy = true;
        await this.saveState();
      }
    } catch { /* first run or unreadable environment */ }
    let initialInfo = { ports: {}, allowLan: null };
    try { initialInfo = (await this.config.read()).info; } catch { /* first run */ }
    let stateChanged = false;
    if (this.state.networkManaged !== true) {
      this.state.mixedPort = initialInfo.ports.mixed || 0;
      this.state.httpPort = initialInfo.ports.http || 0;
      this.state.socksPort = initialInfo.ports.socks || 0;
      this.state.allowLan = initialInfo.allowLan === true;
      stateChanged = true;
    }
    if (this.state.httpPort === this.state.mixedPort) this.state.httpPort = 0;
    if (this.state.socksPort === this.state.mixedPort || this.state.socksPort === this.state.httpPort) this.state.socksPort = 0;
    if (stateChanged) await this.saveState();

    await this.loadActive();
    await this.loadAvailable();
    this.embeddedEntry = await this.ensureEmbedded();
    if (!this.activeId || !(await this.findEntry(this.activeId))) {
      if (this.embeddedEntry) {
        this.activeId = this.embeddedEntry.id;
        this.previousId = '';
        await this.writeActive();
        this.log('info', `已选择内置 Core ${this.embeddedEntry.version}（${this.embeddedEntry.arch}）`);
      } else {
        this.activeId = '';
        this.log('error', '未找到内置 Core，请检查应用包是否完整');
      }
    }
    for (const entry of await readdir(this.installedDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === this.activeId) continue;
      if (await this.findEntry(entry.name)) continue;
      await removePath(path.join(this.installedDir, entry.name));
      this.log('warning', `已清理不完整的 Core 版本目录 ${entry.name}`);
    }
    this.log('info', `Clash 管理服务已启动，Core 渠道 ${this.state.channel}`);
    this.startScheduler();
    await this.refreshUserAgentPrefix();
    if (this.state.autoStart && this.activeId) {
      this.coreState = 'starting';
      this.autoStartTask = this.exclusive(() => this.withPreparation('启动内核', START_STEPS, () => this.startInternal({ fromAuto: true }))).catch(error => {
        this.coreState = 'error';
        this.lastError = error.message;
        this.log('error', `自动启动 Core 失败：${error.message}`);
      }).finally(() => { this.autoStartTask = null; });
    }
    return this;
  }

  async readVersion() {
    for (const file of [path.join(this.appRoot, 'version'), path.join(this.appRoot, '../version')]) {
      try {
        const version = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(await readFile(file, 'utf8'))?.[1];
        if (version) return version;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return '0.1.0';
  }

  async saveState() {
    await atomicJSON(this.stateFile, this.state, 0o600);
  }

  async loadActive() {
    const active = await readJSON(this.activeFile, {});
    this.activeId = typeof active?.id === 'string' ? active.id : '';
    this.previousId = typeof active?.previousId === 'string' ? active.previousId : '';
  }

  async writeActive() {
    await atomicJSON(this.activeFile, { id: this.activeId, previousId: this.previousId, activatedAt: new Date().toISOString() }, 0o600);
  }

  async loadAvailable() {
    const stored = await readJSON(this.availableFile, null);
    if (!stored || !Array.isArray(stored.entries) || !stored.checkedAt) return;
    if (this.now() - Date.parse(stored.checkedAt) > AVAILABLE_TTL) return;
    if (!Object.hasOwn(CHANNELS, stored.channel)) return;
    this.available = { channel: stored.channel, entries: stored.entries.filter(item => item && typeof item.id === 'string'), checkedAt: stored.checkedAt, error: '', fallback: stored.fallback === true };
  }


  /** Extract the packaged core for the host architecture once per app version. */
  async ensureEmbedded() {
    const arch = architectureName(this.arch);
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(this.appRoot, 'cores', 'core-versions.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.log('warning', '应用包没有内置 Core 元数据，将只能使用已安装版本');
      return null;
    }
    this.packageMetadata = metadata;
    if (!arch) return null;
    const asset = metadata?.assets?.[arch];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size)) {
      this.log('error', '内置 Core 元数据不完整');
      return null;
    }
    const version = String(metadata.version || metadata.tag || '');
    if (!/^v\d+\.\d+\.\d+$/.test(version)) {
      this.log('error', '内置 Core 版本号无效');
      return null;
    }
    const directory = path.join(this.embeddedDir, `${version}-${arch}`);
    const binary = path.join(directory, 'mihomo');
    const markerFile = path.join(directory, 'installed.json');
    let marker = await readJSON(markerFile, null);
    if (!marker || marker.sha256 !== asset.sha256 || marker.size !== asset.size || !(await pathExists(binary))) {
      const archive = path.join(this.appRoot, 'cores', arch, 'mihomo.gz');
      if (!(await pathExists(archive))) {
        this.log('error', `应用包缺少内置 ${arch} Core`);
        return null;
      }
      await ensureDir(directory, 0o700);
      this.log('info', `正在释放内置 Core ${version}（${arch}）`);
      const extracted = await extractGzip(archive, binary, { expectedSha256: asset.sha256, expectedSize: asset.size, arch, mode: 0o555 });
      marker = { version, arch, sha256: asset.sha256, size: asset.size, binarySha256: await hashFile(binary), extractedAt: new Date().toISOString(), source: metadata.source || '', license: metadata.license || '' };
      await atomicJSON(markerFile, marker, 0o600);
      for (const name of await readdir(this.embeddedDir)) if (name !== path.basename(directory)) await removePath(path.join(this.embeddedDir, name));
    }
    return { id: `embedded-${version}-${arch}`, kind: 'embedded', version, channel: 'builtin', arch, path: binary, binarySha256: marker.binarySha256,
      sha256: asset.sha256, size: asset.size, source: marker.source || metadata.source || 'https://github.com/MetaCubeX/mihomo', license: marker.license || metadata.license || 'GPL-3.0', label: `内置 ${version}` };
  }

  async findEntry(id) {
    if (typeof id !== 'string' || !id) return null;
    if (this.embeddedEntry && id === this.embeddedEntry.id) return this.embeddedEntry;
    safeId(id, 'Core 版本标识');
    try {
      const directory = path.join(this.installedDir, id);
      const metadata = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8'));
      if (metadata.id !== id || !['x86_64', 'arm64'].includes(metadata.arch)) return null;
      const binary = path.join(directory, 'mihomo');
      if (!(await pathExists(binary))) return null;
      return { ...metadata, kind: 'installed', path: binary, label: metadata.version || id };
    } catch { return null; }
  }

  async requireActiveEntry() {
    if (!this.activeId) fail('尚未选择 Core 版本', 409);
    const entry = await this.findEntry(this.activeId);
    if (!entry) fail('当前 Core 版本不可用，请在设置中重新选择版本', 409);
    if (entry.arch !== architectureName(this.arch)) fail(`当前 Core 架构 ${entry.arch} 与设备不匹配`, 409);
    return entry;
  }

  async validateCore(entry) {
    const expectations = [];
    expectations.push(entry.path);
    if (!(await pathExists(entry.path))) fail('Core 可执行文件不存在');
    const info = await stat(entry.path);
    if (!info.isFile() || info.size < 1024) fail('Core 可执行文件异常');
    const hash = await hashFile(entry.path);
    if (entry.binarySha256 && hash !== entry.binarySha256) fail('Core 文件已被修改，请重新安装或恢复内置 Core');
    const arch = await elfArchitecture(entry.path);
    if (arch !== architectureName(this.arch)) fail(`Core 架构不匹配：设备为 ${architectureName(this.arch)}，文件为 ${arch || '未知'}`);
    const output = await this.run(entry.path, ['-v'], { timeout: 10000 }).catch(error => { fail(`Core 版本检测失败：${redact(error.message, [this.state.controllerSecret])}`); });
    const version = parseCoreVersion(output);
    if (!version) fail('无法从 Core 输出中识别版本号');
    if (entry.version && version !== String(entry.version).replace(/^v/, '')) fail(`Core 实际版本 ${version} 与记录 ${entry.version} 不一致`);
    return { version, flavor: coreFlavor(output) || entry.channelLabel || 'mihomo' };
  }

  /** Copy bundled GeoIP/GeoSite data into the private runtime directory once. */
  async ensureGeodata() {
    const files = this.packageMetadata?.geodata?.files;
    if (!files) return;
    let copied = false;
    for (const target of Object.keys(files)) {
      const source = path.join(this.appRoot, 'cores', 'geo', target);
      const destination = path.join(this.runtimeDir, target);
      try {
        const sourceInfo = await stat(source);
        if (await pathExists(destination)) continue;
        await copyFile(source, destination);
        await chmod(destination, 0o644);
        copied = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (copied) this.log('info', '已准备内置 GeoIP / GeoSite 数据');
  }

  async ensureCoreData() {
    if (!this.bootstrapData) return;
    if (this.dataBootstrapTask) return this.dataBootstrapTask;
    this.dataBootstrapTask = this.bootstrapCoreData().finally(() => { this.dataBootstrapTask = null; });
    return this.dataBootstrapTask;
  }

  async bootstrapCoreData() {
    const required = ['geoip', 'geosite'];
    if (this.state.channel === 'smart') required.push('model');
    const missing = [];
    for (const key of required) {
      const def = DATASETS.find(item => item.key === key);
      if (!def) continue;
      if (!(await pathExists(path.join(this.runtimeDir, def.filename)))) missing.push(def);
    }
    for (const [index, def] of missing.entries()) {
      this.preparation.step('data', `正在下载 ${def.name}（${index + 1}/${missing.length}），首次运行耗时较长`);
      try {
        this.log('info', `首次准备外部数据：${def.name}（${index + 1}/${missing.length}）`);
        await this.syncData(def.key, { restart: false });
      } catch (error) {
        this.log('warning', `外部数据 ${def.name} 下载失败：${error.message}`);
        this.preparation.detail(`${def.name} 下载失败：${error.message}`);
      }
    }
  }

  async testConfig(entry) {
    await this.ensureGeodata();
    await this.ensureCoreData();
    this.preparation.step('verify', '正在使用 mihomo -t 校验配置');
    try {
      await this.run(entry.path, ['-t', '-d', this.runtimeDir, '-f', this.runtimeConfigPath], { timeout: 25000 });
    } catch (error) {
      fail(`配置校验失败：${redact(error.message, [this.state.controllerSecret]).split('\n').slice(-4).join(' ').slice(0, 600)}`);
    }
  }

  async assertPortsFree(info) {
    if (!this.platformSupported()) return;
    const host = info.allowLan ? '0.0.0.0' : '127.0.0.1';
    for (const [name, port] of Object.entries(info.ports || {})) {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', error => reject(error.code === 'EADDRINUSE' ? new AppError(`代理端口 ${port}（${name}）已被其他程序占用`, 409) : error));
        server.listen({ host, port, exclusive: true }, () => server.close(resolve));
      });
    }
  }

  async waitHealthy(timeout = HEALTH_TIMEOUT) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      if (!this.core?.running) throw Error(this.lastError || 'Core 进程已退出');
      try { return await this.controller().version(); } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error(`Core 健康检查超时${last ? `：${last.message}` : ''}`);
  }

  logCore(line, level) {
    let message = line;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.payload === 'string') message = parsed.payload;
    } catch { /* mihomo writes plain lines to stdout */ }
    const mapped = level === 'error' ? 'error' : /warn/i.test(message) ? 'warning' : level;
    this.logs.add({ level: mapped, message, source: 'core' });
  }

  mapLogLevel(type) {
    if (type === 'error') return 'error';
    if (type === 'warning' || type === 'warn') return 'warning';
    if (type === 'debug') return 'debug';
    return 'info';
  }

  startStreams() {
    this.stopStreams();
    this.streamAbort = new AbortController();
    const client = this.controller();
    const signal = this.streamAbort.signal;
    const reconnect = () => {
      if (this.closed || !this.core?.running || signal.aborted) return;
      this.streamRestartTimer = setTimeout(() => { if (this.core?.running && !signal.aborted) this.startStreams(); }, 1500);
    };
    this.trafficStream = client.openStream('/traffic', {
      signal,
      onLine: sample => {
        if (typeof sample?.up !== 'number' || typeof sample?.down !== 'number') return;
        this.traffic = { up: Math.max(0, sample.up), down: Math.max(0, sample.down), at: Date.now() };
        this.emit('traffic', this.traffic);
      },
      onEnd: reconnect,
    });
    this.logStream = client.openStream(`/logs?level=${this.state.logLevel === 'silent' ? 'warning' : this.state.logLevel}`, {
      signal,
      onLine: frame => { if (frame && typeof frame.payload === 'string') this.logs.add({ level: this.mapLogLevel(frame.type), message: frame.payload, source: 'core' }); },
      onEnd: reconnect,
    });
  }

  stopStreams() {
    if (this.streamRestartTimer) { clearTimeout(this.streamRestartTimer); this.streamRestartTimer = null; }
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.trafficStream?.close();
    this.logStream?.close();
    this.trafficStream = null;
    this.logStream = null;
  }

  async startInternal({ password = '', user = '', fromAuto = false } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    if (this.coreState === 'running' || (this.coreState === 'starting' && !fromAuto)) return this.coreSnapshot();
    if (!this.platformSupported()) fail('本机预览无法启动 Linux Core，请在 fnOS 设备上使用。', 409);
    this.preparation.step('core', '正在校验内核文件、摘要与架构');
    const entry = await this.requireActiveEntry();
    const validated = await this.validateCore(entry);
    const sourceInfo = (await this.config.read()).info;
    if (this.state.networkManaged !== true) await this.adoptNetworkSettings(sourceInfo);
    const info = this.effectiveInfo(sourceInfo);
    await this.assertPortsFree(info);
    await this.config.writeRuntime(this.runtimeConfigPath, { logLevel: this.state.logLevel, network: this.networkSettings(), health: this.healthSettings() });
    await this.applyCoreCapabilities(entry.path, { password, user });
    await this.testConfig(entry);
    await removePath(this.socketPath).catch(() => {});
    this.stoppingIntent = false;
    this.preparation.step('launch', '正在启动内核进程');
    this.coreState = 'starting';
    this.lastError = '';
    this.runtimeMode = '';
    this.startedAt = Date.now();
    this.core = new CoreProcess({
      binary: entry.path,
      args: ['-d', this.runtimeDir, '-f', this.runtimeConfigPath],
      cwd: this.runtimeDir,
      env: { HOME: this.runtimeDir, SAFE_PATHS: this.runtimeDir },
      onLine: (line, level) => this.logCore(line, level),
    });
    this.core.once('exit', details => this.handleCoreExit(details));
    try {
      this.core.start();
    } catch (error) {
      this.core = null;
      this.coreState = 'error';
      this.lastError = error.message;
      fail(`Core 启动失败：${error.message}`, 500);
    }
    try {
      await this.waitHealthy();
      this.preparation.detail('内核已就绪，正在读取运行状态');
    } catch (error) {
      this.stoppingIntent = true;
      await this.core?.stop();
      this.core?.dispose();
      this.core = null;
      this.coreState = 'error';
      this.lastError = error.message;
      this.log('error', `Core 启动失败：${error.message}`);
      fail(error.message, 500);
    }
    const version = await this.controller().version().catch(() => null);
    this.coreVersion = String(version?.version || validated.version).replace(/^v/, '');
    this.coreFlavor = validated.flavor;
    const runtimeConfig = await this.controller().configs().catch(() => null);
    this.runtimeMode = typeof runtimeConfig?.mode === 'string' ? runtimeConfig.mode : '';
    this.coreState = 'running';
    this.restartAttempts = 0;
    await this.refreshMemory();
    this.startStreams();
    if (this.state.autoSystemProxy) {
      try { await this.applySystemProxy(true, { password, user }); }
      catch (error) { this.log('warning', `自动开启 NAS 系统代理失败：${error.message}`); }
    }
    this.log('info', `Core 已启动：${entry.label}（${this.coreVersion}）`);
    this.emit('status');
    return this.coreSnapshot();
  }

  handleCoreExit(details) {
    const wasRunning = this.coreState === 'running' || this.coreState === 'starting';
    this.stopStreams();
    this.core?.dispose();
    this.core = null;
    if (this.stoppingIntent || this.closed) return;
    if (!wasRunning) return;
    this.coreState = 'error';
    this.startedAt = 0;
    this.lastError = details?.error?.message || `Core 意外退出（${details?.code ?? details?.signal ?? '未知'}）`;
    this.log('error', this.lastError);
    this.emit('status');
    if (this.state.autoRestart && this.job.state !== 'running' && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      const delay = Math.min(30000, 2000 * 2 ** this.restartAttempts);
      this.restartAttempts += 1;
      this.log('warning', `将在 ${Math.round(delay / 1000)} 秒后自动重启 Core（第 ${this.restartAttempts} 次）`);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.exclusive(() => this.withPreparation('自动重启内核', START_STEPS, () => this.startInternal())).catch(error => {
          this.lastError = error.message;
          this.log('error', `自动重启失败：${error.message}`);
        });
      }, delay);
    }
  }

  async stopInternal() {
    this.stoppingIntent = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopStreams();
    const process = this.core;
    if (process) {
      await process.stop();
      process.dispose();
    }
    this.core = null;
    this.coreState = 'stopped';
    this.runtimeMode = '';
    this.startedAt = 0;
    this.traffic = { up: 0, down: 0, at: Date.now() };
    this.connectionCount = 0;
    this.memory = 0;
    this.lastError = '';
    await removePath(this.socketPath).catch(() => {});
    this.log('info', 'Core 已停止');
    this.emit('status');
    return this.coreSnapshot();
  }

  assertNoJob() {
    if (this.job.state === 'running') fail('已有 Core 操作进行中，请稍后再试', 409);
  }

  async startCore(options = {}) {
    if (this.coreState === 'starting' && this.autoStartTask) {
      await this.autoStartTask;
      return this.status();
    }
    return this.exclusive(() => this.withPreparation('启动内核', START_STEPS, () => { this.assertNoJob(); return this.startInternal(options); }));
  }

  stopCore() {
    return this.exclusive(async () => {
      this.assertNoJob();
      await this.stopInternal();
      try { await this.applySystemProxy(false); }
      catch (error) { this.log('warning', `停止 Core 后恢复系统代理失败：${error.message}`); }
      return this.status();
    });
  }

  restartCore(options = {}) {
    return this.exclusive(() => this.withPreparation('重启内核', START_STEPS, async () => {
      this.assertNoJob();
      await this.stopInternal();
      await this.startInternal(options);
      return this.status();
    }));
  }

  async refreshSummary() {
    if (this.coreState !== 'running') return;
    const now = this.now();
    if (now - this.summaryAt < 2000) return;
    this.summaryAt = now;
    const client = this.controller();
    client.connections().then(data => {
      this.connectionCount = listenerCount(data?.connections);
      this.totals = { up: Number(data?.uploadTotal) || 0, down: Number(data?.downloadTotal) || 0 };
    }).catch(() => {});
    client.memory().then(async data => {
      const value = Number(data?.inuse) || 0;
      if (value > 0) this.memory = value;
      else await this.refreshMemory();
    }).catch(() => { void this.refreshMemory(); });
    client.configs().then(data => { if (typeof data?.mode === 'string') this.runtimeMode = data.mode; }).catch(() => {});
  }

  async refreshMemory() {
    const pid = this.core?.pid;
    if (!pid) { this.memory = 0; return; }
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (match) this.memory = Number(match[1]) * 1024;
    } catch { /* non-Linux preview */ }
  }

  async systemProxyState() {
    let content = '';
    try { content = await readFile(this.systemEnvironmentFile, 'utf8'); } catch { content = ''; }
    let port = 0;
    try { const config = await this.config.read(); port = config.info.ports.mixed || config.info.ports.http || 0; } catch { port = 0; }
    const lines = content.split(/\r?\n/).filter(line => /^(?:http_proxy|https_proxy|all_proxy)\s*=/i.test(line));
    for (const line of lines.reverse()) {
      const match = /^(?:[^=]+)=\s*["']?(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/i.exec(line);
      if (match && Number(match[1]) === port) return { enabled: true, port };
    }
    return { enabled: false, port };
  }

  async systemProxyWritable() {
    try {
      await access(this.systemEnvironmentFile, fsConstants.W_OK);
      return true;
    } catch { return false; }
  }

  /** One-time bootstrap: copy bundled helpers into the root-owned dir and install the sudoers rule. */
  async initializeServiceMode({ password = '', user = '' } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    const source = path.join(this.appRoot, 'bin', 'setup-privileges');
    if (!(await pathExists(source))) fail('应用包缺少服务模式初始化脚本', 500);
    const args = [this.appRoot.endsWith('/target') ? this.appRoot : `${this.appRoot}/target`];
    let output = '';
    try {
      output = await this.privilegedRun(source, args, { password, user, allowPackageOwned: true });
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(`服务模式初始化失败：${redact(error.message, [this.state.controllerSecret, password])}`, 403);
    }
    if (!(await this.serviceHelperReady())) {
      const detail = redact(String(output || ''), [this.state.controllerSecret, password]).trim().slice(-300);
      fail(`服务模式初始化未生效：helper 未安装到 root 目录${detail ? `（${detail}）` : '，请检查管理员 sudo 权限'}`, 403);
    }
    this.log('info', '服务模式已初始化（root 拥有 helper 与 sudoers 规则）');
    return this.status();
  }

  /** Run a command as root after authenticating the logged-in fnOS administrator. */
  async runAsLoginUser(helper, args, { password, user }) {
    try { return await this.privilege.runAsLoginUser(helper, args, { password, user }); }
    catch (error) { if (error instanceof PrivilegeError) fail(error.message, error.status); throw error; }
  }

  /** Run a root-owned helper. With a password, authenticate as the logged-in admin; otherwise use NOPASSWD sudoers. */
  async privilegedRun(helper, args, { password = '', user = '', allowPackageOwned = false } = {}) {
    const overriddenLoginRunner = this.runAsLoginUser !== ClashManager.prototype.runAsLoginUser
      ? (...values) => this.runAsLoginUser(...values)
      : undefined;
    try {
      return await this.privilege.privilegedRun(helper, args, {
        password, user, allowPackageOwned, runAsLoginUser: overriddenLoginRunner,
      });
    }
    catch (error) { if (error instanceof PrivilegeError) fail(error.message, error.status); throw error; }
  }

  async applyCoreCapabilities(corePath = '', { password = '', user = '' } = {}) {
    const helper = path.join(this.privilegedHelperDir, 'core-caps');
    if (!(await pathExists(helper)) && password) await this.initializeServiceMode({ password, user });
    if (!(await pathExists(helper))) { this.capabilityError = '服务模式未初始化：缺少 root 拥有的 core-caps helper'; return false; }
    const args = corePath ? ['apply', this.root, corePath] : ['apply', this.root];
    try {
      await this.run(helper, args, { timeout: 15000 });
      this.capabilityError = '';
      return true;
    } catch (error) {
      try {
        await this.privilegedRun(helper, args, { password, user });
        this.capabilityError = '';
        return true;
      } catch (sudoError) {
        this.capabilityError = redact(sudoError.message || error.message, [this.state.controllerSecret]).slice(0, 300);
        this.log('warning', `无法授予 Core 网络能力（TUN 可能不可用）：${this.capabilityError}`);
        if (sudoError instanceof AppError && password) throw sudoError;
        return false;
      }
    }
  }

  async serviceHelperReady() {
    return (await pathExists(path.join(this.privilegedHelperDir, 'system-proxy'))) && (await pathExists(path.join(this.privilegedHelperDir, 'core-caps')));
  }

  async coreCapabilities() {
    const pid = this.core?.pid;
    if (!pid) return { known: false, uid: null, capNetAdmin: null, root: false };
    try {
      const content = await readFile(`/proc/${pid}/status`, 'utf8');
      const uid = Number(/^Uid:\s+(\d+)/m.exec(content)?.[1] ?? -1);
      const capHex = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(content)?.[1] || '0';
      const capNetAdmin = (BigInt(`0x${capHex}`) & 0x1000n) !== 0n;
      return { known: true, uid, capNetAdmin, root: uid === 0 };
    } catch { return { known: false, uid: null, capNetAdmin: null, root: false }; }
  }

  async tunStatus() {
    let info = { tunEnabled: false, tunDevice: '' };
    try { info = (await this.config.read()).info; } catch { /* config may not exist yet */ }
    const configured = info.tunEnabled === true;
    let interfaces = [];
    try { interfaces = await readdir('/sys/class/net'); } catch { interfaces = []; }
    const candidates = [...new Set([info.tunDevice, 'Meta', ...interfaces.filter(name => /^tun\d+$/i.test(name))])].filter(Boolean);
    let device = '';
    for (const name of candidates) {
      if (!interfaces.includes(name)) continue;
      try {
        const type = (await readFile(`/sys/class/net/${name}/type`, 'utf8')).trim();
        if (type === '65534' || /^(Meta|tun\d+)$/i.test(name)) { device = name; break; }
      } catch { if (/^(Meta|tun\d+)$/i.test(name)) { device = name; break; } }
    }
    let tunDevicePresent = false;
    try { await stat('/dev/net/tun'); tunDevicePresent = true; } catch { tunDevicePresent = false; }
    const capability = await this.coreCapabilities();
    const active = configured && this.coreState === 'running' && Boolean(device);
    let message = '';
    if (configured) {
      if (this.coreState !== 'running') message = '内核未运行，TUN 不会生效';
      else if (!tunDevicePresent) message = '系统缺少 /dev/net/tun，无法创建虚拟网卡';
      else if (capability.known && capability.capNetAdmin === false) message = `内核进程缺少 CAP_NET_ADMIN，无法创建 TUN 网卡（需要 root 或 setcap）${this.capabilityError ? `：${this.capabilityError}` : ''}`;
      else if (!device) message = '未发现 TUN 网卡，请查看内核日志（可能需要 root/CAP_NET_ADMIN）';
    }
    return { configured, active, device: device || info.tunDevice || 'Meta', tunDevicePresent, capability, message };
  }

  async applySystemProxy(enabled, { password = '', user = '' } = {}) {
    const config = await this.config.read();
    const port = config.info.ports.mixed || config.info.ports.http;
    if (enabled && !port) fail('配置中未设置 mixed-port 或 port，无法设置系统代理');
    let helper = path.join(this.privilegedHelperDir, 'system-proxy');
    if (!(await pathExists(helper)) && password) await this.initializeServiceMode({ password, user });
    if (!(await pathExists(helper))) fail('服务模式未初始化：缺少 root 拥有的系统代理 helper，请先初始化服务模式', 503);
    const args = [enabled ? 'enable' : 'disable', String(port || 0)];
    try {
      await this.run(helper, args, { timeout: 10000 });
    } catch (error) {
      try { await this.privilegedRun(helper, args, { password, user }); }
      catch (sudoError) {
        if (sudoError instanceof AppError) throw sudoError;
        fail(`修改 NAS 系统代理失败（需要 root 权限）：${redact(sudoError.message || error.message, [this.state.controllerSecret])}`, 403);
      }
    }
    const state = await this.systemProxyState();
    if (state.enabled !== enabled) fail('系统代理修改未生效，请检查 /etc/environment 权限');
    this.log('info', enabled ? `已开启 NAS 系统代理 127.0.0.1:${port}` : '已关闭 NAS 系统代理');
    return this.status();
  }

  async setSystemProxy(enabled, { password = '', user = '' } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    if (enabled === true && this.coreState !== 'running') {
      this.state.autoSystemProxy = true;
      await this.saveState();
      this.log('info', '已记录系统代理设置，启动 Core 后自动开启');
      return this.status();
    }
    await this.applySystemProxy(enabled, { password, user });
    this.state.autoSystemProxy = enabled === true;
    await this.saveState();
    return this.status();
  }

  async detectUplinkInterface() {
    try {
      const output = await this.run('ip', ['-4', 'route', 'show', 'default'], { timeout: 5000 });
      const match = /\bdefault\b[^\n]*\bdev\s+(\S+)/.exec(String(output));
      if (match && !/^(?:utun|tun|docker|br-|veth|virbr|lo)/.test(match[1])) return match[1];
    } catch { /* fall through to interface enumeration */ }
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (/^(?:utun|tun|docker|br-|veth|virbr|lo)/.test(name)) continue;
      if ((list || []).some(item => item.family === 'IPv4' && !item.internal)) return name;
    }
    return '';
  }

  async setTun(enabled, { password = '', user = '' } = {}) {
    if (this.closed) fail('管理服务正在停止', 503);
    const turnOn = enabled === true;
    if (this.coreState !== 'running') {
      const source = await this.config.source();
      const interfaceName = turnOn ? await this.detectUplinkInterface() : '';
      const excludeUid = turnOn && typeof process.getuid === 'function' ? process.getuid() : null;
      let next = setTunEnabled(source, turnOn, { interfaceName, excludeUid });
      if (turnOn) next = ensureTunDns(next, { nameservers: await this.systemDnsServers() });
      if (next !== source) await this.exclusive(() => this.applyConfig(next, { kind: 'manual', password, user }));
      return this.status();
    }
    if (turnOn && !(await this.serviceHelperReady())) {
      if (!password) fail('服务模式未初始化：缺少 root 拥有的 core-caps helper，请先完成管理员授权', 503);
      await this.initializeServiceMode({ password, user });
    }
    const before = await this.tunStatus();
    const source = await this.config.source();
    const interfaceName = turnOn ? await this.detectUplinkInterface() : '';
    const excludeUid = turnOn && typeof process.getuid === 'function' ? process.getuid() : null;
    let next = setTunEnabled(source, turnOn, { interfaceName, excludeUid });
    if (turnOn) next = ensureTunDns(next, { nameservers: await this.systemDnsServers() });
    if (turnOn && next === source && before.active) return this.status();
    if (!turnOn && next === source && !before.configured) return this.status();
    const status = await this.exclusive(() => this.applyConfig(next, { kind: 'manual', password, user }));
    if (turnOn) {
      let after = await this.tunStatus();
      for (let attempt = 0; attempt < 10 && !after.active; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        after = await this.tunStatus();
      }
      if (!after.active) {
        let rollbackError = '';
        if (next !== source) {
          try { await this.exclusive(() => this.applyConfig(source, { kind: 'manual' })); }
          catch (error) { rollbackError = error.message; }
        }
        const suffix = rollbackError ? `；恢复原配置也失败：${rollbackError}` : '；已恢复原配置和开关状态';
        const message = `增强模式未生效：${after.message || '未发现 TUN 网卡'}${suffix}`;
        this.log('error', message);
        fail(message, 500);
      }
    }
    this.log('info', turnOn ? '已开启增强模式（TUN）' : '已关闭增强模式（TUN）');
    return status;
  }

  async configSummary() {
    try {
      const config = await this.config.read();
      const managed = ['external-controller', 'external-controller-tls', 'external-controller-pipe', 'external-controller-unix', 'external-ui', 'external-ui-url', 'external-ui-name', 'secret', 'log-level', 'mixed-port', 'port', 'socks-port', 'allow-lan'];
      return {
        updatedAt: config.updatedAt, kind: config.kind, subscriptionId: config.subscriptionId, size: config.size, info: this.effectiveInfo(config.info),
        managedKeys: managed.filter(key => config.info.keys.includes(key) || ['mixed-port', 'port', 'socks-port', 'allow-lan'].includes(key)),
      };
    } catch (error) {
      return { updatedAt: '', kind: 'error', subscriptionId: '', size: 0, info: { ports: {}, mode: '', allowLan: null, logLevel: '', keys: [] }, error: error.message };
    }
  }

  coreSnapshot() {
    return { state: this.coreState, running: this.coreState === 'running', pid: this.core?.pid || 0, version: this.coreVersion, startedAt: this.startedAt };
  }

  async adoptNetworkSettings(info) {
    this.state.mixedPort = info.ports?.mixed || 7890;
    this.state.httpPort = info.ports?.http && info.ports.http !== this.state.mixedPort ? info.ports.http : 0;
    this.state.socksPort = info.ports?.socks && ![this.state.mixedPort, this.state.httpPort].includes(info.ports.socks) ? info.ports.socks : 0;
    this.state.allowLan = info.allowLan === true;
    await this.saveState();
  }

  networkSettings() {
    return { ports: { mixed: this.state.mixedPort > 0 ? this.state.mixedPort : 7890, http: this.state.httpPort || 0, socks: this.state.socksPort || 0 }, allowLan: this.state.allowLan === true };
  }

  effectiveInfo(info) {
    const ports = { ...(info.ports || {}) };
    ports.mixed = this.state.mixedPort > 0 ? this.state.mixedPort : (ports.mixed || 7890);
    if (this.state.httpPort > 0) ports.http = this.state.httpPort; else delete ports.http;
    if (this.state.socksPort > 0) ports.socks = this.state.socksPort; else delete ports.socks;
    return { ...info, ports, allowLan: this.state.allowLan === true };
  }

  async status() {
    this.refreshSummary();
    const config = await this.configSummary();
    const active = await this.findEntry(this.activeId);
    const supported = this.platformSupported();
    const connection = this.coreState === 'running' ? {
      state: this.coreState,
      running: true,
      pid: this.core?.pid || 0,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
      uptimeMs: this.startedAt ? Math.max(0, Date.now() - this.startedAt) : 0,
      version: this.coreVersion,
      flavor: this.coreFlavor,
      mode: this.runtimeMode || config.info.mode || 'rule',
      logLevel: this.state.logLevel,
      allowLan: config.info.allowLan === true,
      ports: config.info.ports,
      traffic: this.traffic,
      totals: this.totals,
      connections: this.connectionCount,
      memory: this.memory,
    } : {
      state: this.coreState === 'error' ? 'error' : this.coreState,
      running: false,
      pid: 0,
      startedAt: '',
      uptimeMs: 0,
      version: '',
      flavor: '',
      mode: this.runtimeMode || config.info.mode || 'rule',
      logLevel: this.state.logLevel,
      allowLan: config.info.allowLan === true,
      ports: config.info.ports,
      traffic: { up: 0, down: 0, at: 0 },
      totals: { up: 0, down: 0 },
      connections: 0,
      memory: 0,
    };
    const proxyState = await this.systemProxyState();
    const tunState = await this.tunStatus();
    return {
      version: this.version,
      platform: { os: this.platform, arch: this.arch, supported },
      environment: {
        systemProxy: proxyState.enabled,
        systemProxyDesired: this.state.autoSystemProxy === true,
        systemProxyManaged: true,
        systemProxyWritable: await this.systemProxyWritable(),
        tunEnabled: tunState.active,
        tunDesired: tunState.configured,
        tunConfigured: tunState.configured,
        tunActive: tunState.active,
        tunDevice: tunState.device,
        tunMessage: tunState.message,
        tunDevicePresent: tunState.tunDevicePresent,
        tunCapability: tunState.capability.capNetAdmin,
      },
      core: {
        ...connection,
        activeId: this.activeId,
        activeLabel: active?.label || '',
        activeVersion: active?.version || '',
        activeTypeLabel: coreTypeLabel(active?.channel || ''),
        activeEmbedded: active?.kind === 'embedded',
        channel: this.state.channel,
        supported,
        autoRestart: this.state.autoRestart,
        lastError: this.lastError,
      },
      settings: { autoStart: this.state.autoStart, autoRestart: this.state.autoRestart, logLevel: this.state.logLevel, channel: this.state.channel, mixedPort: this.state.mixedPort, httpPort: this.state.httpPort, socksPort: this.state.socksPort, allowLan: this.state.allowLan === true, githubMirror: this.state.githubMirror, userAgentSuffix: this.state.userAgentSuffix, userAgentPrefix: this.userAgentPrefixText(), userAgent: this.userAgent(), delayIntervalMinutes: this.state.delayIntervalMinutes, delayTestUrl: this.state.delayTestUrl, delayConcurrency: this.state.delayConcurrency, unifiedDelay: this.state.unifiedDelay, tcpConcurrent: this.state.tcpConcurrent },
      config,
      versions: await this.versionSummary(),
      subscriptions: this.config.listSubscriptions(),
      job: this.jobSnapshot(),
      preparation: this.preparationSnapshot(),
      readiness: await this.dataReadiness(),
    };
  }

  async versionSummary() {
    const installed = [];
    try {
      for (const name of await readdir(this.installedDir, { withFileTypes: true })) {
        if (!name.isDirectory() || name.isSymbolicLink()) continue;
        const entry = await this.findEntry(name.name);
        if (entry) installed.push({ id: entry.id, version: entry.version, channel: entry.channel, channelLabel: entry.channelLabel || CHANNELS[entry.channel]?.label || '', typeLabel: coreTypeLabel(entry.channel), arch: entry.arch, size: entry.size, installedAt: entry.installedAt, active: entry.id === this.activeId, embedded: false });
        else installed.push({ id: name.name, invalid: true, active: false, embedded: false });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    installed.sort((left, right) => Number(right.active) - Number(left.active) || String(right.installedAt || '').localeCompare(String(left.installedAt || '')));
    return {
      activeId: this.activeId,
      previousId: this.previousId,
      embedded: this.embeddedEntry ? [{ id: this.embeddedEntry.id, version: this.embeddedEntry.version, arch: this.embeddedEntry.arch, typeLabel: '稳定版', channel: 'builtin', active: this.embeddedEntry.id === this.activeId, embedded: true }] : [],
      installed,
      available: this.available.entries,
      availableChannel: this.available.channel,
      availableCheckedAt: this.available.checkedAt,
      availableError: this.available.error,
      availableFallback: this.available.fallback === true,
      channel: this.state.channel,
      channels: Object.values(CHANNELS).map(item => ({ id: item.id, label: item.label, risk: item.risk })),
      supportedArch: architectureName(this.arch),
    };
  }

  jobSnapshot() {
    return { state: this.job.state, action: this.job.action, id: this.job.id, message: this.job.message, received: this.job.received, total: this.job.total };
  }

  async checkCores(channel = this.state.channel) {
    if (this.closed) fail('管理服务正在停止', 503);
    if (this.checking) fail('正在查询版本，请稍候', 409);
    channelConfig(channel);
    this.checking = true;
    try {
      const result = await this.repository.catalog(channel);
      this.available = { channel, entries: result.entries, checkedAt: new Date().toISOString(), error: '', fallback: result.fallback === true };
      await atomicJSON(this.availableFile, this.available, 0o600);
      this.log('info', `已获取 ${channelConfig(channel).label} 可用版本：${result.entries.length} 个`);
      return { ...this.available };
    } catch (error) {
      this.available = { channel, entries: [], checkedAt: new Date().toISOString(), error: error.message, fallback: false };
      await atomicJSON(this.availableFile, this.available, 0o600).catch(() => {});
      this.log('warning', `查询 Core 版本失败：${error.message}`);
      throw error;
    } finally {
      this.checking = false;
    }
  }

  async startJob(action, id) {
    if (this.closed) fail('管理服务正在停止', 503);
    if (!['install', 'activate', 'rollback', 'remove'].includes(action)) fail('未知的 Core 操作');
    if (this.job.state === 'running') fail('已有 Core 操作进行中，请稍后再试', 409);
    let entry = null;
    if (action === 'install') {
      entry = this.available.entries.find(item => item.id === id);
      if (!entry) fail('请先检查当前渠道的可用版本，再选择安装', 409);
      if (entry.arch !== architectureName(this.arch)) fail(`该版本适用于 ${entry.arch}，当前设备为 ${architectureName(this.arch) || this.arch}`);
      if (this.available.channel !== this.state.channel) fail('版本渠道已变化，请重新检查更新', 409);
    } else if (action === 'rollback') {
      if (!this.previousId) fail('没有可回滚的 Core 版本');
    } else {
      safeId(id, 'Core 版本标识');
      if (!(await pathExists(path.join(this.installedDir, id))) && !(await this.findEntry(id))) fail('Core 版本不存在', 404);
    }
    this.job = { state: 'running', action, id: id || '', message: action === 'install' ? '正在准备下载' : '正在准备', received: 0, total: entry?.size || 0 };
    this.jobController = new AbortController();
    const task = async () => {
      try {
        if (action === 'install') await this.installEntry(entry);
        else if (action === 'activate') await this.activateEntry(id);
        else if (action === 'rollback') await this.activateEntry(this.previousId);
        else await this.removeEntry(id);
        this.job = { ...this.job, state: 'success', message: action === 'install' ? '下载与自检完成，请在版本列表中启用' : 'Core 操作完成' };
        this.log('info', this.job.message);
      } catch (error) {
        this.job = { ...this.job, state: 'error', message: this.closed ? '操作已中止，当前 Core 保持不变' : error.message };
        this.log('error', `Core 操作失败：${this.job.message}`);
      } finally {
        this.jobController = null;
        this.jobTask = null;
        this.emit('status');
      }
    };
    this.jobTask = action === 'install' ? task() : this.exclusive(task);
    return { job: this.jobSnapshot() };
  }

  async installEntry(entry) {
    const target = path.join(this.installedDir, entry.id);
    if (await pathExists(target)) fail('该 Core 版本已经安装');
    const staging = path.join(this.runtimeDir, 'staging');
    await ensureDir(staging, 0o700);
    const session = path.join(staging, `install-${Date.now()}`);
    await ensureDir(session, 0o700);
    try {
      const archive = path.join(session, 'core.gz');
      const signal = this.jobController?.signal;
      this.job = { ...this.job, message: entry.verified ? '正在下载 Core 并校验 SHA256' : '正在下载 Core（下载后计算 SHA256）' };
      let computedSha = '';
      if (entry.verified && /^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
        await this.repository.download(entry, archive, {
          signal,
          label: 'Core',
          progress: (received, total) => { this.job = { ...this.job, received, total }; },
        });
        computedSha = entry.sha256;
      } else {
        const downloaded = await this.repository.downloadUnverified(entry, archive, {
          signal,
          label: 'Core',
          progress: (received) => { this.job = { ...this.job, received, total: 0 }; },
        });
        computedSha = downloaded.sha256;
      }
      signal?.throwIfAborted();
      this.job = { ...this.job, message: '正在解压并校验架构', received: 0 };
      const binary = path.join(session, 'mihomo');
      await this.extract(archive, binary, {
        expectedSha256: entry.verified ? entry.sha256 : undefined,
        expectedSize: entry.verified ? entry.size : undefined,
        arch: entry.arch, mode: 0o555,
      });
      this.job = { ...this.job, message: '正在检测 Core 版本' };
      const output = await this.run(binary, ['-v'], { timeout: 15000 });
      const version = parseCoreVersion(output);
      if (!version) fail('下载的 Core 无法识别版本号');
      if (entry.version && version !== entry.version.replace(/^v/, '')) fail(`下载的 Core 版本 ${version} 与渠道记录 ${entry.version} 不一致`);
      await ensureDir(target, 0o700);
      const tempBinary = path.join(target, 'mihomo.part');
      await copyFile(binary, tempBinary);
      await chmod(tempBinary, 0o555);
      await rename(tempBinary, path.join(target, 'mihomo'));
      const metadata = {
        id: entry.id, channel: entry.channel, channelLabel: entry.channelLabel, version: `v${version}`, tag: entry.tag, build: entry.build,
        arch: entry.arch, sha256: computedSha, binarySha256: await hashFile(binary), size: entry.size || (await stat(archive)).size,
        source: entry.source, repository: entry.repository, license: entry.license, publishedAt: entry.publishedAt,
        verified: entry.verified === true, fallback: entry.verified !== true,
        installedAt: new Date().toISOString(),
      };
      await atomicJSON(path.join(target, 'metadata.json'), metadata, 0o600);
      await atomicJSON(path.join(target, 'core.json'), { version, flavor: coreFlavor(output) }, 0o600);
      this.log('info', `已安装 Core ${metadata.version}（${entry.arch}）`);
      return metadata;
    } finally {
      await removePath(session);
    }
  }

  async activateEntry(id) {
    const target = await this.findEntry(id);
    if (!target) fail('Core 版本不存在', 404);
    if (target.arch !== architectureName(this.arch)) fail('Core 架构与设备不匹配');
    if (id === this.activeId) fail('该版本已经在使用', 409);
    const validated = await this.validateCore(target);
    const wasRunning = this.coreState === 'running' || this.coreState === 'starting';
    this.job = { ...this.job, message: wasRunning ? '正在切换 Core 版本' : '正在启用 Core 版本' };
    const previousActive = this.activeId;
    const previousPrevious = this.previousId;
    try {
      if (wasRunning) await this.stopInternal();
      await this.config.writeRuntime(this.runtimeConfigPath, { logLevel: this.state.logLevel, network: this.networkSettings(), health: this.healthSettings() });
      await this.testConfig(target);
      this.activeId = id;
      this.previousId = previousActive;
      await this.writeActive();
      await this.refreshUserAgentPrefix();
      if (wasRunning) await this.startInternal();
      this.log('info', `已启用 Core ${target.label}（${validated.version}）`);
    } catch (error) {
      this.activeId = previousActive;
      this.previousId = previousPrevious;
      await this.writeActive().catch(() => {});
      if (wasRunning) {
        await this.startInternal().catch(restartError => {
          this.lastError = restartError.message;
          this.log('error', `恢复原 Core 失败：${restartError.message}`);
        });
      }
      fail(`切换 Core 失败，已恢复原版本：${error.message}`);
    }
    return this.status();
  }

  async removeEntry(id) {
    if (id === this.activeId) fail('不能删除当前启用的 Core 版本', 409);
    if (this.embeddedEntry?.id === id) fail('内置 Core 由应用包管理，不能删除', 409);
    const entry = await this.findEntry(id);
    const directory = path.join(this.installedDir, id);
    if (!(await pathExists(directory))) fail('Core 版本不存在', 404);
    await removePath(directory);
    if (this.previousId === id) {
      this.previousId = '';
      await this.writeActive();
    }
    this.log('info', `已删除 Core ${entry?.label || id}`);
    return { ok: true };
  }

  async proxies() {
    const client = this.requireController();
    const data = await client.proxies();
    const all = data?.proxies || {};
    const proxies = {};
    const groups = [];
    for (const [name, value] of Object.entries(all)) {
      const history = Array.isArray(value?.history) ? value.history : [];
      const latest = history.length ? history[history.length - 1] : null;
      proxies[name] = {
        type: value?.type || '',
        udp: Boolean(value?.udp),
        alive: value?.alive !== false,
        delay: latest && latest.delay > 0 ? latest.delay : 0,
        history: history.slice(-20).map(item => ({ time: item.time, delay: item.delay })),
        now: typeof value?.now === 'string' ? value.now : '',
        hidden: Boolean(value?.hidden),
      };
      if (Array.isArray(value?.all)) {
        groups.push({ name, type: value.type || '', now: typeof value.now === 'string' ? value.now : '', all: value.all, hidden: Boolean(value.hidden) });
      }
    }
    const groupNames = new Set(groups.map(group => group.name));
    let providerData = null;
    try { providerData = await client.request({ path: '/providers/proxies', timeout: 3000 }); } catch { providerData = null; }
    const remoteProviders = providerData?.providers || {};
    const config = await this.config.read();
    const directNames = directProxies(config.source);
    const localProxies = directNames.filter(name => proxies[name] && !groupNames.has(name));
    const definitions = proxyProviders(config.source);
    const providers = definitions.map(definition => {
      const remote = remoteProviders[definition.name] || {};
      const names = [];
      for (const item of Array.isArray(remote.proxies) ? remote.proxies : []) {
        const name = typeof item === 'string' ? item : item?.name;
        if (!name || groupNames.has(name)) continue;
        names.push(name);
        if (!proxies[name] && typeof item === 'string') {
          proxies[name] = { type: '', udp: false, alive: true, delay: 0, history: [], now: '', hidden: false };
        }
        if (!proxies[name] && item && typeof item === 'object') {
          const history = Array.isArray(item.history) ? item.history : [];
          const latest = history.length ? history[history.length - 1] : null;
          proxies[name] = {
            type: item.type || '',
            udp: Boolean(item.udp),
            alive: item.alive !== false,
            delay: latest && latest.delay > 0 ? latest.delay : 0,
            history: history.slice(-20).map(entry => ({ time: entry.time, delay: entry.delay })),
            now: '',
            hidden: false,
          };
        }
      }
      return {
        name: definition.name,
        type: definition.type || remote.vehicleType || remote.type || '',
        count: names.length,
        proxies: names,
        interval: definition.interval || 0,
        updatedAt: remote.updatedAt || '',
        subscriptionInfo: remote.subscriptionInfo || null,
        canRefresh: true,
      };
    });
    for (const group of groups) {
      if (!proxies[group.name] || proxies[group.name].delay > 0) continue;
      const selected = proxies[group.now];
      if (selected && selected.delay > 0) { proxies[group.name].delay = selected.delay; continue; }
      const values = group.all.map(name => proxies[name]?.delay || 0).filter(delay => delay > 0);
      if (values.length) proxies[group.name].delay = Math.min(...values);
    }
    return {
      mode: this.runtimeMode || config.info.mode || 'rule',
      groups,
      proxies,
      providers,
      local: { count: localProxies.length, proxies: localProxies },
    };
  }

  async refreshProvider(name) {
    if (typeof name !== 'string' || !name) fail('代理提供商名称无效');
    const config = await this.config.read();
    const definition = proxyProviders(config.source).find(item => item.name === name);
    if (!definition) fail('配置中未找到该代理提供商', 404);
    const client = this.requireController();
    try { await client.updateProxyProvider(name); }
    catch (error) { fail(`刷新代理提供商失败：${error.message}`); }
    this.log('info', `已刷新代理提供商 ${name}`);
    return { name };
  }

  async selectProxy(group, name) {
    const client = this.requireController();
    await client.selectProxy(group, name);
    this.log('info', `已切换代理组 ${group} 到 ${name}`);
    return { group, name };
  }

  async delay(name) {
    const client = this.requireController();
    const result = await client.delay(name, { url: this.state.delayTestUrl });
    return { name, delay: Number(result?.delay) || 0, message: result?.message || '' };
  }

  async groupDelay(group) {
    const client = this.requireController();
    const result = await client.groupDelay(group, { url: this.state.delayTestUrl });
    return { group, delays: result || {} };
  }

  async connections() {
    const client = this.requireController();
    const data = await client.connections();
    this.connectionCount = listenerCount(data?.connections);
    this.totals = { up: Number(data?.uploadTotal) || 0, down: Number(data?.downloadTotal) || 0 };
    const connections = (Array.isArray(data?.connections) ? data.connections : []).slice(0, 2000).map(item => ({
      id: String(item.id || ''),
      network: item.metadata?.network || '',
      type: item.metadata?.type || '',
      host: item.metadata?.host || '',
      source: item.metadata?.sourceIP || '',
      destination: item.metadata?.destinationIP || '',
      port: item.metadata?.destinationPort || '',
      process: item.metadata?.processPath || '',
      chains: Array.isArray(item.chains) ? item.chains : [],
      rule: item.rule || '',
      rulePayload: item.rulePayload || '',
      upload: Number(item.upload) || 0,
      download: Number(item.download) || 0,
      start: item.start || '',
    }));
    return { connections, uploadTotal: this.totals.up, downloadTotal: this.totals.down, truncated: Array.isArray(data?.connections) && data.connections.length > 2000 };
  }

  async closeConnection(id) {
    const client = this.requireController();
    await client.closeConnection(id);
    return { ok: true };
  }

  async closeAllConnections() {
    const client = this.requireController();
    await client.closeAllConnections();
    this.log('info', '已关闭全部连接');
    return { ok: true };
  }

  async setMode(mode) {
    if (!['rule', 'global', 'direct'].includes(mode)) fail('代理模式无效');
    if (this.coreState === 'running') {
      const client = this.controller();
      await client.patchConfigs({ mode }).catch(error => fail(`切换模式失败：${error.message}`));
      const current = await client.configs().catch(() => null);
      if (current && typeof current.mode === 'string' && current.mode !== mode) fail(`Core 未接受模式切换（当前 ${current.mode}）`);
      this.runtimeMode = mode;
    }
    await this.config.setMode(mode);
    this.log('info', `代理模式已切换为 ${mode}`);
    return { mode };
  }

  async logLevelUpdate(logLevel) {
    if (!CORE_LEVELS.has(logLevel)) return;
    const target = logLevel === 'silent' ? 'warning' : logLevel;
    try { await this.controller().patchConfigs({ 'log-level': target }); }
    catch (error) { this.log('warning', `更新 Core 日志级别失败，将在下次启动生效：${error.message}`); }
  }

  async setSettings(input = {}, { password = '', user = '' } = {}) {
    const previous = { ...this.state };
    const next = { ...this.state };
    const parsePort = (value, label, { allowZero = false } = {}) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) fail(`${label}必须是 1–65535 的整数`);
      return port;
    };
    if (input.autoStart !== undefined) next.autoStart = input.autoStart === true;
    if (input.autoRestart !== undefined) next.autoRestart = input.autoRestart === true;
    if (input.mixedPort !== undefined) next.mixedPort = parsePort(input.mixedPort, '混合端口');
    if (input.httpPort !== undefined) next.httpPort = parsePort(input.httpPort, 'HTTP 端口', { allowZero: true });
    if (input.socksPort !== undefined) next.socksPort = parsePort(input.socksPort, 'SOCKS 端口', { allowZero: true });
    if (input.allowLan !== undefined) next.allowLan = input.allowLan === true;
    if (next.httpPort > 0 && next.httpPort === next.mixedPort) fail('HTTP 端口不能与混合端口相同');
    if (next.socksPort > 0 && (next.socksPort === next.mixedPort || next.socksPort === next.httpPort)) fail('SOCKS 端口不能与其他端口相同');
    if (input.logLevel !== undefined) {
      if (!CORE_LEVELS.has(input.logLevel)) fail('日志级别无效');
      next.logLevel = input.logLevel;
    }
    if (input.channel !== undefined) {
      channelConfig(input.channel);
      if (input.channel !== this.state.channel) {
        next.channel = input.channel;
        this.available = { channel: input.channel, entries: [], checkedAt: '', error: '', fallback: false };
        await atomicJSON(this.availableFile, this.available, 0o600).catch(() => {});
      }
    }
    if (input.githubMirror !== undefined) {
      const mirror = String(input.githubMirror || '').trim();
      if (mirror && !normalizeMirror(mirror)) fail('GitHub 加速地址无效，需要 http(s) URL');
      next.githubMirror = mirror;
    }
    if (input.delayTestUrl !== undefined) {
      let testUrl;
      try { testUrl = new URL(String(input.delayTestUrl).trim()); } catch { fail('测速网址无效'); }
      if (!['http:', 'https:'].includes(testUrl.protocol)) fail('测速网址只支持 HTTP/HTTPS');
      next.delayTestUrl = testUrl.href;
    }
    if (input.userAgentSuffix !== undefined) next.userAgentSuffix = normalizeUserAgentSuffix(input.userAgentSuffix);
    if (input.delayIntervalMinutes !== undefined) {
      const minutes = Number(input.delayIntervalMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) fail('定时测速间隔必须是 0–1440 分钟');
      next.delayIntervalMinutes = minutes;
    }
    if (input.delayConcurrency !== undefined) {
      const concurrency = Number(input.delayConcurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) fail('测速并发数必须是 1–20');
      next.delayConcurrency = concurrency;
    }
    if (input.unifiedDelay !== undefined) next.unifiedDelay = input.unifiedDelay === true;
    if (input.tcpConcurrent !== undefined) next.tcpConcurrent = input.tcpConcurrent === true;
    if (input.delayIntervalMinutes !== undefined) this.lastDelayAt = 0;
    const hasNetworkInput = ['mixedPort', 'httpPort', 'socksPort', 'allowLan'].some(key => input[key] !== undefined);
    if (hasNetworkInput) next.networkManaged = true;
    const logLevelChanged = next.logLevel !== this.state.logLevel;
    const healthChanged = next.unifiedDelay !== this.state.unifiedDelay || next.tcpConcurrent !== this.state.tcpConcurrent;
    const networkChanged = next.mixedPort !== this.state.mixedPort || next.httpPort !== this.state.httpPort
      || next.socksPort !== this.state.socksPort || next.allowLan !== this.state.allowLan;
    this.state = next;
    await this.saveState();
    if ((networkChanged || healthChanged) && (this.coreState === 'running' || this.coreState === 'starting')) {
      try {
        await this.exclusive(async () => {
          if (this.coreState === 'running' || this.coreState === 'starting') await this.stopInternal();
          await this.startInternal({ password, user });
        });
      } catch (error) {
        this.state = previous;
        await this.saveState();
        try { await this.exclusive(() => this.startInternal()); } catch { /* keep the original error */ }
        fail(`应用网络设置失败，已恢复原设置：${error.message}`);
      }
    } else if (logLevelChanged && this.coreState === 'running') {
      await this.logLevelUpdate(next.logLevel);
    }
    this.log('info', '已保存设置');
    return this.status();
  }

  async saveConfig(source) {
    return this.exclusive(() => { this.assertNoJob(); return this.applyConfig(source, { kind: 'manual' }); });
  }

  async applyConfig(source, options = {}) {
    return this.withPreparation('应用配置', APPLY_STEPS, () => this.applyConfigInternal(source, options));
  }

  async applyConfigInternal(source, { kind = 'manual', subscriptionId = '', password = '', user = '' } = {}) {
    const current = await this.config.read();
    if (source === current.source) {
      this.log('info', '配置无变化，未保存');
      const status = await this.status();
      status.configSaved = false;
      return status;
    }
    // Validate before touching the stored configuration so a failed save leaves no backup.
    await this.validateConfig(source);
    const wasRunning = this.coreState === 'running' || this.coreState === 'starting';
    this.preparation.step('save', '正在保存配置并创建备份');
    const saved = await this.config.save(source, { kind, subscriptionId });
    if (this.state.networkManaged !== true) await this.adoptNetworkSettings(saved.info);
    try {
      if (wasRunning) {
        await this.stopInternal();
        await this.startInternal({ password, user });
      } else {
        this.preparation.step('launch', '正在写入运行配置并校验');
        await this.config.writeRuntime(this.runtimeConfigPath, { logLevel: this.state.logLevel, network: this.networkSettings(), health: this.healthSettings() });
        const entry = await this.requireActiveEntry();
        await this.applyCoreCapabilities(entry.path, { password, user });
        await this.testConfig(entry);
      }
    } catch (error) {
      await this.config.rollback(saved);
      if (wasRunning) {
        await this.startInternal().catch(restartError => {
          this.lastError = restartError.message;
          this.log('error', `恢复原配置后重启 Core 失败：${restartError.message}`);
        });
      }
      fail(`配置应用失败，已恢复原配置：${error.message}`);
    }
    this.log('info', kind === 'subscription' ? '订阅配置已应用' : '配置已保存并应用');
    const status = await this.status();
    status.configSaved = true;
    return status;
  }

  async readConfig() {
    const config = await this.config.read();
    return {
      source: config.source, info: config.info, updatedAt: config.updatedAt, kind: config.kind, subscriptionId: config.subscriptionId, size: config.size,
      managedKeys: ['external-controller', 'external-controller-tls', 'external-controller-pipe', 'external-controller-unix', 'external-ui', 'external-ui-url', 'external-ui-name', 'secret', 'log-level', 'mixed-port', 'port', 'socks-port', 'allow-lan'].filter(key => config.info.keys.includes(key) || ['mixed-port', 'port', 'socks-port', 'allow-lan'].includes(key)),
    };
  }

  async validateConfig(source) {
    return this.withPreparation('校验配置', VALIDATE_STEPS, async () => {
      await this.ensureGeodata();
      await this.ensureCoreData();
      const runtimePath = path.join(this.runtimeDir, 'validate.yaml');
      try {
        const content = injectController(source, { socketPath: this.socketPath, secret: this.state.controllerSecret, logLevel: this.state.logLevel, network: this.networkSettings() });
        await atomicWrite(runtimePath, content, 0o600);
        const entry = await this.requireActiveEntry();
        this.preparation.step('verify', '正在使用 mihomo -t 校验配置');
        await this.run(entry.path, ['-t', '-d', this.runtimeDir, '-f', runtimePath], { timeout: 25000 });
        return { ok: true, info: this.effectiveInfo(configInfo(source)) };
      } catch (error) {
        if (error instanceof AppError) throw error;
        fail(`配置校验失败：${redact(error.message, [this.state.controllerSecret]).split('\n').slice(-4).join(' ').slice(0, 600)}`);
      } finally {
        await removePath(runtimePath).catch(() => {});
      }
    });
  }

  async listBackups() { return this.config.listBackups(); }

  async deleteBackup(id) {
    const result = await this.config.deleteBackup(id);
    this.log('info', '已删除配置备份');
    return result;
  }

  async delayAll() {
    const client = this.requireController();
    const data = await client.proxies();
    const groups = Object.entries(data?.proxies || {}).filter(([name, value]) => Array.isArray(value?.all) && !['GLOBAL', 'COMPATIBLE'].includes(name)).map(([name]) => name);
    const results = {};
    const limit = Math.max(1, Math.min(20, Number(this.state.delayConcurrency) || 5));
    let cursor = 0;
    const worker = async () => {
      while (cursor < groups.length) {
        const name = groups[cursor];
        cursor += 1;
        try { results[name] = await client.groupDelay(name, { url: this.state.delayTestUrl }); }
        catch (error) { results[name] = { error: error.message }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, worker));
    const tested = Object.values(results).reduce((count, value) => count + (value && !value.error ? Object.keys(value).length : 0), 0);
    this.log('info', `一键测速完成：${groups.length} 个策略组，${tested} 个节点结果`);
    return { groups: results, tested, url: this.state.delayTestUrl, concurrency: limit };
  }

  async restoreBackup(id) { return this.exclusive(() => { this.assertNoJob(); return this.restoreBackupInternal(id); }); }

  async restoreBackupInternal(id) {
    return this.withPreparation('恢复配置备份', [
      { key: 'data', label: '准备外部数据' },
      { key: 'verify', label: '校验配置' },
      { key: 'launch', label: '恢复配置' },
    ], async () => {
      const restored = await this.config.restoreBackup(id);
      const wasRunning = this.coreState === 'running';
      try {
        if (wasRunning) { await this.stopInternal(); await this.startInternal(); }
        else {
          this.preparation.step('launch', '正在校验恢复后的配置');
          await this.config.writeRuntime(this.runtimeConfigPath, { logLevel: this.state.logLevel, network: this.networkSettings(), health: this.healthSettings() });
          const entry = await this.requireActiveEntry();
          await this.testConfig(entry);
        }
      } catch (error) {
        await this.config.rollback(restored);
        if (wasRunning) await this.startInternal().catch(() => {});
        fail(`恢复备份失败：${error.message}`);
      }
      this.log('info', '已从备份恢复配置');
      return this.status();
    });
  }

  async addSubscription(input) {
    const result = await this.config.addSubscription(input);
    this.log('info', `已添加订阅 ${result.name}`);
    return result;
  }

  async updateSubscriptionSettings(id, input) { return this.config.updateSubscriptionSettings(id, input); }

  async deleteSubscription(id) {
    const result = await this.config.deleteSubscription(id);
    this.log('info', '已删除订阅');
    return result;
  }

  async updateSubscription(id) {
    this.log('info', '正在更新订阅');
    const result = await this.config.updateSubscription(id);
    this.log('info', `订阅 ${result.name} 已更新`);
    return result;
  }

  async applySubscription(id) {
    const item = this.config.findSubscription(id);
    const source = await this.config.readSubscriptionContent(id);
    const augmented = augmentSubscriptionConfig(source);
    if (augmented.added.length) this.log('info', `订阅缺少 ${augmented.added.join('、')}，已自动补充基础分组与规则`);
    const status = await this.exclusive(() => { this.assertNoJob(); return this.applyConfig(augmented.source, { kind: 'subscription', subscriptionId: item.id }); });
    status.augmented = augmented.added;
    return status;
  }

  async previewSubscription(id) { return this.config.previewSubscription(id); }


  async githubFetcher(url, options = {}) {
    const original = String(url);
    const target = mirrorGithubUrl(original, this.state.githubMirror);
    const requestOptions = this.withUserAgent(options);
    if (target === original) return this.fetcher(original, requestOptions);
    try {
      const response = await this.fetcher(target, requestOptions);
      if (![403, 404, 429].includes(response.status) && response.status < 500) return response;
      await response.body?.cancel();
      this.log('warning', `GitHub 加速地址返回 HTTP ${response.status}，改用直连`);
    } catch (error) {
      this.log('warning', `GitHub 加速地址请求失败：${error.message}，改用直连`);
    }
    return this.fetcher(original, requestOptions);
  }

  mirrorUrl(url) {
    return mirrorGithubUrl(url, this.state.githubMirror);
  }

  dataSettings() {
    return {
      autoUpdate: this.state.dataAutoUpdate === true,
      intervalHours: Number(this.state.dataIntervalHours) || 0,
      model: this.state.dataModel,
      modelOptions: Object.entries(MODEL_LABELS).map(([id, label]) => ({ id, label, url: MODEL_URLS[id] })),
      urls: { ...this.state.dataUrls },
    };
  }

  /** Required datasets that the first start would still have to download. */
  async dataReadiness() {
    const required = ['geoip', 'geosite'];
    if (this.state.channel === 'smart') required.push('model');
    const missing = [];
    for (const key of required) {
      const def = DATASETS.find(item => item.key === key);
      if (def && !(await pathExists(path.join(this.runtimeDir, def.filename)))) missing.push(key);
    }
    return {
      ready: missing.length === 0,
      missing,
      channel: this.state.channel,
      names: missing.map(key => DATASETS.find(item => item.key === key)?.name || key),
    };
  }

  async dataStatus() {
    await this.ensureGeodata().catch(() => {});
    const items = [];
    for (const def of DATASETS) {
      const file = path.join(this.runtimeDir, def.filename);
      let size = 0, updatedAt = '';
      try {
        const info = await stat(file);
        size = info.size;
        updatedAt = info.mtime.toISOString();
      } catch { /* not downloaded yet */ }
      items.push({
        key: def.key,
        name: def.name,
        filename: def.filename,
        description: def.description,
        model: def.model === true,
        url: this.state.dataUrls[def.key] || def.url,
        size,
        updatedAt,
        exists: size > 0,
      });
    }
    return { settings: this.dataSettings(), items };
  }

  async saveDataSettings(input = {}) {
    if (input.autoUpdate !== undefined) this.state.dataAutoUpdate = input.autoUpdate === true;
    if (input.intervalHours !== undefined) {
      const hours = Number(input.intervalHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) fail('数据更新间隔必须是 1–720 小时');
      this.state.dataIntervalHours = hours;
    }
    if (input.model !== undefined) {
      if (!Object.hasOwn(MODEL_URLS, input.model)) fail('Smart 模型版本无效');
      this.state.dataModel = input.model;
      if (!input.urls || input.urls.model === undefined) this.state.dataUrls.model = MODEL_URLS[input.model];
    }
    if (input.urls && typeof input.urls === 'object') {
      for (const key of DATASET_KEYS) {
        if (input.urls[key] === undefined) continue;
        const value = String(input.urls[key]).trim();
        let parsed;
        try { parsed = new URL(value); } catch { fail(`数据地址无效：${key}`); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(`数据地址必须是 HTTP/HTTPS：${key}`);
        this.state.dataUrls[key] = parsed.href;
      }
    }
    await this.saveState();
    return this.dataStatus();
  }

  async syncData(key, { restart = true, url: overrideUrl = '' } = {}) {
    const def = DATASETS.find(item => item.key === key);
    if (!def) fail('未知的数据类型');
    return this.withPreparation(`同步${def.name}`, [
      { key: 'download', label: `下载${def.name}` },
      { key: 'restart', label: '重启内核以加载数据' },
    ], () => this.syncDataInternal(def, { restart, overrideUrl }));
  }

  async syncDataInternal(def, { restart = true, overrideUrl = '' } = {}) {
    if (overrideUrl) {
      let parsedOverride;
      try { parsedOverride = new URL(String(overrideUrl)); } catch { fail('数据更新地址无效'); }
      if (!['http:', 'https:'].includes(parsedOverride.protocol) || parsedOverride.username || parsedOverride.password) fail('数据更新地址必须是 HTTP/HTTPS');
      this.state.dataUrls[def.key] = parsedOverride.href;
      await this.saveState();
    }
    const url = this.state.dataUrls[def.key];
    let parsed;
    try { parsed = new URL(url); } catch { fail('数据更新地址无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail('数据更新地址必须是 HTTP/HTTPS');
    if (this.preparation.has('download')) this.preparation.step('download', `正在下载${def.name}`);
    const response = await this.githubFetcher(parsed.href, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(120000), headers: { 'user-agent': 'fnos-clash-manager' } });
    if (!response.ok) fail(`数据下载失败：HTTP ${response.status}`, 502);
    const expected = Number(response.headers?.get?.('content-length')) || 0;
    const chunks = [];
    let size = 0;
    this.preparation.bytes(0, expected);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) fail('数据文件超过 128 MiB 限制');
      chunks.push(Buffer.from(chunk));
      this.preparation.bytes(size, expected);
    }
    if (!size) fail('数据文件为空');
    await ensureDir(this.runtimeDir, 0o700);
    const destination = path.join(this.runtimeDir, def.filename);
    const temporary = `${destination}.tmp-${process.pid}`;
    await writeFile(temporary, Buffer.concat(chunks), { mode: 0o644 });
    await rename(temporary, destination);
    this.state.dataUpdatedAt[def.key] = new Date(this.now()).toISOString();
    await this.saveState();
    this.log('info', `已更新外部数据 ${def.name}（${size} 字节）`);
    if (restart && this.coreState === 'running') {
      try {
        this.preparation.step('restart', '正在重启内核以加载新数据');
        await this.exclusive(async () => { await this.stopInternal(); await this.startInternal(); });
        this.log('info', '外部数据已应用，Core 已重启');
      } catch (error) { this.log('warning', `外部数据已更新，但 Core 重启失败：${error.message}`); }
    }
    return { key: def.key, filename: def.filename, size, updatedAt: this.state.dataUpdatedAt[def.key] };
  }

  async syncAllData({ restart = true } = {}) {
    const steps = DATASETS.map(def => ({ key: def.key, label: def.name })).concat({ key: 'restart', label: '重启内核以加载数据' });
    return this.withPreparation('同步外部数据', steps, async () => {
      const results = [];
      for (const def of DATASETS) {
        this.preparation.step(def.key, `正在下载${def.name}`);
        results.push(await this.syncData(def.key, { restart: false }));
      }
      if (restart && this.coreState === 'running') {
        try {
          this.preparation.step('restart', '正在重启内核以加载新数据');
          await this.exclusive(async () => { await this.stopInternal(); await this.startInternal(); });
          this.log('info', '外部数据已全部应用，Core 已重启');
        } catch (error) { this.log('warning', `外部数据已更新，但 Core 重启失败：${error.message}`); }
      }
      return results;
    });
  }

  healthSettings() {
    return { unifiedDelay: this.state.unifiedDelay === true, tcpConcurrent: this.state.tcpConcurrent === true };
  }

  async systemDnsServers() {
    try {
      const resolv = await readFile('/etc/resolv.conf', 'utf8');
      return resolv.split('\n').map(line => /^\s*nameserver\s+(\S+)/.exec(line)?.[1]).filter(value => value && !/^127\./.test(value)).slice(0, 4);
    } catch { return []; }
  }

  async mountOptions(file) {
    if (!file) return '';
    try {
      const output = await this.run('findmnt', ['-no', 'OPTIONS', '--target', file], { timeout: 5000 });
      return String(output).split('\n')[0].trim();
    } catch { return ''; }
  }

  /** Execute a URL like a third-party app that honors the NAS system proxy setting. */
  async testUrl(input = '') {
    const raw = String(input || '').trim();
    if (!raw) fail('请输入测试网址');
    if (raw.length > 2048) fail('测试网址过长');
    let url;
    try { url = new URL(raw); } catch { fail('测试网址格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail('只支持 HTTP/HTTPS 网址');
    if (url.username || url.password) fail('测试网址不能包含用户名或密码');
    const proxy = await this.systemProxyState();
    const tun = await this.tunStatus();
    if (tun.active && !(proxy.enabled && proxy.port)) {
      return {
        url: url.href,
        proxy: { enabled: false },
        skipped: true,
        reason: '增强模式已开启，应用进程 UID 被 TUN 排除；应用自身直连不代表系统流量，请用终端 curl 验证 TUN。',
      };
    }
    const args = ['-sS', '-L', '--max-redirs', '5', '-o', '/dev/null', '-w', '%{http_code} %{time_total}', '--max-time', '15'];
    if (proxy.enabled && proxy.port) args.push('-x', `http://127.0.0.1:${proxy.port}`, '--noproxy', '');
    else args.push('--noproxy', '*');
    args.push(url.href);
    try {
      const output = await this.run('curl', args, { timeout: 20000 });
      const match = /(\d{3})\s+([\d.]+)\s*$/.exec(String(output).trim());
      return {
        url: url.href,
        proxy: proxy.enabled && proxy.port ? { enabled: true, port: proxy.port } : { enabled: false },
        ok: true,
        code: match?.[1] || '000',
        seconds: match?.[2] || '',
      };
    } catch (error) {
      return {
        url: url.href,
        proxy: proxy.enabled && proxy.port ? { enabled: true, port: proxy.port } : { enabled: false },
        ok: false,
        error: redact(error.message, [this.state.controllerSecret]).slice(-400),
      };
    }
  }

  async diagnostics() {
    const config = await this.config.read();
    const info = this.effectiveInfo(config.info);
    const source = config.source;
    const addresses = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const item of list || []) if (item.family === 'IPv4' && !item.internal) addresses.push({ iface: name, address: item.address });
    }
    const tunState = await this.tunStatus();
    const activeEntry = await this.findEntry(this.activeId);
    const mountOptions = activeEntry ? await this.mountOptions(activeEntry.path) : '';
    const dnsServers = await this.systemDnsServers();
    const proxyState = await this.systemProxyState();
    const proxyWritable = await this.systemProxyWritable();
    const helperReady = await this.serviceHelperReady();
    const portEntries = Object.entries(info.ports || {}).filter(([, port]) => port > 0);
    const checks = [];
    let lanReachable = null;
    if (this.coreState === 'running') {
      for (const address of addresses.slice(0, 3)) {
        for (const [name, port] of portEntries.slice(0, 2)) {
          const reachable = await this.canConnect(address.address, port);
          checks.push({ iface: address.iface, address: address.address, name, port, reachable });
          if (reachable) lanReachable = true;
        }
      }
      if (lanReachable === null && checks.length) lanReachable = false;
    }
    const hints = [];
    if (this.coreState !== 'running') hints.push('Core 未运行，请先启动 Core 后再诊断局域网访问。');
    if (info.allowLan !== true) hints.push('配置未开启 allow-lan，其他设备无法通过本机代理端口上网。请在配置中加入 allow-lan: true 并保存应用。');
    if (info.keys.includes('authentication')) hints.push('配置启用了代理认证（authentication），局域网客户端需要填写对应的用户名和密码。');
    if (info.keys.includes('bind-address') && !/^["']?\*["']?$/.test(topLevelValue(source, 'bind-address') || '')) hints.push(`bind-address 当前为 ${topLevelValue(source, 'bind-address')}，只绑定特定地址时其他网卡将无法访问。`);
    if (lanReachable === false) hints.push('Core 正在运行，但从本机局域网地址无法连接代理端口：请检查 bind-address、fnOS 防火墙或端口是否被占用。');
    if (lanReachable === true) hints.push('代理端口在局域网地址上可以连接。若其他设备仍无法上网，请检查虚拟机网络模式（NAT 需端口转发，建议桥接）、宿主机防火墙，以及宿主机代理工具的 TUN / fake-ip 是否会拦截虚拟机流量。');
    if (!addresses.length) hints.push('未发现局域网 IPv4 地址，请检查虚拟机网卡配置。');
    if (tunState.configured && !tunState.active) hints.push(`增强模式未生效：${tunState.message}`);
    if (tunState.configured && tunState.active) hints.push(`增强模式已生效：TUN 网卡 ${tunState.device} 已创建；请用不带代理的 curl 验证实际流量。`);
    if (/\bnosuid\b/.test(mountOptions)) hints.push('Core 所在文件系统为 nosuid，file capabilities 会被内核忽略，TUN 无法获得 CAP_NET_ADMIN；需要把 Core 放到非 nosuid 路径或改由 root 运行。');
    if (dnsServers.some(server => /^127\./.test(server))) hints.push(`系统 DNS 为 ${dnsServers.join('、')}；回环 DNS 不会被 TUN 的 dns-hijack 接管，请改用局域网 DNS 或为 Core 配置可用的上游 DNS。`);
    if (tunState.capability.known && tunState.capability.capNetAdmin === false) hints.push(`Core 当前没有 CAP_NET_ADMIN；请重新安装/升级应用，或按 README 初始化服务模式 helper，然后重启内核。`);
    if (!proxyWritable && !helperReady) hints.push('系统代理需要 root-owned 服务模式 helper；请重新安装/升级应用，或按 README 执行一次性 root 初始化，然后重试。');
    if (proxyState.enabled) hints.push('NAS 系统代理只写入 /etc/environment，仅对之后新登录的会话生效；当前 SSH shell、已运行服务不会自动使用它。透明代理请使用增强模式（TUN）。');
    return {
      app: { version: this.version },
      userAgent: this.userAgent(),
      platform: { os: this.platform, arch: this.arch, supported: this.platformSupported() },
      core: { state: this.coreState, running: this.coreState === 'running', version: this.coreVersion, uptimeMs: this.startedAt ? Math.max(0, Date.now() - this.startedAt) : 0, activeId: this.activeId, path: activeEntry?.path || '', mountOptions },
      dns: { servers: dnsServers },
      config: {
        allowLan: info.allowLan,
        bindAddress: topLevelValue(source, 'bind-address') || '',
        ports: info.ports,
        mode: info.mode,
        logLevel: info.logLevel,
        authentication: info.keys.includes('authentication'),
        dns: info.keys.includes('dns'),
      },
      tun: {
        configured: tunState.configured,
        active: tunState.active,
        device: tunState.device,
        devicePresent: tunState.tunDevicePresent,
        capNetAdmin: tunState.capability.capNetAdmin,
        capabilityKnown: tunState.capability.known,
        capabilityError: this.capabilityError,
        message: tunState.message,
      },
      systemProxy: { enabled: proxyState.enabled, port: proxyState.port, writable: proxyWritable },
      serviceMode: { ready: helperReady, helperDir: this.privilegedHelperDir },
      network: { addresses, checks, lanReachable },
      hints,
    };
  }

  canConnect(host, port, timeout = 1500) {
    return new Promise(resolve => {
      const socket = net.connect({ host, port });
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  logsHistory({ limit = 300, minLevel = '' } = {}) {
    return this.logs.history({ limit, minLevel });
  }

  startScheduler() {
    clearInterval(this.schedulerTimer);
    this.lastDelayAt = this.now();
    this.schedulerTimer = setInterval(() => this.runScheduledTasks().catch(error => this.log('error', `定时任务失败：${error.message}`)), 60000);
    this.schedulerTimer.unref?.();
  }

  async runScheduledTasks() {
    await this.runScheduledSubscriptions();
    await this.runScheduledDelay();
    await this.runScheduledData();
  }

  async runScheduledDelay() {
    if (this.closed || this.schedulerBusy) return;
    const minutes = Number(this.state.delayIntervalMinutes) || 0;
    if (minutes <= 0 || this.coreState !== 'running') return;
    if (this.now() - (this.lastDelayAt || 0) < minutes * 60000) return;
    this.lastDelayAt = this.now();
    try { await this.delayAll(); }
    catch (error) { this.log('warning', `定时测速失败：${error.message}`); }
  }

  async runScheduledData() {
    if (this.closed || this.schedulerBusy || !this.state.dataAutoUpdate) return;
    const hours = Number(this.state.dataIntervalHours) || 0;
    if (hours <= 0) return;
    const last = Math.max(0, ...Object.values(this.state.dataUpdatedAt || {}).map(value => Date.parse(value) || 0));
    if (last && this.now() - last < hours * 3600000) return;
    await this.syncAllData({ restart: true }).catch(error => this.log('warning', `定时更新外部数据失败：${error.message}`));
  }

  async runScheduledSubscriptions() {
    if (this.closed || this.schedulerBusy) return;
    this.schedulerBusy = true;
    try {
      for (const item of this.config.subscriptions) {
        if (!Number.isInteger(item.intervalHours) || item.intervalHours <= 0) continue;
        const last = Date.parse(item.updatedAt || item.attemptedAt || item.createdAt || 0);
        if (Number.isFinite(last) && this.now() - last < item.intervalHours * 3600000) continue;
        try {
          await this.config.updateSubscription(item.id);
          this.log('info', `定时更新订阅 ${item.name} 完成`);
        } catch (error) {
          this.log('warning', `定时更新订阅 ${item.name} 失败：${error.message}`);
        }
      }
    } finally {
      this.schedulerBusy = false;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.schedulerTimer);
    clearTimeout(this.restartTimer);
    this.jobController?.abort();
    const jobTask = this.jobTask;
    this.stopStreams();
    this.stoppingIntent = true;
    const process = this.core;
    this.core = null;
    if (process) {
      await process.stop().catch(() => {});
      process.dispose();
    }
    this.coreState = 'stopped';
    try { await this.applySystemProxy(false); }
    catch (error) { this.log('warning', `停止应用时恢复系统代理失败：${error.message}`); }
    await jobTask?.catch(() => {});
    await this.logs?.close();
  }
}

