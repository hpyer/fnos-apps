import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ICONS } from '../shared/icons.mjs';

export function json(response, code, data) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(data));
}
export async function body(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 16_384) throw new Error('请求体过大');
  }
  return JSON.parse(data || '{}');
}
export function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host;
  } catch { return false; }
}

// Tickets authenticate the cross-origin handoff from fnOS to the standalone
// DSH port. Sessions are intentionally memory-only and disappear on restart.
export class Sessions {
  constructor() { this.tickets = new Map(); this.sessions = new Map(); }
  clean() {
    for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
  ticket(authority, navigation = {}) {
    this.clean();
    const value = randomBytes(32).toString('base64url');
    this.tickets.set(value, { authority, navigation, expires: Date.now() + 60_000 });
    return value;
  }
  exchange(ticket, authority) {
    this.clean();
    const value = this.tickets.get(ticket);
    if (!value || value.authority !== authority) throw new Error('打开凭据已过期，请从飞牛管理页重新打开');
    this.tickets.delete(ticket);
    const session = randomBytes(32).toString('base64url');
    this.sessions.set(session, { authority, navigation: value.navigation, expires: Date.now() + 8 * 3600_000 });
    return session;
  }
  session(request, port) {
    this.clean();
    const cookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`fnos_dsh_${port}=`))?.split('=')[1];
    const session = this.sessions.get(cookie);
    return session && session.authority === request.headers.host && sameOrigin(request) ? session : null;
  }
  authorized(request, port) { return this.session(request, port) !== null; }
}
export function upstreamHeaders(request, address, port, websocket = false) {
  const headers = { ...request.headers, host: address.host };
  // Do not trust forwarded identity, or disclose the manager's own session to plugins.
  const connectionHeaders = (headers.connection ?? '').split(',').map(x => x.trim().toLowerCase());
  for (const key of Object.keys(headers)) if (key.startsWith('x-trim-') || key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
  for (const key of [...connectionHeaders, 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'connection', 'upgrade']) delete headers[key];
  const cookies = (headers.cookie ?? '').split(';').filter(x => !x.trim().startsWith(`fnos_dsh_${port}=`)).join(';');
  if (cookies) headers.cookie = cookies; else delete headers.cookie;
  if (request.headers.origin) headers.origin = address.origin;
  headers['x-forwarded-for'] = request.socket.remoteAddress ?? '127.0.0.1';
  if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}
const bootstrap = `<!doctype html><meta charset="utf-8"><title>打开 DSH</title><p id="message">正在验证访问权限…</p><script src="/_fnos/bootstrap.js"></script>`;
const bootstrapJS = `const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch('/_fnos/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);location.replace(d.path)}).catch(e=>document.getElementById('message').textContent=e.message);`;
// DSH deliberately treats a non-loopback browser as a remote, memory-only
// client. This application is its authenticated host, so grant the official
// front end the documented host transport flag before its own modules load.
const ownsHostTag = '<link rel="stylesheet" href="/_fnos/shell.css?v=1.0.0"><script src="/_fnos/owns-host.js"></script><script src="/_fnos/shell.js?v=1.0.0" defer></script>';
const shellCSS = `#fnos-dsh-shell,#fnos-dsh-shell *{box-sizing:border-box}#fnos-dsh-shell{position:fixed;z-index:2147483647;top:0;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;width:250px;min-height:38px;padding:3px 5px 3px 9px;border:1px solid rgba(71,84,103,.2);border-top:0;border-radius:0 0 13px 13px;background:rgba(255,255,255,.96);box-shadow:0 12px 28px rgba(15,23,42,.14);font:14px/1.42 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#273244;backdrop-filter:blur(18px)}#fnos-dsh-shell [data-role=state]{display:flex;align-items:center;gap:6px;flex:1;min-width:0;font-size:11px;font-weight:650;white-space:nowrap}#fnos-dsh-shell [data-role=state]::before{content:"";width:7px;height:7px;border-radius:50%;background:#98a2b3;box-shadow:0 0 0 3px rgba(152,162,179,.15)}#fnos-dsh-shell.is-running [data-role=state]::before{background:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.13)}#fnos-dsh-shell.is-busy [data-role=state]::before{background:#d97706;box-shadow:0 0 0 3px rgba(217,119,6,.13)}#fnos-dsh-shell button{position:relative;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#526174;cursor:pointer}#fnos-dsh-shell button:hover{background:#edf3ff;color:#1d4ed8}#fnos-dsh-shell button:disabled{opacity:.42;cursor:not-allowed}#fnos-dsh-shell button svg{width:15px;height:15px;fill:currentColor}#fnos-dsh-shell button::after{content:attr(data-tooltip);position:absolute;top:calc(100% + 9px);left:50%;transform:translateX(-50%) translateY(-3px);padding:5px 7px;border-radius:6px;background:#172033;color:#fff;font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s}#fnos-dsh-shell button:hover:not(:disabled)::after,#fnos-dsh-shell button:focus-visible::after{opacity:1;transform:translateX(-50%) translateY(0)}#fnos-dsh-shell.is-dark{border-color:rgba(255,255,255,.14);background:rgba(25,27,32,.95);box-shadow:0 12px 28px rgba(0,0,0,.3);color:#f5f7fb}#fnos-dsh-shell.is-dark [data-role=state]::before{background:#7d8490;box-shadow:0 0 0 3px rgba(125,132,144,.12)}#fnos-dsh-shell.is-dark.is-running [data-role=state]::before{background:#40cf78;box-shadow:0 0 0 3px rgba(64,207,120,.12)}#fnos-dsh-shell.is-dark.is-busy [data-role=state]::before{background:#f3a837;box-shadow:0 0 0 3px rgba(243,168,55,.12)}#fnos-dsh-shell.is-dark button{color:#d8dce4}#fnos-dsh-shell.is-dark button:hover{background:rgba(255,255,255,.11);color:#fff}#fnos-dsh-veil{position:fixed;z-index:2147483646;inset:0;display:grid;place-items:center;background:rgba(247,249,252,.74);color:#273244;backdrop-filter:blur(3px);cursor:wait}#fnos-dsh-veil[hidden]{display:none}#fnos-dsh-veil>div{display:grid;justify-items:center;gap:9px;padding:22px 28px;border:1px solid rgba(71,84,103,.18);border-radius:14px;background:rgba(255,255,255,.96);box-shadow:0 16px 42px rgba(15,23,42,.16)}#fnos-dsh-veil .spinner{display:grid;place-items:center;width:38px;height:38px;animation:fnos-dsh-spin .9s linear infinite;transform-origin:center;will-change:transform}#fnos-dsh-veil .spinner .iconfont-symbol{display:block;width:34px;height:34px;fill:#2463d4}#fnos-dsh-veil strong{font-size:14px}#fnos-dsh-veil small{color:#667085;font-size:12px}@keyframes fnos-dsh-spin{to{transform:rotate(360deg)}}#fnos-dsh-veil.is-dark{background:rgba(14,16,20,.72);color:#f5f7fb}#fnos-dsh-veil.is-dark>div{border-color:rgba(255,255,255,.13);background:rgba(28,30,35,.96);box-shadow:0 16px 42px rgba(0,0,0,.35)}#fnos-dsh-veil.is-dark small{color:#b0b7c2}@media(max-width:620px){#fnos-dsh-shell{max-width:calc(100vw - 16px)}#fnos-dsh-shell [data-role=state]{min-width:0;max-width:160px;overflow:hidden;text-overflow:ellipsis}}`;
const shellJS = `(()=>{const root=document.createElement('section'),veil=document.createElement('section');root.id='fnos-dsh-shell';veil.id='fnos-dsh-veil';root.setAttribute('aria-label','DSH for fnOS 状态');veil.hidden=true;root.innerHTML='<span data-role="state">正在读取状态</span><button type="button" data-action="restart" data-tooltip="重启 DSH" aria-label="重启 DSH">${ICONS.restart}</button><button type="button" data-action="settings" data-tooltip="打开设置" aria-label="打开设置">${ICONS.settings}</button>';veil.innerHTML='<div><span class="spinner">${ICONS.refresh}</span><strong data-role="message">DSH 正在重启</strong><small>请稍候，暂时不能操作</small></div>';const mount=()=>{document.body?.prepend(root);document.body?.append(veil)};if(document.body)mount();else addEventListener('DOMContentLoaded',mount,{once:true});const state=root.querySelector('[data-role=state]'),restart=root.querySelector('[data-action=restart]'),message=veil.querySelector('[data-role=message]');let busy=false,restartPending=false,restartSeenBusy=false,restartAt=0,reloading=false,reloadTimer=null;const scheduleReload=()=>{if(reloading||reloadTimer)return;reloadTimer=setTimeout(()=>{reloading=true;location.assign('/_fnos/reopen')},1_200)};const theme=()=>{const page=document.documentElement,body=document.body;const tokens=[page.className,page.getAttribute('data-theme'),page.getAttribute('data-color-mode'),body?.className,body?.getAttribute('data-theme'),getComputedStyle(page).colorScheme].filter(Boolean).join(' ').toLowerCase();const dark=/\\bdark\\b/.test(tokens)&&!/\\blight\\b/.test(tokens);root.classList.toggle('is-dark',dark);veil.classList.toggle('is-dark',dark)};const block=(value,label)=>{veil.hidden=!value;if(label)message.textContent=label};new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','data-color-mode','style']});theme();const render=data=>{busy=Boolean(data.busy);if(restartPending&&busy)restartSeenBusy=true;if(restartPending&&data.error){restartPending=false;restartSeenBusy=false;clearTimeout(reloadTimer);reloadTimer=null}if(restartPending&&!reloading&&!data.error&&restartSeenBusy&&!busy&&data.running)scheduleReload();root.classList.toggle('is-running',Boolean(data.running));root.classList.toggle('is-busy',busy);state.textContent=busy?data.busy+' · '+(data.current||''):data.running?'运行中 · '+(data.current||''):data.current?'已停止 · '+data.current:'未安装';restart.disabled=busy||!data.current;block(busy||restartPending,busy?data.busy:restartPending?'DSH 正在重启':'')};const refresh=async()=>{try{const r=await fetch('/_fnos/status',{cache:'no-store'});if(!r.ok)throw Error();render(await r.json())}catch{state.textContent='状态不可用';root.classList.remove('is-running')}};restart.addEventListener('click',async()=>{if(busy||restart.disabled)return;restartPending=true;restartSeenBusy=false;restartAt=Date.now();restart.disabled=true;block(true,'DSH 正在重启');try{const r=await fetch('/_fnos/restart',{method:'POST',headers:{'content-type':'application/json'}});if(!r.ok)throw Error((await r.json()).error);setTimeout(refresh,300)}catch(e){restartPending=false;restartSeenBusy=false;clearTimeout(reloadTimer);reloadTimer=null;block(false);state.textContent=e.message||'重启失败';restart.disabled=false}});root.querySelector('[data-action=settings]').addEventListener('click',()=>location.assign('/_fnos/settings'));refresh();setInterval(refresh,500)})();`;
export function ownsHostJS(settingsDocument, hostBridge = '') {
  return `globalThis.__FNOS_DSH_SETTINGS_FILE__=${JSON.stringify(settingsDocument)};\n${hostBridge}`;
}

export function injectOwnHostIndex(source) {
  const html = source.toString('utf8');
  if (!/<head(?:\s[^>]*)?>/i.test(html)) return source;
  return Buffer.from(html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${ownsHostTag}`));
}

function canInjectIndex(request, upstream) {
  return request.method === 'GET' && new URL(request.url, 'http://dsh.invalid').pathname === '/'
    && upstream.statusCode === 200 && /^text\/html(?:;|$)/i.test(String(upstream.headers['content-type'] ?? ''))
    && !upstream.headers['content-encoding'];
}

function forwardTransformed(response, upstream, transform) {
  const chunks = [];
  upstream.on('data', chunk => chunks.push(chunk));
  upstream.on('error', () => response.destroy());
  upstream.on('end', () => {
    const body = transform(Buffer.concat(chunks));
    const headers = { ...upstream.headers };
    delete headers['content-length'];
    response.writeHead(upstream.statusCode, headers);
    response.end(body);
  });
}

// This server owns the configurable public DSH port. Its internal /_fnos/
// namespace handles the authenticated handoff and status island; every other
// route is forwarded to DSH without a plugin-path allowlist.
export function createDshGateway(manager, sessions, port, hostBridge = '') {
  const server = http.createServer(async (request, response) => {
    try {
      const internalPath = new URL(request.url, 'http://dsh.invalid').pathname;
      if (request.method === 'GET' && ['/_fnos/bootstrap', '/_fnos/bootstrap.js', '/_fnos/owns-host.js', '/_fnos/shell.js', '/_fnos/shell.css'].includes(internalPath)) {
        // The NAS gateway and public DSH port differ in origin because their
        // ports differ. This bootstrap page must therefore remain frameable
        // by fnOS; 'self' and 'none' both make the browser reject it first.
        response.writeHead(200, { 'content-type': internalPath.endsWith('.css') ? 'text/css; charset=utf-8' : internalPath.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" });
        return response.end(internalPath === '/_fnos/owns-host.js' ? ownsHostJS(manager.settingsDocument, hostBridge) : internalPath === '/_fnos/shell.js' ? shellJS : internalPath === '/_fnos/shell.css' ? shellCSS : internalPath.endsWith('.js') ? bootstrapJS : bootstrap);
      }
      if (request.method === 'POST' && request.url === '/_fnos/session') {
        const address = manager.process.address;
        if (!address) return json(response, 503, { error: 'DSH 尚未就绪' });
        const { ticket } = await body(request);
        // This is deliberately ticket-authenticated rather than Origin-authenticated.
        // fnOS can change Origin/Fetch-Metadata for the page it opened. A 256-bit,
        // single-use, 60-second ticket is fragment-only and bound to this authority.
        const session = sessions.exchange(ticket, request.headers.host);
        response.setHeader('set-cookie', `fnos_dsh_${port}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return json(response, 200, { path: address.pathname + address.search + address.hash });
      }
      const session = sessions.session(request, port);
      if (!session) return json(response, 401, { error: '请从飞牛 DSH 管理页打开应用' });
      if (request.method === 'GET' && request.url === '/_fnos/status') {
        const state = await manager.status();
        return json(response, 200, { current: state.current, running: state.running, busy: state.busy, error: state.error });
      }
      if (request.method === 'POST' && request.url === '/_fnos/restart') {
        if (manager.busy) return json(response, 409, { error: `正在${manager.busy}` });
        manager.dispatch('restart').catch(() => {});
        return json(response, 202, { ok: true });
      }
      if (request.method === 'GET' && internalPath === '/_fnos/reopen') {
        // A browser navigation can arrive between process replacement and DSH's
        // final readiness probe. Keep this authenticated request pending until
        // the supervisor has completed the restart instead of exposing JSON.
        const deadline = Date.now() + 120_000;
        while ((manager.busy || !manager.process.address) && Date.now() < deadline) await delay(250);
        if (!manager.process.address) return json(response, 503, { error: manager.error || 'DSH 启动超时，请从设置页重试' });
        const ticket = sessions.ticket(request.headers.host, session.navigation);
        response.writeHead(303, { location: `/_fnos/bootstrap#${ticket}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return response.end();
      }
      if (request.method === 'GET' && request.url === '/_fnos/settings') {
        const location = session.navigation?.settingsUrl;
        if (!location) return json(response, 503, { error: '设置页地址不可用，请重新打开 DSH for fnOS' });
        response.writeHead(303, { location, 'cache-control': 'no-store' });
        return response.end();
      }
      const address = manager.process.address;
      if (!address) return json(response, 503, { error: 'DSH 正在重启或尚未启动' });
      // Preserve every path and byte, including plugin APIs, binary assets and SSE.
      const headers = upstreamHeaders(request, address, port);
      const pathname = new URL(request.url, 'http://dsh.invalid').pathname;
      // Only the DSH root document is adapted; plugin responses stay byte-for-byte intact.
      if (request.method === 'GET' && pathname === '/') headers['accept-encoding'] = 'identity';
      // The upstream always binds to loopback on a random port. The external
      // port is held only by this authenticated gateway.
      const proxy = http.request({ hostname: '127.0.0.1', port: address.port, path: request.url, method: request.method, headers }, upstream => {
        if (upstream.statusCode === 401 && request.method === 'GET' && request.url === '/' && (address.search || address.hash)) {
          upstream.resume();
          response.writeHead(303, { location: address.pathname + address.search + address.hash, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
          response.end();
          return;
        }
        if (canInjectIndex(request, upstream)) return forwardTransformed(response, upstream, injectOwnHostIndex);
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
        upstream.on('error', () => response.destroy());
      });
      proxy.on('error', () => { if (!response.headersSent) json(response, 502, { error: 'DSH 连接暂时不可用' }); else response.destroy(); });
      request.on('aborted', () => proxy.destroy());
      response.on('close', () => proxy.destroy());
      request.pipe(proxy);
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.destroy(); }
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.closeConnections = () => { for (const socket of sockets) socket.destroy(); };
  server.on('upgrade', (request, socket, head) => {
    const address = manager.process.address;
    if (!sessions.authorized(request, port) || !address || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    // WebSocket does not use request.pipe(), so tunnel both raw sockets after
    // the loopback upstream confirms its Upgrade response.
    const proxy = http.request({ hostname: '127.0.0.1', port: address.port, path: request.url, headers: upstreamHeaders(request, address, port, true) });
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    proxy.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    proxy.on('error', () => socket.destroy());
    socket.on('error', () => proxy.destroy());
    proxy.end();
  });
  return server;
}
