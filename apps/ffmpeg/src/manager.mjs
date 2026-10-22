import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateChecker } from '@fnos/version-check';
import { command } from './command.mjs';
import { targetArchitecture } from './repository.mjs';
import { ComponentRepository } from './components.mjs';
import { extractComponent } from './zip.mjs';
import { extractArchive } from './archive.mjs';
import { atomicJSON, currentVersion, hashFile, metadata, versionDirectory, versionID } from './storage.mjs';

const TOOLS = ['ffmpeg', 'ffprobe'];
export class FFmpegManager {
  constructor(root, { platform = process.platform, arch = process.arch, repository, run = command, extract = extractArchive, extractZip = extractComponent, flock = '/usr/bin/flock', xz = '/usr/bin/xz' } = {}) {
    this.root = root; this.platform = platform; this.arch = arch;
    this.repository = repository || new ComponentRepository({ platform, arch });
    this.run = run; this.extract = extract; this.extractZip = extractZip; this.ffprobeEnabled = false; this.flock = flock; this.xz = xz;
    this.checker = new UpdateChecker({ check: () => this.repository.catalog() }, { cacheMs: 60 * 1000 });
    this.available = []; this.controller = new AbortController(); this.task = null; this.closed = false;
    this.job = { state: 'idle', message: '尚无操作' };
  }
  async init() {
    // CLI users need directory traversal and read/execute access; state remains private.
    await mkdir(this.root, { recursive: true, mode: 0o755 }); await chmod(this.root, 0o755);
    await mkdir(path.join(this.root, 'versions'), { recursive: true, mode: 0o755 });
    await chmod(path.join(this.root, 'versions'), 0o755);
    await mkdir(path.join(this.root, 'staging'), { recursive: true, mode: 0o700 });
    await chmod(path.join(this.root, 'staging'), 0o700);
    const lock = await open(path.join(this.root, 'catalog.lock'), 'a', 0o644); await lock.chmod(0o644); await lock.close();
    for (const name of await readdir(path.join(this.root, 'staging'))) await rm(path.join(this.root, 'staging', name), { recursive: true, force: true });
    try { this.ffprobeEnabled = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8')).ffprobeEnabled === true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of await readdir(path.join(this.root, 'versions'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try { await lstat(path.join(this.root, 'versions', entry.name, '.probe-pending.json')); await this.catalog('recover-probe', entry.name); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      await stat(path.join(this.root, 'operation.json'));
      this.job = { state: 'error', message: '上次操作被中断，当前版本指针已保留；请检查版本列表后重试' };
      await rm(path.join(this.root, 'operation.json'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async check() {
    if (this.closed) throw Error('管理服务正在停止');
    const entries = await this.checker.check();
    this.available = entries;
    return { available: entries };
  }
  async previous() {
    try {
      const value = JSON.parse(await readFile(path.join(this.root, 'previous.json'), 'utf8'));
      await metadata(this.root, versionID(value.id));
      return value.id;
    } catch { return ''; }
  }
  async status() {
    let active = '', activeError = '';
    try { active = await currentVersion(this.root); if (active) await metadata(this.root, active); }
    catch (error) { activeError = error.message; }
    const installed = [];
    for (const entry of await readdir(path.join(this.root, 'versions'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const info = await metadata(this.root, entry.name);
        installed.push({ ...info, hasFFprobe: await this.hasProbe(info.id), active: info.id === active });
      } catch { installed.push({ id: entry.name, invalid: true, active: entry.name === active }); }
    }
    installed.sort((a, b) => Number(b.active) - Number(a.active) || b.id.localeCompare(a.id));
    let supported = true;
    try { targetArchitecture(this.platform, this.arch); } catch { supported = false; }
    const commands = await Promise.all(TOOLS.map(async tool => {
      const name = `/usr/local/bin/${tool}`;
      let registered = false;
      try {
        registered = await realpath(name) === await realpath(`/var/apps/ffmpeg-for-fnos/target/bin/${tool}`);
      } catch { /* Not registered in local preview or before NAS installation. */ }
      const selected = installed.find(item => item.id === active);
      return { name: tool, path: name, registered, installed: !!selected && !selected.invalid && (tool === 'ffmpeg' || selected.hasFFprobe) };
    }));
    return { active, activeError, previous: await this.previous(), installed, available: this.available,
      job: { ...this.job }, ffprobeEnabled: this.ffprobeEnabled, supported, arch: this.arch, commands };
  }
  start(action, id) {
    if (this.closed) throw Error('管理服务正在停止');
    if (this.task || this.diagnosing) throw Error('已有版本操作进行中，请稍后再试');
    if (!['install', 'activate', 'rollback', 'remove', 'probe'].includes(action)) throw Error('未知版本操作');
    if (action === 'probe') { if (typeof id !== 'boolean') throw Error('ffprobe 选项必须是布尔值'); }
    else if (action !== 'rollback') versionID(id);
    const entry = action === 'install' ? this.available.find(item => item.id === id) : null;
    if (action === 'install' && !entry) throw Error('请先检查更新，再选择需要下载的版本');
    this.job = { state: 'running', action, id, message: '正在准备', received: 0, total: entry?.size || 0 };
    this.task = (async () => {
      try {
        await atomicJSON(path.join(this.root, 'operation.json'), { action, id });
        if (action === 'probe') await this.setProbe(id);
        else if (action === 'install') await this.install(entry);
        else if (action === 'remove') { this.job.message = '正在删除版本'; await this.catalog('remove', id); }
        else {
          const selected = action === 'rollback' ? await this.previous() : id;
          if (!selected) throw Error('没有可回滚的已安装版本');
          this.job.message = action === 'rollback' ? '正在校验并回滚' : '正在校验并启用';
          await this.activate(selected);
        }
        this.job = { ...this.job, state: 'success', message: action === 'install' ? '下载与自检完成，请在已安装版本中启用' : action === 'probe' ? (id ? 'ffprobe 已启用，后续新版本将同步安装' : '已停止后续 ffprobe 同步，已有组件保留') : '版本操作完成' };
      } catch (error) {
        this.job = { ...this.job, state: 'error', message: this.controller.signal.aborted ? '操作已中止，当前版本指针已保留' : error.message };
      } finally {
        await rm(path.join(this.root, 'operation.json'), { force: true }).catch(() => {});
        this.task = null;
      }
    })();
    return { job: { ...this.job } };
  }
  async catalog(action, id, candidate) {
    await this.run(this.flock, ['--no-fork', '-x', path.join(this.root, 'catalog.lock'), process.execPath,
      fileURLToPath(new URL('./catalog-action.mjs', import.meta.url)), this.root, action, id, ...(candidate ? [candidate] : [])], { timeout: 45000, signal: this.controller.signal });
  }
  async validate(directory, tools = ['ffmpeg']) {
    const hashes = {}, versions = {};
    for (const tool of tools) {
      const file = path.join(directory, 'bin', tool), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 20) throw Error(`${tool} 不是有效的可执行文件`);
      const descriptor = await open(file, 'r'); const header = Buffer.alloc(20);
      try { await descriptor.read(header, 0, 20, 0); } finally { await descriptor.close(); }
      if (header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== (this.arch === 'x64' ? 62 : 183)) throw Error(`${tool} 与设备架构不匹配`);
      hashes[tool] = await hashFile(file);
      const output = await this.run(file, ['-version'], { signal: this.controller.signal });
      const version = new RegExp(`^${tool} version ([^\\s]+)`, 'm').exec(output)?.[1];
      if (!version) throw Error(`${tool} 版本检测失败`);
      versions[tool] = version;
    }
    if (versions.ffmpeg && versions.ffprobe && versions.ffmpeg !== versions.ffprobe) throw Error('ffmpeg 和 ffprobe 版本不一致');
    return { hashes, version: versions.ffmpeg || versions.ffprobe };
  }
  async hasProbe(id) {
    try {
      const info = await metadata(this.root, id), file = await lstat(path.join(this.root, 'versions', id, 'bin/ffprobe'));
      return typeof info.hashes?.ffprobe === 'string' && file.isFile() && !file.isSymbolicLink();
    } catch { return false; }
  }
  async setProbe(enabled) {
    if (enabled) {
      const active = await currentVersion(this.root);
      if (active) await this.ensureProbe(active);
    }
    await atomicJSON(path.join(this.root, 'settings.json'), { ffprobeEnabled: enabled });
    this.ffprobeEnabled = enabled;
  }
  async verifyInstalled(id) {
    const directory = await versionDirectory(this.root, id), info = await metadata(this.root, id);
    if (info.arch !== this.arch) throw Error('版本架构不匹配');
    const tools = ['ffmpeg', ...(info.hashes?.ffprobe ? ['ffprobe'] : [])];
    for (const tool of tools) {
      const file = path.join(directory, 'bin', tool), details = await lstat(file);
      if (!details.isFile() || details.isSymbolicLink() || await hashFile(file) !== info.hashes?.[tool]) throw Error('版本文件已改动，请删除后重新下载');
    }
    return { directory, info, tools };
  }
  async selfTest(directory, tools, { ffmpegDirectory = directory } = {}) {
    const output = path.join(directory, 'self-test.wav');
    const binary = path.join(ffmpegDirectory, 'bin/ffmpeg');
    await this.run(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.05', '-c:a', 'pcm_s16le', output], { signal: this.controller.signal });
    if (tools.includes('ffprobe')) {
      const result = await this.run(path.join(directory, 'bin/ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', output], { signal: this.controller.signal });
      if (!JSON.parse(result).streams?.some(item => item.codec_name === 'pcm_s16le')) throw Error('FFmpeg 编解码自检失败');
    } else await this.run(binary, ['-nostdin', '-v', 'error', '-i', output, '-f', 'null', '-'], { signal: this.controller.signal });
    await rm(output, { force: true });
  }
  async prepare(entry, tools, temp) {
    const directory = path.join(temp, 'version'), resolved = structuredClone(entry);
    const progress = (received, total) => { Object.assign(this.job, { received, total }); };
    const retry = ({ attempt, maxRetries }) => { this.job.message = `下载中断，正在重试（${attempt}/${maxRetries}）`; };
    if (entry.format === 'components') {
      for (const tool of tools) {
        this.job.message = `正在下载 ${tool} 并校验 SHA256`; this.job.received = 0; this.job.total = entry.components[tool]?.size || 0;
        const archive = path.join(temp, `${tool}.zip`);
        resolved.components[tool] = await this.repository.downloadComponent(entry, tool, archive, { signal: this.controller.signal, progress, retry });
        this.job.message = `正在解压 ${tool}`;
        await this.extractZip(archive, directory, tool, { signal: this.controller.signal });
      }
      await writeFile(path.join(directory, 'SOURCE.txt'), 'FFmpeg / ffprobe build source: https://ffmpeg.martin-riedl.de/\nBuild configuration and source: https://git.martin-riedl.de/ffmpeg/build-script\nDownloaded components and SHA256 are recorded in metadata.json.\n', { mode: 0o644 });
      await chmod(path.join(directory, 'SOURCE.txt'), 0o644);
    } else {
      await this.run(this.xz, ['--version'], { signal: this.controller.signal });
      this.job.message = '正在下载旧构建并校验 SHA256';
      const archive = path.join(temp, 'download.tar.xz');
      await this.repository.download(entry, archive, { signal: this.controller.signal, progress, retry });
      await this.extract(archive, directory, entry.name.replace(/\.tar\.xz$/, ''), { signal: this.controller.signal, xz: this.xz, tools });
      await chmod(path.join(directory, 'LICENSE.txt'), 0o644);
    }
    await chmod(path.join(directory, 'bin'), 0o755);
    for (const tool of tools) await chmod(path.join(directory, 'bin', tool), 0o555);
    await chmod(directory, 0o755);
    return { directory, entry: resolved };
  }
  async install(entry) {
    targetArchitecture(this.platform, this.arch);
    try { await lstat(path.join(this.root, 'versions', entry.id)); throw Error('该构建已经安装'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.run(this.flock, ['--version'], { signal: this.controller.signal });
    const tools = this.ffprobeEnabled ? TOOLS : ['ffmpeg'];
    const temp = await mkdtemp(path.join(this.root, 'staging', 'install-'));
    try {
      const { directory, entry: resolved } = await this.prepare(entry, tools, temp);
      this.job.message = '正在检查架构与运行兼容性';
      const validated = await this.validate(directory, tools);
      await this.selfTest(directory, tools);
      let size = 0;
      for (const tool of tools) size += (await stat(path.join(directory, 'bin', tool))).size;
      await writeFile(path.join(directory, '.use.lock'), '', { mode: 0o644, flag: 'wx' });
      await chmod(path.join(directory, '.use.lock'), 0o644);
      await atomicJSON(path.join(directory, 'metadata.json'), { ...resolved, ...validated, diskSize: size, installedAt: new Date().toISOString() }, 0o644);
      this.controller.signal.throwIfAborted();
      await rename(directory, path.join(this.root, 'versions', entry.id));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async ensureProbe(id) {
    const directory = await versionDirectory(this.root, id), info = await metadata(this.root, id);
    // Always verify the existing ffmpeg before using it to test a newly downloaded companion.
    const binary = path.join(directory, 'bin/ffmpeg'), details = await lstat(binary);
    if (!details.isFile() || details.isSymbolicLink() || await hashFile(binary) !== info.hashes?.ffmpeg) throw Error('当前 ffmpeg 文件已改动，无法补装组件');
    if (await this.hasProbe(id)) { await this.verifyInstalled(id); return; }
    try { await lstat(path.join(directory, 'bin/ffprobe')); throw Error('ffprobe 文件未受信任，请先处理版本文件异常'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = await mkdtemp(path.join(this.root, 'staging', 'probe-'));
    try {
      const { directory: candidate, entry: resolved } = await this.prepare(info, ['ffprobe'], temp);
      this.job.message = '正在校验当前版本的 ffprobe';
      const validated = await this.validate(candidate, ['ffprobe']);
      if (validated.version !== info.version) throw Error('补装的 ffprobe 与当前 ffmpeg 版本不一致');
      await this.selfTest(candidate, ['ffprobe'], { ffmpegDirectory: directory });
      const updated = { ...info, components: resolved.components, hashes: { ...info.hashes, ...validated.hashes },
        diskSize: (await stat(binary)).size + (await stat(path.join(candidate, 'bin/ffprobe'))).size };
      await atomicJSON(path.join(candidate, 'metadata.json'), updated);
      await this.catalog('probe', id, candidate);
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async activate(id) {
    targetArchitecture(this.platform, this.arch);
    if (this.ffprobeEnabled) await this.ensureProbe(id);
    const { directory, info, tools } = await this.verifyInstalled(id);
    const validated = await this.validate(directory, tools);
    if (validated.version !== info.version) throw Error('版本检测结果已变化');
    await this.catalog('activate', id);
  }
  async diagnostics() {
    if (this.task || this.diagnosing) throw Error('请等待版本操作完成');
    this.diagnosing = true;
    try {
      const id = await currentVersion(this.root);
      if (!id) throw Error('请先启用一个版本');
      const { directory } = await this.verifyInstalled(id);
      const binary = path.join(directory, 'bin/ffmpeg');
      const build = await this.run(binary, ['-hide_banner', '-version'], { signal: this.controller.signal });
      const hwaccels = await this.run(binary, ['-hide_banner', '-hwaccels'], { signal: this.controller.signal });
      const encoders = await this.run(binary, ['-hide_banner', '-encoders'], { signal: this.controller.signal });
      return { id, build, hwaccels, encoders };
    } finally { this.diagnosing = false; }
  }
  async close() {
    this.closed = true; this.controller.abort();
    await this.task;
  }
}
