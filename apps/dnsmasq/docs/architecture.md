# Dnsmasq for fnOS 架构

## 边界

管理服务运行在 package 用户下，通过 Unix socket 提供 fnOS 网关界面；dnsmasq 作为同一 package 用户的受控子进程运行。只有绑定低端口所需的 `CAP_NET_BIND_SERVICE` 由应用专属 root helper 设置。应用不提供 DHCP，不修改默认路由、NAT 或 `/etc/resolv.conf`。

Socket 模式下管理服务只信任飞牛网关注入的 `x-trim-userid` 与 `x-trim-isadmin` 请求头；只有未设置 `TRIM_APPDEST` 的本机开发模式才按回环 Host 校验，避免把网关请求误判为非管理员。

## 配置模型

`state.json` 保存监听地址、上游 DNS、缓存大小、查询日志和自动启动选项；`records.json` 保存精确记录和后缀记录。管理服务校验所有 IP、域名和记录类型后，以临时文件加 rename 的方式生成 `runtime/dnsmasq.conf`。启动前调用 `dnsmasq --test`，校验通过才启动前台进程。

## 提权

`native/app/bin/setup-privileges` 安装 root 拥有的 helper 和最小 sudoers 规则；`dnsmasq-caps` 只接受应用包中 dnsmasq 的固定路径，并设置 `cap_net_bind_service+ep`。helper 文件必须 root 拥有且不可被组/其他用户写入。是否受 fnOS 挂载参数、`setcap` 和目标内核支持，需要真机验收。

## 卸载

向导字段统一为 `wizard_delete_data`，默认 `keep`。删除回调只接受应用专属数据目录的规范化路径；未知值、缺失值、符号链接越界或重复回调都按保留处理。
