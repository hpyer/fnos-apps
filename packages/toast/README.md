# @fnos/toast

面向 fnOS 应用页面的轻量 toast 组件。应用按需添加 workspace 依赖，并在浏览器构建时打包 JavaScript 和 CSS；无运行时依赖。

```json
{ "dependencies": { "@fnos/toast": "workspace:*" } }
```

```js
import { toast } from '@fnos/toast';
import '@fnos/toast/style.css'; // 也可以在应用 CSS 中 @import

toast({ content: '配置已保存' });
toast({ type: 'error', title: '保存失败', content: error.message });
toast({ title: '有新版本', content: '请在应用中心手动安装', link: { label: '下载 FPK', href: 'https://example.com/app.fpk' }, duration: 0 });
const pending = toast({ content: '正在处理…', duration: 0 });
pending.close();
```

`toast({ title, content, link, type, position, duration, container })` 返回 `{ close }`。`link` 仅接受 HTTPS 地址，在新标签页打开。标题省略时依类型使用「提示 / 成功 / 警告 / 错误」。类型默认为 `info`；位置默认为 `top-right`，可选 `top-left`、`top-center`、`top-right`、`bottom-left`、`bottom-center`、`bottom-right`、`center`。默认 3000 毫秒关闭，`duration: 0` 表示手动关闭。鼠标悬停或焦点进入时暂停计时，离开后继续。`container` 默认为 `document.body`，原生 `dialog` 内的通知可指定该弹窗，以免被顶层弹窗遮挡。内容作为纯文本插入，可以安全显示错误详情。
