# Dnsmasq for fnOS

这是一个 DNS-only 应用：使用固定 53 端口，提供 DNS 缓存、显式上游 DNS 和自定义解析记录，不配置 DHCP、路由、NAT，也不改写系统 `resolv.conf`。安装时不询问端口，53 端口不可修改。

如果希望 NAS 本机也解析部分自定义域名，可以在设置中开启「把解析记录同步到 NAS 的 hosts」。该功能只写 `/etc/hosts` 的标记块，不切换系统 DNS，不影响 Clash 的 TUN、系统代理或它自己的 DNS；详见下文。

应用窗口包含三个页面：

- **概览**：查看服务状态、dnsmasq 版本、监听地址、上游 DNS、缓存大小和解析记录数量，并提供启动、重启、停止操作。
- **设置**：编辑监听地址、上游 DNS、缓存大小、查询日志和自动启动；可选把解析记录同步到 NAS 的 hosts。
- **解析记录**：新增或删除精确记录和后缀记录。

诊断收在概览中，默认只显示「运行诊断」按钮；展开后显示运行权限、53 端口能力、NAS hosts 状态、二进制、运行平台、生成的配置和最近日志。

## NAS 本机 hosts 同步

设置页的「把解析记录同步到 NAS 的 hosts」默认关闭。开启后，应用通过 root helper 把记录写入 `/etc/hosts` 中带标记的块，NAS 上的系统程序、服务和其他应用即可通过本机 NSS 解析这些名字；不会修改 `resolv.conf`，也不会把系统 DNS 指向 dnsmasq。

- **精确记录**按「IP 域名」逐条写入，支持 IPv4、IPv6 和同一域名的多个地址。
- **后缀记录**只能写入域名本身（例如 `lan.home.arpa`）。`/etc/hosts` 没有通配符语法，`*.lan.home.arpa` 以及未单独列出的子域名不会被匹配；需要这些子域名时请再添加精确记录。
- 修改或删除记录后会自动重新生成 hosts 块；关闭开关会移除标记块，恢复 `/etc/hosts` 其他内容。
- 卸载应用时会移除该标记块，即使选择保留应用数据。
- 容器内的 `/etc/hosts` 是容器自己的文件，不会被此功能修改；该功能只影响 fnOS 本机。
- 对使用了 Clash 的设备，hosts 命中发生在系统解析层，Clash 的 DNS/TUN 不会被改写；这些域名会直接使用你配置的地址，不再走 Clash 的域名分流。

如果确实需要 NAS 本机使用完整的后缀 DNS 行为（缓存、上游转发和通配符），只能把系统 DNS 指向本应用，但那会改变 `resolv.conf` 并与 Clash TUN/DNS 产生交互，本应用默认不做这件事。

## 首次运行权限

dnsmasq 以应用包用户运行，绑定 53 端口需要 `CAP_NET_BIND_SERVICE` 文件能力。安装脚本在具备 root 权限时会自动准备 root helper 并授予该能力；如果 fnOS 以应用用户执行安装脚本，首次启动会提示输入一次 NAS 管理员密码完成初始化。

- 管理员密码通过临时 ECDH 信道加密提交，只用于本次 `su`/`sudo` 提权，不保存、不写入日志。
- 初始化后，root helper 位于 `/usr/local/lib/dnsmasq-for-fnos`，sudoers 只允许应用用户执行 `dnsmasq-caps apply`。
- 应用启动或重启时如果发现能力丢失（例如升级替换了二进制），会通过该 sudo 规则自动重新设置，无需再次输入密码。
- 详细权限边界见 [架构说明](docs/architecture.md) 和仓库的[提权与系统集成踩坑](../../docs/privilege-and-pitfalls.md)。

## 构建

`pnpm run build dnsmasq` 会从 `core-versions.lock` 记录的运行时 Release 下载 Debian 12 构建的 dnsmasq 2.93（按构建机架构选择 x86_64 或 arm64），校验大小、SHA-256 和 ELF 架构后打入 FPK；下载内容缓存于 `.local/runtime/`。

- 运行时必须在 Debian 12（glibc 2.36）构建。Ubuntu 24.04 编译出的二进制要求 `GLIBC_2.38`，在 fnOS 上会报 `GLIBC_2.38 not found`，不能用于发布。
- 需要验证自定义构建时，使用 `DNSMASQ_BINARY=/path/to/dnsmasq pnpm run build dnsmasq`；该二进制仍须匹配锁文件记录的 SHA-256 和目标架构，否则构建失败。
- 更新 dnsmasq 版本时，先运行 `node apps/dnsmasq/scripts/build-dnsmasq.mjs <arch>` 生成运行时，再把产物、许可证和校验值发布到 `dnsmasq-runtime-<version>` Release 并更新 `core-versions.lock`。运行时 Release 的 tag 不要包含 `/v`，避免被应用发布 workflow 匹配。

本机开发使用 `pnpm run dev dnsmasq`，开发脚本会先打包页面资源（页面依赖公共凭据客户端），再启动管理服务。

## 数据与卸载

持久化数据位于 `${TRIM_PKGVAR}`：`state.json`、`records.json`、`runtime/dnsmasq.conf`、`runtime/dnsmasq.pid`、`runtime/hosts.snippet` 和 `logs/`。卸载默认保留这些数据；只有卸载向导明确选择「删除全部应用数据」时才删除应用专属数据目录。`/etc/hosts` 中的应用标记块属于系统集成，卸载时会无条件移除；其他应用、共享目录和系统 DNS 配置不在清理范围内。

## 验证范围

本机测试不等同于 fnOS 验收。真机至少需要验证 53 端口绑定、首次管理员授权、helper 路径与 sudoers、启动/停止/升级、配置回滚、局域网客户端查询、hosts 同步与 Clash 共存，以及卸载保留/删除两条路径。验收清单见 [docs/acceptance.md](docs/acceptance.md)。
