# @fnos/version-check

通用版本检查器。来源只需实现 `async check(context)`，返回由应用定义的版本元数据；公共层负责手动触发、按间隔自动触发、结果缓存及并发请求合并。检查器不执行下载或安装。

```js
import { GitHubReleaseSource, UpdateChecker } from '@fnos/version-check';

const checker = new UpdateChecker(new GitHubReleaseSource({
  repository: 'owner/repo',
  tagPrefix: 'my-app',
  filePrefix: 'my-app-for-fnos',
  version: installedVersion,
}), { cacheMs: 60 * 60 * 1000 });

const { update } = await checker.check();
await checker.checkNow(); // 手动检查，跳过缓存
const schedule = checker.startAutoCheck({
  intervalMs: 4 * 60 * 60 * 1000,
  onResult: result => console.log(result),
  onError: error => console.error(error),
});
schedule.stop();
```

GitHub 来源识别 `my-app/v<version>` 标签和 `my-app-for-fnos_v<version>_<x86|arm>.fpk` 资产，返回 `{ update: null | { version, url } }`。浏览器调用 `watchAppUpdates({ endpoint, interval })`，新版本通过常驻 toast 提供下载链接。FPK 仍由管理员在飞牛应用中心手动安装。

npm 来源可查询指定 registry 的包版本或标签，返回版本号及完整性信息：

```js
import { NpmRegistrySource, UpdateChecker } from '@fnos/version-check';

const checker = new UpdateChecker(new NpmRegistrySource({ packageName: '@deepseek-ai/dsh' }));
const metadata = await checker.checkNow({ registry: 'https://registry.npmjs.org', selector: 'latest' });
```

其他来源可直接传入自定义实现，例如 `new UpdateChecker({ check: ({ channel }) => repository.latest(channel) })`。每个检查器可以独立选择手动检查、缓存时长及自动检查频率。应用负责验证结果是否适合安装，以及执行其原有下载、校验和安装流程。

构建应用时须将本包服务端代码及 toast 的 JS/CSS 打入 FPK，不依赖工作区。
