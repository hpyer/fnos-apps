# 应用发布契约

每个 `scripts/apps/<slug>` 目录对应 `apps/<slug>` 中的一个 workspace package。

- `meta.env`：应用 ID、包名、标签前缀、文件前缀和支持架构；它既被本地 Node 脚本读取，也会被 GitHub Actions 以 Bash `source` 读取，所以带空格的值必须使用双引号。
- `apps/<slug>/CHANGELOG.md`：应用发布说明的唯一来源。每次发布都必须增加 `## [版本]` 条目；本地发布检查和 GitHub Release 都会提取该版本的内容。

只要应用提供 `package.json` 的 `build` 脚本，把结果写入 `dist/<APP_ID>`，就可以共用根目录的构建、打包、标签检查和发布工作流。

调用根目录通用脚本时始终将 `<slug>` 作为第一个参数，例如 `pnpm run build dsh`；脚本不会默认选择 DSH 或其它应用。
