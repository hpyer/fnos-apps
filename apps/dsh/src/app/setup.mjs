import path from 'node:path';
import { DEFAULTS, validateConfig, writeJson } from '../shared/config.mjs';
const root = process.env.TRIM_PKGVAR;
if (!root) throw new Error('缺少 TRIM_PKGVAR');
const config = validateConfig({ ...DEFAULTS, port: process.env.wizard_port ?? DEFAULTS.port });
await writeJson(path.join(root, 'config.json'), config);
