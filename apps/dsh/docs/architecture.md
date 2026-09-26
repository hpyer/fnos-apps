# DSH for fnOS 架构

## 进程与入口

飞牛 `cmd/main` 以应用专用用户运行 `main.mjs`。管理器监听统一网关的 `${TRIM_APPDEST}/app.sock`，公开前缀 `/app/dsh-for-fnos`。网关提供的 `X-Trim-Userid` 是租户键；管理器为每个 UID 按需创建独立的、位于 `/volN/<uid>/` 下的用户所选工作目录 `HOME`、其下的 `.dsh` `DSH_HOME`、DSH 子进程、上游认证 Cookie 和插件监视器。

DSH 子进程继承应用专用用户的系统 UID/GID，飞牛 UID 仅用于路由和独立数据目录；用户授权目录的 ACL 决定应用账户能访问哪些文件。多个用户授权的目录可能都对同一应用账户开放，因此终端及插件可以访问应用账户有权访问的其他用户目录。包账户的登录 shell 可能是 `nologin`，启动 DSH 时显式设置 `SHELL=/bin/sh`，供内置终端使用。当前实现不提供按飞牛用户 UID 执行命令的系统权限隔离。

桌面和飞牛 App 使用同一启动页与同源 `/app/dsh-for-fnos/dsh/` 页面。状态岛在桌面端显示紧凑弹层，在窄屏上显示底部触控面板，支持版本切换、当前实例重启和个人目录授权。只有管理员显示应用管理入口。

启动页、DSH 代理和用户操作要求网关提供 `X-Trim-Userid`。运行时下载、默认版本、npm 源与插件市场修复另外要求 `X-Trim-Isadmin=true`；不依赖桌面图标可见性作为鉴权。

所有修改操作仅接收 JSON POST，并要求 `X-Fnos-Request: 1`。全局下载与设置串行化；每个用户的启动、切换和重启在自己的租户内串行化，不会阻塞其他已运行实例。每个已启动租户记录最近请求时间和活跃 HTTP/SSE/WebSocket 连接；无活跃连接并超过管理员设置的空闲时间（默认 600 秒）后关闭子进程。管理员状态接口只列出当前运行服务，并可手动关闭指定 UID 的实例。

启动 API 返回相对路径，不从内部 Host 推导外部地址。所有浏览器请求复用飞牛的协议、域名和端口。每个 DSH 子进程仅监听 `127.0.0.1:0`，由操作系统分配不冲突的临时端口；管理器按 UID 保存上游地址，不需要配置固定端口池。旧 `port` / `publicHost` 设置仅供回归测试使用。

DSH 的进程由独立 worker 监管。管理器和 worker 使用 IPC 保持父子归属；父进程消失时 worker 终止 DSH 进程组。重启操作停止旧进程后再启动新进程，应用停用也会终止所拥有的子进程。

## 插件兼容

网关剥离 `/app/dsh-for-fnos/dsh` 后转发请求，不维护插件路径白名单。二进制、JSON、JavaScript 和 SSE 正文透传；HTML 资源属性及 CSS URL 适配子路径，并在 HTML 中优先加载外部 URL 适配脚本。该脚本处理 Fetch、XHR、EventSource、WebSocket、Worker、动态资源元素和 History URL；上游 DSH 0.1.5-rc.1 的插件加载器通过 `script.src` 加载 boot graph 中的插件脚本。

官方首页继续注入 `__DSH_TRANSPORT__.ownsHost=true` 宿主桥接与状态岛。重启和设置跳转均保留同源路径。第三方插件的原生动态 `import()`、Service Worker、内联 HTML/CSS 资源和独立 Cookie 登录不保证透明兼容；需要按实际插件测试。

每个 HTTP 请求都必须通过飞牛登录鉴权；修改请求还要求浏览器适配脚本附带 `X-Fnos-Request: 1`，不开放跨域预检。WebSocket 在握手时绑定 `X-Trim-Userid`，并要求 Origin 与该用户此前受保护的请求来源匹配。来源记录仅存内存，每位用户最多保留 8 个来源。

