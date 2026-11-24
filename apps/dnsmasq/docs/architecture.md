# Dnsmasq for fnOS 架构

## 边界

管理服务运行在 package 用户下，通过 Unix socket 提供 fnOS 网关界面；dnsmasq 作为同一 package 用户的受控子进程运行。只有绑定低端口所需的 `CAP_NET_BIND_SERVICE` 由应用专属 root helper 设置。应用不提供 DHCP，不修改默认路由、NAT 或 `/etc/resolv.conf`。可选的 NAS hosts 同步只维护 `/etc/hosts` 标记块，不接管系统 DNS。

Socket 模式下管理服务只信任飞牛网关注入的 `x-trim-userid` 与 `x-trim-isadmin` 请求头；只有未设置 `TRIM_APPDEST` 的本机开发模式才按回环 Host 校验，避免把网关请求误判为非管理员。管理员授权请求优先使用网关注入的 `x-trim-username`（权威登录名），仅当它缺失或不是可用的 Linux 账户名时才按 UID 查询 `/etc/passwd`，用于一次 `su` 提权。

## 运行时与版本

`core-versions.lock` 固定 dnsmasq 版本、源码地址与校验值、许可证，以及 x86_64/arm64 运行时资产的大小、SHA-256 和 ELF 架构。`pnpm run build dnsmasq` 通过 `scripts/runtime.mjs` 优先复用 `.local/runtime/` 缓存，否则从固定 Release 下载并校验后写入 `app/bin/dnsmasq` 和 `app/bin/COPYING-dnsmasq`，同时生成 `app/dnsmasq-version`。该 Release 是构建依赖，必须保留；资产被删除时构建会因 HTTP 404 失败。`DNSMASQ_BINARY` 覆盖同样要通过锁文件校验，避免把 Ubuntu 24.04（glibc 2.39）构建的二进制打进 Debian 12 的 fnOS 包。

概览页显示 `dnsmasq <版本>`：服务未运行时使用打包时写入的版本，运行后以启动横幅中的实际版本为准；诊断中同时显示版本和二进制路径。

## 配置模型

`state.json` 保存监听地址、上游 DNS、缓存大小、查询日志和自动启动选项；`records.json` 保存精确记录和后缀记录。管理服务校验所有 IP、域名和记录类型后，以临时文件加 rename 的方式生成 `runtime/dnsmasq.conf`。启动前调用 `dnsmasq --test`，校验通过才启动前台进程。

生成的配置固定包含 `no-resolv`、`bind-interfaces`、`log-facility=-` 和运行目录内的 `pid-file`。`--log-facility=-` 让 dnsmasq 把普通日志和开启后的查询日志写到 stderr，由管理服务收集到 `logs/dnsmasq.log`；这避免了 `--no-daemon` 调试模式强制记录全部查询。进程以 `--keep-in-foreground` 运行，不 fork，也不会切换到其他运行用户。

## 提权

`native/app/bin/setup-privileges` 安装 root 拥有的 helper 和最小 sudoers 规则；`hosts-sync` 只接受应用数据目录内的 hosts 片段；`dnsmasq-caps` 只接受本应用安装目录中的 dnsmasq 二进制，并对路径做 `readlink -f` 规范化后校验。校验覆盖 `/var/apps/dnsmasq-for-fnos/target`、`/vol*/@appcenter/dnsmasq-for-fnos` 及其历史 `target`/`@appdata` 布局。helper 文件必须 root 拥有且不可被组/其他用户写入。

初始化有两条路径：

1. 安装或升级脚本以 root 执行时，复制 helper、安装 sudoers 并立即设置能力。
2. fnOS 以应用用户执行生命周期脚本时，首次启动因缺少能力而失败；界面提示输入一次 NAS 管理员密码，经 ECDH 加密提交后由管理服务以登录管理员身份执行 `setup-privileges`，再通过 NOPASSWD sudo 规则应用能力。密码只在本次授权中使用。首次开启 hosts 同步时也复用这套授权，sudoers 仅增加 `hosts-sync apply <应用片段>` 和 `hosts-sync remove`。

升级替换二进制会丢失文件能力。`upgrade_callback` 在 root 下重新设置；管理服务在每次启动前也会检查 helper 是否存在并重新应用能力，因此升级后通常无需再次授权。文件系统挂载为 `nosuid` 时内核会忽略文件能力，这种情况需要真机确认，诊断会保留 dnsmasq 的原始 stderr。

## NAS hosts 同步

`hostsSync` 默认关闭。开启时，管理服务按记录生成 `runtime/hosts.snippet`：精确记录和后缀记录都按「地址 域名」输出，后缀记录只输出域名本身，因为 `/etc/hosts` 不支持通配符。root helper `hosts-sync` 接收该文件路径，校验路径只允许应用数据目录内的 `runtime/hosts.snippet`，再按行校验 IP 和域名格式后，用带标记的块替换 `/etc/hosts` 中旧块。

更新使用同目录临时文件加 rename；目标文件被 bind mount 时退化为原地覆盖。关闭开关或卸载时只移除标记块，保留 `/etc/hosts` 其他内容。该功能不修改 `resolv.conf`、系统 DNS、Clash TUN 或 Clash 自己的 DNS 配置；它只影响 fnOS 本机的 NSS 解析，容器内的 `/etc/hosts` 不受影响。后缀记录无法匹配未列出的子域名，这是 hosts 格式本身的限制。

## 启动失败诊断

管理服务等待 dnsmasq 输出启动标记，并保留最近的 stderr。启动失败时按错误内容转换为可操作提示：缺少 `CAP_NET_BIND_SERVICE`、53 端口被占用、监听地址不属于本机，或其他带原始输出的失败原因。退出码不再直接作为用户可见错误。

## 卸载

向导字段统一为 `wizard_delete_data`，默认 `keep`。删除回调只接受应用专属数据目录的规范化路径；未知值、缺失值、符号链接越界或重复回调都按保留处理。`uninstall_init` 会先移除 `/etc/hosts` 中的应用标记块，再清理 helper 和 sudoers；hosts 块不算应用数据，不随「保留数据」保留。
