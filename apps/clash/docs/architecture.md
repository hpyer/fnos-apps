# 架构

## 组成

```text
fnOS 桌面 / 统一网关
        │  app.sock (0660) + X-Trim-* 管理员头
Node.js 管理服务（clash_for_fnos）
├── server.mjs           静态页面、REST API、SSE
├── manager.mjs          Core 生命周期、版本槽位、配置应用、订阅调度
├── config-service.mjs   配置备份/校验/原子写入、订阅下载与掩码
├── controller-client.mjs mihomo Controller 客户端（Unix Socket）
├── core-process.mjs     受控子进程与日志转发
├── repository.mjs       渠道/发布资产解析与 SHA256 元数据
├── download.mjs         带重试的校验下载
├── archive.mjs          gzip 解压与 ELF 架构检查
└── log-hub.mjs          日志环形缓冲与 SSE 扇出
        │
mihomo 子进程（当前激活槽位）
├── mixed/http/socks 代理端口
├── external-controller-unix（私有 Socket）
└── 外部数据（GeoIP / GeoSite / Country / ASN / Model）
```

## 进程与生命周期

- `native/cmd/main` 只管理 Node 管理进程，通过 PID 和 `/proc/<pid>/cmdline` 匹配确认身份；`stop` 先发送 SIGTERM，超时后 SIGKILL。卸载/升级前先停止管理服务，管理服务退出时停止 Core。
- `main.mjs` 只接受应用用户运行（非 dev 模式下拒绝 root），从 `TRIM_PKGVAR` 读取私有数据目录，通过 `TRIM_APPDEST/app.sock` 暴露页面。
- `CoreProcess` 使用 `spawn(binary, args, { shell: false })` 启动 mihomo，参数固定为 `-d <runtime> -f <runtime/config.yaml>`。标准输出/错误按行进入日志中心；意外退出时按 `autoRestart` 设置退避重启，最多 5 次，成功启动后计数清零。
- 启动前依次：读取当前 Core 槽位 → 校验文件哈希和 ELF 架构 → 执行 `-v` 版本探测 → 检查代理端口占用 → 写入注入 Controller 的运行时配置 → `mihomo -t` 校验 → 启动并轮询 Controller `/version`（最长 15 秒）。任一步失败都会保留原状态并返回明确错误。
- 概览内存优先读取 Controller `/memory`，不可用时读取 Core 进程 `/proc/<pid>/status` 的 VmRSS，避免只显示“—”。
- 日志中心对 Controller secret、`secret/password/token` 字段和 URL 查询参数脱敏；`logs/manager.log` 达到 2 MiB 时轮转为 `manager.log.1`。生命周期脚本另将管理进程标准输出写入 `logs/stdout.log`，避免与结构化日志并发写同一文件。

## Core 版本槽位

- 应用包内置 `app/cores/x86_64/mihomo.gz` 与 `app/cores/arm64/mihomo.gz`，以及 `app/cores/geo/`。构建脚本按 `core-versions.lock` 下载并校验后写入 FPK，两份架构同时携带，保证任何构建机打出的包都能离线启动。
- 首次启动时按设备架构校验 gzip SHA256、大小、解压后 ELF 架构，释放到 `var/cores/embedded/<version>-<arch>/`，并记录二进制哈希；旧内置版本目录自动清理。
- 用户安装的版本位于 `var/cores/installed/<渠道-版本-架构>/`，`metadata.json` 记录来源、渠道、版本、架构、压缩包与二进制 SHA256、大小、发布时间和许可证。`cores/active.json` 是唯一生效指针，同时记录上一版本供回滚。
- 版本安装是异步任务：下载到 `runtime/staging`。API 条目校验上游 SHA256/大小；GitHub 限流时从 releases Atom/`expanded_assets` 页面取资产，下载后计算 SHA256 并记录为 `verified=false`，再校验 gzip/ELF 并运行 `-v` 识别版本，通过后原子移动到正式目录。同一时刻只允许一个 Core 操作。
- 启用版本：停止旧 Core → `mihomo -t` 校验目标 Core 与当前配置 → 更新指针 → 启动并健康检查；失败恢复旧指针，并在原先运行的情况下重启旧 Core。删除禁止作用于当前版本；内置 Core 由 FPK 管理，不能删除。
- 代理页的「代理提供商」以配置中的 `proxy-providers` 为数据源，节点与 `subscriptionInfo` 通过 Controller `/providers/proxies` 合并；单提供商刷新使用 `PUT /providers/proxies/<name>`。
- `GLOBAL` 是 mihomo 内置 Selector 组，始终存在于 `/proxies` 响应；它只在全局模式下承载流量。界面在规则/直连模式下隐藏该组，切到全局模式时自动选中并显示当前出口，`DIRECT` 出口会明确提示不会经过代理节点。模式切换通过 Controller `PATCH /configs` 即时生效，并回读 `/configs` 校验运行态。

## 配置与订阅

