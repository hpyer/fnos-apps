# Clash for fnOS

fnOS 原生的 mihomo 托管应用。管理服务、Core 和订阅任务均以专用 `clash_for_fnos` 包用户运行；内置 x86_64 与 ARM64 的 MetaCubeX mihomo 稳定版 Core。系统代理和增强模式（TUN）通过一次受控的管理员授权准备 root helper，之后管理服务仍保持非 root。

应用面向 fnOS 管理员提供概览、代理提供商与策略组、配置和订阅、连接、日志、外部数据、Core 版本管理，以及系统代理和 TUN 控制。

## 功能概览

- **概览**：实时上下行速率、累计流量、内存、连接数、运行时长、监听端口；当前策略组快捷切换与一键测速；模拟第三方应用的网址连通性测试。
- **代理**：按配置中的 `proxy-providers` 展示提供商、用量、到期时间、节点数并支持展开和单独刷新；策略组展开、切换出口、搜索和批量测速。
- **配置**：粘贴/导入 Clash YAML，保存前执行 `mihomo -t` 校验；失败自动回滚。支持 HTTPS 订阅、手动应用、定时下载和配置备份。
- **连接与日志**：查看活动连接、关闭单条或全部连接；日志通过 SSE 实时推送，敏感字段自动脱敏。
- **设置**：混合/HTTP/SOCKS 端口、allow-lan、自动启动、崩溃自动重启、系统代理、TUN、定时测速、统一延迟、TCP 并发、GitHub 加速、日志级别和 Core 渠道。
- **外部数据**：GeoIP、GeoSite、Country MMDB、ASN 和 Smart 模型（Model.bin）的下载、自动更新、地址编辑和立即同步。
- **Core 版本**：稳定版、测试版、Smart 版；支持检查、安装、启用、回滚和删除，安装前后均校验摘要/架构/版本。

## 安装与首次使用

1. 安装对应架构的 FPK。应用依赖飞牛 Node.js 24；管理页面通过统一网关仅向管理员开放。
2. 首次打开时应用会选中内置 mihomo 并自动启动 Core（可在设置中关闭自动启动）。
3. 首次启动 Core 或保存配置时，应用会检查 GeoIP / GeoSite 数据；缺失时通过当前 GitHub 加速地址自动下载。Smart 渠道还会自动准备 `Model.bin`。
4. 首次使用系统代理或增强模式时，界面会弹出管理员密码框。密码经 ECDH(P-256) + AES-GCM 加密通道提交，应用通过 `su` 切换到当前登录的 fnOS 管理员，再用其 sudo 权限完成一次性 helper 初始化。
5. 初始化完成后，管理服务仍是包用户；helper 位于 `/usr/local/lib/clash-for-fnos`，sudoers 规则只允许包用户执行受限 helper。

也可以手工完成一次服务模式初始化（仅在信任该安装包时）：

```sh
sudo install -d -m 0755 -o root -g root /usr/local/lib/clash-for-fnos
sudo install -m 0755 -o root -g root /vol1/@appcenter/clash-for-fnos/target/bin/setup-privileges /usr/local/lib/clash-for-fnos/setup-privileges
sudo /usr/local/lib/clash-for-fnos/setup-privileges /vol1/@appcenter/clash-for-fnos/target
```

如果实际安装路径是 `/var/apps/clash-for-fnos/target` 或其它卷下的 `@appdata` 路径，请把上面的 target 路径替换为实际值。不要直接 `sudo` 执行应用目录中由包用户拥有的脚本。

## 界面与适配

- 主要界面按 fnOS PC 窗口 `1100 × 640`（内容可视约 `1100 × 596`）设计；概览使用三列指标。
- 移动端使用底部状态/模式/导航布局，表格和表单按窄屏收敛。
- 应用主体不重复显示 fnOS 窗口已有的应用图标和标题。
- 「设置」页的“外部数据”、诊断和 Core 版本区域较长，按正常页面滚动使用。

## 使用说明

### 概览

- 顶部指标每 2 秒刷新一次。
- 「当前代理组」可直接切换规则模式下的出口；「一键测速」会更新所有节点延迟。
- 「连通性测试」把输入 URL 当作支持系统代理的第三方应用执行：
  - 系统代理开启时通过 `127.0.0.1:<mixed-port>` 访问；
  - 系统代理关闭时直连；
  - 默认地址为 `https://www.google.com`。
