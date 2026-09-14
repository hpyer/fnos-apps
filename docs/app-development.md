# fnOS Apps 开发与发布约定

本文档描述 workspace 的通用约定。DSH 的功能与运行说明位于 [apps/dsh/README.md](../apps/dsh/README.md)，其架构和验收文档也保存在该应用目录。

## 应用目录

每个应用是 `apps/<slug>` 下的一个 pnpm workspace package。它必须提供 `package.json`、`native/manifest` 和一个 `build` 脚本；构建脚本把可打包目录输出到 `dist/<APP_ID>`。已有应用可以保留自己的构建实现，新应用可以先用：

```sh
pnpm run create my-app "我的应用" 8080
```

通用脚本不会推断当前应用；构建、打包和发布都必须显式传入应用标识，例如 `pnpm run build my-app`。

应用专属元数据位于 `scripts/apps/<slug>/meta.env`：

```dotenv
APP_ID=my-app
PACKAGE_NAME=@fnos/my-app
DISPLAY_NAME="我的应用"
TAG_PREFIX=my-app
FILE_PREFIX=my-app
RELEASE_TITLE="我的应用"
SUPPORTED_ARCH="x86 arm"
```

每个应用还必须在 `apps/<slug>/CHANGELOG.md` 维护面向用户的变更记录。发布版本必须存在非空的 `## [版本]` 条目；`pnpm run check <slug>` 会验证它，GitHub Release 会直接使用该条目作为 Release Notes。

`TAG_PREFIX` 决定 Git 标签和 Release 的命名空间。例如 DSH 使用 `dsh/v1.0.0`，另一个应用可以使用 `my-app/v1.0.0`。这样不同应用可以各自发布相同的版本号，互不覆盖。

脚手架创建完成后会自动执行 `pnpm install --lockfile-only`，把新 workspace 写入根目录锁文件。

## 本地构建

```sh
pnpm install
pnpm test
pnpm run build dsh
pnpm run pack dsh --arch x86
pnpm run pack dsh --arch arm
```

FPK 会输出到 `dist/release/<FILE_PREFIX>_v<VERSION>_<ARCH>.fpk`。打包器不会修改 `apps/<slug>/native/manifest`，而是在临时目录中写入目标版本和 `platform`，所以连续构建两个架构不会产生串包。GitHub Release 标题使用 `<RELEASE_TITLE> v<VERSION>`；`RELEASE_TITLE` 应包含应用的完整展示名称，不会自动附加平台名称。

本机已有 `fnpack` 时直接调用它；也可以设置 `FNPACK_BIN` 指向固定版本。GitHub Actions 使用 `scripts/install-fnpack.sh` 下载并校验官方 Linux x86 构建器，应用源码分别在 x64、arm64 runner 上构建，再将保留权限的构建产物交给 x64 runner 打包。声明了 `package.json` 中 `fnos.nativeModules` 的应用，还会在打包时校验目标模块的 Linux ELF 架构。

## 发布流程

1. 更新应用的 `package.json`、`native/manifest` 和 `CHANGELOG.md`；changelog 必须包含当前版本的 `## [版本]` 条目，然后运行 `pnpm run check dsh`。
2. 查看标签：`pnpm run release tag dsh --version 1.0.0`；在 Git 仓库中创建标签可追加 `--create`。
3. 创建并推送应用专属标签，例如 `git tag -a dsh/v1.0.0 -m "DSH for fnOS 1.0.0" && git push origin dsh/v1.0.0`。
4. `Release fnOS app` 工作流会构建 `SUPPORTED_ARCH` 中的架构，上传 FPK 和 SHA-256 文件，并创建同名 GitHub Release。

需要同一版本重新打包时使用修订标签，例如 `dsh/v1.0.0-r1`；修订号只区分构建，不改变应用版本。也可以在 Actions 中手动填写应用、版本和修订号，工作流会创建对应 Release。

## CI 约定

`.github/workflows/ci.yml` 用于 Pull Request 和主分支检查；`.github/workflows/release.yml` 只负责解析应用标签；`.github/workflows/reusable-build-app.yml` 负责读取元数据、展开架构矩阵、构建 FPK 和发布。新增应用只需要提供相同的元数据和 package 构建入口，不需要复制一套工作流。
