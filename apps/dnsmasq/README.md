# Dnsmasq for fnOS

这是一个 DNS-only 应用：只监听配置中的 DNS 地址和 53 端口，使用显式上游 DNS、缓存和自定义解析记录，不配置 DHCP、路由、NAT，也不改写系统 `resolv.conf`。

当前版本为开发中的 `0.1.0`。构建前需要在目标 Linux x86_64/arm64 构建机生成 dnsmasq 2.93 二进制：

```sh
node apps/dnsmasq/scripts/build-dnsmasq.mjs x64
DNSMASQ_BINARY=apps/dnsmasq/binaries/x86_64/dnsmasq pnpm run build dnsmasq
```

应用以 package 用户运行，只有受控的 `dnsmasq-caps` helper 通过 `CAP_NET_BIND_SERVICE` 允许绑定 53 端口；不会把 Node 管理进程整体改为 root。首次安装、升级和卸载后的 helper 生命周期需要在 fnOS 真机验证。

持久化数据位于 `${TRIM_PKGVAR}`：`state.json`、`records.json`、`runtime/dnsmasq.conf` 和 `logs/`。卸载默认保留这些数据；只有卸载向导明确选择“删除全部应用数据”时才删除应用专属数据目录，其他应用、共享目录和系统 DNS 配置不在清理范围内。

本机测试不等同于 fnOS 验收。真机至少需要验证 53 端口绑定、helper 提权、启动/停止/升级、配置回滚、局域网客户端查询，以及卸载保留/删除两条路径。
