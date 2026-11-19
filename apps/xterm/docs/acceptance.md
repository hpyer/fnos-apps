# 原型验证与 fnOS 实机验收

## 本机范围

2026-11-19：Xterm for fnOS 版本为 1.2.0，新增命令历史持久化/去重和系统代理同步。本机 macOS / Node 24.19.0 通过 `node --test test/bashrc.test.mjs`（5 项，覆盖 SIGKILL 后历史保留、重复命令去重、启动时历史压缩、代理导入与实时切换、`su-shell` 继续加载应用配置）。当前执行环境没有可用的 PTY 设备，原有 `test/terminal.test.mjs` 同样无法完成，因此真实 PTY 交互仍需在具备 PTY 的环境和 fnOS 实机复核；本机结果不能替代 NAS 验收。

2026-09-22：Xterm for fnOS 版本为 1.1.0。本机 macOS / Node 24 已通过 `pnpm --filter @fnos/xterm test`（6 项）、`pnpm run build xterm` 和 `pnpm run pack xterm --all`；Shell wrapper 已通过语法检查并随构建产物打包，已生成 x86/arm 两份 FPK。`su` 在 fnOS 实机上的真实用户切换、权限和目标用户 HOME 仍需实机验证，不能以本机测试替代。

2026-09-15：`pnpm test` 全仓 43 项通过（DSH 37、Xterm 6）；`pnpm run build xterm` 与 `pnpm run pack xterm --all` 通过。浏览器连接真实 PTY 后用 `vi` 验证国旗 emoji 显示和后续文本列对齐。Xterm for fnOS 版本为 1.0.1；该版本仍需 fnOS 实机升级验证。

2026-09-14：`pnpm test` 全仓 43 项通过（DSH 37、Xterm 6）；`pnpm run build xterm` 与 `pnpm run pack xterm --all` 通过。Xterm for fnOS 版本为 1.0.0。

- macOS / Node 24：真实 node-pty + Bash 验证 TTY、Unicode、窗口尺寸、Ctrl+C 以及断开 IPC 后 Shell 退出。
- 模拟 Unix Socket 网关验证匿名/非管理员拒绝、来源和自定义 Header、WebSocket Upgrade 鉴权、凭据有效期、UID/Origin 绑定、一次性消费、单用户单会话、非法尺寸和断开清理。
- 浏览器打开打包后的页面，验证真实连接、终端输入与尺寸回传。
- 使用 Zig 0.14.1、Node 24.19.0 头文件与锁定的 node-pty 1.1.0 源码交叉编译 Linux x64/arm64，检查 ELF64 和目标机器类型；fnpack 生成两份 FPK。
- 这些检查不等于 Linux 模块实际加载测试或 NAS 验收；本机没有可用的 Linux 容器运行环境。

## NAS 必测

1. 分别在 fnOS ≥ 1.1.3100 的 x86_64、arm64 设备上安装；验证 nodejs_v24、glibc 及 PTY 模块加载，确认实际进程是包用户且服务拒绝 root 启动。
2. 桌面图标显示黑蓝 X；Socket 权限允许网关访问且不向无关本地账号开放；终端无新增 TCP 监听。
3. 普通用户、匿名、跨站和伪造身份请求均拒绝；不同用户不得消费对方凭据。验证退出登录和撤销管理员权限后的既有连接行为。
4. 中文输入法、粘贴、复制、Tab 补全、vim/top、Ctrl+C、缩放、长时间大量输出、浏览器后台节流。
5. 断开、关闭窗口、断网、应用停用、升级、NAS 重启、主服务被强杀时，检查 Shell 与前台任务回收；检查故意脱离 session 的进程限制。
6. 经 HTTPS 反代和飞牛远程访问验证 Origin/Host 改写、WSS 心跳、空闲超时；不以局域网通过代替远程验证。
7. 从新连接确认 HOME 数据保留；检查日志不含终端输入输出、凭据、环境变量；确认卸载保留/删除数据行为。
8. 历史：执行多条命令后直接点击「断开」或关闭窗口，再次连接后确认历史仍在；重复执行同一命令后按一次上箭头应回到上一条不同命令；执行 `su <用户>` 后重复检查目标用户 `~/.xterm_history` 的写入、权限和去重；多个管理员同时连接时确认历史追加不丢行、不互相覆盖。
9. 系统代理：通过 Clash 等应用或手工修改 `/etc/environment` 打开代理，在新会话和已连接的会话中检查 `env`、`curl` 是否走代理；在会话保持打开时启用、修改端口、删除代理，确认后续命令生效且删除后相关变量被清除；执行 `su` 和 `su -` 后重复检查；确认 `PATH` 等其他变量没有被导入，日志中不出现代理地址、账号或密码。

已在一台 fnOS 设备上验证 1.0.0 的基础会话、断开、清屏以及 `cd`、`pwd`、`ls` 等命令；1.0.1 升级、跨架构、长时间运行和异常恢复项目仍待完整实机验收。
