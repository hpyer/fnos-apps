import { open } from 'node:fs/promises';

const ELF_MACHINES = { x86_64: 62, arm64: 183 };

export async function readHeader(file, length = 20) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Return the ELF architecture or null when the file is not a static Linux binary. */
export async function elfArchitecture(file) {
  let header;
  try { header = await readHeader(file, 20); } catch { return null; }
  if (header.length < 20 || header.toString('hex', 0, 4) !== '7f454c46') return null;
  if (header[4] !== 2 || header[5] !== 1) return null;
  const machine = header.readUInt16LE(18);
  return Object.entries(ELF_MACHINES).find(([, value]) => value === machine)?.[0] || null;
}

export function expectedMachine(arch) {
  return ELF_MACHINES[arch] || 0;
}

/** Parse the version reported by `mihomo -v` / `mihomo version`. */
export function parseCoreVersion(output) {
  const match = /\bv?(\d+\.\d+\.\d+)\b/.exec(String(output || ''));
  return match ? match[1] : '';
}

export function coreFlavor(output) {
  const text = String(output || '');
  if (/smart/i.test(text)) return 'Smart';
  if (/mihomo|clash\.meta|MetaCubeX/i.test(text)) return 'MetaCubeX';
  return '';
}
