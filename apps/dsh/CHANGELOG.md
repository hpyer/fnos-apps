# Changelog

此文件记录 DSH for fnOS 面向用户的发布变更。每次发布都必须新增与应用版本一致的 `## [版本]` 条目；GitHub Release 会直接使用该条目的内容。

## [1.0.2]

### Added

- 支持通过飞牛统一网关的 `/app/dsh-for-fnos/dsh/` 路径访问 DSH，无需额外开放 DSH 端口。

### Fixed

- 插件变更后仅在 dsh-market 连续确认安装操作已结束时自动重启；状态查询暂时失败或出现新的文件变更会继续等待，避免中断更新。

## [1.0.1]

### Fixed

- 修复通过 dsh-market 更新插件时，管理器过早重启 DSH，导致更新请求提示“DSH 连接暂时不可用”的问题。

## [1.0.0]

### Added

- 支持在 fnOS 内下载、校验、保留、启用和回退多个 DSH 版本，本地最多保留 5 个已完成版本。
- 支持 `latest`、`alpha`、`beta`、`next` 更新标签、可选 npm 源，以及首次自动安装 dsh-market。
- 将 DSH 与设置页整合到同一应用窗口，并提供统一状态岛、重启和设置入口。
- 将 DSH 工作区、配置、插件和会话保存在飞牛共享目录，方便备份和维护。
- 保留官方 DSH profile 与插件 API，代理透传插件资源、HTTP API、SSE 和 WebSocket。
- DSH 应用图标、原生入口和双架构 FPK 打包流程已适配 fnOS。
