import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ControllerClient } from '../src/controller-client.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clash-controller-'));
  const socket = path.join(directory, 'controller.sock');
  const state = { mode: 'rule', selected: 'Node A', connections: [{ id: 'c1', upload: 1, download: 2, chains: ['Node A'], metadata: { host: 'example.com' } }] };
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(value === undefined ? '' : JSON.stringify(value)); };
    if (url.pathname === '/version') return send(200, { meta: true, version: 'v1.19.33' });
    if (url.pathname === '/configs') return send(200, { mode: state.mode, 'log-level': 'info' });
    if (url.pathname === '/proxies') return send(200, { proxies: { Proxy: { type: 'Selector', now: state.selected, all: ['Node A', 'Node B'] }, 'Node A': { type: 'Shadowsocks', history: [{ time: 'x', delay: 120 }] } } });
    const proxyDelay = /^\/proxies\/(.+)\/delay$/.exec(decodeURIComponent(url.pathname));
    if (proxyDelay) return send(200, { delay: 120 });
    const groupDelay = /^\/group\/(.+)\/delay$/.exec(decodeURIComponent(url.pathname));
    if (groupDelay) return send(200, { 'Node A': 120, 'Node B': 460 });
    const proxy = /^\/proxies\/(.+)$/.exec(decodeURIComponent(url.pathname));
    if (proxy) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try { state.selected = JSON.parse(body).name; } catch { /* ignore */ }
        send(204);
      });
      return;
    }
    if (url.pathname === '/connections') {
      if (request.method === 'DELETE') { state.connections = []; return send(204); }
      return send(200, { downloadTotal: 100, uploadTotal: 50, connections: state.connections });
    }
    if (/^\/connections\/.+$/.test(url.pathname)) { state.connections = []; return send(204); }
    if (url.pathname === '/memory') return send(200, { inuse: 1024, oslimit: 0 });
    if (url.pathname === '/traffic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      let tick = 0;
      const timer = setInterval(() => { tick += 1; response.write(`${JSON.stringify({ up: tick, down: tick * 2 })}\n`); }, 40);
      request.on('close', () => clearInterval(timer));
      return;
    }
    if (url.pathname === '/error') return send(401, { message: 'invalid secret' });
    send(404, { message: 'not found' });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client: new ControllerClient({ socketPath: socket }), state, requests };
}

test('Controller 常用接口通过 Unix Socket 工作', async t => {
  const { client, state, requests } = await fixture(t);
  assert.equal((await client.version()).version, 'v1.19.33');
  assert.equal((await client.configs()).mode, 'rule');
  assert.equal((await client.memory()).inuse, 1024);
  await client.selectProxy('Proxy', 'Node B');
  assert.equal(state.selected, 'Node B');
  assert.equal((await client.delay('Node A')).delay, 120);
  assert.deepEqual(await client.groupDelay('Proxy'), { 'Node A': 120, 'Node B': 460 });
  assert.equal((await client.connections()).connections.length, 1);
  await client.closeConnection('c1');
  await client.closeAllConnections();
  assert.ok(requests.some(item => item.startsWith('PUT /proxies/Proxy')));
  assert.ok(requests.some(item => item.includes('/proxies/Node%20A/delay') || item.includes('/proxies/Node A/delay')));
});

test('流式接口持续解析 JSON 行并可关闭', async t => {
  const { client } = await fixture(t);
  const samples = [];
  const stream = client.openStream('/traffic', { onLine: sample => samples.push(sample) });
  await new Promise(resolve => setTimeout(resolve, 220));
  stream.close();
  assert.ok(samples.length >= 2);
  assert.ok(samples.every(sample => typeof sample.up === 'number' && typeof sample.down === 'number'));
});

test('错误响应转换为中文错误', async t => {
  const { client } = await fixture(t);
  await assert.rejects(() => client.request({ path: '/error' }), /invalid secret/);
  await assert.rejects(() => client.request({ path: '/missing' }), /not found/);
});
