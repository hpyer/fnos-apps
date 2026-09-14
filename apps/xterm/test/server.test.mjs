import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { serve, PREFIX } from "../src/server.mjs";
const admin = {
  "x-trim-userid": "1000",
  "x-trim-isadmin": "true",
  origin: "http://nas.test",
};
async function fixture(t) {
  const dir = await mkdtemp(tmpdir() + "/xterm-test-");
  for (const name of ["index.html", "index.js", "index.css", "icon.png"])
    await writeFile(dir + "/" + name, "fixture");
  const spawned = [];
  let stopped = 0,
    clock = 100;
  const service = await serve({
    assets: pathToFileURL(dir + "/"),
    socket: dir + "/app.sock",
    identity: { username: "package" },
    now: () => clock,
    createTerminal: (size, send) => {
      spawned.push({ size, send });
      setImmediate(() => send({ type: "ready" }));
      return {
        input: (data) => send({ type: "data", data }),
        resize: (size) => {
          spawned.at(-1).size = size;
        },
        ack: () => {},
        stop: () => {
          stopped++;
        },
      };
    },
  });
  t.after(async () => {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  });
  function request(route, headers = admin, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: dir + "/app.sock",
          path: PREFIX + route,
          headers,
          method,
        },
        (res) => {
          let data = "";
          res.on("data", (v) => (data += v));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  async function ticket(headers = admin) {
    const result = await request(
      "/api/ticket",
      { ...headers, "x-fnos-request": "1" },
      "POST",
    );
    assert.equal(result.status, 200);
    return JSON.parse(result.data).ticket;
  }
  function connect(headers = admin) {
    return new WebSocket("ws://localhost" + PREFIX + "/ws", {
      createConnection: () => net.connect(dir + "/app.sock"),
      headers,
    });
  }
  return {
    request,
    ticket,
    connect,
    spawned,
    get stopped() {
      return stopped;
    },
    expire() {
      clock += 16000;
    },
  };
}
function event(ws, name) {
  return new Promise((resolve, reject) => {
    ws.once(name, (...args) => resolve(args));
    ws.once("error", reject);
  });
}
async function open(f, token, headers = admin) {
  const ws = f.connect(headers);
  await event(ws, "open");
  const response = event(ws, "message");
  ws.send(JSON.stringify({ type: "open", ticket: token, cols: 80, rows: 24 }));
  await response;
  return ws;
}
test("HTTP requires administrator, custom header, valid origin and exact route", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/", {})).status, 403);
  assert.equal(
    (await f.request("/", { ...admin, "x-trim-isadmin": "false" })).status,
    403,
  );
  assert.equal((await f.request("/", admin)).status, 200);
  assert.equal((await f.request("/api/ticket", admin, "POST")).status, 403);
  assert.equal(
    (
      await f.request(
        "/api/ticket",
        { ...admin, "x-fnos-request": "1", origin: "null" },
        "POST",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/ticket",
        { ...admin, "x-fnos-request": "1", "sec-fetch-site": "cross-site" },
        "POST",
      )
    ).status,
    403,
  );
  assert.equal((await f.request("/../index.html")).status, 404);
});
test("upgrade cannot bypass administrator authorization", async (t) => {
  const f = await fixture(t);
  const ws = f.connect({ ...admin, "x-trim-isadmin": "false" });
  await new Promise((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 403);
      res.resume();
      ws.terminate();
      resolve();
    });
    ws.on("error", () => {});
  });
  assert.equal(f.spawned.length, 0);
});
test("ticket bound to UID and origin, expiry, no shell before auth", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { ...admin, "x-trim-userid": "1001" },
    { ...admin, origin: "http://evil.test" },
    admin,
  ]) {
    const token = await f.ticket();
    if (headers === admin) f.expire();
    const ws = f.connect(headers);
    await event(ws, "open");
    const closed = event(ws, "close");
    ws.send(
      JSON.stringify({ type: "open", ticket: token, cols: 80, rows: 24 }),
    );
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(f.spawned.length, 0);
});
test("single-use ticket, I/O, size validation and disconnect cleanup", async (t) => {
  const f = await fixture(t),
    token = await f.ticket(),
    ws = await open(f, token);
  const output = event(ws, "message");
  ws.send(JSON.stringify({ type: "input", data: "hello 中文" }));
  assert.equal(JSON.parse((await output)[0]).data, "hello 中文");
  const second = f.connect();
  await event(second, "open");
  const rejected = event(second, "close");
  second.send(
    JSON.stringify({ type: "open", ticket: token, cols: 80, rows: 24 }),
  );
  assert.equal((await rejected)[0], 1008);
  const closed = event(ws, "close");
  ws.send(JSON.stringify({ type: "resize", cols: 1000000, rows: 24 }));
  await closed;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.spawned.length, 1);
  assert.equal(f.stopped, 1);
});
test("second authenticated session rejected; service stop cleans live PTY", async (t) => {
  const f = await fixture(t);
  const first = await open(f, await f.ticket());
  const token = await f.ticket();
  const second = f.connect();
  await event(second, "open");
  const closed = event(second, "close");
  second.send(
    JSON.stringify({ type: "open", ticket: token, cols: 80, rows: 24 }),
  );
  assert.equal((await closed)[0], 1008);
  const done = event(first, "close");
  await f.request("/");
  first.close();
  await done;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.stopped, 1);
});
