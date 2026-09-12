import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

function parseKeyValueFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readField(source, field) {
  const match = source.match(new RegExp(`^\\s*${field}\\s*=\\s*(.+?)\\s*$`, 'm'));
  return match?.[1];
}

export async function resolveApp(slug) {
  if (!slug) throw new Error('缺少应用标识，请传入 <slug>；也可使用 --app <slug>');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`应用标识只能包含小写字母、数字和连字符：${slug}`);
  }

  const appDir = path.join(root, 'apps', slug);
  const manifestPath = path.join(appDir, 'native', 'manifest');
  const packagePath = path.join(appDir, 'package.json');
  const metaPath = path.join(root, 'scripts', 'apps', slug, 'meta.env');
  const [manifestSource, packageSource, metaSource] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(packagePath, 'utf8'),
    readFile(metaPath, 'utf8').catch(() => ''),
  ]);
  const packageJson = JSON.parse(packageSource);
  const meta = parseKeyValueFile(metaSource);
  const appId = meta.APP_ID || readField(manifestSource, 'appname');
  const version = meta.VERSION || packageJson.version || readField(manifestSource, 'version');
  if (!appId || !version) throw new Error(`应用 ${slug} 缺少 appname 或 version`);

  return {
    slug,
    dir: appDir,
    packageName: meta.PACKAGE_NAME || packageJson.name,
    packageJson,
    metaPath,
    manifestPath,
    manifestSource,
    appId,
    displayName: meta.DISPLAY_NAME || readField(manifestSource, 'display_name') || slug,
    version,
    tagPrefix: meta.TAG_PREFIX || slug,
    filePrefix: meta.FILE_PREFIX || appId,
    releaseTitle: meta.RELEASE_TITLE || meta.DISPLAY_NAME || appId,
    supportedArchitectures: (meta.SUPPORTED_ARCH || 'x86 arm').split(/[ ,]+/).filter(Boolean),
    distDir: path.join(root, 'dist', appId),
    meta,
  };
}

export function parseCli(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (['--all', '--create'].includes(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=', 2);
      if (inlineValue !== undefined) options[key] = inlineValue;
      else options[key] = argv[++index];
      continue;
    }
    positional.push(arg);
  }
  return { options, positional };
}
