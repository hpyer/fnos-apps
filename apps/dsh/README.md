# DSH for fnOS

DSH for fnOS 在飞牛 NAS 上运行一个仅供管理员共用的 DeepSeek Harness（DSH）实例。桌面入口会直接在同一飞牛应用窗口加载 DSH；首次没有可用版本时自动进入设置页。状态岛在 DSH 与设置页中提供运行状态、重启和页面切换。

## 功能

- DSH 访问端口可在安装向导与设置页配置，范围为 1024–65535，默认 3080。
- 默认检查 npm `latest`，可附加 `alpha`、`beta`、`next`；可下载精确版本并手动启用。
- 每个 DSH 版本独立安装并校验包名、版本和 lockfile integrity；已完成版本最多保留 5 个，当前版本不会自动删除。
- 启用新版本会先完成健康检查，失败则尝试恢复原版本。
- 首次成功启动自动安装 `dshmarket`；之后不会重复安装用户已移除的市场。
- 代理保留官方 Web profile、插件机制和数据格式，透传插件 HTTP、静态资源、SSE 与 WebSocket；不改写第三方插件前端代码。

这是管理员共享实例，不提供普通用户入口或用户数据隔离。DSH 与第三方插件的跨版本兼容性由其各自维护；切换不兼容版本前请备份共享目录的 `.dsh`。

## 本地开发

从仓库根目录执行：

```sh
pnpm install
pnpm run dev dsh
```

本机管理入口为 `http://127.0.0.1:3081/app/dsh-for-fnos/`，设置页为 `http://127.0.0.1:3081/app/dsh-for-fnos/settings/`。`3081` 仅用于本机开发的管理服务；DSH 的访问端口默认是 `3080`，可在设置页修改。开发运行数据位于 `apps/dsh/.local/`，不会影响 NAS 上已有的应用数据。

```sh
pnpm test
pnpm run build dsh
pnpm run pack dsh --arch x86
pnpm run pack dsh --all
pnpm run check dsh
```

FPK 输出到根目录 `dist/release/`。当前应用依赖 fnOS 的 `nodejs_v24`，最低支持 fnOS 1.1.3100；同一份 Node.js 源码可分别打包为 x86 与 arm FPK。

## 源码结构

```text
src/app/        Node.js 入口与安装初始化
src/server/     fnOS 网关管理服务与 DSH 代理
src/runtime/    DSH 版本、下载、进程和生命周期管理
src/shared/     配置、命令执行与共享图标
src/web/admin/  设置页资源
src/web/launcher/ 启动页资源与飞牛桥接
src/web/host/   注入 DSH 官方页面的宿主桥接
```

构建脚本会把这些模块映射为 fnOS 包中既有的 `app/` 文件布局；原生运行时不依赖源码目录结构。

## 安装与使用

1. 在飞牛应用中心安装对应架构的 FPK，并在安装向导中设置 DSH 访问端口。
2. 首次打开 **DSH for fnOS** 会进入设置页；下载 DSH 和安装市场完成后，即可返回 DSH。
3. 后续打开应用会直接显示 DSH。需要检查更新、下载或启用版本、修改端口和 npm 源时，在状态岛进入设置页。
4. 设置页的 npm 源可选择腾讯云、npmmirror、Yarn 与官方源，默认腾讯云；它只影响本应用，运行中的插件会在重启 DSH 后使用新源。

## 数据目录

应用壳运行数据位于 `${TRIM_PKGVAR}`，用于保存端口、版本状态、独立运行时和下载缓存。DSH 工作区、配置、插件和会话位于飞牛声明的共享目录，默认位置为：

```text
/vol1/@appshare/dsh-for-fnos/
├── 工作区目录
└── .dsh/
```

升级时会迁移旧的 `${TRIM_PKGVAR}/home`。应用不会读取、修改或迁移 `dsh-for-mac` 数据。

独立 DSH 端口适用于可信局域网；浏览器必须能直接访问 NAS 的配置端口。远程 HTTPS 部署应使用独立域名的根路径转发并配置 TLS，不能给 DSH 增加路径前缀。

## 延伸文档

- [架构说明](docs/architecture.md)
- [本机验证与 fnOS 实机验收](docs/acceptance.md)
- [发布变更记录](CHANGELOG.md)
- [DSH 项目](https://github.com/deepseek-ai/deepseek-harness)
- [dsh-market](https://github.com/dsh-market/dsh-market)
