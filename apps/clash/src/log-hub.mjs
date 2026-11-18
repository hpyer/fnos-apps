import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './redact.mjs';

const LEVELS = { debug: 0, info: 1, warning: 2, error: 3 };

/**
 * In-memory ring buffer and SSE fan-out for manager and core logs. Every line is
 * redacted before it reaches memory, the log file or a browser.
 */
export class LogHub {
  constructor({ file, limit = 600, fileLimit = 2 * 1024 * 1024, secrets = () => [] } = {}) {
    this.file = file;
    this.limit = limit;
    this.fileLimit = fileLimit;
    this.secrets = secrets;
    this.entries = [];
    this.seq = 0;
    this.subscribers = new Set();
    this.stream = null;
    this.fileBytes = 0;
    this.rotating = false;
  }

  async init() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.fileBytes = (await stat(this.file)).size; } catch { this.fileBytes = 0; }
    if (this.fileBytes > this.fileLimit) await this.rotate();
    else this.open();
  }

  open() {
    this.stream = createWriteStream(this.file, { flags: 'a', mode: 0o600 });
    this.stream.on('error', () => { this.stream = null; });
  }

  async rotate() {
    if (this.rotating) return;
    this.rotating = true;
    try {
      const previous = this.stream;
      this.stream = null;
      if (previous) await new Promise(resolve => previous.end(resolve)).catch(() => {});
      await rm(`${this.file}.1`, { force: true });
      await rename(this.file, `${this.file}.1`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.fileBytes = 0;
      this.open();
    } finally {
      this.rotating = false;
    }
  }

  add({ level = 'info', message, source = 'app' } = {}) {
    const normalized = Object.hasOwn(LEVELS, level) ? level : 'info';
    const entry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level: normalized,
      source,
      message: redact(String(message ?? ''), this.secrets()).slice(0, 4000),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const response of this.subscribers) {
      try { response.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { this.subscribers.delete(response); }
    }
    this.append(entry);
    return entry;
  }

  append(entry) {
    if (!this.stream) return;
    const line = `${entry.at} [${entry.level}] ${entry.source}: ${entry.message}\n`;
    this.stream.write(line);
    this.fileBytes += Buffer.byteLength(line);
    if (this.fileBytes > this.fileLimit) void this.rotate();
  }

  history({ limit = 300, minLevel = '' } = {}) {
    const floor = Object.hasOwn(LEVELS, minLevel) ? LEVELS[minLevel] : -1;
    const result = floor < 0 ? this.entries : this.entries.filter(entry => LEVELS[entry.level] >= floor);
    return result.slice(-Math.max(1, Math.min(limit, this.limit)));
  }

  subscribe(response) {
    this.subscribers.add(response);
    return () => this.subscribers.delete(response);
  }

  async close() {
    for (const response of this.subscribers) { try { response.end(); } catch { /* already closed */ } }
    this.subscribers.clear();
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise(resolve => stream.end(resolve)).catch(() => {});
  }
}
