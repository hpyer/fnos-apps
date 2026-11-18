import { lookup } from 'node:dns/promises';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fail } from './errors.mjs';
import { defaultConfig } from './config-template.mjs';
import { downloadText } from './download.mjs';
import { maskUrl } from './redact.mjs';
import { atomicJSON, atomicWrite, ensureDir, readJSON, safeId } from './storage.mjs';
import { configInfo, injectController, looksJSON, setTopLevel, validateConfigSource } from './yaml.mjs';

const SUBSCRIPTION_URL_MAX = 2048;
const NAME_MAX = 60;
const BACKUP_KEEP = 10;
const BACKUP_NAME = /^[0-9T-]+-[a-z0-9-]+\.yaml$/i;

export { defaultConfig };

export function normalizeSubscriptionName(value) {
  if (typeof value !== 'string') fail('订阅名称无效');
  const name = value.trim();
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) fail(`订阅名称须为 1–${NAME_MAX} 个可见字符`);
  return name;
}

export function validateSubscriptionUrl(value) {
  if (typeof value !== 'string' || value.length > SUBSCRIPTION_URL_MAX) fail('订阅地址无效');
  let url;
  try { url = new URL(value.trim()); } catch { fail('订阅地址必须是有效的 HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('订阅地址只支持 HTTP/HTTPS');
  if (url.username || url.password) fail('订阅地址不能包含用户名或密码');
  return url.href;
}

export function normalizeInterval(value) {
  const interval = Number(value ?? 0);
  if (!Number.isInteger(interval) || interval < 0 || interval > 168) fail('订阅更新间隔须为 0–168 小时，0 表示不自动更新');
  return interval;
}

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^22[4-9]\./, /^23\d\./, /^24\d\./, /^25[0-5]\./,
];
// 198.18.0.0/15 is reserved for benchmarking and widely used as the fake-ip pool by
// proxy tools on the network path (mihomo's default fake-ip range). It does not host
// real intranet services, so DNS answers in that range are not treated as an SSRF risk.

/** Reject loopback/private/link-local targets to keep subscription downloads from becoming SSRF. */
export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some(pattern => pattern.test(address));
  if (family === 6) {
    const value = String(address).toLowerCase();
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff');
  }
  return true;
}

export class ConfigService {
  constructor({ root, socketPath, secret, logLevel = 'info', fetcher = globalThis.fetch, resolver = lookup }) {
    this.root = root;
    this.socketPath = socketPath;
    this.secret = secret;
    this.logLevel = logLevel;
    this.fetcher = fetcher;
    this.resolver = resolver;
    this.configDir = path.join(root, 'config');
    this.configFile = path.join(this.configDir, 'config.yaml');
    this.metaFile = path.join(this.configDir, 'meta.json');
    this.backupDir = path.join(root, 'backups');
    this.subscriptionDir = path.join(root, 'subscriptions');
    this.subscriptionFile = path.join(root, 'subscriptions.json');
    this.subscriptions = [];
    this.meta = { updatedAt: '', kind: 'default', subscriptionId: '' };
  }

