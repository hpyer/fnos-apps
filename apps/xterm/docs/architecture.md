# 原型架构

浏览器在 `/app/xterm-for-fnos/` 使用 xterm.js 显示终端，向同源 `/api/ticket` 发起带自定义 Header 的 POST。飞牛网关完成登录校验，应用检查 `X-Trim-Userid` 与 `X-Trim-Isadmin=true`。无 CORS 授权，跨站请求拒绝。桌面入口的可见性不充当后端鉴权。

服务仅监听 `${TRIM_APPDEST}/app.sock`，权限 0660；身份头仅在该可信网关边界内使用。安装后必须验证 socket 所有者、组及其他本地账号不可写入的边界。应用包用户能运行任意其权限允许的命令，包用户不是沙箱。

Shell 默认保持应用包用户身份。需要管理员权限时，用户可以在 Shell 内执行 `su <管理员用户名>`，由 fnOS 的系统认证机制校验密码并切换身份。首版不根据网关身份自动切换 Linux 用户，避免引入特权启动服务、网关账号到系统账号映射和凭据处理。`su` 后的权限和环境完全由 fnOS 系统配置决定，应用不代填、保存或记录密码。

连接凭据有效 15 秒、一次性使用，绑定 UID 与浏览器 Origin，通过 WebSocket 首帧发送，不放进 URL、日志或存储。Upgrade 本身再次检查管理员身份；首帧验证前不创建 PTY，5 秒未验证即关闭。因为网关可能改写 Host，不简单要求 Origin 等于内部 Host，而由同源 POST 签发的凭据绑定 Origin。全部静态资源本地分发。CSP 允许 xterm 渲染所需的内联样式，不允许内联脚本。

每个会话启动一个独立 Node worker，通过 IPC 持有 PTY。WebSocket 关闭后断开 worker IPC；主进程退出（包括被强杀）也会触发 worker 清理。Linux 按 PTY session ID 清理前台任务和 Shell，然后结束 worker。故意使用 setsid 或其他方式脱离终端 session 的守护进程不在此原型的完整回收保证内；不承诺容器级进程隔离。若 worker 本身被 SIGKILL，JS 清理不能执行，此项需要后续 cgroup 监管设计。

输出使用浏览器渲染完成后的 ACK；累计 64K 字符后暂停 PTY，低于 32K 恢复，超过 256K 结束异常会话。WebSocket 输出缓冲和输入 IPC 队列也有限制。尺寸为 2–500 列、1–200 行，单条 WebSocket 消息最大 32 KiB。15 秒心跳检测死连接。不实现终端记录、共享会话、SSH、文件传输或后台保活。

飞牛账号退出/管理员权限撤销是否会主动断开已有 WebSocket，官方接口没有在本原型中提供持续复核机制；当前身份在建连时验证，既有连接撤销行为需要实机确认。正式开放远程访问前应确定撤销策略。

当前包版本为 1.0.0。后续版本按提交整理 CHANGELOG，并执行发布检查。

参考：https://developer.fnnas.com/docs/core-concepts/gateway-registration 、https://developer.fnnas.com/docs/core-concepts/privilege 、https://github.com/microsoft/node-pty 、https://xtermjs.org/docs/guides/security/ 。
