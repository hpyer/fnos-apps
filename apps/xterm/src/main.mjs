import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, PREFIX } from "./server.mjs";
import { createTerminalFactory } from "./terminal.mjs";
const dev = process.argv.includes("--dev");
if (!dev && process.getuid() === 0) throw Error("终端服务必须以应用包用户运行");
const root =
  process.env.TRIM_PKGVAR || (dev ? path.resolve(".local/xterm") : null);
if (!root) throw Error("缺少 TRIM_PKGVAR");
const home = path.join(root, "home");
await mkdir(home, { recursive: true, mode: 0o700 });
// Do not inherit NAS cookies, application credentials or the full host env.
const environment = {
  PATH: "/var/apps/nodejs_v24/target/bin:/usr/local/bin:/usr/bin:/bin",
  LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
  BASH_SILENCE_DEPRECATION_WARNING: "1",
  EXINIT: "if exists('+emoji') | set noemoji | endif",
  HOME: home,
  USER: os.userInfo().username,
  LOGNAME: os.userInfo().username,
};
const service = await serve({
  assets: new URL("./web/", import.meta.url),
  devPort: dev ? 3082 : undefined,
  socket: dev ? undefined : path.join(process.env.TRIM_APPDEST, "app.sock"),
  identity: {
    username: os.userInfo().username,
    uid: process.getuid(),
    mode: dev ? "本机开发账号" : "应用包用户",
  },
  createTerminal: createTerminalFactory({
    home,
    environment,
    worker: fileURLToPath(new URL("./worker.mjs", import.meta.url)),
  }),
});
console.log(
  dev ? `Xterm：http://127.0.0.1:3082${PREFIX}/` : "Xterm 服务已启动",
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await service.stop();
    process.exit(0);
  });
