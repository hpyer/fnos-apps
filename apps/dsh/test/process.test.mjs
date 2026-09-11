import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { probe, DshProcess } from '../src/runtime/process.mjs';
import { listen } from '../src/server/server.mjs';

test('readiness exchanges the DSH launch token and verifies the authenticated index', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/?token=test') { res.writeHead(303, { location: '/', 'set-cookie': 'dsh_auth=yes; HttpOnly; Path=/' }); res.end(); }
    else { res.writeHead(req.headers.cookie === 'dsh_auth=yes' ? 200 : 401); res.end('index'); }
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/?token=test`);
  assert.equal(await probe(url), true);
  assert.equal(await probe(new URL('/', url)), false);
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
