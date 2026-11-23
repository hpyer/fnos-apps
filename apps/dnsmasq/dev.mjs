import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The page imports the shared credential client, which uses bare package
// specifiers and cannot be served unbundled. Build the same assets as a package
// build so local development behaves like the installed app.
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, '.local', 'web-dev');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(root, 'src', 'web', 'index.html'), path.join(out, 'index.html'));
await build({ entryPoints: [path.join(root, 'src/web/index.js'), path.join(root, 'src/web/index.css')], outdir: out, bundle: true, platform: 'browser', target: 'es2022', format: 'esm', logLevel: 'warning' });
process.env.DNSMASQ_WEB_DIR = out;
await import('./src/main.mjs');
