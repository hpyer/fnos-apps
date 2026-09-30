import { toast } from '@fnos/toast';
import { UpdateChecker } from './core.mjs';

/** Check a same-origin update endpoint and keep a download reminder visible. */
export function watchAppUpdates({ endpoint, interval = 4 * 60 * 60 * 1000 } = {}) {
  let shownVersion = null;
  const checker = new UpdateChecker({
    async check() {
      if (document.hidden) return { update: null };
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error(`更新检查失败：HTTP ${response.status}`);
      return response.json();
    },
  });
  const schedule = checker.startAutoCheck({ intervalMs: interval, onResult({ update }) {
      if (!update || update.version === shownVersion) return;
      shownVersion = update.version;
      toast({ title: `发现新版本 ${update.version}`, content: '下载 FPK 后，请在飞牛应用中心手动安装。',
        link: { label: '下载 FPK', href: update.url }, type: 'info', duration: 0 });
    }, onError() { /* Update checks must never interrupt the application. */ } });
  return () => schedule.stop();
}