- TUN 开启后，应用进程自身 UID 被 TUN 排除，直连测试会显示“跳过”；此时请在终端用 `curl` 验证 TUN。

### 代理

- 提供商来自配置 `proxy-providers`；点击提供商可展开全部节点。
- 策略组列表支持搜索、展开、切换出口和单独测速。
- 左侧状态框下方可切换规则/全局/直连。全局模式全部流量走 GLOBAL 组；若 GLOBAL 指向 DIRECT，则不会经过代理节点。
- 延迟测试使用设置页中的测速网址和并发数。

### 配置与订阅

- 配置保存前先执行 `mihomo -t`，通过后备份旧配置、写入新配置并重启 Core；校验或启动失败会自动恢复。
- 订阅必须使用 HTTPS，默认拒绝回环、RFC1918、链路本地和 CGNAT 地址，防止 SSRF；内容上限 8 MiB，配置上限 2 MiB。
- 订阅添加时立即下载一次；自动更新只下载内容，不自动替换当前配置，需要手动「应用」。
- 订阅地址在界面中只显示掩码。

### 设置

- **端口**：混合端口必填，HTTP/SOCKS 可设为 `0` 关闭；端口和 `allow-lan` 由应用接管，写入运行时配置时覆盖配置文件中的同名字段。
- **定时测速**：间隔 `0` 表示关闭，默认 30 分钟；测速网址可修改；并发数限制 1–20。
- **统一延迟测速**：对应 mihomo `unified-delay`。
- **TCP 并发连接**：对应 mihomo `tcp-concurrent`。
- **GitHub 加速**：默认 `https://ghfast.top/`，保存后对所有 GitHub 资源请求生效；留空则直连。加速地址失败时自动回退直连。
- **日志级别**和**更新渠道**：日志级别同时影响 Core 与界面；渠道包括稳定版、测试版和 Smart 版。

### 外部数据

| 数据 | 文件 | 默认来源 |
|---|---|---|
| GeoIP | `geoip.dat` | `MetaCubeX/meta-rules-dat` release |
| GeoSite | `geosite.dat` | 同上 |
| Country MMDB | `country.mmdb` | 同上 |
| ASN | `GeoLite2-ASN.mmdb` | 同上 |
| Smart 模型 | `Model.bin` | `vernesong/mihomo` 的 `LightGBM-Model` release |

- GeoIP / GeoSite 不随 FPK 内置；首次启动或保存配置时会自动补齐。
- Country、ASN、Smart 模型按需下载。
- 自动更新可设置间隔（小时）；每项可单独编辑更新地址和立即同步。
- Smart 模型支持标准、中等、大型三个版本，对应 `Model.bin`、`Model-middle.bin`、`Model-large.bin`，下载后统一保存为 `Model.bin`。
- 同步完成且 Core 正在运行时，应用会自动重启 Core 以加载新数据。

### 系统代理与增强模式

- **系统代理**维护 `/etc/environment` 中的 `http_proxy`/`https_proxy`/`all_proxy` 标记块，只影响之后登录的会话，不改变当前 shell、已运行服务或容器。
- **增强模式**对应 `tun.enable`；开启时实际检查 TUN 网卡、`/dev/net/tun` 和 Core 的 `CAP_NET_ADMIN`，未生效会回滚配置和 Core。
- 停止 Core 时会移除系统代理标记块，TUN 网卡和路由随 Core 停止释放；设置页中的开关状态保留。再次启动 Core 时会按设置自动恢复。
- 停用应用或卸载时也会清理系统代理；TUN 随 Core 停止而消失，不会残留影响 NAS 网络。
- 系统代理不是透明代理。要使直接 `curl` 也走代理，需要使用增强模式（TUN）。

验证 TUN 时请使用：

```sh
curl -I https://www.google.com
curl -I https://1.1.1.1
```

不要用 `ping` 作为判断依据：fnOS 普通登录用户通常没有 `CAP_NET_RAW`，`ping` 会因 raw socket 权限失败，与 TUN 是否生效无关。

### Core 版本

- 支持 MetaCubeX 稳定版、`Prerelease-Alpha` 测试版和 `vernesong/mihomo` Smart 版。
- 在线安装需要 GitHub API 提供的 SHA-256 和大小；API 限流时使用 releases Atom/资产页面，下载后计算 SHA-256、校验 gzip、ELF 架构和版本输出。
- 启用前重新校验文件哈希和配置；失败恢复旧版本和旧配置。

