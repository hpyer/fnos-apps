# fnOS Apps

这是一个使用 pnpm workspace 管理飞牛 fnOS 原生应用的多应用仓库。每个应用在 `apps/<slug>` 中独立开发、测试和发布；通用脚本、双架构打包和 GitHub Actions 工作流由根目录统一维护。

## 应用

| 应用名称 | 版本号 | 应用介绍 | 下载 |
| --- | --- | --- | --- |
| [DSH for fnOS](apps/dsh/README.md) | `1.0.2` | 在飞牛 NAS 上管理管理员共用的 DeepSeek Harness 实例，支持多版本下载、切换、重启、插件市场和官方插件 API。 | [GitHub](https://github.com/hpyer/fnos-apps/releases?q=DSH+for+fnOS&expanded=true) |
| [Xterm for fnOS](apps/xterm/README.md) | `1.0.0` | 管理员专用本机 Bash 终端，以应用包用户运行，断开后结束会话。 | [GitHub](https://github.com/hpyer/fnos-apps/releases?q=Xterm+for+fnOS&expanded=true) |

## 快速开始

要求 Node.js 24+、pnpm 11.22.0；本地打包还需要可执行的 `fnpack`。

```sh
# 安装依赖并运行全仓测试
pnpm install
pnpm test

# 本地开发 DSH
pnpm run dev dsh

# 构建并打包 DSH 的全部支持架构
pnpm run build dsh
pnpm run pack dsh --all

# 发布前检查
pnpm run check dsh
```

操作单个应用时必须显式传入应用标识，例如 `dsh`；仓库不会默认选择某个应用。

完整的参数、单应用测试、`fnpack` 配置、脚手架和发布标签用法见[命令使用手册](docs/commands.md)。应用开发和发布约定见[开发文档](docs/app-development.md)。

## 仓库结构

```text
apps/<slug>/             单个应用的源码、原生清单、测试和应用文档
apps/<slug>/native/      fnOS manifest、入口、权限、向导和资源
apps/<slug>/docs/        应用架构、验收与运行说明
scripts/                 通用脚手架、构建、打包、发布与 fnpack 安装器
scripts/apps/<slug>/     应用发布元数据
docs/                    workspace 通用开发与发布文档
.github/workflows/       CI、应用标签发布及可复用双架构构建
```

参考：[飞牛开发指南](https://developer.fnnas.com/docs/guide/)、[开放 API](https://developer.fnnas.com/api/overview/) 与 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)。
