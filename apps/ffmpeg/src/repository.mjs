import { downloadVerified, MAX_DOWNLOAD } from './download.mjs';
export { MAX_DOWNLOAD } from './download.mjs';

const API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds';
const DOWNLOAD = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/';
const FEED = 'https://github.com/BtbN/FFmpeg-Builds/releases.atom';
const TAG = /^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/;

export function targetArchitecture(platform, arch) {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) throw Error('下载仅支持 Linux x86_64 / ARM64 fnOS；本机可预览管理页');
  return arch === 'x64' ? 'linux64' : 'linuxarm64';
}
export function parseRelease(release, arch, { checksumManifest = false } = {}) {
  if (!release || release.draft || release.prerelease || !TAG.test(release.tag_name)) return [];
  const target = targetArchitecture('linux', arch);
  const pattern = new RegExp(`^ffmpeg-(n(\\d+\\.\\d+)\\.\\d+(?:-\\d+-g[0-9a-f]+)?)-${target}-gpl-(\\d+\\.\\d+)\\.tar\\.xz$`);
  return (Array.isArray(release.assets) ? release.assets : []).flatMap(asset => {
    const match = pattern.exec(asset.name);
    const sizeValid = Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_DOWNLOAD;
    if (!match || match[2] !== match[3] || (!sizeValid && !(checksumManifest && asset.size === null))) return [];
    const url = `${DOWNLOAD}${release.tag_name}/${asset.name}`;
    if (asset.browser_download_url !== url || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) return [];
    return [{ id: `${release.tag_name}-${match[2]}-${arch}`, branch: match[2], build: match[1], arch,
      tag: release.tag_name, name: asset.name, url, sha256: asset.digest.slice(7), size: asset.size,
      publishedAt: release.published_at, source: 'BtbN/FFmpeg-Builds', variant: 'gpl' }];
  });
}
export function parseFeed(source) {
  // Read only bounded, literal Atom fields; never expand XML entities or interpret HTML content.
  if (!/<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(source)) throw Error('GitHub 发行订阅格式无效');
  const entries = [];
  for (const [, entry] of source.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const tag = /<id>\s*tag:github\.com,2008:Repository\/\d+\/(autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\s*<\/id>/.exec(entry)?.[1];
    const publishedAt = /<updated>\s*([^<]+)\s*<\/updated>/.exec(entry)?.[1]?.trim();
    if (tag && Number.isFinite(Date.parse(publishedAt))) entries.push({ tag, publishedAt });
  }
  return [...new Map(entries.map(entry => [entry.tag, entry])).values()].sort((a, b) => b.tag.localeCompare(a.tag)).slice(0, 3);
}
export function parseChecksums(source, { tag, publishedAt }, arch) {
  if (!TAG.test(tag)) throw Error('固定构建标签无效');
  const assets = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]([a-zA-Z0-9._-]+\.tar\.xz)$/.exec(line);
    if (!match) continue;
    const [, sha256, name] = match;
    if (assets.has(name)) throw Error('SHA256 清单包含重复文件');
    assets.set(name, { name, size: null, digest: `sha256:${sha256}`, browser_download_url: `${DOWNLOAD}${tag}/${name}` });
  }
  return parseRelease({ tag_name: tag, published_at: publishedAt, assets: [...assets.values()] }, arch, { checksumManifest: true });
}
function allowedURL(url, api, feed) {
  const value = new URL(url);
  if (value.protocol !== 'https:' || value.username || value.password || value.port) return false;
  if (api) return value.origin === 'https://api.github.com' && value.pathname.startsWith('/repos/BtbN/FFmpeg-Builds/');
  if (feed) return value.href === FEED;
  return (value.origin === 'https://github.com' && value.pathname.startsWith('/BtbN/FFmpeg-Builds/releases/download/')) ||
    value.hostname === 'release-assets.githubusercontent.com' || value.hostname === 'objects.githubusercontent.com';
}
async function bytes(response, limit) {
  let size = 0; const chunks = [];
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw Error('版本来源返回的数据过大');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export class FFmpegRepository {
  constructor({ platform = process.platform, arch = process.arch, fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.platform = platform; this.arch = arch; this.fetcher = fetcher; this.now = now; this.apiRetryAt = 0;
  }
  async response(url, { api = false, feed = false, signal, headers = {} } = {}) {
    for (let i = 0; i < 5; i++) {
      if (!allowedURL(url, api, feed)) throw Error('下载来源不在允许名单中');
      const response = await this.fetcher(url, { redirect: 'manual', cache: 'no-store', signal,
        headers: { accept: api ? 'application/vnd.github+json' : feed ? 'application/atom+xml' : 'application/octet-stream', 'user-agent': 'fnos-ffmpeg-manager', 'cache-control': 'no-cache', ...headers } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw Error('下载地址重定向无效');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) {
        const host = new URL(url).hostname;
        const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
        const retryAfter = response.headers.get('retry-after');
        const retryAt = Math.max(this.now() + 60000,
          Number(response.headers.get('x-ratelimit-reset') || 0) * 1000 || 0,
          /^\d+$/.test(retryAfter || '') ? this.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter) || 0);
        await response.body?.cancel();
        const step = api ? 'GitHub 版本查询 API' : feed ? 'GitHub 发行订阅' : `GitHub 文件下载（${host}）`;
        const message = limited && api ? `${step} 已限流（HTTP ${response.status}），约 ${Math.ceil((retryAt - this.now()) / 60000)} 分钟后再试` :
          `${step} 请求失败：HTTP ${response.status}${response.status === 403 ? '，请检查 NAS 出站网络或代理是否拒绝访问' : ''}`;
        throw Object.assign(Error(message), { status: response.status, retryAt, retryAfter });
      }
      return response;
    }
    throw Error('下载地址重定向次数过多');
  }
  async catalog() {
    targetArchitecture(this.platform, this.arch);
    let apiError;
    if (this.now() >= this.apiRetryAt) {
      try {
        const response = await this.response(`${API}/releases?per_page=10`, { api: true, signal: AbortSignal.timeout(15000) });
        const releases = JSON.parse((await bytes(response, 8 * 1024 * 1024)).toString('utf8'));
        if (!Array.isArray(releases)) throw Error('版本来源格式无效');
        return this.select(releases.flatMap(release => parseRelease(release, this.arch)));
      } catch (error) {
        apiError = error;
        // Do not keep retrying a throttled API when the user clicks Check again.
        this.apiRetryAt = error.retryAt || this.now() + 60000;
      }
    }
    try {
      const signal = AbortSignal.timeout(30000);
      const response = await this.response(FEED, { feed: true, signal });
      const releases = parseFeed((await bytes(response, 2 * 1024 * 1024)).toString('utf8'));
      for (const release of releases) {
        let response;
        try { response = await this.response(`${DOWNLOAD}${release.tag}/checksums.sha256`, { signal }); }
        catch (error) { if (error.status === 404) continue; throw error; }
        const entries = parseChecksums((await bytes(response, 128 * 1024)).toString('utf8'), release, this.arch);
        if (entries.length) return this.select(entries);
      }
      throw Error('发行订阅中没有当前架构的可校验构建');
    } catch (error) {
      throw Error(`版本查询失败：${apiError ? apiError.message + '；' : ''}备用来源：${error.message}`);
    }
  }
  select(entries) {
    entries.sort((a, b) => b.tag.localeCompare(a.tag) || compareBranch(b.branch, a.branch));
    // One immutable build per release branch. The user can keep older downloaded builds locally.
    const branches = new Set();
    const result = entries.filter(entry => { if (branches.has(entry.branch)) return false; branches.add(entry.branch); return true; });
    result.sort((a, b) => compareBranch(b.branch, a.branch));
    if (!result.length) throw Error('没有找到当前架构带 SHA256 的发布分支构建');
    return result;
  }
  async download(entry, destination, options = {}) {
    if (entry.arch !== this.arch || !TAG.test(entry.tag) || entry.url !== `${DOWNLOAD}${entry.tag}/${entry.name}` ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.size !== null && (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_DOWNLOAD))) throw Error('下载元数据无效，请重新检查更新');
    await downloadVerified({ ...options, destination, label: '旧构建', sha256: entry.sha256, size: entry.size,
      request: settings => this.response(entry.url, settings) });
  }
}
function compareBranch(a, b) {
  const [am, an] = a.split('.').map(Number), [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}
