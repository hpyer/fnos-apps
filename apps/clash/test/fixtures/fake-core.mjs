#!/usr/bin/env node
// Test-only stand-in for a mihomo core. It implements the small part of the
// external-controller API used by the manager so the whole process lifecycle can
// be exercised on macOS and Linux without downloading or executing mihomo.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const controlFile = process.env.FAKE_CORE_CONTROL || '';
let control = {};
try { control = JSON.parse(fs.readFileSync(controlFile, 'utf8')); } catch { control = {}; }

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : ''; };

if (argv.includes('-v') || argv.includes('version')) {
  process.stdout.write(`Mihomo Meta ${control.fakeVersion ? `v${control.fakeVersion}` : 'v1.19.33'} linux amd64 with go1.24.0\n`);
  process.exit(0);
}

const configFile = option('-f');
let config = '';
try { config = fs.readFileSync(configFile, 'utf8'); } catch { config = ''; }

if (argv.includes('-t') || argv.includes('-test')) {
  if (control.failConfigTest || config.includes('INVALID_CONFIG')) {
    process.stderr.write('configuration file test failed: fake validation error\n');
    process.exit(1);
  }
  process.stdout.write(`configuration file ${configFile} test is successful\n`);
  process.exit(0);
}

if (control.mode === 'crash') {
  process.stderr.write('fake core crashed at startup\n');
  process.exit(3);
}

function yamlValue(key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(config);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

const socketPath = yamlValue('external-controller-unix');
if (!socketPath) {
  process.stderr.write('missing external-controller-unix\n');
  process.exit(2);
}
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });

const startedAt = new Date().toISOString();
const groups = {
  Proxy: { type: 'Selector', now: 'Node A', all: ['DIRECT', 'Node A', 'Node B'] },
  Auto: { type: 'URLTest', now: 'Node B', all: ['Node A', 'Node B'], hidden: false },
};
const nodes = {
  DIRECT: { type: 'Direct', alive: true, history: [] },
  'Node A': { type: 'Shadowsocks', alive: true, udp: true, history: [{ time: startedAt, delay: 120 }] },
  'Node B': { type: 'VMess', alive: true, udp: false, history: [{ time: startedAt, delay: 460 }] },
};
let connections = [{
  id: 'conn-1', upload: 1024, download: 2048, start: startedAt,
  chains: ['Node A'], rule: 'Match', rulePayload: '',
  metadata: { network: 'tcp', type: 'HTTP', host: 'example.com', destinationIP: '93.184.216.34', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '50000' },
}];

function proxiesPayload() {
  const proxies = { ...nodes };
  for (const [name, group] of Object.entries(groups)) proxies[name] = { type: group.type, now: group.now, all: group.all, hidden: Boolean(group.hidden), history: [] };
  return { proxies };
}

function send(response, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

function readBody(request) {
  return new Promise(resolve => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

const streams = new Set();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/version') return send(response, 200, { meta: true, version: control.fakeControllerVersion || 'v1.19.33' });
  if (pathname === '/configs') {
    if (request.method === 'PATCH') {
      const body = await readBody(request);
      Object.assign(nodes, {});
      if (body.mode) control.mode = body.mode;
      config = `${config}\n# patched ${JSON.stringify(body)}\n`;
      return send(response, 204);
    }
    return send(response, 200, { mode: control.mode || 'rule', 'log-level': 'info', 'mixed-port': 7890, 'allow-lan': false });
  }
  if (pathname === '/proxies' && request.method === 'GET') return send(response, 200, proxiesPayload());
  if (pathname === '/providers/proxies' && request.method === 'GET') {
    return send(response, 200, { providers: { airport: {
      name: 'airport', vehicleType: 'HTTP', updatedAt: '2026-01-01T00:00:00Z',
      subscriptionInfo: { upload: 1024, download: 2048, total: 10240, expire: 1893456000 },
      proxies: [{ name: 'Provider Node', type: 'Shadowsocks', udp: true, alive: true, history: [{ time: '2026-01-01T00:00:00Z', delay: 88 }] }],
    } } });
  }
  if (/^\/providers\/proxies\/[^/]+$/.test(pathname) && request.method === 'PUT') return send(response, 204);
  const delayMatch = /^\/proxies\/([^/]+)\/delay$/.exec(pathname);
  if (delayMatch) {
    if (delayMatch[1] === 'Node A') return send(response, 200, { delay: 120 });
    if (delayMatch[1] === 'Node B') return send(response, 200, { delay: 460 });
    return send(response, 200, { delay: 0, message: 'timeout' });
  }
  const groupDelayMatch = /^\/group\/([^/]+)\/delay$/.exec(pathname);
  if (groupDelayMatch) return send(response, 200, { 'Node A': 120, 'Node B': 460 });
  const proxyMatch = /^\/proxies\/([^/]+)$/.exec(pathname);
  if (proxyMatch) {
    const name = proxyMatch[1];
    if (request.method === 'PUT') {
      const body = await readBody(request);
      if (groups[name] && groups[name].type === 'Selector' && body.name) { groups[name].now = body.name; return send(response, 204); }
      return send(response, 400, { message: 'invalid proxy selection' });
    }
    if (request.method === 'GET') return send(response, 200, proxiesPayload().proxies[name] || {});
  }
  if (pathname === '/connections') {
    if (request.method === 'GET') return send(response, 200, { downloadTotal: 2048, uploadTotal: 1024, connections });
    if (request.method === 'DELETE') { connections = []; return send(response, 204); }
  }
  const connectionMatch = /^\/connections\/(.+)$/.exec(pathname);
  if (connectionMatch && request.method === 'DELETE') {
    connections = connections.filter(item => item.id !== connectionMatch[1]);
    return send(response, 204);
  }
  if (pathname === '/memory') return send(response, 200, { inuse: 12 * 1024 * 1024, oslimit: 0 });
  if (pathname === '/traffic' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    streams.add(response);
    let tick = 0;
    const timer = setInterval(() => { tick += 1; response.write(`${JSON.stringify({ up: 100 + tick, down: 200 + tick })}\n`); }, 80);
    request.on('close', () => { clearInterval(timer); streams.delete(response); });
    return;
  }
  if (pathname === '/logs' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    streams.add(response);
    let tick = 0;
    const timer = setInterval(() => { tick += 1; response.write(`${JSON.stringify({ type: tick % 3 === 0 ? 'warning' : 'info', payload: `fake log line ${tick}` })}\n`); }, 100);
    request.on('close', () => { clearInterval(timer); streams.delete(response); });
    return;
  }
  send(response, 404, { message: 'not found' });
});

server.listen(socketPath, () => {
  if (control.crashAfterMs) setTimeout(() => { process.stderr.write('fake core exited unexpectedly\n'); process.exit(4); }, Number(control.crashAfterMs));
});

function shutdown() {
  for (const stream of streams) { try { stream.end(); } catch { /* closed */ } }
  server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); });
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
