import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.resolve(source, '../../dist/nginx-for-fnos');
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });
console.log(`已构建 ${target}`);
