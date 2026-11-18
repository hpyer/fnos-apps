/**
 * Track a multi-step preparation task (first-run data downloads, config apply,
 * core start) so the page can show determinate progress instead of a spinner.
 *
 * Steps only ever move forward: activating a step that is already finished keeps
 * the current step and only refreshes the message. That makes it safe to call
 * the same phase from nested helpers such as ensureCoreData()/testConfig().
 */
export class PreparationProgress {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.state = emptyState();
  }

  get active() {
    return this.state.active;
  }

  start(label, steps = []) {
    const list = steps
      .filter(step => step && (typeof step === 'string' || step.key))
      .map(step => (typeof step === 'string' ? { key: step, label: step } : { key: String(step.key), label: String(step.label || step.key) }));
    this.state = {
      active: true,
      label: String(label || '准备中').slice(0, 80),
      message: list[0]?.label || '',
      error: '',
      steps: list.map(step => ({ ...step, state: 'pending' })),
      index: -1,
      received: 0,
      bytesTotal: 0,
      startedAt: this.now(),
      endedAt: 0,
    };
  }

  has(key) {
    return this.state.steps.some(step => step.key === key);
  }

  /** Mark the step with `key` as the current one. Unknown keys only update the message. */
  step(key, message = '') {    if (!this.state.active) return false;
    const { steps } = this.state;
    const index = steps.findIndex(step => step.key === key);
    if (index < 0) {
      if (message) this.detail(message);
      return false;
    }
    if (index < this.state.index) {
      if (message) this.detail(message);
      return false;
    }
    const next = steps.map((step, position) => {
      if (position < index && step.state !== 'done') return { ...step, state: 'done' };
      if (position === index) return { ...step, state: 'active' };
      return step;
    });
    this.state = { ...this.state, steps: next, index, message: String(message || steps[index].label).slice(0, 200), received: 0, bytesTotal: 0 };
    return true;
  }

  detail(message) {
    if (!this.state.active || !message) return;
    this.state = { ...this.state, message: String(message).slice(0, 200) };
  }

  /** Byte progress of the current step; `total` is 0 when the server sent no length. */
  bytes(received, total = 0) {
    if (!this.state.active) return;
    const value = Number(received);
    const size = Number(total);
    this.state = {
      ...this.state,
      received: Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0,
      bytesTotal: Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0,
    };
  }

  done() {
    if (!this.state.active) return;
    this.state = {
      ...this.state,
      active: false,
      steps: this.state.steps.map(step => (step.state === 'active' ? { ...step, state: 'done' } : step)),
      message: '',
      received: 0,
      bytesTotal: 0,
      endedAt: this.now(),
    };
  }

  fail(message) {
    if (!this.state.active) return;
    const text = String(message || '操作失败').slice(0, 300);
    this.state = {
      ...this.state,
      active: false,
      steps: this.state.steps.map(step => (step.state === 'active' ? { ...step, state: 'error' } : step)),
      message: text,
      error: text,
      received: 0,
      bytesTotal: 0,
      endedAt: this.now(),
    };
  }

  snapshot() {
    const { startedAt, endedAt, active } = this.state;
    const end = endedAt || (active ? this.now() : startedAt);
    return {
      ...this.state,
      steps: this.state.steps.map(step => ({ ...step })),
      elapsedMs: startedAt ? Math.max(0, end - startedAt) : 0,
    };
  }
}

function emptyState() {
  return { active: false, label: '', message: '', error: '', steps: [], index: -1, received: 0, bytesTotal: 0, startedAt: 0, endedAt: 0 };
}
