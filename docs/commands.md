# 命令使用手册

本文档集中说明 fnOS Apps workspace 的安装、测试、开发、构建、打包、检查、发布和应用脚手架命令。

## 基本约定

要求 Node.js 24+、pnpm 11.22.0；本地打包还需要可执行的 `fnpack`。

```sh
# 安装或同步 workspace 依赖
pnpm install

# CI 中严格按 pnpm-lock.yaml 安装，不允许自动更新锁文件
pnpm install --frozen-lockfile
```

`dev`、`build`、`pack`、`check`、`release` 和 `create` 都必须显式传入应用标识 `<slug>`，仓库不会默认选择 DSH。应用标识既可以作为第一个位置参数，也可以通过 `--app` 指定：

```sh
pnpm run build dsh
pnpm run build --app dsh
```

带值选项支持 `--key value` 和 `--key=value` 两种写法；`--all`、`--create` 是不带值的开关。

## 命令总览

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装全部 workspace 依赖 |
| `pnpm test` | 运行所有应用测试 |
| `pnpm run dev <slug>` | 启动指定应用的本地开发模式 |
| `pnpm run build <slug>` | 构建指定应用到 `dist/<APP_ID>` |
| `pnpm run pack <slug> [选项]` | 将已构建应用打包成 FPK |
| `pnpm run check <slug> [选项]` | 执行指定应用的发布前一致性检查 |
| `pnpm run release [子命令] <slug> [选项]` | 查看发布信息、提取说明或生成标签 |
| `pnpm run create <slug> <显示名称> [默认端口]` | 创建新应用脚手架 |

## 测试

```sh
# 运行所有 workspace 应用的测试
pnpm test

# 只运行一个应用的测试；这里使用 package.json 中的包名
pnpm --filter @fnos/dsh test
```

## 本地开发

```sh
pnpm run dev <slug>
pnpm run dev --app <slug>

# 示例
pnpm run dev dsh
```

该命令调用指定应用自己的 `dev` 脚本。开发服务器的地址、端口和运行方式由应用决定。

## 构建

```sh
pnpm run build <slug>
pnpm run build --app <slug>

# 示例：输出到 dist/dsh-for-fnos
pnpm run build dsh
```

构建完成后会检查 `dist/<APP_ID>` 及其中的 `manifest` 是否存在。构建不会生成 FPK。

## 打包

打包前必须先构建应用：

```sh
pnpm run build <slug>
pnpm run pack <slug> [--arch x86|arm] [--all] [--version <版本>] [--output <目录>]
```

| 选项 | 说明 |
| --- | --- |
| `--arch x86\|arm` | 打包单一架构；未指定时默认 `x86` |
| `--all` | 按应用元数据中的 `SUPPORTED_ARCH` 打包全部架构；指定后以它为准，不再读取 `--arch` |
| `--version <版本>` | 临时写入 FPK manifest 的版本；默认使用应用发布元数据版本 |
| `--output <目录>` | FPK 输出目录；默认 `dist/release` |
| `--app <slug>` | 使用选项而非位置参数指定应用 |

```sh
# 默认打包 x86
pnpm run pack dsh

# 分别打包指定架构
pnpm run pack dsh --arch x86
pnpm run pack dsh --arch arm

# 打包应用声明支持的全部架构
pnpm run pack dsh --all

# 指定版本和输出目录
pnpm run pack dsh --all --version 1.0.0 --output ./artifacts

# 使用非全局 fnpack
FNPACK_BIN=/absolute/path/to/fnpack pnpm run pack dsh --all
```

默认文件名为 `dist/release/<FILE_PREFIX>_v<VERSION>_<ARCH>.fpk`。打包过程只修改临时副本中的 `version` 和 `platform`，不会改写应用源码里的 manifest。

仓库还提供 CI/Linux 使用的官方 `fnpack` 安装器：

```sh
# 安装到指定路径；省略路径时使用 FNPACK_BIN、RUNNER_TEMP 或 /tmp/fnpack
bash scripts/install-fnpack.sh /absolute/path/to/fnpack

# 可覆盖下载版本、地址和预期校验值
FNPACK_VERSION=1.2.3 FNPACK_URL=<下载地址> FNPACK_SHA256=<sha256> \
  bash scripts/install-fnpack.sh /absolute/path/to/fnpack
```

## 发布前检查

```sh
pnpm run check <slug> [--version <版本>] [--tag <标签>]

# 等价写法
pnpm run release check <slug> [--version <版本>] [--tag <标签>]

# 示例
pnpm run check dsh
pnpm run check dsh --version 1.0.0 --tag dsh/v1.0.0
pnpm run check dsh --tag dsh/v1.0.0-r1
```

检查内容包括：指定版本与 `package.json` 一致、`package.json` 与原生 manifest 版本一致、标签符合 `<TAG_PREFIX>/v<VERSION>`（允许 `-rN` 修订后缀），以及 `CHANGELOG.md` 存在对应版本的非空条目。未传 `--tag` 时使用当前 GitHub Actions 标签或默认标签。

## 发布辅助命令

`release` 用于生成或校验发布信息，不会上传 FPK，也不会创建 GitHub Release。支持以下子命令：

```sh
# 输出应用 ID、版本、标签和支持架构；metadata 可省略
pnpm run release metadata <slug> [--version <版本>]
pnpm run release <slug> [--version <版本>]

# 执行发布前检查
pnpm run release check <slug> [--version <版本>] [--tag <标签>]

# 输出 CHANGELOG.md 中指定版本的 Release Notes
pnpm run release notes <slug> [--version <版本>]

# 仅输出应使用的标签
pnpm run release tag <slug> [--version <版本>] [--revision <编号>]

# 创建本地 annotated Git 标签
pnpm run release tag <slug> [--version <版本>] [--revision <编号>] --create
```

示例：

```sh
pnpm run release dsh
pnpm run release notes dsh --version 1.0.0
pnpm run release tag dsh --version 1.0.0
pnpm run release tag dsh --version 1.0.0 --revision 1
pnpm run release tag dsh --version 1.0.0 --revision 1 --create

# 推送标签后触发对应应用的 GitHub Actions 发布流程
git push origin dsh/v1.0.0-r1
```

`--revision 1` 与 `--revision r1` 都生成 `-r1` 后缀。修订标签只区分同一应用版本的重新打包，不会改变 FPK 内的应用版本。

## 新建应用

```sh
pnpm run create <slug> <显示名称> [默认端口]
pnpm run create --app <slug> --name <显示名称> [--port <默认端口>]

# 示例
pnpm run create demo "示例应用" 8080
pnpm run create --app demo --name "示例应用" --port 8080
```

`<slug>` 只能包含小写字母、数字和连字符；端口必须是 2 至 5 位数字，省略时默认为 `8080`。脚手架会创建 `apps/<slug>`、`scripts/apps/<slug>/meta.env`、基础原生清单和变更日志，并执行 `pnpm install --lockfile-only` 将新 workspace 写入锁文件。

创建后即可使用通用命令：

```sh
pnpm run dev demo
pnpm test
pnpm run build demo
pnpm run pack demo --all
pnpm run check demo
```