  async init() {
    await ensureDir(this.root, 0o700);
    await ensureDir(this.configDir, 0o700);
    await ensureDir(this.backupDir, 0o700);
    await ensureDir(this.subscriptionDir, 0o700);
    try { await readFile(this.configFile, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWrite(this.configFile, defaultConfig(), 0o600);
      this.meta = { updatedAt: new Date().toISOString(), kind: 'default', subscriptionId: '' };
      await atomicJSON(this.metaFile, this.meta, 0o600);
    }
    this.meta = { ...this.meta, ...(await readJSON(this.metaFile, {})) };
    const stored = await readJSON(this.subscriptionFile, { subscriptions: [] });
    this.subscriptions = Array.isArray(stored?.subscriptions) ? stored.subscriptions.filter(item => item && typeof item.id === 'string') : [];
  }

  async read() {
    const source = await readFile(this.configFile, 'utf8');
    const details = await stat(this.configFile);
    return { source, info: configInfo(source), updatedAt: this.meta.updatedAt, kind: this.meta.kind, subscriptionId: this.meta.subscriptionId, size: details.size };
  }

  async source() {
    try { return await readFile(this.configFile, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return defaultConfig();
    }
  }

  async buildRuntimeConfig({ logLevel = this.logLevel, network = null, health = null } = {}) {
    const source = await this.source();
    return injectController(source, { socketPath: this.socketPath, secret: this.secret, logLevel, network, health });
  }

  async writeRuntime(file, options = {}) {
    const content = await this.buildRuntimeConfig(options);
    await atomicWrite(file, content, 0o600);
    return content;
  }

  async backup(reason = 'manual') {
    const source = await this.source();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${reason.replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'manual'}.yaml`;
    await atomicWrite(path.join(this.backupDir, name), source, 0o600);
    await this.pruneBackups();
    return name;
  }

  async pruneBackups() {
    const files = (await readdir(this.backupDir)).filter(name => BACKUP_NAME.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) await rm(path.join(this.backupDir, name), { force: true });
  }

  async listBackups() {
    const files = (await readdir(this.backupDir)).filter(name => BACKUP_NAME.test(name)).sort().reverse().slice(0, BACKUP_KEEP);
    return Promise.all(files.map(async name => ({ id: name, label: name.replace(/\.yaml$/, ''), size: (await stat(path.join(this.backupDir, name))).size })));
  }

  async restoreBackup(id) {
    if (typeof id !== 'string' || !BACKUP_NAME.test(id)) fail('备份标识无效');
    const source = await readFile(path.join(this.backupDir, id), 'utf8');
    return this.save(source, { kind: 'restore' });
  }

  async deleteBackup(id) {
    if (typeof id !== 'string' || !BACKUP_NAME.test(id)) fail('备份标识无效');
    await rm(path.join(this.backupDir, id), { force: true });
    return { ok: true };
  }

  /** Validate, back up and atomically store a user configuration. */
  async save(source, { kind = 'manual', subscriptionId = '' } = {}) {
    validateConfigSource(source);
    const previous = await this.source();
    const previousMeta = { ...this.meta };
    if (source === previous) return { unchanged: true, previous, previousMeta, ...(await this.read()) };
    if (previous.trim()) await this.backup('pre-save');
    await atomicWrite(this.configFile, source, 0o600);
    this.meta = { updatedAt: new Date().toISOString(), kind, subscriptionId };
    await atomicJSON(this.metaFile, this.meta, 0o600);
    return { previous, previousMeta, unchanged: false, ...(await this.read()) };
  }

  async rollback({ previous, previousMeta }) {
    if (typeof previous !== 'string') return false;
    await atomicWrite(this.configFile, previous, 0o600);
    this.meta = previousMeta || { updatedAt: new Date().toISOString(), kind: 'rollback', subscriptionId: '' };
    await atomicJSON(this.metaFile, this.meta, 0o600);
    return true;
  }

  async setMode(mode) {
    if (!['rule', 'global', 'direct'].includes(mode)) fail('代理模式无效');
    const source = await this.source();
    const next = setTopLevel(source, 'mode', mode);
    await atomicWrite(this.configFile, next, 0o600);
    this.meta = { ...this.meta, updatedAt: new Date().toISOString() };
    await atomicJSON(this.metaFile, this.meta, 0o600);
    return configInfo(next);
  }

  subscriptionView(item) {
    return {
      id: item.id,
      name: item.name,
      urlMasked: maskUrl(item.url),
      intervalHours: item.intervalHours,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || '',
      lastError: item.lastError || '',
      size: item.size || 0,
      applied: this.meta.subscriptionId === item.id,
    };
  }

  listSubscriptions() {
    return this.subscriptions.map(item => this.subscriptionView(item)).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async persistSubscriptions() {
    await atomicJSON(this.subscriptionFile, { subscriptions: this.subscriptions }, 0o600);
  }

  findSubscription(id) {
    safeId(id, '订阅标识');
    const item = this.subscriptions.find(entry => entry.id === id);
    if (!item) fail('订阅不存在', 404);
    return item;
  }

  async addSubscription(input = {}) {
    const name = normalizeSubscriptionName(input.name);
    const url = validateSubscriptionUrl(input.url);
    const intervalHours = normalizeInterval(input.intervalHours);
    if (this.subscriptions.some(item => item.name === name)) fail('已存在同名订阅');
    const item = { id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, url, intervalHours,
      createdAt: new Date().toISOString(), updatedAt: '', lastError: '', size: 0, etag: '', lastModified: '', appliedAt: '', attemptedAt: '' };
    this.subscriptions.push(item);
    await this.persistSubscriptions();
    // Fetch the content immediately so wrong URLs or tokens surface at once.
    try { return await this.updateSubscription(item.id); }
    catch { return this.subscriptionView(item); }
  }

  async updateSubscriptionSettings(id, input = {}) {
    const item = this.findSubscription(id);
    if (input.name !== undefined) item.name = normalizeSubscriptionName(input.name);
    if (input.url !== undefined) item.url = validateSubscriptionUrl(input.url);
    if (input.intervalHours !== undefined) item.intervalHours = normalizeInterval(input.intervalHours);
    if (this.subscriptions.some(entry => entry.id !== id && entry.name === item.name)) fail('已存在同名订阅');
    await this.persistSubscriptions();
    return this.subscriptionView(item);
  }

  async deleteSubscription(id) {
    const item = this.findSubscription(id);
    this.subscriptions = this.subscriptions.filter(entry => entry.id !== item.id);
    await this.persistSubscriptions();
    await rm(path.join(this.subscriptionDir, `${item.id}.yaml`), { force: true });
    return { ok: true };
  }

  async readSubscriptionContent(id) {
    const item = this.findSubscription(id);
    try { return await readFile(path.join(this.subscriptionDir, `${item.id}.yaml`), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') fail('订阅尚未下载内容，请先更新', 409);
      throw error;
    }
  }

  async assertPublicHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (isPrivateAddress(host)) fail('订阅地址指向内网或回环地址，已拒绝');
      return;
    }
    let addresses;
    try { addresses = await this.resolver(host, { all: true }); } catch { fail('订阅地址域名解析失败'); }
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) fail('订阅地址解析到内网或回环地址，已拒绝');
  }

  async subscriptionRequest(url, { signal, headers = {} } = {}) {
    let current = url;
    for (let hop = 0; hop < 5; hop += 1) {
      const parsed = new URL(current);
      if (!['http:', 'https:'].includes(parsed.protocol)) fail('订阅重定向只支持 HTTP/HTTPS');
      if (parsed.username || parsed.password) fail('订阅重定向不能包含用户名或密码');
      await this.assertPublicHost(parsed.hostname);
      const response = await this.fetcher(current, {
        redirect: 'manual',
        cache: 'no-store',
        signal,
        headers: { 'user-agent': 'fnos-clash-manager', accept: 'text/yaml, application/yaml, text/plain, */*', ...headers },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) fail('订阅重定向缺少目标地址');
        current = new URL(location, current).href;
        continue;
      }
      return response;
    }
    fail('订阅重定向次数过多');
  }

  /** Download and validate subscription content; applying it remains a separate action. */
  async updateSubscription(id, { signal } = {}) {
    const item = this.findSubscription(id);
    item.attemptedAt = new Date().toISOString();
    await this.persistSubscriptions();
    let downloaded;
    try {
      downloaded = await downloadText({
        url: item.url,
        request: (url, options) => this.subscriptionRequest(url, options),
        maxBytes: 8 * 1024 * 1024, signal, timeoutMs: 30000, label: '订阅内容',
      });
    } catch (error) {
      item.lastError = error.message;
      await this.persistSubscriptions();
      throw error;
    }
    try { validateConfigSource(downloaded.text); }
    catch (error) {
      item.lastError = error.message;
      await this.persistSubscriptions();
      throw error;
    }
    await atomicWrite(path.join(this.subscriptionDir, `${item.id}.yaml`), downloaded.text, 0o600);
    item.updatedAt = new Date().toISOString();
    item.lastError = '';
    item.size = downloaded.size;
    item.etag = downloaded.etag;
    item.lastModified = downloaded.lastModified;
    await this.persistSubscriptions();
    return { ...this.subscriptionView(item), info: configInfo(downloaded.text) };
  }

  async applySubscription(id) {
    const item = this.findSubscription(id);
    const source = await this.readSubscriptionContent(id);
    validateConfigSource(source);
    return this.save(source, { kind: 'subscription', subscriptionId: item.id });
  }

  async previewSubscription(id) {
    const item = this.findSubscription(id);
    const source = await this.readSubscriptionContent(id);
    return { id: item.id, name: item.name, source, info: configInfo(source), looksJSON: looksJSON(source) };
  }
}
