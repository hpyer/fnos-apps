export { UpdateChecker } from './core.mjs';

const ARCHITECTURES = { x64: 'x86', arm64: 'arm' };

function releaseSource({ repository, tagPrefix, filePrefix }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new TypeError('Invalid GitHub repository');
  if (typeof tagPrefix !== 'string' || !tagPrefix || typeof filePrefix !== 'string' || !/^[\w.-]+$/.test(filePrefix)) {
    throw new TypeError('Invalid release tag or file prefix');
  }
  const [owner, repo] = repository.split('/');
  return {
    releasesURL: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
    downloadPrefix: `https://github.com/${owner}/${repo}/releases/download/`,
    tagStart: `${tagPrefix}/v`,
  };
}

export async function readAppVersion(urls) {
  const { readFile } = await import('node:fs/promises');
  for (const url of urls) {
    try {
      const manifest = await readFile(url, 'utf8');
      const version = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(manifest)?.[1];
      if (version) return version;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('无法读取应用版本');
}

export function compareVersions(left, right) {
  const parts = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
  const a = parts(left), b = parts(right);
  if (!a || !b) throw new TypeError('Invalid application version');
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export function selectUpdate(releases, { repository, tagPrefix, filePrefix, version, arch }) {
  const { downloadPrefix, tagStart } = releaseSource({ repository, tagPrefix, filePrefix });
  const architecture = ARCHITECTURES[arch] || arch;
  if (!['x86', 'arm'].includes(architecture)) return null;
  let newest = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const match = typeof release.tag_name === 'string' && release.tag_name.startsWith(tagStart)
      ? /^(\d+\.\d+\.\d+)(?:-r\d+)?$/.exec(release.tag_name.slice(tagStart.length)) : null;
    if (!match || compareVersions(match[1], version) <= 0) continue;
    const name = `${filePrefix}_v${match[1]}_${architecture}.fpk`;
    const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded' &&
      typeof item.browser_download_url === 'string' && item.browser_download_url.startsWith(downloadPrefix));
    if (!asset) continue;
    if (!newest || compareVersions(match[1], newest.version) > 0) {
      newest = { version: match[1], url: asset.browser_download_url };
    }
  }
  return newest;
}

export class GitHubReleaseSource {
  constructor({ repository, tagPrefix, filePrefix, version, arch = process.arch, fetcher = globalThis.fetch }) {
    this.options = { repository, tagPrefix, filePrefix, version, arch };
    this.releasesURL = releaseSource(this.options).releasesURL;
    this.fetcher = fetcher;
  }

  async check() {
    const releases = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.fetcher(`${this.releasesURL}&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'fnos-version-check' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub Releases 请求失败：${response.status}`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('GitHub Releases 响应无效');
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    return { update: selectUpdate(releases, this.options) };
  }
}

export class NpmRegistrySource {
  constructor({ packageName, fetcher = globalThis.fetch, timeoutMs = 30_000 }) {
    if (typeof packageName !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName)) throw new TypeError('Invalid npm package name');
    this.packageName = packageName;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async check({ registry, selector, signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetcher(`${registry}/${encodeURIComponent(this.packageName)}/${encodeURIComponent(selector)}`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) throw new Error(`标签/版本 ${selector} 查询失败：HTTP ${response.status}`);
    const data = await response.json();
    if (data.name !== this.packageName || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(data.dist?.integrity ?? '')) {
      throw new Error('registry 返回了无效的包名或完整性信息');
    }
    return { version: data.version, integrity: data.dist.integrity };
  }
}
