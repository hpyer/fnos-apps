# @fnos/privilege

fnOS 原生应用的公共提权基础组件，提供：

- root helper 调用、权限检查和错误脱敏
- 首次管理员授权与后续 `sudo -n` 执行
- ECDH + AES-GCM 管理员凭据通道
- 浏览器端凭据加密

组件不提供任意 root 命令执行接口。每个应用仍必须维护自己的 root-owned helper、允许的操作、参数校验、应用数据路径和 capability 策略。构建应用 FPK 时，必须把本包运行时代码和资源复制进应用包，安装后不得依赖 workspace。

## 导出

- `@fnos/privilege`：Node.js `PrivilegeBroker` 与 `PrivilegeError`
- `@fnos/privilege/credential`：服务端凭据密钥生成、解密和错误类型
- `@fnos/privilege/client`：浏览器端管理员凭据加密

公共组件本身不负责安装任何 helper，也不决定 sudoers 规则；这些行为必须由具体应用的安装脚本和 helper 实现。
