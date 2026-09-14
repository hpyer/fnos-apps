import path from 'node:path';
import { watch } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, symlink, unlink, writeFile, readlink } from 'node:fs/promises';
import { loadConfig, readJson, writeJson } from '../shared/config.mjs';
import { Versions, exactVersion } from './versions.mjs';
import { DshProcess } from './process.mjs';
import { run, redact } from '../shared/command.mjs';

// Coordinates all mutable DSH state. Public callers must enter through
// exclusive() so downloading, switching, restarting and market installation
// cannot race over the same runtime directory or child process.
export class Manager {
  constructor(root, environment, dependencies = {}) {
    this.root = root;
    this.environment = environment;
    this.abort = new AbortController();
    this.versions = dependencies.versions ?? new Versions(root, environment, { signal: this.abort.signal });
    this.process = dependencies.process ?? new DshProcess(environment);
    this.execute = dependencies.execute ?? run;
    this.watch = dependencies.watch ?? watch;
    this.pluginRestartDelay = dependencies.pluginRestartDelay ?? 2_500;
    this.pluginRestartIdleRequired = dependencies.pluginRestartIdleRequired ?? 2;
    this.profileWatcher = null;
    this.pluginRestartTimer = null;
    this.pluginRestartIdleChecks = 0;
    this.pluginChangeGeneration = 0;
    this.busy = null;
    this.error = null;
    this.releases = [];
    this.stopping = false;
  }
  async init() {
    this.config = await loadConfig(this.root);
    this.state = await readJson(path.join(this.root, 'state.json'), { current: null, marketInstalled: false });
    // The atomic symlink is authoritative if a crash interrupts the state-file write.
    try {
      const pointer = await readlink(path.join(this.root, 'runtimes/current'));
      if (!pointer.startsWith('versions/')) throw new Error('当前版本指针格式无效');
      this.state.current = exactVersion(pointer.slice('versions/'.length));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.migrateLegacyHome();
    await mkdir(this.environment.DSH_HOME, { recursive: true, mode: 0o700 });
    this.settingsDocument = await this.exposeSettingsDocument();
  }
  async migrateLegacyHome() {
    const source = this.environment.DSH_LEGACY_HOME;
    const target = this.environment.HOME;
    if (!source || !target || path.resolve(source) === path.resolve(target)) return;
    try { await lstat(source); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await mkdir(target, { recursive: true, mode: 0o700 });
    await this.moveTree(source, target);
    try { await rmdir(source); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    // Earlier releases exposed settings.yaml through a config/ subfolder.
    // Make the migrated DSH home self-contained without changing its content.
    const settings = path.join(this.environment.DSH_HOME, 'settings.yaml');
    try {
      const link = await readlink(settings);
      const resolved = path.resolve(path.dirname(settings), link);
      if (resolved !== path.resolve(settings)) {
        const temporary = `${settings}.migrating`;
        await copyFile(resolved, temporary);
        await unlink(settings);
        await rename(temporary, settings);
      }
    } catch (error) { if (error.code !== 'EINVAL' && error.code !== 'ENOENT') throw error; }
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
  async exposeSettingsDocument() {
    const [share] = (this.environment.TRIM_DATA_SHARE_PATHS ?? '').split(':').filter(Boolean);
    if (!share) return null;
    const local = path.join(this.environment.DSH_HOME, 'settings.yaml');
    const exposed = path.join(share, 'settings.yaml');
    await mkdir(share, { recursive: true, mode: 0o700 });
    // When DSH_HOME itself is inside the shared home, keep its canonical
    // .dsh/settings.yaml location instead of introducing another redirect.
    if (path.resolve(this.environment.HOME ?? '') === path.resolve(share)) return local;
    if (path.resolve(local) === path.resolve(exposed)) return exposed;
    try {
      const link = await readlink(local);
      if (path.resolve(path.dirname(local), link) === path.resolve(exposed)) return exposed;
      await unlink(local);
    } catch (error) {
      if (error.code !== 'EINVAL' && error.code !== 'ENOENT') throw error;
      if (error.code === 'EINVAL') {
        await copyFile(local, exposed);
        await unlink(local);
      }
    }
    await symlink(exposed, local);
    return exposed;
  }
  async save() { await writeJson(path.join(this.root, 'state.json'), this.state); }
  async status() {
    return {
      config: this.config, current: this.state.current, running: !!this.process.child && !!this.process.address,
      busy: this.busy, error: this.error, marketInstalled: this.state.marketInstalled,
      versions: await this.versions.list(), releases: this.releases,
    };
  }
  async exclusive(label, action) {
    if (this.stopping) throw new Error('应用正在停止');
    if (this.busy) throw new Error(`正在${this.busy}，请稍后再试`);
    this.busy = label;
    this.error = null;
    // Keep the promise for observers, but always clear the UI-visible lock.
    const task = (async () => {
      try { return await action(); }
      catch (error) { this.error = redact(error.message); throw error; }
      finally { this.busy = null; }
    })();
    this.pending = task;
    return task;
  }
  async bootstrap() {
    return this.exclusive('初始化 DSH', async () => {
      if (!this.state.current) {
        // Download and activation are deliberately separate UI actions after
        // first boot; bootstrap is the only automatic initial installation.
        const release = await this.versions.metadata(this.config, 'latest');
        await this.versions.install(this.config, release.version);
        await this.activate(release.version);
      } else {
        await this.activate(this.state.current);
      }
    });
  }
  async ensureMarket(version) {
    if (this.state.marketInstalled) return;
    // Use DSH's own profile-aware CLI instead of writing plugin files directly.
    await this.execute(process.execPath, [this.versions.entry(version), 'plugin', '--profile', 'web', 'add', 'dshmarket'], {
      cwd: this.versions.location(version), env: { ...this.environment, npm_config_registry: this.config.registry }, timeout: 900_000, signal: this.abort.signal,
    });
    this.state.marketInstalled = true;
    await this.save();
  }
  async startVersion(version) {
    if (this.stopping) throw new Error('应用正在停止');
    await this.ensureMarket(version);
    if (this.stopping) throw new Error('应用正在停止');
    const patch = path.join(this.root, 'host.cordis.patch.yml');
    // The managed supervisor owns restarts. Keep the user's own patch file intact.
    await writeFile(patch, '- id: dsh-market\n  config:\n    allowRestart: false\n', { mode: 0o600 });
    this.process.environment = {
      ...this.environment, npm_config_registry: this.config.registry,
      PATH: `${path.join(this.versions.location(version), 'node_modules/.bin')}:${this.environment.PATH}`,
    };
    await this.process.start(this.versions.entry(version), this.environment.DSH_HOME, patch);
    this.watchPluginProfile();
  }
  watchPluginProfile() {
    if (this.stopping || this.profileWatcher) return;
    const profile = path.join(this.environment.DSH_HOME, 'profiles', 'web');
    try {
      this.profileWatcher = this.watch(profile, { persistent: false }, (_event, filename) => {
        // pnpm commits this file only after a profile dependency operation has
        // completed. It covers install, update and uninstall without reacting
        // to normal DSH settings or workspace writes.
        if (filename?.toString() !== 'pnpm-lock.yaml') return;
        this.pluginChangeGeneration += 1;
        this.pluginRestartIdleChecks = 0;
        this.schedulePluginRestart();
      });
    } catch (error) {
      // The profile directory is created by DSH's first web startup. A later
      // version start will install the watcher once it exists.
      if (error.code !== 'ENOENT') this.error = `无法监测插件变更：${error.message}`;
    }
  }
  schedulePluginRestart(generation = this.pluginChangeGeneration) {
    if (this.stopping || !this.state.current) return;
    clearTimeout(this.pluginRestartTimer);
    this.pluginRestartTimer = setTimeout(() => {
      this.pluginRestartTimer = null;
      void this.restartForPluginChange(generation);
    }, this.pluginRestartDelay);
  }
  async pluginOperationState() {
    if (this.process.pluginOperationState) return this.process.pluginOperationState();
    if (this.process.pluginOperationActive) return await this.process.pluginOperationActive() ? 'active' : 'idle';
    return 'idle';
  }
  async restartForPluginChange(generation = this.pluginChangeGeneration) {
    if (this.stopping || !this.state.current) return;
    if (generation !== this.pluginChangeGeneration) return this.schedulePluginRestart();
    if (this.busy) {
      this.pluginRestartIdleChecks = 0;
      return this.schedulePluginRestart(generation);
    }
    // pnpm can commit its lockfile before dsh-market finishes validation and
    // writes the HTTP response. The market endpoint can also be briefly
    // unavailable while pnpm replaces package files. Only consecutive, valid
    // idle responses prove that the entire operation has settled.
    const operation = await this.pluginOperationState();
    if (generation !== this.pluginChangeGeneration) return this.schedulePluginRestart();
    if (operation !== 'idle') {
      this.pluginRestartIdleChecks = 0;
      return this.schedulePluginRestart(generation);
    }
    this.pluginRestartIdleChecks += 1;
    if (this.pluginRestartIdleChecks < this.pluginRestartIdleRequired) return this.schedulePluginRestart(generation);
    this.pluginRestartIdleChecks = 0;
    try { await this.dispatch('restart'); }
    catch { /* manager.status() exposes the failure to the application UI */ }
  }
  async activate(version) {
    exactVersion(version);
    if (!(await this.versions.list()).some(x => x.version === version)) throw new Error('该版本尚未安装');
    const previous = this.state.current;
    await this.process.stop();
    try {
      await this.startVersion(version);
      const current = path.join(this.root, 'runtimes/current');
      const temporary = `${current}.tmp`;
      await rm(temporary, { force: true });
      // Commit the healthy runtime through an atomic pointer replacement. The
      // previous pointer remains available until the new child is verified.
      await symlink(path.join('versions', version), temporary);
      await rename(temporary, current);
      this.state.current = version;
      // The runtime is already healthy and the authoritative pointer committed.
      // Failure to write auxiliary state must not roll it back to a different process.
      try { await this.save(); }
      catch { this.error = 'DSH 已切换，但辅助状态文件写入失败，请检查磁盘空间与权限'; }
    } catch (error) {
      await this.process.stop();
      this.state.current = previous;
      // A failed candidate never becomes current. Restore the previous process
      // when possible, while leaving its runtime files untouched for diagnosis.
      if (!this.stopping && previous && previous !== version) {
        try { await this.startVersion(previous); }
        catch (rollback) { throw new Error(`新版本启动失败，旧版也无法恢复：${rollback.message}`); }
      }
      throw error;
    }
  }
  async dispatch(action, data = {}) {
    const labels = { check: '检查更新', download: '下载版本', activate: '切换版本', restart: '重启 DSH', market: '安装插件市场' };
    if (!labels[action]) throw new Error('未知操作');
    return this.exclusive(labels[action], async () => {
      switch (action) {
        case 'check': this.releases = await this.versions.check(this.config); break;
        case 'download': await this.versions.install(this.config, exactVersion(data.version), [this.state.current]); break;
        case 'activate': await this.activate(data.version); break;
        case 'restart':
          if (!this.state.current) throw new Error('请先下载并启用一个 DSH 版本');
          await this.activate(this.state.current); break;
        case 'market':
          if (!this.state.current) throw new Error('请先启用一个 DSH 版本');
          await this.process.stop();
          this.state.marketInstalled = false;
          await this.save();
          await this.activate(this.state.current); break;
      }
    });
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.pluginRestartTimer);
    this.pluginRestartIdleChecks = 0;
    this.profileWatcher?.close();
    this.profileWatcher = null;
    this.abort.abort();
    await this.process.stop();
  }
}
