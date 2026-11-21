# fnOS 应用提权与开发踩坑

本文总结 Clash for fnOS 开发过程中遇到的提权、系统集成和打包问题。重点不是 Clash 的业务逻辑，而是**任何需要修改系统状态的 fnOS 应用**都可能复用的经验。

Clash 的具体实现可参考：

- 包用户与 Core：`apps/clash/native/config/privilege`、`apps/clash/src/manager.mjs`
- root helper：`apps/clash/native/app/bin/setup-privileges`、`core-caps`、`system-proxy`
- 公共提权传输：`packages/privilege/src/broker.mjs`、`credential.mjs`、`client.mjs`
- 架构与生命周期：[apps/clash/docs/architecture.md](../apps/clash/docs/architecture.md)

公共组件只负责提权通道、凭据保护、helper 权限检查和 capability 调用。每个应用仍必须提供独立的 root-owned helper、sudoers 文件、参数校验和应用专属路径策略；不得把公共组件当作任意 root 命令执行器。

## 1. 提权模型：应用保持非 root

### 原则

应用主体、Node 管理服务和业务子进程都应以应用包用户运行，例如 `run-as: package`。只有**范围极小、参数受控**的 helper 允许以 root 执行。

不要把整个应用改成 `run-as: root`，也不要给应用目录中的脚本设置 setuid。那样会让应用目录、日志、订阅内容或 Web 请求中的任意缺陷直接变成 root 权限问题。

### Clash 的模型

```text
管理员在界面输入密码
  -> 服务端用 ECDH + AES-GCM 解出密码
  -> su 当前登录管理员
  -> sudo 执行一次 root 拥有的 setup-privileges
  -> 安装 /usr/local/lib/clash-for-fnos/{system-proxy,core-caps}
  -> 写入 /etc/sudoers.d/clash-for-fnos
  -> 后续包用户只通过 sudo -n 调用这两个 helper
```

关键点：

- `setup-privileges` 只负责安装 helper 和 sudoers，不提供任意命令执行。
- helper 只接受固定子命令和受校验的参数。
- 管理服务始终保持包用户，不具备 root 身份。
- 首次初始化完成后，日常操作不再需要管理员密码。

### 踩坑：直接 `sudo` 应用目录里的脚本

应用目录由包用户拥有，包用户可以在里面替换脚本。如果 sudoers 允许执行这个路径，就等于允许包用户获得任意 root 权限。

正确做法：

1. 管理员先把初始化脚本复制到 root 拥有的固定目录。
2. 初始化脚本再安装 root 拥有的 helper。
3. sudoers 只允许执行 root 目录中的 helper。
4. helper 安装完成后校验 owner 和 mode，不能只看“是否可执行”。

Clash 的手工引导命令如下，路径要按实际安装目录替换：

```sh
sudo install -d -m 0755 -o root -g root /usr/local/lib/clash-for-fnos
sudo install -m 0755 -o root -g root \
  /vol1/@appcenter/clash-for-fnos/target/bin/setup-privileges \
  /usr/local/lib/clash-for-fnos/setup-privileges
sudo /usr/local/lib/clash-for-fnos/setup-privileges \
  /vol1/@appcenter/clash-for-fnos/target
```

### 踩坑：helper 只改了权限，没有改 owner

`chmod 0755` 不会改变文件所有者。如果 helper 仍属于包用户，包用户可以替换内容，再借 sudoers 执行。

安装 helper 时必须使用类似：

```sh
install -m 0755 -o root -g root "$SRC/system-proxy" "$INSTALL_DIR/system-proxy"
```

并在安装后检查：

```sh
[ "$(stat -c '%u' "$file")" = 0 ]
[ $((0$(stat -c '%a' "$file") & 022)) -eq 0 ]
```

目录 `/usr/local/lib/<app>` 也必须是 root 拥有、不可被组或其他用户写入。

## 2. 密码提交与 sudo

### 踩坑：fnOS 管理页是 HTTP，WebCrypto 不可用

