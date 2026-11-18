# Changelog

## [1.0.1]

### Fixed

- x86 安装包改用 mihomo `amd64-compatible` 内核，修复旧款 x86_64 CPU 缺少 x86-64-v3 指令集时启动失败的问题。
- 在线安装稳定版 Core 时优先选择 `amd64-compatible` 资产，避免在旧 CPU 上再次安装不兼容内核。

## [1.0.0]

### Added

- 首次发布 Clash for fnOS，提供 x86_64 与 ARM64 安装包，以专用应用用户托管 mihomo。
- FPK 按架构内置 MetaCubeX mihomo v1.19.34 Core 与 GPL-3.0 许可证；GeoIP、GeoSite、Country、ASN 和 Smart 模型在首次使用时下载。
- 侧边栏运行状态与右上角启动/停止/重启、规则/全局/直连切换、应用版本/平台/系统代理/增强模式开关；概览、代理、配置、连接、日志、设置六个页面，适配 1100×596 与移动端。
- 代理页分为「代理提供商」和「策略组」两块，提供商来自 `proxy-providers`，显示用量/到期/节点数，支持单独刷新、展开和搜索；概览指标一行三个。
- Core 启动、停止、重启、健康检查、端口冲突提示、崩溃自动重启和 secret 脱敏日志。
- 配置文件编辑、`mihomo -t` 校验、原子保存、最近 10 份备份与恢复/删除；保存前先校验，失败不保存、无变动不新增备份；失败自动回滚配置和 Core；备份支持手动删除。
- HTTPS 订阅管理：掩码、添加后立即下载、手动/定时下载、内容校验、手动应用，拒绝内网/回环地址与超限内容。
- fake-ip / benchmark 保留段 `198.18.0.0/15` 不再视为内网地址，适配宿主机 TUN + fake-ip 的虚拟化测试环境。
- 设置页提供「网络诊断」：检查 allow-lan、bind-address、端口、局域网地址与端口可达性，并给出虚拟机网络、防火墙和宿主机 TUN 干扰的排查提示。
- 设置页新增混合端口、可选 HTTP/SOCKS 端口和允许局域网开关，由应用写入运行时配置并覆盖用户配置中的同名字段。
- 代理页仅在全局模式下显示 mihomo 内置 GLOBAL 组并自动选中；全局出口为 DIRECT 时明确提示，模式切换后回读运行态校验。
- 配置编辑器提示 `external-controller*`、`external-ui*`、`secret`、`log-level`、端口和 allow-lan 由应用接管；`external-ui` 设置被忽略；Controller 固定使用私有 Unix Socket，不监听配置中的 TCP 端口。
- 连接列表不横向滚动，点击行查看详情并在详情内关闭单条连接，工具栏支持刷新和关闭全部。
- NAS 系统代理与增强模式（TUN）开关：按实际状态显示，开启失败提示并回退；系统代理通过受控 helper 修改 `/etc/environment`，TUN 通过配置重启/回滚并检查 TUN 网卡、`/dev/net/tun` 与 `CAP_NET_ADMIN`。
- 服务模式：首次开启系统代理/增强模式时在界面输入管理员密码，密码经 ECDH+AES-GCM 加密通道提交；应用通过 `su` 切换到当前登录管理员并以其 sudo 权限执行一次初始化，自动安装 root 拥有的 helper 并写入窄范围 sudoers；密码不保存、不落日志，之后无需再输。管理服务仍为包用户，Core 启动前对当前二进制设置 `CAP_NET_ADMIN,CAP_NET_RAW+ep`。
- 卸载向导提供“保留数据（默认）/删除全部应用数据”选择，删除操作校验路径并清理配置、订阅、日志与已安装内核。
- GitHub API 限流时改用 releases Atom/资产页面备用来源，下载后计算并记录 SHA256。
- 连接页支持刷新、筛选和关闭单条/全部连接；日志页通过 SSE 实时接收内核与应用日志。
- 设置页管理稳定版、测试版、Smart版内核，支持 SHA256/大小/ELF/版本校验，安装、启用、回滚和删除保护。
- 定时节点测速、可配置测速网址与并发数；统一延迟和 TCP 并发会覆盖配置文件同名字段。
- GitHub 加速地址统一作用于 Core、订阅、更新检查和外部数据；加速地址失败时自动回退直连。
- 外部数据管理 GeoIP、GeoSite、Country、ASN 和 Smart 模型，支持自动更新、间隔、地址编辑和立即同步；GeoIP/GeoSite 首次启动自动下载。
- 停止 Core、停用应用或卸载时恢复系统代理并释放 TUN；启动 Core 时按设置自动恢复系统代理和 TUN。
- x86 与 ARM 安装包只携带目标架构 Core，减小 FPK 体积。
- Controller 仅使用私有 Unix Socket；管理页通过统一网关管理员身份校验，写接口要求 JSON、同源与自定义请求头。
- 适配桌面与窄屏的简体中文界面，固定浅色主题，应用更新提醒。
- 完整本机自动化测试，覆盖版本锁、下载、配置、订阅、进程托管、版本切换、回滚、HTTP API 和 SSE。

### Compatibility

- 依赖飞牛 Node.js 24；管理页仅向管理员开放，管理服务与 Core 以应用包用户运行。
- TUN、NAS 系统代理采用服务模式：管理服务仍为包用户；管理员执行一次 `setup-privileges` 安装窄范围 sudoers，Core 启动前仅对当前二进制设置 `CAP_NET_ADMIN,CAP_NET_RAW`。未初始化时开关会报错并回读实际状态；文件系统不支持 file capabilities 时 TUN 仍会报错并回退。
- 在线 Core 版本检查依赖 GitHub API，未认证请求可能受 IP 限流；内置 Core 与已安装版本的启用/回滚/删除不受影响。
- 具体 fnOS 版本、x86_64/ARM64 实机安装、网关、端口、DNS、IPv6、跨账户权限和资源占用仍需目标 NAS 验收。
