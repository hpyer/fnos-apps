import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const CHANNELS = new Set(['stable', 'mainline']);
const CODENAMES = { debian: new Set(['bullseye', 'bookworm', 'trixie']), ubuntu: new Set(['jammy', 'noble', 'resolute']) };
const MAX_INDEX = 8 * 1024 * 1024;
const MAX_PACKAGE = 128 * 1024 * 1024;

export function channelName(value) {
  if (!CHANNELS.has(value)) throw Error('请选择稳定版或主线版');
  return value;
}

export function distribution(text, platform, arch) {
  if (platform !== 'linux') throw Error('官方版本安装仅支持 Linux fnOS');
  const values = Object.fromEntries(text.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')];
  }));
  const family = values.ID?.toLowerCase();
  const codename = values.VERSION_CODENAME?.toLowerCase();
  const architecture = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!CODENAMES[family]?.has(codename) || !architecture) {
    throw Error(`当前系统 ${values.PRETTY_NAME || family || '未知'} / ${arch} 没有可确认兼容的 Nginx 官方软件包`);
  }
  return { family, codename, architecture };
}

export function parsePackages(source, architecture) {
  const packages = source.split(/\n\s*\n/).map(block => Object.fromEntries(block.split('\n').filter(line => /^[A-Za-z0-9-]+: /.test(line)).map(line => {
    const at = line.indexOf(': '); return [line.slice(0, at), line.slice(at + 2)];
  })));
  const candidates = packages.filter(item => item.Package === 'nginx' && item.Architecture === architecture &&
    /^\d+\.\d+\.\d+(-[^\s]+)?$/.test(item.Version || '') &&
    /^pool\/nginx\/n\/nginx\/[a-zA-Z0-9._+~%-]+\.deb$/.test(item.Filename || '') &&
    /^[a-fA-F0-9]{64}$/.test(item.SHA256 || '') && Number(item.Size) > 0 && Number(item.Size) <= MAX_PACKAGE);
  candidates.sort((a, b) => {
    const av = a.Version.match(/^\d+\.\d+\.\d+/)[0].split('.').map(Number);
    const bv = b.Version.match(/^\d+\.\d+\.\d+/)[0].split('.').map(Number);
    return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
  });
  const latest = candidates[0];
  if (!latest) throw Error('官方仓库未找到当前架构的 Nginx 软件包');
  return { version: latest.Version.match(/^\d+\.\d+\.\d+/)[0], packageVersion: latest.Version,
    filename: latest.Filename, sha256: latest.SHA256.toLowerCase(), size: Number(latest.Size) };
}

async function responseBytes(response, limit) {
  if (!response.ok) throw Error(`官方仓库请求失败：HTTP ${response.status}`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('官方仓库返回文件过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class OfficialRepository {
  constructor({ fetcher = globalThis.fetch, osRelease = () => readFile('/etc/os-release', 'utf8'), platform = process.platform, arch = process.arch } = {}) {
    this.fetcher = fetcher; this.osRelease = osRelease; this.platform = platform; this.arch = arch;
  }
  async target() {
    if (this.platform !== 'linux') throw Error('官方版本安装仅支持 Linux fnOS，本机预览无法下载');
    return distribution(await this.osRelease(), this.platform, this.arch);
  }
  async request(url, timeout) {
    const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (response.url !== url) throw Error('官方仓库响应地址不符');
    return response;
  }
  async latest(channel) {
    channelName(channel);
    const { family, codename, architecture } = await this.target();
    const base = `https://nginx.org/packages/${channel === 'mainline' ? 'mainline/' : ''}${family}/`;
    const index = `${base}dists/${codename}/nginx/binary-${architecture}/Packages.gz`;
    const bytes = await responseBytes(await this.request(index, 20000), MAX_INDEX);
    const entry = parsePackages(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'), architecture);
    return { ...entry, channel, distribution: `${family} ${codename} / ${architecture}`, url: base + entry.filename };
  }
  async download(entry, target) {
    const { family } = await this.target();
    const prefix = `https://nginx.org/packages/${entry.channel === 'mainline' ? 'mainline/' : ''}${family}/pool/nginx/n/nginx/`;
    if (!entry.url?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.size > MAX_PACKAGE) throw Error('官方软件包元数据无效');
    const response = await this.request(entry.url, 120000);
    if (!response.ok || response.url !== entry.url) throw Error(`软件下载失败：HTTP ${response.status}`);
    const file = await open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_PACKAGE || size > entry.size) throw Error('官方软件包大小不符');
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw Error('官方软件包写入失败');
          offset += bytesWritten;
        }
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw Error('官方软件包 SHA256 校验失败');
    } catch (error) { await file.close(); await rm(target, { force: true }); throw error; }
    await file.close();
  }
}
