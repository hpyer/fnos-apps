import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, chmod, rm } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
export const PREFIX = "/app/xterm-for-fnos";
export function dimensions(value) {
  return (
    value &&
    Number.isInteger(value.cols) &&
    value.cols >= 2 &&
    value.cols <= 500 &&
    Number.isInteger(value.rows) &&
    value.rows >= 1 &&
    value.rows <= 200
  );
}
export async function serve({
  assets,
  socket,
  devPort,
  createTerminal,
  identity,
  now = Date.now,
}) {
  const files = new Map(
    await Promise.all(
      ["index.html", "index.js", "index.css", "icon.png"].map(async (name) => [
        name,
        await readFile(new URL(name, assets)),
      ]),
    ),
  );
  const tickets = new Map(),
    sessions = new Map(),
    connections = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32768,
    perMessageDeflate: false,
  });
  const uid = (req) => {
    if (req.headers["sec-fetch-site"] === "cross-site") return null;
    if (devPort !== undefined)
      return req.headers.host === `127.0.0.1:${server.address().port}`
        ? "dev"
        : null;
    return /^\d+$/.test(req.headers["x-trim-userid"] || "") &&
      req.headers["x-trim-isadmin"] === "true"
      ? req.headers["x-trim-userid"]
      : null;
  };
  function json(res, status, data) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  function validOrigin(origin) {
    try {
      const url = new URL(origin);
      return (
        ["http:", "https:"].includes(url.protocol) && url.origin === origin
      );
    } catch {
      return false;
    }
  }
  const server = http.createServer((req, res) => {
    const user = uid(req);
    if (!user) return json(res, 403, { error: "仅限飞牛管理员访问" });
    if (req.method === "GET" && req.url === PREFIX) {
      res.writeHead(302, { location: PREFIX + "/" });
      return res.end();
    }
    if (req.method === "POST" && req.url === PREFIX + "/api/ticket") {
      req.resume();
      const origin = req.headers.origin;
      if (
        req.headers["x-fnos-request"] !== "1" ||
        !validOrigin(origin) ||
        (devPort !== undefined &&
          origin !== `http://127.0.0.1:${server.address().port}`)
      )
        return json(res, 403, { error: "请求来源校验失败" });
      for (const [key, value] of tickets)
        if (value.expires <= now() || value.uid === user) tickets.delete(key);
      if (tickets.size >= 64) return json(res, 429, { error: "连接请求过多" });
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, { uid: user, origin, expires: now() + 15000 });
      return json(res, 200, { ticket, identity });
    }
    const name =
      req.url === PREFIX + "/"
        ? "index.html"
        : req.url?.slice(PREFIX.length + 1);
    if (
      req.method !== "GET" ||
      !req.url.startsWith(PREFIX + "/") ||
      !files.has(name)
    )
      return json(res, 404, { error: "未找到接口" });
    res.writeHead(200, {
      "content-type": {
        "index.html": "text/html; charset=utf-8",
        "index.js": "text/javascript",
        "index.css": "text/css",
        "icon.png": "image/png",
      }[name],
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(files.get(name));
  });
  server.on("connection", (s) => {
    connections.add(s);
    s.once("close", () => connections.delete(s));
  });
  server.on("upgrade", (req, socket, head) => {
    const user = uid(req),
      origin = req.headers.origin;
    if (
      req.url !== PREFIX + "/ws" ||
      !user ||
      !validOrigin(origin) ||
      wss.clients.size >= 16
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let terminal,
        authenticated = false,
        alive = true;
      const timeout = setTimeout(() => ws.close(1008, "连接凭据超时"), 5000);
      const send = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 262144) return ws.terminate();
          ws.send(JSON.stringify(data));
        }
      };
      ws.on("error", () => ws.terminate());
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 15000);
      ws.on("close", () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (sessions.get(user) === ws) sessions.delete(user);
        terminal?.stop();
      });
      ws.on("message", (raw, binary) => {
        try {
          if (binary) throw Error();
          const data = JSON.parse(raw.toString());
          if (!authenticated) {
            const grant = tickets.get(data.ticket);
            if (
              data.type !== "open" ||
              !grant ||
              grant.uid !== user ||
              grant.origin !== origin ||
              grant.expires <= now() ||
              !dimensions(data)
            )
              throw Error();
            tickets.delete(data.ticket);
            if (sessions.has(user) || sessions.size >= 4) {
              ws.close(1008, "已有连接，请先断开");
              return;
            }
            authenticated = true;
            clearTimeout(timeout);
            sessions.set(user, ws);
            terminal = createTerminal(data, (message) => {
              send(
                message.type === "ready" ? { ...message, identity } : message,
              );
              if (message.type === "exit") ws.close(1000, "Shell 已退出");
            });
            return;
          }
          if (
            data.type === "input" &&
            typeof data.data === "string" &&
            data.data.length <= 8192
          )
            terminal.input(data.data);
          else if (data.type === "resize" && dimensions(data))
            terminal.resize(data);
          else if (
            data.type === "ack" &&
            Number.isInteger(data.count) &&
            data.count > 0 &&
            data.count <= 262144
          )
            terminal.ack(data.count);
          else throw Error();
        } catch {
          ws.close(1008, "终端请求无效或启动失败");
        }
      });
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  if (socket) await rm(socket, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket || { host: "127.0.0.1", port: devPort }, resolve);
  });
  if (socket) await chmod(socket, 0o660);
  return {
    server,
    async stop() {
      for (const ws of wss.clients) ws.terminate();
      for (const s of connections) s.destroy();
      await new Promise((r) => server.close(r));
      wss.close();
      if (socket) await rm(socket, { force: true });
    },
  };
}
