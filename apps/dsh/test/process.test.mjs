import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { probe, DshProcess } from '../src/runtime/process.mjs';
import { listen } from '../src/server/server.mjs';

for (const location of ['/', './']) test(`readiness accepts a ${location} token redirect and verifies the authenticated index`, async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/?token=test') { res.writeHead(303, { location, 'set-cookie': 'dsh_auth=yes; HttpOnly; Path=/' }); res.end(); }
    else { res.writeHead(req.headers.cookie === 'dsh_auth=yes' ? 200 : 401); res.end('index'); }
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/?token=test`);
  assert.equal(await probe(url), true);
  assert.equal(await probe(new URL('/', url)), false);
});
test('readiness rejects a token redirect away from the authenticated index', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(303, { location: '/other', 'set-cookie': 'dsh_auth=yes; HttpOnly; Path=/' });
    res.end();
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(await probe(new URL(`http://127.0.0.1:${server.address().port}/?token=test`)), false);
});
test('owned process can observe a market operation through its authenticated session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-process-market-'));
  const entry = path.join(root, 'fixture.mjs');
  await writeFile(entry, `import http from 'node:http'; let polls=0; const s=http.createServer((q,r)=>{if(q.url==='/dsh-market/status'){r.setHeader('content-type','application/json');return r.end(JSON.stringify({active:++polls===1,busy:false}))}r.end('ok')});s.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+s.address().port+'/'));`);
  const process = new DshProcess({ ...globalThis.process.env });
  t.after(async () => { await process.stop(); await rm(root, { recursive: true, force: true }); });
  await process.start(entry, root);
  assert.equal(await process.pluginOperationState(), 'active');
  assert.equal(await process.pluginOperationState(), 'idle');
});
test('an unavailable market status is never treated as a completed operation', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const process = new DshProcess({});
  process.address = new URL(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await process.pluginOperationState(), 'unavailable');
  assert.equal(await process.pluginOperationActive(), true);
});
test('owned process starts when DSH redirects the launch token to ./', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-process-token-'));
  const entry = path.join(root, 'fixture.mjs');
  await writeFile(entry, `import http from 'node:http'; const s=http.createServer((q,r)=>{if(q.url==='/?token=test'){r.writeHead(303,{location:'./','set-cookie':'dsh_auth=yes; HttpOnly; Path=/'});return r.end()}r.writeHead(q.headers.cookie==='dsh_auth=yes'?200:401);r.end('index')});s.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+s.address().port+'/?token=test'));`);
  const process = new DshProcess({ ...globalThis.process.env });
  t.after(async () => { await process.stop(); await rm(root, { recursive: true, force: true }); });
  await process.start(entry, root);
  assert.equal(process.authCookie, 'dsh_auth=yes');
  assert.equal((await fetch(new URL('/', process.address), { headers: { cookie: process.authCookie } })).status, 200);
});
test('owned worker starts and stops a real child server', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-process-'));
  const entry = path.join(root, 'fixture.mjs');
  await writeFile(entry, `import http from 'node:http'; const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+s.address().port+'/'));`);
  const process = new DshProcess({ ...globalThis.process.env });
  t.after(async () => { await process.stop(); await rm(root, { recursive: true, force: true }); });
  await process.start(entry, root);
  const address = process.address;
  assert.equal((await fetch(address)).status, 200);
  await process.stop();
  assert.equal(process.child, null);
  await assert.rejects(fetch(address));
});
