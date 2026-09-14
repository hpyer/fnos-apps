import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function authenticatedProbe(address) {
  const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
  await response.body?.cancel();
  if (response.ok) return { ok: true, cookie: '' };
  // Recent DSH exchanges its launch token for an HttpOnly cookie and a 303.
  // Node fetch does not maintain a cookie jar across redirects.
  if (response.status !== 303 || response.headers.get('location') !== '/') return { ok: false, cookie: '' };
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) return { ok: false, cookie: '' };
  const index = await fetch(new URL('/', address), { redirect: 'manual', headers: { cookie }, signal: AbortSignal.timeout(1500) });
  await index.body?.cancel();
  return { ok: index.ok, cookie: index.ok ? cookie : '' };
}
export async function probe(address) { return (await authenticatedProbe(address)).ok; }
export class DshProcess {
  constructor(environment) { this.environment = environment; this.child = null; this.address = null; this.authCookie = ''; }
  async start(entry, cwd, patch) {
    if (this.child) throw new Error('DSH 已在运行');
    this.address = null;
    // DSH chooses an ephemeral loopback port. The gateway is the only process
    // that exposes it externally and applies the browser session boundary.
    const args = [entry, 'web', ...(patch ? ['--patch', patch] : []), '--no-open', '--host', '127.0.0.1', '--port', '0'];
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), ...args], {
      cwd, env: this.environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    let line = '';
    let failure;
    child.once('error', error => { failure = error; if (this.child === child) this.child = null; });
    child.once('exit', () => {
      if (this.child === child) { this.child = null; this.address = null; this.authCookie = ''; }
    });
    // Do not write the authenticated URL, prompts, or plugin output into manager logs.
    child.stdout.on('data', chunk => {
      line = (line + chunk.toString()).slice(-16384);
      const match = line.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+[^\s]*)/);
      if (match) this.address = new URL(match[1]);
    });
    child.stderr.resume();
    // Require multiple successful probes to avoid publishing a runtime while
    // DSH is still completing its own startup and token exchange.
    let healthy = 0;
    for (let i = 0; i < 240; i++) {
      if (failure || this.child !== child) throw failure ?? new Error('DSH 启动时退出，请检查所选版本与插件兼容性');
      if (this.address) {
        try {
          const session = await authenticatedProbe(this.address);
          if (session.ok && this.child === child) {
            this.authCookie = session.cookie;
            if (++healthy >= 3) return;
          }
          else healthy = 0;
        } catch { healthy = 0; }
      }
      await delay(500);
    }
    await this.stop();
    throw new Error('DSH 启动检查超时（120 秒）');
  }
  async pluginOperationState() {
    if (!this.address) return 'unavailable';
    try {
      const response = await fetch(new URL('/dsh-market/status', this.address), {
        headers: this.authCookie ? { cookie: this.authCookie } : {},
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) { await response.body?.cancel(); return 'unavailable'; }
      const status = await response.json();
      if (status.active === true || status.busy === true) return 'active';
      if (status.active === false && (status.busy === false || status.busy === undefined)) return 'idle';
      return 'unavailable';
    } catch { return 'unavailable'; }
  }
  async pluginOperationActive() {
    // A failed status check during package replacement is not evidence that the
    // operation ended. Keep legacy boolean callers conservative as well.
    return (await this.pluginOperationState()) !== 'idle';
  }
  async stop() {
    const child = this.child;
    if (!child) { this.authCookie = ''; return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 12_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.child === child) { this.child = null; this.address = null; }
    this.authCookie = '';
  }
}