在普通 HTTP 页面中，`window.crypto.subtle` 可能不存在，不能假设浏览器提供 WebCrypto。Clash 改用纯 JavaScript 的 `@noble/curves`、`@noble/hashes` 和 `@noble/ciphers` 完成 ECDH + AES-GCM。

同时注意：

- 公钥可能是压缩的 33 字节点，也可能是未压缩点；服务端要统一转换。
- base64/base64url 要做规范化，否则会出现 “string to be decoded is not correctly encoded”。
- 凭据公钥只在需要提权时获取，失败后要允许重新获取。
- 密码只在内存中短暂存在，不写 state、不写日志、不放进 URL 或命令行参数。

### 踩坑：用 shell 拼接密码

不要执行：

```sh
echo "$PASSWORD" | sudo -S ...
```

或把密码放进命令参数。密码会出现在进程列表、shell 历史或错误输出中。

应使用参数数组和 stdin：

```js
run('sudo', ['-S', '-p', '', helper, ...args], { input: `${password}\n` });
```

sudoers 中为应用用户加 `!requiretty`，并为每个 helper 单独授权。写入前用 `visudo -cf` 校验，安装为 `0440`。

### 踩坑：sudoers 通配符过宽

sudoers 的 `*` 不是参数级安全边界。可以写：

```text
clash_for_fnos ALL=(root) NOPASSWD: \
  /usr/local/lib/clash-for-fnos/system-proxy enable *, \
  /usr/local/lib/clash-for-fnos/system-proxy disable *, \
  /usr/local/lib/clash-for-fnos/core-caps apply * *
```

但 helper 仍必须自己校验：

- 端口必须是 1–65535 的数字。
- 数据目录必须是本应用允许的路径。
- Core 路径必须位于本应用的 `cores/embedded` 或 `cores/installed` 下。
- 拒绝符号链接逃逸和 `..` 路径。

不能因为 sudoers 只允许某个脚本，就信任脚本收到的所有参数。

### 踩坑：提权失败被 UI 静默吞掉

Clash 的 `privilegedAct` 第一次探测会静默处理“需要提权”，避免用户还没输入密码就看到错误。但**输入密码后的重试不能继续静默**，否则密码错误时接口已经返回“管理员密码不正确，提权失败”，界面却没有任何提示。

通用做法：

- 第一次无密码探测可以静默。
- 密码提交后的失败必须显示接口错误。
- 成功提示和错误提示分开控制，不要用一个 `silent` 同时关闭两者。
- 提权失败后回读实际状态，把开关恢复为真实值。

## 3. helper 与系统路径

### 踩坑：安装路径不是固定值

fnOS 在不同版本/部署方式下可能出现：

- `/vol1/@appcenter/<app>/target`
- `/var/apps/<app>/target`
- `/vol*/@appdata/<app>/...`

不要在 helper 里只接受一个硬编码路径。Clash 同时接受 appcenter、`@appdata` 和 `/var/apps` 路径，并通过脚本自身目录、`APP_DEST/bin`、`APP_DEST/app/bin` 和有限深度查找定位 helper 源文件。

路径校验要使用规范化后的真实路径，不能只做字符串前缀判断，否则 `..` 或符号链接可能逃逸。

### 踩坑：生命周期脚本找不到 helper

安装/升级后目录布局可能变化。helper 查找顺序应覆盖：

1. 初始化脚本自身所在目录。
2. 应用 target 的 `bin/`。
3. 应用 target 的 `app/bin/`。
4. 受限的 `find` 兜底。

不要从当前工作目录推断应用目录。

### 踩坑：升级时 helper 丢失或被覆盖

应用升级会替换 `target`，但 root helper 在 `/usr/local/lib` 下，应保持独立。升级后：

- 重新校验 helper 是否存在、owner 是否为 root。
- 不要因为应用目录更新就删除 sudoers 和 helper。
- 卸载时才按顺序清理：先恢复系统代理，再移除 helper/sudoers。