## 配置托管字段

以下字段由应用接管，写入运行时配置时会覆盖用户配置中的值：

- `external-controller` / `external-controller-*`
- `secret`
- `log-level`
- `mixed-port` / `port` / `socks-port` / `allow-lan`
- `external-ui` / `external-ui-url` / `external-ui-name`（忽略）
- `unified-delay` / `tcp-concurrent`

Controller 只监听私有 Unix Socket `${TRIM_PKGVAR}/runtime/controller.sock`，不开放 TCP Controller 端口。

## 安全说明

- 订阅地址必须为 HTTPS；下载前解析域名并拒绝回环、内网、链路本地和 CGNAT 地址。
- Controller secret、订阅地址和敏感日志字段不会返回给前端；订阅地址在界面中掩码显示。
- 管理员密码只在内存中用于一次 sudo 认证，不保存、不写入日志；提交使用 ECDH + AES-GCM 加密通道。
- 服务模式 helper 必须由 root 拥有且不可被其他用户写入；应用目录中的同名脚本只作为安装源，不会通过 sudo 执行。
- TUN 只对当前生效的 Core 二进制设置 `CAP_NET_ADMIN,CAP_NET_RAW`；不会修改其他程序。
- 若 Core 所在文件系统为 `nosuid`，file capabilities 会被忽略，TUN 无法工作；网络诊断会提示挂载参数。

## 服务模式权限

初始化后，`/etc/sudoers.d/clash-for-fnos` 只允许包用户执行 `/usr/local/lib/clash-for-fnos` 中的：

- `system-proxy enable|disable <port>`
- `core-caps apply <data-dir> [<core>]`

helper 安装目录必须由 root 拥有且不可被组/其他用户写入。

## 数据目录

运行数据位于 `${TRIM_PKGVAR}`（通常是 `/vol*/@appdata/clash-for-fnos` 或 `/var/apps/clash-for-fnos/var`）：

```text
var/
├── state.json              # 运行设置、外部数据地址与 Controller secret（0600）
├── config/config.yaml      # 当前托管配置
├── config/meta.json        # 配置来源与更新时间
├── backups/                # 最近 10 份配置备份
├── subscriptions.json      # 订阅元数据（0600）
├── subscriptions/          # 已下载的订阅内容
├── cores/embedded/         # 从 FPK 释放的内置 Core
├── cores/installed/        # 已安装 Core 版本
├── runtime/                # Controller Socket、运行配置、外部数据、暂存目录
├── logs/manager.log        # 应用与 Core 结构化日志（脱敏、轮转）
└── logs/stdout.log         # 管理进程标准输出
```

不要手工编辑 `runtime/` 和 `cores/` 内的文件；配置和订阅请通过管理页修改。

## 卸载与数据

卸载时应用中心提供数据选择：

- **保留配置、订阅、日志和已安装内核（默认）**：只删除应用运行文件，保留应用数据目录。
- **删除全部应用数据（不可恢复）**：`uninstall_callback` 校验目标路径确实属于本应用后，删除配置、订阅、日志、外部数据和已安装 Core。

卸载前会清理系统代理标记块并停止 Core；TUN 随 Core 停止释放。具备 root 权限时，卸载脚本还会移除 `/etc/sudoers.d/clash-for-fnos` 和 `/usr/local/lib/clash-for-fnos`。

## 开发与验证

```sh
pnpm install
pnpm run dev clash
pnpm test
pnpm run build clash
pnpm run pack clash --all
```

本机预览地址为 `http://127.0.0.1:3085/app/clash-for-fnos/`。macOS 只能预览界面和配置编辑；启动 Core、订阅更新、端口冲突等与 Linux 二进制相关的路径必须在 fnOS 上验证。

构建需要访问 GitHub 下载锁定的 Core，缓存位于 `apps/clash/.local/cores/`（已忽略提交）。`pnpm run pack clash --all` 生成 x86 与 arm 两个 FPK；每个包只携带对应架构的 Core（x86 约 22 MB、ARM 约 20 MB），不包含其它架构内核和 GeoIP/GeoSite/ASN/Model 数据。

见 [架构](docs/architecture.md) 和 [验收清单](docs/acceptance.md)。License：应用代码随仓库发布；内置 mihomo 为 GPL-3.0，许可证随 FPK 的 `app/cores/` 分发，版本与 SHA-256 记录在 `core-versions.lock`。
