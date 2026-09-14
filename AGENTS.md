# 项目开发约束

- 使用 pnpm workspace 管理应用。每个应用位于 `apps/<slug>`，原生 fnOS 包位于 `apps/<slug>/native`。
- 根目录维护通用脚本、CI/CD 和 workspace 文档；应用的功能说明、架构、验收和运行文档放在各自的 `apps/<slug>/` 目录。
- 执行 `dev`、`build`、`pack`、`check`、`release` 等通用命令时必须显式传入应用标识，例如 `pnpm run build <slug>`；不得默认选择某个应用。
- 应用构建输出写入 `dist/<slug>`，FPK 通过 `pnpm run pack <slug>` 生成。打包前应保证应用版本、manifest 与发布元数据一致。
- 只有用户明确要求发布应用新版本时，才更新应用版本号和 `CHANGELOG.md`；发布变更应根据该版本包含的 Git 提交整理，不得在日常功能提交中提前维护未发布条目。
- 应用 `README.md` 只描述当前最新状态和使用方式，不记录“从哪个版本开始”或逐版本变动；版本历史统一写入 `CHANGELOG.md`。
- 发布应用新版本时，必须同步更新根目录 `README.md` 应用列表中的版本号。
- 进程调用使用参数数组，禁止用 shell 字符串拼接命令。运行数据、构建产物与应用包目录保持分离；不得改写系统全局 npm/pnpm 配置。
- 修改应用逻辑、安装流程、权限、网关或代理后运行 `pnpm test`；打包使用 `pnpm run pack <slug>`。明确区分本机测试与 fnOS 实机验证，不能以本机结果替代 NAS 验收。
- 不在日志、测试输出、文档或提交内容中写入访问令牌、API Key、会话内容、用户数据或完整环境变量。

## 飞牛文档

- 遇到 fnOS 的平台行为、manifest 字段、生命周期、权限、统一网关、开放 API 或 `fnpack` 用法不确定时，优先查阅[飞牛开发文档](https://developer.fnnas.com/docs/guide/)和[开放 API 手册](https://developer.fnnas.com/api/overview/)；不要根据其它平台经验猜测。
- 对依赖具体 fnOS 版本、设备架构或部署环境的行为，在文档和测试记录中标注需要实机验证的范围。

## Git 提交

用户要求提交时，先检查 `git status` 和相关 diff，仅暂存本次任务文件；无关更改拆分提交。

提交信息遵循 Conventional Commits：`<type>(<scope>): <summary>`。

允许类型：feat、fix、docs、style、refactor、perf、test、build、ci、chore。type 小写，summary 少于 72 个字符且末尾不加句号。破坏性变更使用 `!`，原因或迁移细节不明显时补充正文；无法确定 type/scope 时先询问。