## 4. TUN 与 Linux capabilities

### 踩坑：把 Core 整个跑成 root

TUN 需要 `CAP_NET_ADMIN`，但不需要把 mihomo 变成 root 进程。Clash 的 `core-caps` 只对当前 Core 二进制设置：

```sh
setcap cap_net_admin,cap_net_raw+ep <core>
```

注意：

- `setcap` 经常不在默认 `PATH`，要查找 `/usr/sbin/setcap`、`/sbin/setcap` 等路径。
- 文件系统挂载为 `nosuid` 时，file capabilities 会被忽略，TUN 仍然失败。
- 每次安装、切换、重新释放 Core 后都要重新设置 capabilities；替换二进制会丢失 capabilities。
- Core 路径必须由 helper 校验，不能接受任意用户路径。

### 踩坑：TUN 开启后 DNS/网络反而坏了

Clash 曾经出现 TUN 开启后 `SSL_ERROR_SYSCALL`、`Could not resolve host`。根因不是 TUN 网卡没建，而是 Core 自己的出站流量又被 TUN 抓回去，形成回环。

需要同时处理：

- 通过 `tun.exclude-uid` 排除应用包用户 UID。
- 固定 `interface-name` 为实际上行网卡。
- 设置 `tun.auto-detect-interface: false`，避免自动探测选错接口。
- 使用系统 DNS 或显式配置 DNS，配合 `dns-hijack`。
- 开启后实际检查 TUN 网卡、`/dev/net/tun` 和 `CAP_NET_ADMIN`，不能只看配置写入成功。

### 踩坑：用 `ping` 验证 TUN

普通 fnOS 登录用户通常没有 `CAP_NET_RAW`，`ping` 可能因 raw socket 权限失败。这个失败与 TUN 是否接管无关。

应使用：

```sh
curl -I https://www.google.com
curl -I https://1.1.1.1
ip link show Meta
```

`curl -x http://127.0.0.1:7890` 只能验证 mixed-port，不能验证 TUN。

## 5. 系统级状态：系统代理

### 踩坑：把“系统代理”当成透明代理

`/etc/environment` 中的 `http_proxy`/`https_proxy` 只影响之后启动、读取环境变量的进程和新登录会话。当前 shell、已运行的服务、容器和直接 socket 不受影响。

需要透明接管时使用 TUN，不要承诺系统代理能覆盖所有流量。

### 踩坑：改写 `/etc/environment` 时破坏用户内容

不要直接覆盖整个文件。Clash 的 helper 只维护标记块：

```text
# clash-for-fnos proxy begin
http_proxy=...
https_proxy=...
all_proxy=...
no_proxy=...
# clash-for-fnos proxy end
```

写入时：

- 先删除旧标记块，再追加新块。
- 保留标记块之外的所有内容。
- 使用临时文件 + `chmod 0644` + 原子 `mv`。
- 处理 `mktemp` 失败、文件不存在和重复 enable/disable。
- disable 不需要端口，不能因为没有端口就跳过清理。

### 踩坑：停止内核后系统代理还留着

代理已经指向一个停止的端口，会让后续登录会话网络不可用。

Clash 把“设置状态”和“实际状态”分开：

- 用户开启系统代理后，记录 desired 状态。
- 停止 Core、停用应用、卸载应用时移除 `/etc/environment` 标记块。
- 再次启动 Core 时，如果 desired 为开启，自动重新写入。
- 界面在 Core 停止时显示“已设置，启动 Core 后自动开启”，而不是假装代理已生效。

清理顺序很重要：

1. 停止 Core。
2. 恢复系统代理。
3. 停止管理进程。
4. 卸载时在移除 helper/sudoers 之前执行代理清理。

`cmd/main stop` 和 `uninstall_init` 都应有兜底清理，不能只依赖管理进程优雅退出。

## 6. 应用生命周期与安装包

### 踩坑：卸载后残留系统状态

卸载时不仅要删应用数据，还要考虑：

