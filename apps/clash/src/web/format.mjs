const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(value, { rate = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return rate ? '0 B/s' : '0 B';
  if (number < 1024) return `${Math.round(number)} B${rate ? '/s' : ''}`;
  let size = number / 1024;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) { size /= 1024; unit += 1; }
  const text = size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return `${text} ${BYTE_UNITS[unit]}${rate ? '/s' : ''}`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

export function delayLevel(delay) {
  const number = Number(delay);
  if (!Number.isFinite(number) || number <= 0) return 'none';
  if (number < 300) return 'good';
  if (number < 800) return 'warn';
  return 'bad';
}

export function delayText(delay) {
  const number = Number(delay);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return `${Math.round(number)} ms`;
}

export function modeLabel(mode) {
  return { rule: '规则', global: '全局', direct: '直连' }[mode] || mode || '—';
}

export function levelLabel(level) {
  return { debug: '调试', info: '信息', warning: '警告', error: '错误', silent: '静默' }[level] || level || '信息';
}

export function connectionTarget(item) {
  if (!item) return '—';
  const host = item.host || item.destination || '';
  return host ? (item.port ? `${host}:${item.port}` : host) : '—';
}

export function truncate(text, length = 42) {
  const value = String(text ?? '');
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(1, length - 1))}…`;
}

export function configKindLabel(kind) {
  return { default: '默认配置', manual: '手动编辑', subscription: '订阅应用', restore: '备份恢复', rollback: '自动回滚' }[kind] || kind || '—';
}
