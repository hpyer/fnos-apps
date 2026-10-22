# 架构

- `native/config/resource` 用 `usr-local-linker` 声明全局 `ffmpeg`、`ffprobe` 入口脚本，以自身文件名选择命令，不接受环境变量指定运行根目录。链接目标留在 FPK 中，实际版本留在独立运行数据目录。默认只下载 ffmpeg，ffprobe 入口在组件缺失时显示补装提示并返回 127；状态接口分别报告入口注册和当前组件安装状态。
- `cmd/main` 只管理 Node 管理进程，使用 PID 和 `/proc` 命令行匹配确认身份。停止不按 `ffmpeg` 进程名杀进程。安装与升级前检查命令冲突及 xz/flock，长期服务以包用户运行。
- `server.mjs` 通过 0660 Unix Socket 和统一网关开放管理员页面；写接口要求 JSON、自定义头和非跨站请求。开发模式仅监听回环地址并校验 Host。所有进程调用都用参数数组，不插入 shell 命令。
- `components.mjs` 从 Martin Riedl 的稳定版区匹配 x64 / arm64 独立 ZIP，固定构建时间戳、版本及架构；客户端只能提交服务器缓存的构建 ID。查询仅获取 ffmpeg 的 SHA256 与 HEAD 大小，未选 ffprobe 时不请求其文件。下载限制时间、体积、HTTPS 来源和逐跳重定向，最终强制匹配 SHA256；HEAD 不可用时可用未知大小下载，仍有硬上限与哈希校验。成功查询缓存一分钟。
- `download.mjs` 供独立组件及旧 BtbN 归档复用。连接异常、传输提前结束及部分临时 HTTP 错误最多重试 3 次，按 1/2/4 秒退避并遵守 Retry-After；每文件总时限 30 分钟，请求头等待上限 30 秒，连续 60 秒无数据会中止该次连接并重试。每次重试重新检查来源及重定向。使用 identity 编码、Range 和可用的强 ETag/Last-Modified 续传，严格核对 Content-Range、响应大小及最终整份 SHA256；遇到 200 或 416 安全地清空残片重新下载，不追加完整响应。部分文件只在当前操作内保留，最终失败或停止时清理，既有同名文件不覆盖。错误区分网络中断、超时、空间不足和权限，管理页使用原有进度区及公共 Toast。
- `zip.mjs` 内置单组件 ZIP 读取与 deflate 解压，检查中央目录、本地文件头、CRC、展开大小、常规文件类型与固定组件名；拒绝多文件、路径穿越、链接、加密及异常大小。输出路径由应用指定，失败删除部分输出，不覆盖已有文件。
- `repository.mjs` 保留旧 BtbN 构建的查询和下载能力；GitHub API 不可用时可回退 Atom 与固定标签的校验清单，限流遵守恢复时间。当前管理页使用独立组件来源，旧版本补装使用其原始来源记录。`archive.mjs` 调用系统 xz 并逐块检查 tar，按指定工具列表仅提取常规可执行文件及许可证，拒绝穿越、链接和异常扩展。
- `manager.mjs` 保证同一时刻仅有一个下载/启用/回滚/删除操作，诊断期间也阻止变更。暂存目录与正式版本在同一数据目录，只有 ELF 架构检查、版本一致性和 PCM 自检通过后才 rename 为正式版本。下载不会自动启用。操作中断后，下次启动清理暂存并显示中断提示。
- `settings.json` 的 `ffprobeEnabled` 默认为 false。勾选操作先补齐当前构建，成功后才持久化选项；无当前版本时直接保存。新版本按该选项下载一个或两个组件，启用和回滚先补齐目标缺失的 ffprobe；取消不删除已有组件。已有组件校验通过后直接复用，不重复下载。
- 补装使用暂存目录校验 SHA256、ELF、与当前 ffmpeg 完全一致的版本及 PCM 自检，再于目录排他锁下提交 ffprobe 和元数据；原 ffmpeg 文件不被替换。提交前写入受校验的恢复日志，重启时检查组件哈希再完成元数据更新。失败保留当前指针和原同步选项；成功提交后清理日志失败不会回滚二进制。不承诺 fsync 级断电持久性。
- 安装目录和 `bin` 为 0755，二进制为 0555，目录锁、版本锁及元数据为 0644；管理状态为 0600，暂存为 0700。显式设置权限以适配生命周期脚本的 umask 077。fnOS Windows ACL 及父目录遍历权限仍需跨账户实机验证。应用账户可管理的二进制若由 root 调用，root 即信任该应用账户及下载来源；不使用 setuid。
- `catalog-action.mjs` 在 `catalog.lock` 排他锁内切换或删除；启用前重新校验文件哈希和可运行性，先保存上一版本再原子替换 `current`。`current` 是唯一生效指针，断电可能留下更新的上一版本记录，但不会使两条命令分别指向不同版本。不承诺断电级 fsync 持久性。
- 全局入口在目录共享锁内读取指针并取得版本共享锁，随后释放目录锁并 exec，保留版本锁 FD 8。删除先持有目录排他锁，再尝试版本排他锁，避免调用与删除竞争。直接版本路径执行绕过锁，不自动跟踪；诊断操作与版本变更在管理进程内互斥。
- 全局入口不依赖 Node 管理服务运行。该行为以及应用停止期间资源链接是否存在需在 fnOS 验收；卸载、系统更新或资源链接冲突不由入口脚本绕过。

复用 `@fnos/version-check` 的检查调度/并发合并及应用 FPK 更新提醒、`@fnos/toast` 的提示组件。构建复制服务端公共代码并打包浏览器依赖，运行时只依赖飞牛 Node.js 24 与系统工具，不依赖其他 workspace 应用。

平台依据：[应用资源](https://developer.fnnas.com/docs/core-concepts/resource/)、[权限](https://developer.fnnas.com/docs/core-concepts/privilege/)、[应用框架](https://developer.fnnas.com/docs/core-concepts/framework/)。下载依据：[独立组件来源](https://ffmpeg.martin-riedl.de/)、[上游构建脚本](https://git.martin-riedl.de/ffmpeg/build-script)、[BtbN 构建说明](https://github.com/BtbN/FFmpeg-Builds)。