- 系统代理标记块。
- sudoers 文件和 root helper。
- TUN 网卡是否随 Core 进程退出。
- 应用数据保留/删除选项。

Clash 的顺序是：

- `uninstall_init` 先用 root helper disable 系统代理。
- 停止管理进程和 Core，TUN 随进程释放。
- 具备 root 权限时移除 sudoers/helper。
- `uninstall_callback` 只在用户明确选择删除数据时清理应用专属目录。

不要把“卸载脚本被调用”等同于“无条件删除所有数据”。

### 踩坑：Linux 架构不是只有 x86_64

x86_64 还分 x86-64-v2/v3 等微架构。MetaCubeX mihomo 的标准 `amd64` 资产要求 x86-64-v3，较老的 NAS CPU 会报：

```text
This program can only be run on AMD64 processors with v3 microarchitecture support.
```

Clash 的修正：

- 内置 x86 Core 使用 `amd64-compatible` 资产。
- 在线稳定版优先选择 `mihomo-linux-amd64-compatible-*.gz`。
- API 不可用时的备用资产列表也使用 compatible 名称。
- ARM64 保持标准 arm64 资产。

同类应用如果要分发预编译二进制，应明确目标 CPU 基线，并准备 compatible/legacy 版本。

### 踩坑：每个架构的 FPK 都塞两套 Core

如果构建目录同时包含 x86_64 和 arm64 Core，直接复制到两个 FPK 会让每个安装包都变成双倍体积。

Clash 在 `package.json` 中声明：

```json
"archPrune": {
  "x86": ["app/cores/arm64"],
  "arm": ["app/cores/x86_64"]
}
```

打包器在 staging 阶段裁掉非目标架构，构建目录仍可保留双架构用于本机检查。

### 踩坑：CI 全新缓存目录不存在

本地有 `.local/cores` 缓存时构建正常，CI 全新环境下载许可证会失败：

```text
ENOENT: no such file or directory, open '.../LICENSE.part'
```

下载函数必须在写文件前创建目标目录，不能假设缓存目录已存在。Clash 在 `download()` 开始时执行：

```js
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
```

## 7. 新应用提权检查清单

开发需要修改系统状态的应用时，按以下顺序检查：

- [ ] 应用主体是否仍为 package 用户，没有整体 `run-as: root`。
- [ ] 是否只有固定 helper 可以 root 执行，helper 参数是否逐项校验。
- [ ] helper 是否 root 拥有、目录是否不可被组/其他用户写入。
- [ ] sudoers 是否只授权具体 helper，是否通过 `visudo -cf`。
- [ ] 初始化脚本是否从 root 拥有的路径执行，而不是应用目录中的可写脚本。
- [ ] 密码是否通过加密通道提交，是否避免命令行、日志和 state 泄露。
- [ ] 提权失败是否有明确错误提示，是否回读实际状态。
- [ ] 应用路径是否覆盖 appcenter、`@appdata`、`/var/apps` 等实际布局。
- [ ] 修改系统文件是否只改应用标记块，是否原子写入并保留其他内容。
- [ ] 停止 Core/停用/卸载时是否恢复系统代理等全局状态。
- [ ] TUN 是否使用 capabilities 而不是 root，是否排除应用 UID 防止回环。
- [ ] 是否用 `curl`/`ip link` 验证 TUN，而不是 `ping`。
- [ ] 预编译二进制是否选择兼容目标 CPU 的构建。
- [ ] 每个架构的 FPK 是否只包含目标架构运行时。
- [ ] CI 全新环境是否能从空缓存完成构建。
- [ ] 卸载是否区分保留数据和删除数据，并有越界删除测试。
- [ ] 是否在真实 fnOS、目标 CPU 和目标架构上验证过，而不只是本机/虚拟机。

## 8. 一句话总结

**把 root 权限收缩到最小 helper，把 helper 参数当作不可信输入，把系统级状态当作需要生命周期管理的资源；任何“本机能跑”都不能替代真实 fnOS 上的权限、CPU、挂载和架构验证。**