- 用户配置保存在 `config/config.yaml`，写入前执行 `mihomo -t`；保存时先校验、再备份（保留最近 10 份，可手动删除），写入失败或应用失败会回滚配置并恢复原 Core。`external-controller*`、`external-ui*`、`secret`、`log-level`、`mixed-port`、`port`、`socks-port` 和 `allow-lan` 由应用接管并在运行时配置中重写；配置页会列出这些被接管的字段。
- 运行时配置不直接使用用户文件：`yaml.mjs` 只解析顶层字段，删除 `external-controller*`、`external-ui*`、`secret`、`log-level` 以及托管的端口/allow-lan，再追加私有 Unix Socket、随机 secret、日志级别和设置页中的网络参数。JSON 配置同样支持。嵌套结构不做解释，语法语义仍由 `mihomo -t` 判定。
- 订阅支持 HTTP/HTTPS（HTTP 为明文，建议 HTTPS），下载前解析域名并拒绝回环、RFC1918、链路本地和 CGNAT 地址（SSRF 防护），重定向逐跳复核；`198.18.0.0/15`（benchmark/fake-ip 保留段）不视为内网服务。内容上限 8 MiB 且必须是可识别的 Clash 配置。自动更新只下载内容，应用动作由用户确认；下载失败按间隔退避重试（记录 attemptedAt）。
- 配置备份、订阅内容和 Core 元数据均为 `0600`，目录为 `0700`；GeoIP/GeoSite 等外部数据由设置页下载到 `runtime/`；首次启动自动补齐 Core 所需数据。
- 卸载向导 `wizard/uninstall` 提供保留/删除数据单选，默认保留；`uninstall_callback` 仅在用户明确选择删除时清理 `TRIM_PKGVAR`，并校验路径属于本应用。

## 安全边界

- 统一网关注入管理员身份；开发模式只监听回环地址并校验 Host。写操作额外要求 JSON、`X-Fnos-Request: 1` 和同源请求，请求体上限 3 MiB，部分响应限制大小。`GET /api/diagnostics` 只读汇总 Core 状态、allow-lan/bind-address、端口、本机网卡地址和本机到代理端口的 TCP 可达性，用于区分监听、防火墙与虚拟机网络问题。
- Controller 仅使用 Unix Socket，不监听 TCP；即使配置中原本包含 `external-controller: 0.0.0.0:9090` 也会在运行时配置中移除。
- 不实现任意外部命令或路由修改。增强模式改写配置中的 `tun.enable`，通过既有配置校验/重启流程生效，并在重启后检查 TUN 网卡、`/dev/net/tun` 和内核 `CAP_NET_ADMIN`；未检测到网卡则恢复原配置/原 Core 并报错。`curl -x <mixed-port>` 只能验证代理端口，不能验证 TUN。
- NAS 系统代理通过 root 拥有的 `/usr/local/lib/clash-for-fnos/system-proxy` 维护 `/etc/environment` 中的标记块；helper 只接受 `enable|disable` 和 1–65535 端口，直接执行失败时尝试 `sudo -n`（服务模式已初始化后的 NOPASSWD 规则）；首次初始化或需要管理员密码时，通过 `su` 切换到当前登录管理员并执行 `sudo`，helper/脚本必须是 root 拥有或受控的应用初始化脚本，且不可被组/其他用户写入。权限不足、提权失败或回读状态不一致都会返回错误，由界面把开关恢复为实际状态。
- API 来源的 Core 要求 SHA256 与大小一致；备用来源没有上游摘要时明确标记，下载后计算并记录 SHA256，界面安装确认中提示。

## 构建与打包

- `scripts/cores.mjs` 读取 `core-versions.lock`，把 mihomo 压缩包和许可证下载到 `.local/cores/`（git 忽略），校验 SHA256/大小；gzip 完整性、解压大小和 ELF 架构在构建时检查。
- `build.mjs` 复制 `native/`、服务端源码、`@fnos/version-check` 运行代码、内置 Core 资源和浏览器端 esbuild 产物到 `dist/clash-for-fnos`，并写入 `app/version`。
- `pnpm run pack clash --all` 由通用脚本为 x86/arm 分别写 `platform` 并生成 FPK；FPK 的 `manifest`、`package.json` 与 `app/version` 版本必须一致。
- 测试使用 `test/fixtures/fake-core.mjs` 在 macOS/Linux 上模拟 Controller、流量、日志和崩溃，验证完整生命周期；真实 mihomo 只在 fnOS Linux 上运行。

## 已知限制

- 首次启动释放内置 Core 需要约 60 MB 临时磁盘；每个 FPK 只包含目标架构的 Core，GeoIP/GeoSite/ASN/Model 在安装后下载。
- `api.github.com` 未认证请求受 IP 速率限制；内置 Core 和已安装版本不受影响。
- 升级会替换 `app/cores`，但不会删除私有数据；`cores/active.json` 指向已不存在的内置版本时自动回退到新内置版本。
- 应用停止时是否保留资源链接、升级/卸载清理顺序、端口占用、跨账户访问和资源占用必须在 x86_64、ARM64 实机验收。
