import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * A single managed mihomo child process. Arguments are always passed as an
 * array with shell disabled, and output is streamed line by line to the caller.
 */
export class CoreProcess extends EventEmitter {
  constructor({ binary, args, cwd, env = {}, onLine = () => {} }) {
    super();
    this.binary = binary;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onLine = onLine;
    this.child = null;
    this.startedAt = 0;
    this.stopping = false;
    this.settled = true;
  }

  get running() {
    return Boolean(this.child && this.settled === false);
  }

  get pid() {
    return this.child?.pid || 0;
  }

  start() {
    if (this.running) throw Error('Core 已在运行');
    this.stopping = false;
    this.settled = false;
    this.startedAt = Date.now();
    const child = spawn(this.binary, this.args, {
      cwd: this.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });
    this.child = child;

    const consume = (stream, level) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.trim()) this.onLine(line, level);
        }
        if (buffer.length > 16384) { this.onLine(buffer, level); buffer = ''; }
      });
      stream.on('end', () => { if (buffer.trim()) this.onLine(buffer, level); });
    };
    consume(child.stdout, 'info');
    consume(child.stderr, 'error');

    const settle = (info) => {
      if (this.settled) return;
      this.settled = true;
      const payload = { expected: this.stopping, ...info };
      this.emit('exit', payload);
    };
    child.once('error', error => settle({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => settle({ code, signal, error: null }));
  }

  /** Always returns; SIGKILL is used when the core ignores SIGTERM. */
  async stop({ timeout = 8000 } = {}) {
    const child = this.child;
    if (!child || this.settled) return { code: null, signal: null, alreadyStopped: true };
    this.stopping = true;
    const exited = new Promise(resolve => {
      if (this.settled) return resolve();
      this.once('exit', () => resolve());
    });
    child.kill('SIGTERM');
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    try {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, timeout + 3000))]);
    } finally {
      clearTimeout(timer);
    }
    return { code: child.exitCode, signal: child.signalCode };
  }

  dispose() {
    this.removeAllListeners();
    this.child = null;
    this.settled = true;
  }
}
