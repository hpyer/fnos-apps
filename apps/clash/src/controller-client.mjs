import http from 'node:http';
import { fail } from './errors.mjs';

const MAX_RESPONSE = 8 * 1024 * 1024;

function controllerMessage(text, status) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value.message === 'string' && value.message) return value.message;
  } catch { /* plain text body */ }
  if (status === 401) return 'Controller 校验失败';
  if (status === 404) return 'Controller 未找到该接口或对象';
  return text.trim().slice(0, 300) || `Controller 返回 HTTP ${status}`;
}

/**
 * Minimal mihomo external-controller client. All traffic stays on the private
 * Unix socket; no TCP controller port is opened for the LAN.
 */
export class ControllerClient {
  constructor({ socketPath, timeout = 5000 }) {
    if (!socketPath) throw Error('缺少 Controller Socket 路径');
    this.socketPath = socketPath;
    this.timeout = timeout;
  }

  request({ path, method = 'GET', body, signal, timeout = this.timeout }) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const request = http.request({
        socketPath: this.socketPath,
        path,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE) { request.destroy(Error('Controller 响应过大')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode >= 400) return reject(Object.assign(Error(controllerMessage(text, response.statusCode)), { status: response.statusCode }));
          if (!text) return resolve(null);
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        });
      });
      const timer = setTimeout(() => request.destroy(Error('Controller 请求超时')), timeout);
      const abort = () => request.destroy(Error('Controller 请求已取消'));
      signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
      request.on('error', error => { clearTimeout(timer); reject(error); });
      if (payload) request.write(payload);
      request.end();
    });
  }

  async version() { return this.request({ path: '/version', timeout: 2000 }); }
  async configs() { return this.request({ path: '/configs' }); }
  async patchConfigs(body) { return this.request({ path: '/configs', method: 'PATCH', body }); }
  async proxies() { return this.request({ path: '/proxies' }); }

  async updateProxyProvider(name) {
    if (typeof name !== 'string' || !name) fail('代理提供商名称无效');
    return this.request({ path: `/providers/proxies/${encodeURIComponent(name)}`, method: 'PUT', timeout: 60000 });
  }
  async connections() { return this.request({ path: '/connections' }); }
  async memory() { return this.request({ path: '/memory' }); }

  async selectProxy(name, selection) {
    if (typeof name !== 'string' || !name || typeof selection !== 'string' || !selection) fail('代理组名称或节点无效');
    return this.request({ path: `/proxies/${encodeURIComponent(name)}`, method: 'PUT', body: { name: selection } });
  }

  async delay(name, { url = 'https://www.gstatic.com/generate_204', timeout = 5000 } = {}) {
    if (typeof name !== 'string' || !name) fail('节点名称无效');
    return this.request({ path: `/proxies/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`, timeout: timeout + 3000 });
  }

  async groupDelay(name, { url = 'https://www.gstatic.com/generate_204', timeout = 5000 } = {}) {
    if (typeof name !== 'string' || !name) fail('代理组名称无效');
    return this.request({ path: `/group/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`, timeout: timeout + 8000 });
  }

  async closeConnection(id) {
    if (typeof id !== 'string' || !id) fail('连接 ID 无效');
    return this.request({ path: `/connections/${encodeURIComponent(id)}`, method: 'DELETE' });
  }

  async closeAllConnections() { return this.request({ path: '/connections', method: 'DELETE' }); }

  /** Open a streaming endpoint (/traffic, /logs). Errors are reported as stream end. */
  openStream(path, { signal, onLine = () => {}, onEnd = () => {} } = {}) {
    let closed = false;
    const finish = error => {
      if (closed) return;
      closed = true;
      onEnd(error);
    };
    const request = http.request({ socketPath: this.socketPath, path, method: 'GET', headers: { accept: 'application/json' } }, response => {
      if (response.statusCode >= 400) {
        response.resume();
        finish(Error(`Controller 流接口返回 HTTP ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 4 * MAX_RESPONSE) { request.destroy(Error('Controller 流数据过大')); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { onLine(JSON.parse(line)); } catch { /* ignore malformed frames */ }
        }
      });
      response.on('end', () => finish(null));
      response.on('error', error => finish(error));
    });
    const abort = () => request.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', error => finish(error));
    request.end();
    return { close() { abort(); } };
  }
}
