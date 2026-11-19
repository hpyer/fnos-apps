# 原型架构

浏览器在 `/app/xterm-for-fnos/` 使用 xterm.js 显示终端，向同源 `/api/ticket` 发起带自定义 Header 的 POST。飞牛网关完成登录校验，应用检查 `X-Trim-Userid` 与 `X-Trim-Isadmin=true`。无 CORS 授权，跨站请求拒绝。桌面入口的可见性不充当后端鉴权。

服务仅监听 `${TRIM_APPDEST}/app.sock`，权限 0660；身份头仅在该可信网关边界内使用。安装后必须验证 socket 所有者、组及其他本地账号不可写入的边界。应用包用户能运行任意其权限允许的命令，包用户不是沙箱。

Shell 默认保持应用包用户身份。需要管理员权限时，用户可以在 Shell 内执行 `su <管理员用户名>`，由 fnOS 的系统认证机制校验密码并切换身份。首版不根据网关身份自动切换 Linux 用户，避免引入特权启动服务、网关账号到系统账号映射和凭据处理。`su` 后的权限和环境完全由 fnOS 系统配置决定，应用不代填、保存或记录密码。

## Shell 配置、历史与系统代理

Bash 以 `--noprofile --rcfile app/bashrc` 启动，不读取包用户或目标用户的 `.bash_profile`/`.bashrc`。`su` 由内置函数改为调用 `su -s app/su-shell`；`su-shell` 再用同一份 `bashrc` 启动目标用户的 Bash，因此配色、历史和系统代理规则在切换用户后继续有效。应用不把用户自己的 profile 注入 Shell。

PTY 在浏览器断开时被 SIGKILL，Bash 没有机会执行正常的退出写历史流程。`bashrc` 因此在每条命令执行后的提示符钩子中，把最后一条历史追加到当前用户的 `~/.xterm_history`（0600），并设置 `HISTCONTROL=ignoredups:erasedups`；启动时先用 `awk` 去重并限制为最近 10000 行，再由 Bash 自动加载，因此重复命令只占一条历史。文件追加使用 `flock`（存在时）串行化并发会话；退出钩子把 `HISTFILE` 指向 `/dev/null`，避免 Bash 在正常退出时用整份内存历史覆盖或重复追加其他会话刚写入的内容。多个会话共享同一个包用户 HOME 时共享同一份历史；`su` 后改用目标用户 HOME 下的历史文件。历史文件只记录命令文本，不记录终端输出。应用包用户的历史属于 `${TRIM_PKGVAR}` 下的应用数据；`su` 后的历史属于目标用户自己的数据，卸载应用不清理用户 home，避免越界删除。

系统代理以 `/etc/environment` 为准，读取 `http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`、`ftp_proxy` 及对应大写变量；同一逻辑变量只给出一侧时补齐大小写两种形式，其他变量（包括 `PATH`）不会导入。`bashrc` 在启动时应用一次，并在 DEBUG 陷阱（每条命令前，最多每秒一次）和 `PROMPT_COMMAND`（每次提示符）重新读取；内容未变化时跳过，手动 `export` 的代理变量不会被无故覆盖。系统代理变化后，已在运行的交互 Shell 在后续命令使用新值，无需重连；已经启动的子进程不会追溯修改。`su` 启动的新 Shell 同样读取该文件，因此 `su -` 清空环境后仍能恢复系统代理。应用只读取 `/etc/environment`，不修改系统代理配置；不保存代理地址、账号或密码，也不提供独立的代理配置界面。`/etc/environment` 不存在或不可读时保持继承环境不变。

连接凭据有效 15 秒、一次性使用，绑定 UID 与浏览器 Origin，通过 WebSocket 首帧发送，不放进 URL、日志或存储。Upgrade 本身再次检查管理员身份；首帧验证前不创建 PTY，5 秒未验证即关闭。因为网关可能改写 Host，不简单要求 Origin 等于内部 Host，而由同源 POST 签发的凭据绑定 Origin。全部静态资源本地分发。CSP 允许 xterm 渲染所需的内联样式，不允许内联脚本。

每个会话启动一个独立 Node worker，通过 IPC 持有 PTY。WebSocket 关闭后断开 worker IPC；主进程退出（包括被强杀）也会触发 worker 清理。Linux 按 PTY session ID 清理前台任务和 Shell，然后结束 worker。故意使用 setsid 或其他方式脱离终端 session 的守护进程不在此原型的完整回收保证内；不承诺容器级进程隔离。若 worker 本身被 SIGKILL，JS 清理不能执行，此项需要后续 cgroup 监管设计。

输出使用浏览器渲染完成后的 ACK；累计 64K 字符后暂停 PTY，低于 32K 恢复，超过 256K 结束异常会话。WebSocket 输出缓冲和输入 IPC 队列也有限制。尺寸为 2–500 列、1–200 行，单条 WebSocket 消息最大 32 KiB。15 秒心跳检测死连接。不实现终端记录、共享会话、SSH、文件传输或后台保活。

飞牛账号退出/管理员权限撤销是否会主动断开已有 WebSocket，官方接口没有在本原型中提供持续复核机制；当前身份在建连时验证，既有连接撤销行为需要实机确认。正式开放远程访问前应确定撤销策略。

当前包版本为 1.2.0。后续版本按提交整理 CHANGELOG，并执行发布检查。

参考：https://developer.fnnas.com/docs/core-concepts/gateway-registration 、https://developer.fnnas.com/docs/core-concepts/privilege 、https://github.com/microsoft/node-pty 、https://xtermjs.org/docs/guides/security/ 。
