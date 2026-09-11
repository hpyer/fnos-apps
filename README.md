# fnOS Apps

这是一个使用 pnpm workspace 管理飞牛 fnOS 原生应用的多应用仓库。每个应用在 `apps/<slug>` 中独立开发、测试和发布；通用脚本、双架构打包和 GitHub Actions 工作流由根目录统一维护。

## 文档导航

- [应用开发与发布约定](docs/app-development.md)：创建应用、构建、打包、版本与 CI/CD。
- [DSH for fnOS](apps/dsh/README.md)：首个应用的功能、开发、安装与运行数据说明。
- [DSH 架构](apps/dsh/docs/architecture.md)：网关、进程、版本事务与插件兼容策略。
- [DSH 实机验收](apps/dsh/docs/acceptance.md)：本机验证记录与 NAS 验收清单。

## 快速开始

要求 Node.js 24+、pnpm 11.22.0；本地打包还需要全局安装 `fnpack`。

```sh
pnpm install
pnpm test

# 本地开发指定应用
pnpm run dev dsh

# 构建、打包与发布前检查指定应用
pnpm run build dsh
pnpm run pack dsh --all
pnpm run check dsh
```

所有通用命令都必须将应用标识作为第一个参数；仓库不会默认选择 DSH 或其它应用。

## 新建应用

```sh
pnpm run create demo "示例应用" 8080
pnpm run build demo
pnpm run pack demo --all
```

脚手架会创建 `apps/demo` workspace 及 `scripts/apps/demo` 发布元数据。后续应用可使用独立的标签命名空间，例如 `demo/v1.0.0`；标签触发的发布只构建对应应用的 x86 和 arm FPK。

## 仓库结构

```text
apps/<slug>/             单个应用的源码、原生清单、测试和应用文档
apps/<slug>/native/      fnOS manifest、入口、权限、向导和资源
apps/<slug>/docs/        应用架构、验收与运行说明
scripts/                 通用脚手架、构建、打包、发布与 fnpack 安装器
scripts/apps/<slug>/     应用发布元数据与 Release Notes 模板
docs/                    workspace 通用开发与发布文档
.github/workflows/       CI、应用标签发布及可复用双架构构建
```

参考：[飞牛开发指南](https://developer.fnnas.com/docs/guide/)、[开放 API](https://developer.fnnas.com/api/overview/) 与 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)。
