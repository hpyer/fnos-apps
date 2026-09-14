# DSH for fnOS 架构

## 进程与入口

飞牛 `cmd/main` 以应用专用用户运行 `main.mjs`。管理器监听统一网关的 `${TRIM_APPDEST}/app.sock`，公开前缀 `/app/dsh-for-fnos`。桌面主入口先加载轻量启动页；DSH 已就绪时，启动页在**同一飞牛应用窗口**内替换为 同源 `/app/dsh-for-fnos/dsh/` 页面。首次没有本地版本时，启动页自动转到设置页。版本和市场管理页通过状态岛中的设置按钮进入。

所有启动页、设置页资源和接口均要求网关提供 `X-Trim-Userid`，且 `X-Trim-Isadmin=true`；不能依赖桌面图标可见性作为鉴权。

管理接口的修改操作仅接收 JSON POST，并要求自定义请求头。飞牛网关已先验证管理员身份；浏览器跨站脚本无法在未获 CORS 授权时附带该自定义头。这里不以 Origin 与 Host 相等作为边界，因为飞牛统一网关可能保留浏览器 Origin 但将 Host 改为 Unix Socket 上游地址。耗时操作在服务内执行，立即返回 202，浏览器读取 `/api/status`；关闭页面不会打断安装。同一时间仅允许一个下载、切换、重启或设置操作。

启动 API 返回相对路径，不从内部 Host 推导外部地址。所有浏览器请求复用飞牛的协议、域名和端口。原生和开发入口都不再监听独立 DSH TCP 端口；DSH 自身仍仅监听 `127.0.0.1` 的临时端口。旧 `port` / `publicHost` 设置保留用于回退，源码的 `standalone` 选项仅供旧行为回归测试使用。

DSH 的进程由独立 worker 监管。管理器和 worker 使用 IPC 保持父子归属；父进程消失时 worker 终止 DSH 进程组。重启操作停止旧进程后再启动新进程，应用停用也会终止所拥有的子进程。

## 插件兼容

网关剥离 `/app/dsh-for-fnos/dsh` 后转发请求，不维护插件路径白名单。二进制、JSON、JavaScript 和 SSE 正文透传；HTML 资源属性及 CSS URL 适配子路径，并在 HTML 中优先加载外部 URL 适配脚本。该脚本处理 Fetch、XHR、EventSource、WebSocket、Worker、动态资源元素和 History URL；上游 DSH 0.1.5-rc.1 的插件加载器通过 `script.src` 加载 boot graph 中的插件脚本。

官方首页继续注入 `__DSH_TRANSPORT__.ownsHost=true` 宿主桥接与状态岛。重启和设置跳转均保留同源路径。第三方插件的原生动态 `import()`、Service Worker、内联 HTML/CSS 资源和独立 Cookie 登录不保证透明兼容；需要按实际插件测试。

每个 HTTP 请求都必须通过飞牛管理员鉴权；修改请求还要求浏览器适配脚本附带 `X-Fnos-Request: 1`，不开放跨域预检。WebSocket 同样校验管理员身份，并要求 Origin 与该管理员此前受自定义请求头保护的请求来源匹配，以兼容飞牛改写内部 Host。来源记录仅存内存，每位用户最多保留 8 个来源。

代理不向 DSH 传递飞牛 Cookie、Authorization、Referer 和身份头；它使用进程健康检查已取得的 DSH 内部 Cookie，按回环地址设置 Host/Origin。上游 Set-Cookie 不下发至飞牛域名，避免污染系统会话。HTTP 重定向保持子路径，SSE 关闭代理缓冲。原生模式不再向浏览器发放跨端口凭据。

官方市场安装命令为 `dsh plugin --profile web add dshmarket`。应用在自己的 DSH_HOME 内执行此命令，保留官方 profile 结构与 pnpm 插件管理。不会向 DSH 源文件注入补丁、删除用户插件、重写用户 `cordis.patch.yml`，也不会假设插件只访问 `/api`。

管理器通过单独的 `--patch` 文件为 `dsh-market` 设置 `config.allowRestart=false`，将进程重启统一交给应用管理页。市场更新 API、插件配置 API 和其它路由透传；这些 API 的跨版本兼容仍由 DSH/插件负责。

当前没有接入飞牛文件选择器、`/fn` 指令、文件管理开放 API、macOS 专属功能或其它参考应用的功能。

## 版本事务

1. 查询用户选定的 npm 标签，得到精确版本及 integrity；`latest` 始终保留。
2. 在独立 staging 目录使用 npm 安装精确 `@deepseek-ai/dsh`，由 npm 校验包内容。
3. 复核安装后的包名、版本、lockfile integrity 和入口文件。校验通过后才允许清理旧版本。
4. 保护当前版本与新下载版本，按语义版本淘汰到总计最多 5 个已完成版本。下载失败不清理旧版本。
5. 用户单独选择启用。停止旧 DSH，按官方 profile 启动新版本。
6. 解析 DSH 输出的就绪 URL，在内存中使用启动令牌换取 Cookie 并验证首页，连续成功 3 次后更新当前版本指针。
7. 启动失败停止候选进程并尝试重启原版本；错误保留在管理页，供用户处理插件或重试。

只保证运行时版本的回退，不承诺回退 DSH 自身的数据迁移或插件依赖变化。当前不提供自动更新、自动启用新版本、定时任务或额外固定版本配额。

## 打包

pnpm workspace 管理开发依赖；esbuild 将管理器依赖打包成 Node.js ESM。FPK 携带 pnpm 11，调用飞牛 `nodejs_v24` 提供的 Node/npm；DSH 由目标 NAS 在首次运行时安装，因此 FPK 不固定 DSH 版本，不包含开发机的原生二进制依赖。

`fnpack` 1.2.3 的部分校验失败仍返回退出码 0，打包脚本额外验证是否真正生成新 FPK。