代理不向 DSH 传递飞牛 Cookie、Authorization、Referer 和身份头；它使用进程健康检查已取得的 DSH 内部 Cookie，按回环地址设置 Host/Origin。上游 Set-Cookie 不下发至飞牛域名，避免污染系统会话。HTTP 重定向保持子路径，SSE 关闭代理缓冲。原生模式不再向浏览器发放跨端口凭据。

官方市场安装命令为 `dsh plugin --profile web add dshmarket`。应用在每个用户自己的 DSH_HOME 内执行此命令，保留官方 profile 结构与 pnpm 插件管理。不会向 DSH 源文件注入补丁、删除用户插件、重写用户 `cordis.patch.yml`，也不会假设插件只访问 `/api`。

管理器通过单独的 `--patch` 文件为 `dsh-market` 设置 `config.allowRestart=false`，将进程重启统一交给应用管理页。市场更新 API、插件配置 API 和其它路由透传；这些 API 的跨版本兼容仍由 DSH/插件负责。

飞牛不支持直接授权用户主目录根。首次启动页通过 `trim.file.userAccess` 让当前用户在自己的主目录中选择 DSH 工作目录；后端只接受 `/volN/<uid>/` 下的子目录，确认该目录对应用可读写后才创建 DSH 租户。状态岛可继续调起目录选择器为该用户增加额外目录，后端按 UID 查询已授权目录，并在用户 Home 的 `authorized/` 下维护可识别的符号链接；工作目录本身不会再重复链接到 `authorized/` 内。

每个租户的 pnpm 内容缓存放在 `${TRIM_PKGVAR}/users/<uid>/pnpm-store`，避免把内容寻址缓存和用户目录 ACL 混用。应用将自身启动掩码调整为常规可读模式；用户主目录与飞牛授权 ACL 才是隔离边界。安装市场若遇到旧 `.dsh/profiles/web` 的 `EACCES`，先仅删除派生的 `node_modules` 和 lockfile 重建；若 profile 清单仍不可读，则保留式地将整个 `web` 目录改名为带时间戳的备份，创建新的官方 profile 并重试。恢复不删除工作区、会话或旧 profile 备份。

## 版本事务

1. 查询用户选定的 npm 标签，得到精确版本及 integrity；`latest` 始终保留。
2. 在独立 staging 目录使用 npm 安装精确 `@deepseek-ai/dsh`，由 npm 校验包内容。
3. 复核安装后的包名、版本、lockfile integrity 和入口文件。校验通过后才将运行时移入已安装版本目录；下载失败不会改动已有版本。
4. 已安装版本数量不设上限。管理员可以手动删除版本；删除前重新检查管理员默认版本、所有用户已选版本及当前运行进程，任一引用存在时拒绝删除。
5. 普通用户只能从已安装版本中选择；切换时只停止该 UID 的旧 DSH，按官方 profile 启动新版本。
6. 解析 DSH 输出的就绪 URL，在内存中使用启动令牌换取当前租户的 Cookie 并验证首页，连续成功 3 次后保存该用户的当前版本。
7. 启动失败停止候选进程并尝试重启原版本；错误保留在管理页，供用户处理插件或重试。

首次安装由管理器查询 `latest`、下载并设为全局默认版本。第一个完成工作目录授权的管理员会自动启动该版本；其余用户保持按需启动，避免在未打开应用时创建不必要的租户进程。

只保证运行时版本的回退，不承诺回退 DSH 自身的数据迁移或插件依赖变化。当前不提供自动更新、自动启用新版本、定时任务或固定版本配额。

## 打包

pnpm workspace 管理开发依赖；esbuild 将管理器依赖打包成 Node.js ESM。FPK 携带 pnpm 11，调用飞牛 `nodejs_v24` 提供的 Node/npm；DSH 由目标 NAS 在首次运行时安装，因此 FPK 不固定 DSH 版本，不包含开发机的原生二进制依赖。

`fnpack` 1.2.3 的部分校验失败仍返回退出码 0，打包脚本额外验证是否真正生成新 FPK。
