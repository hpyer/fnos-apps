/** A source implements check(context) and returns its own version metadata. */
export class UpdateChecker {
  constructor(source, { cacheMs = 0, now = Date.now } = {}) {
    if (typeof source?.check !== 'function') throw new TypeError('Update source must implement check(context)');
    if (!Number.isFinite(cacheMs) || cacheMs < 0) throw new TypeError('Cache duration must be non-negative');
    this.source = source;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cached = new Map();
    this.pending = new Map();
  }

  async check(context, { fresh = false } = {}) {
    const key = JSON.stringify(context ?? null);
    const cached = this.cached.get(key);
    if (!fresh && cached && this.now() - cached.at < this.cacheMs) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = Promise.resolve().then(() => this.source.check(context));
    this.pending.set(key, pending);
    try {
      const value = await pending;
      this.cached.set(key, { value, at: this.now() });
      return value;
    } finally { this.pending.delete(key); }
  }

  checkNow(context) { return this.check(context, { fresh: true }); }

  startAutoCheck({ intervalMs, context, onResult = () => {}, onError = () => {}, immediate = true }) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('Check interval must be positive');
    let stopped = false, timer;
    const currentContext = () => typeof context === 'function' ? context() : context;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(run, intervalMs);
      timer.unref?.();
    };
    const run = async () => {
      if (stopped) return;
      try {
        const value = await this.checkNow(currentContext());
        if (!stopped) await onResult(value);
      } catch (error) { if (!stopped) { try { await onError(error); } catch { /* A callback must not stop future checks. */ } } }
      finally { schedule(); }
    };
    if (immediate) queueMicrotask(run);
    else schedule();
    return {
      checkNow: () => this.checkNow(currentContext()),
      stop: () => { stopped = true; clearTimeout(timer); },
    };
  }
}
