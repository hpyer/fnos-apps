import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { loadConfig, readJson, writeJson } from '../shared/config.mjs';
import { Manager } from './manager.mjs';
import { DshProcess } from './process.mjs';
import { Versions, exactVersion } from './versions.mjs';
import { userAccessibleFolders } from './fnos-api.mjs';

function validUid(uid) {
  const value = String(uid ?? '');
  if (value !== 'dev' && !/^[1-9]\d*$/.test(value)) throw new Error('无法识别当前飞牛用户');
  return value;
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Owns global runtime downloads and a lazily-created DSH tenant per fnOS UID.
// Every tenant has its own HOME, DSH_HOME, process, authenticated upstream
// cookie and plugin watcher, while verified DSH runtime files remain shared.
export class FleetManager {
  constructor(root, environment, dependencies = {}) {
    this.root = root;
    this.environment = environment;
    this.sharedHome = environment.HOME ?? path.join(root, 'home');
    this.userHomeRoot = dependencies.userHomeRoot ?? environment.DSH_USER_HOME_ROOT ?? path.join(this.sharedHome, 'user-homes');
    this.abort = new AbortController();
    this.versions = dependencies.versions ?? new Versions(root, environment, { signal: this.abort.signal });
    this.processFactory = dependencies.processFactory ?? (tenantEnvironment => new DshProcess(tenantEnvironment));
    this.folderProvider = dependencies.folderProvider ?? (uid => userAccessibleFolders(this.environment, uid));
    this.tenants = new Map();
    this.tenantPromises = new Map();
    this.busy = null;
    this.error = null;
    this.globalTask = null;
    this.releases = [];
    this.stopping = false;
    this.idleTimer = null;
    this.initialLaunch = null;
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.config = await loadConfig(this.root);
    this.state = await readJson(path.join(this.root, 'state.json'), { defaultVersion: null, legacyOwner: null, userHomes: {} });
    this.state.defaultVersion ??= this.state.current ?? null;
    this.state.userHomes ??= {};
    try {
      const pointer = await readlink(path.join(this.root, 'runtimes/current'));
      if (pointer.startsWith('versions/')) this.state.defaultVersion = exactVersion(pointer.slice('versions/'.length));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.idleTimer = setInterval(() => { void this.closeIdleTenants(); }, 1_000);
    this.idleTimer.unref?.();
  }

  async save() { await writeJson(path.join(this.root, 'state.json'), this.state); }

  userRoot(uid) { return path.join(this.userHomeRoot, validUid(uid)); }

  userHome(uid) { return this.state.userHomes[validUid(uid)] ?? null; }

  async setUserHome(uid, selected) {
    uid = validUid(uid);
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('请选择有效的 DSH 工作目录');
    const root = path.resolve(this.userRoot(uid));
    const home = path.resolve(selected);
    const relative = path.relative(root, home);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('DSH 工作目录必须是你的飞牛主目录中的子目录');
    }
    if (this.tenants.has(uid)) throw new Error('DSH 已在运行，不能更改工作目录');
    this.state.userHomes[uid] = home;
    await this.save();
    return home;
  }

  async homeAccess(uid) {
    const home = this.userHome(uid);
    if (!home) return { home: this.userRoot(uid), ready: false, selected: false };
    try {
      await access(home, constants.R_OK | constants.W_OK | constants.X_OK);
      return { home, ready: true, selected: true };
    } catch (error) {
      if (['EACCES', 'ENOENT'].includes(error.code)) return { home, ready: false, selected: true };
      throw error;
    }
  }

  async exclusive(label, action) {
    if (this.stopping) throw new Error('应用正在停止');
    if (this.busy) throw new Error(`正在${this.busy}，请稍后再试`);
    this.busy = label;
    this.error = null;
    const task = (async () => {
      try { return await action(); }
      catch (error) { this.error = error.message; throw error; }
      finally { this.busy = null; }
    })();
    this.pending = task;
    return task;
  }

  async claimLegacyHome(uid, isAdmin) {
    if (!isAdmin || this.state.legacyOwner || !(await exists(path.join(this.sharedHome, '.dsh')))) return;
    if (this.legacyClaim) return this.legacyClaim;
    this.legacyClaim = (async () => {
      if (this.state.legacyOwner || !(await exists(path.join(this.sharedHome, '.dsh')))) return;
      const home = this.userHome(uid);
      for (const entry of await readdir(this.sharedHome, { withFileTypes: true })) {
        if (entry.name === 'users') continue;
        const target = path.join(home, entry.name);
        if (await exists(target)) continue;
        await rename(path.join(this.sharedHome, entry.name), target);
      }
      this.state.legacyOwner = uid;
      await this.save();
    })();
    try { return await this.legacyClaim; }
    finally { this.legacyClaim = null; }
  }

  async tenant(uid, isAdmin = false) {
    uid = validUid(uid);
    if (this.tenants.has(uid)) return this.tenants.get(uid);
    if (this.tenantPromises.has(uid)) return this.tenantPromises.get(uid);
    const creating = this.createTenant(uid, isAdmin);
    this.tenantPromises.set(uid, creating);
    try { return await creating; }
    finally { this.tenantPromises.delete(uid); }
  }

  async createTenant(uid, isAdmin) {
    const access = await this.homeAccess(uid);
    if (!access.ready) throw new Error('请先选择并授权 DSH 工作目录');
    await this.migrateTenantHome(uid, access.home);
    await this.claimLegacyHome(uid, isAdmin);
    const tenantRoot = path.join(this.root, 'users', uid);
    const home = access.home;
    const tenantEnvironment = {
      ...this.environment,
      HOME: home,
      DSH_HOME: path.join(home, '.dsh'),
      DSH_LEGACY_HOME: '',
      TRIM_DATA_SHARE_PATHS: '',
      // Keep pnpm's content-addressable store in app-managed data. fnOS may
      // grant a selected user directory through ACL without propagating that
      // ACL to pnpm's copied package tree on every filesystem implementation.
      pnpm_config_store_dir: path.join(tenantRoot, 'pnpm-store'),
    };
    const manager = new Manager(tenantRoot, tenantEnvironment, {
      versions: this.versions,
      process: this.processFactory(tenantEnvironment, uid),
      configRoot: this.root,
      versionPointer: false,
      exposeSettings: false,
      initialVersion: this.state.defaultVersion,
    });
    await manager.init();
    if (!manager.state.current && this.state.defaultVersion) {
      manager.state.current = this.state.defaultVersion;
      await manager.save();
    }
    if (this.state.legacyOwner === uid && this.state.marketInstalled && !manager.state.marketInstalled) {
      manager.state.marketInstalled = true;
      await manager.save();
    }
    this.tenants.set(uid, manager);
    return manager;
  }

  async migrateTenantHome(uid, home) {
    const legacy = path.join(this.sharedHome, 'users', uid, 'home');
    if (!(await exists(legacy)) || path.resolve(legacy) === path.resolve(home)) return;
    await this.moveTree(legacy, home);
    try { await rmdir(legacy); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
  }

  async moveTree(source, target) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        await this.moveTree(from, to);
        try { await rmdir(from); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
        continue;
      }
      try { await lstat(to); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(from, to); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        if (entry.isSymbolicLink()) { await symlink(await readlink(from), to); await unlink(from); }
        else { await copyFile(from, to); await unlink(from); }
      }
    }
  }

  async userStatus(uid, isAdmin = false) {
    const homeAccess = await this.homeAccess(uid);
    if (!homeAccess.ready) return {
      current: this.state.defaultVersion, running: false, busy: null, error: null, marketInstalled: false, versions: [],
      config: isAdmin ? this.config : undefined, releases: isAdmin ? this.releases : [], defaultVersion: this.state.defaultVersion,
      globalBusy: this.busy, globalError: this.error, globalTask: isAdmin ? this.globalTask : undefined,
      services: isAdmin ? this.runningServices() : undefined,
      isAdmin, userRoot: this.userRoot(uid), userHome: homeAccess.home, needsHomeAuthorization: true, homeSelectionRequired: !homeAccess.selected,
    };
    const manager = await this.tenant(uid, isAdmin);
    manager.config = this.config;
    if (!manager.state.current && this.state.defaultVersion) {
      manager.state.current = this.state.defaultVersion;
      await manager.save();
    }
    if (isAdmin && this.state.initialLaunchPending && manager.state.current && !manager.process.child && !manager.process.address) {
      await this.startInitialAdmin(uid, manager);
    }
    return {
      ...await manager.status(),
      config: isAdmin ? this.config : undefined,
      releases: isAdmin ? this.releases : [],
      defaultVersion: this.state.defaultVersion,
      globalBusy: this.busy,
      globalError: this.error,
      globalTask: isAdmin ? this.globalTask : undefined,
      services: isAdmin ? this.runningServices() : undefined,
      isAdmin,
      userRoot: this.userRoot(uid),
      userHome: homeAccess.home,
      needsHomeAuthorization: false,
      homeSelectionRequired: false,
    };
  }

  async startInitialAdmin(uid, manager) {
    if (this.initialLaunch) return this.initialLaunch;
    this.initialLaunch = (async () => {
      try {
        await this.dispatchUser(uid, true, 'start');
        this.state.initialLaunchPending = false;
        await this.save();
      } catch (error) {
        // First-run startup is best effort. Keep the error visible on the
        // administrator's tenant without retrying it on every status poll.
        this.state.initialLaunchPending = false;
        await this.save();
        manager.error = `首次启动 DSH 失败：${error.message}`;
      } finally {
        this.initialLaunch = null;
      }
    })();
    return this.initialLaunch;
  }

  async context(uid, isAdmin = false) {
    const manager = await this.tenant(uid, isAdmin);
    manager.config = this.config;
    return {
      get process() { return manager.process; },
      get settingsDocument() { return manager.settingsDocument; },
      get busy() { return manager.busy; },
      get error() { return manager.error; },
      touchActivity: () => manager.touchActivity(),
      openActivityConnection: () => manager.openActivityConnection(),
      status: () => this.userStatus(uid, isAdmin),
      dispatch: (action, data) => this.dispatchUser(uid, isAdmin, action, data),
    };
  }

  async dispatchUser(uid, isAdmin, action, data = {}) {
    if (!['start', 'activate', 'restart', 'market', 'folders'].includes(action)) throw new Error('未知操作');
    const manager = await this.tenant(uid, isAdmin);
    const reject = message => { manager.error = message; throw new Error(message); };
    if (action === 'market' && !isAdmin) reject('仅限管理员重新安装插件市场');
    manager.config = this.config;
    if (!manager.state.current && this.state.defaultVersion) {
      manager.state.current = this.state.defaultVersion;
      await manager.save();
    }
    if (this.busy && action !== 'start') reject(`正在${this.busy}，请稍后再试`);
    if (action === 'folders') return manager.exclusive('同步授权目录', () => this.syncFolders(uid, manager));
    if (action === 'start') {
      if (manager.process.child && manager.process.address) return;
      if (!manager.state.current) reject('管理员尚未设置可用的 DSH 版本');
      await this.syncFolders(uid, manager).catch(() => {});
      return manager.exclusive('启动 DSH', () => manager.activate(manager.state.current));
    }
    return manager.dispatch(action, data);
  }

  async syncFolders(uid, manager = null) {
    uid = validUid(uid);
    manager ??= await this.tenant(uid);
    const paths = [...new Set(await this.folderProvider(uid))].filter(folder => typeof folder === 'string' && path.isAbsolute(folder) && path.resolve(folder) !== path.resolve(manager.environment.HOME));
    const directory = path.join(manager.environment.HOME, 'authorized');
    const stateFile = path.join(manager.root, 'folders.json');
    const previous = await readJson(stateFile, { links: {} });
    const links = {};
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const folder of paths) {
      const base = path.basename(folder) || '授权目录';
      const suffix = createHash('sha256').update(folder).digest('hex').slice(0, 8);
      const name = `${base}-${suffix}`;
      const link = path.join(directory, name);
      links[name] = folder;
      try {
        if (await readlink(link) === folder) continue;
        await unlink(link);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error;
        if (error.code === 'EINVAL') continue;
      }
      await symlink(folder, link);
    }
    for (const [name, target] of Object.entries(previous.links ?? {})) {
      if (links[name] === target) continue;
      const link = path.join(directory, name);
      try { if (await readlink(link) === target) await unlink(link); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error; }
    }
    await writeJson(stateFile, { links });
    return { paths, directory };
  }

  async versionUsage(version) {
    exactVersion(version);
    const selected = new Set();
    const running = new Set();
    for (const [uid, manager] of this.tenants) {
      if (manager.state.current !== version) continue;
      selected.add(uid);
      if (manager.process.child && manager.process.address) running.add(uid);
    }
    const usersRoot = path.join(this.root, 'users');
    await mkdir(usersRoot, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const state = await readJson(path.join(usersRoot, entry.name, 'state.json'), null);
      if (state?.current === version) selected.add(entry.name);
    }
    return { selected: [...selected], running: [...running] };
  }

  async removeVersion(version) {
    exactVersion(version);
    if (version === this.state.defaultVersion) throw new Error('默认版本无法删除，请先设置其他默认版本');
    const usage = await this.versionUsage(version);
    if (usage.running.length) throw new Error(`该版本正被 ${usage.running.length} 个用户运行，无法删除`);
    if (usage.selected.length) throw new Error(`该版本仍被 ${usage.selected.length} 个用户选用，无法删除`);
    await this.versions.remove(version);
  }

  async setDefault(version) {
    exactVersion(version);
    if (!(await this.versions.list()).some(item => item.version === version)) throw new Error('该版本尚未安装');
    const current = path.join(this.root, 'runtimes/current');
    const temporary = `${current}.tmp`;
    await mkdir(path.dirname(current), { recursive: true, mode: 0o700 });
    await rm(temporary, { force: true });
    await symlink(path.join('versions', version), temporary);
    await rename(temporary, current);
    this.state.defaultVersion = version;
    await this.save();
  }

  async dispatchAdmin(action, data = {}) {
    const labels = { check: '检查更新', download: '下载版本', remove: '删除版本', default: '设置默认版本' };
    if (!labels[action]) throw new Error('未知管理操作');
    const tenantBusy = [...this.tenants.values()].find(manager => manager.busy)?.busy;
    if (tenantBusy) {
      this.error = `有用户正在${tenantBusy}，请稍后再试`;
      throw new Error(this.error);
    }
    const version = ['download', 'remove'].includes(action) ? exactVersion(data.version) : null;
    if (action === 'download') this.globalTask = { type: 'download', version, step: 1, total: 4, stage: '准备下载', startedAt: Date.now() };
    try {
      return await this.exclusive(labels[action], async () => {
        if (action === 'check') this.releases = await this.versions.check(this.config);
        if (action === 'download') await this.versions.install(this.config, version, progress => { this.globalTask = { ...this.globalTask, ...progress }; });
        if (action === 'remove') await this.removeVersion(version);
        if (action === 'default') await this.setDefault(data.version);
      });
    } finally {
      if (action === 'download') this.globalTask = null;
    }
  }

  runningServices() {
    const now = Date.now();
    const timeout = this.config.idleTimeoutSeconds * 1_000;
    return [...this.tenants.entries()].flatMap(([uid, manager]) => {
      const running = !!manager.process.child && !!manager.process.address;
      if (!running) return [];
      const active = manager.activeConnections > 0 || !!manager.busy;
      const idle = !active;
      const lastActivityAt = manager.lastActivityAt ?? now;
      return [{ uid, version: manager.state.current, running, busy: manager.busy, activeConnections: manager.activeConnections, idle, lastActivityAt, closesAt: idle ? lastActivityAt + timeout : null }];
    });
  }

  async closeIdleTenants() {
    if (this.stopping) return;
    const now = Date.now();
    const timeout = this.config.idleTimeoutSeconds * 1_000;
    for (const manager of this.tenants.values()) {
      if (manager.busy || manager.activeConnections > 0 || !manager.process.child || !manager.process.address) continue;
      const lastActivityAt = manager.lastActivityAt ?? now;
      if (now - lastActivityAt < timeout) continue;
      try { await manager.exclusive('因空闲关闭 DSH', () => manager.stopForIdle()); }
      catch { /* Status exposes ordinary runtime errors; the next sweep can retry. */ }
    }
  }

  async stopService(uid) {
    uid = validUid(uid);
    const manager = this.tenants.get(uid);
    if (!manager?.process.child || !manager.process.address) throw new Error('该 DSH 服务未运行');
    await manager.exclusive('关闭 DSH', () => manager.stopForIdle());
  }

  async updateConfig(config) {
    await this.exclusive('保存设置', async () => {
      await writeJson(path.join(this.root, 'config.json'), config);
      this.config = config;
      for (const manager of this.tenants.values()) manager.config = config;
    });
  }

  async bootstrap() {
    if (this.state.defaultVersion) return;
    this.globalTask = { type: 'download', version: 'latest', step: 1, total: 4, stage: '正在查询 latest', startedAt: Date.now() };
    try {
      return await this.exclusive('初始化 DSH', async () => {
        const release = await this.versions.metadata(this.config, 'latest');
        this.globalTask = { ...this.globalTask, version: release.version, stage: '准备下载' };
        await this.versions.install(this.config, release.version, progress => { this.globalTask = { ...this.globalTask, ...progress }; });
        await this.setDefault(release.version);
        this.state.initialLaunchPending = true;
        await this.save();
      });
    } finally {
      this.globalTask = null;
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.idleTimer);
    this.abort.abort();
    await Promise.all([
      this.pending?.catch(() => {}),
      ...[...this.tenants.values()].map(manager => manager.stop()),
    ]);
  }
}
