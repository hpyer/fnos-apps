import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function ensureDir(directory, mode = 0o700) { await mkdir(directory, { recursive: true, mode }); }
export async function readJSON(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
export async function atomicWrite(file, content, mode = 0o600) { await ensureDir(path.dirname(file)); const temp = `${file}.tmp-${process.pid}-${Date.now()}`; await writeFile(temp, content, { mode }); await rename(temp, file); }
export async function atomicJSON(file, value) { await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }
export async function removePath(file) { await rm(file, { recursive: true, force: true }); }
