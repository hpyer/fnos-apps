const TITLES = { info: '提示', success: '成功', warning: '警告', error: '错误' };
const POSITIONS = new Set(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'center']);
const hosts = new WeakMap();

/** Show a toast. Import @fnos/toast/style.css in the app's stylesheet. */
export function toast({ title, content = '', link, type = 'info', position = 'top-right', duration = 3000, container = document.body } = {}) {
  if (!Object.hasOwn(TITLES, type)) throw new TypeError(`Unknown toast type: ${type}`);
  if (!POSITIONS.has(position)) throw new TypeError(`Unknown toast position: ${position}`);
  if (!Number.isFinite(duration) || duration < 0) throw new TypeError('Toast duration must be a non-negative number');
  const linkURL = link ? new URL(link.href) : null;
  if (linkURL && linkURL.protocol !== 'https:') throw new TypeError('Toast link must use HTTPS');

  let positions = hosts.get(container);
  if (!positions) { positions = new Map(); hosts.set(container, positions); }
  let host = positions.get(position);
  if (!host) {
    host = document.createElement('div');
    host.className = `fnos-toast-host fnos-toast-host--${position}`;
    container.append(host);
    positions.set(position, host);
  }

  const item = document.createElement('div');
  item.className = `fnos-toast fnos-toast--${type}`;
  item.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'fnos-toast__icon';
  icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'fnos-toast__body';
  const heading = document.createElement('strong');
  heading.className = 'fnos-toast__title';
  heading.textContent = title == null || !String(title).trim() ? TITLES[type] : String(title);
  body.append(heading);
  if (content !== '' && content != null) {
    const detail = document.createElement('div');
    detail.className = 'fnos-toast__content';
    detail.textContent = String(content);
    body.append(detail);
  }
  if (link) {
    const anchor = document.createElement('a');
    anchor.className = 'fnos-toast__link';
    anchor.href = linkURL.href;
    anchor.textContent = String(link.label || '查看详情');
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    body.append(anchor);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'fnos-toast__close';
  dismiss.setAttribute('aria-label', '关闭提示');
  dismiss.textContent = '×';
  item.append(icon, body, dismiss);
  host.append(item);

  let timer, startedAt, remaining = duration, closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    item.remove();
    if (!host.childElementCount) {
      host.remove();
      positions.delete(position);
      if (!positions.size) hosts.delete(container);
    }
  }
  function pause() {
    if (closed || !timer) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
  }
  function resume() {
    if (closed || !duration || timer) return;
    startedAt = performance.now();
    timer = setTimeout(close, remaining);
  }
  item.addEventListener('mouseenter', pause);
  item.addEventListener('mouseleave', () => { if (!item.contains(document.activeElement)) resume(); });
  item.addEventListener('focusin', pause);
  item.addEventListener('focusout', event => { if (!item.contains(event.relatedTarget) && !item.matches(':hover')) resume(); });
  dismiss.addEventListener('click', close);
  resume();
  return { close };
}
