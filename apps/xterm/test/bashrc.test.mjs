import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bashrc = fileURLToPath(new URL("../src/bashrc", import.meta.url));
const suShell = fileURLToPath(new URL("../src/su-shell", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startShell({ home, proxy, wrapper = false, appEnv = true }) {
  const child = spawn(wrapper ? suShell : "/bin/bash", wrapper ? ["-i"] : ["--noprofile", "--rcfile", bashrc, "-i"], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TERM: "dumb",
      LANG: "C.UTF-8",
      XTERM_PROXY_FILE: proxy,
      ...(appEnv ? { XTERM_BASHRC: bashrc, XTERM_SU_SHELL: suShell } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const waiters = [];
  const timer = setTimeout(() => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`shell output timeout:\n${output.slice(-2000)}`));
  }, 8000);
  const data = (chunk) => {
    output += chunk.toString();
    for (let i = waiters.length - 1; i >= 0; i--)
      if (waiters[i].pattern.test(output)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
  };
  child.stdout.on("data", data);
  child.stderr.on("data", data);
  child.once("close", () => {
    clearTimeout(timer);
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`shell exited before output:\n${output.slice(-2000)}`));
  });
  return {
    child,
    get output() {
      return output;
    },
    send(data) {
      child.stdin.write(data);
    },
    wait(pattern) {
      if (pattern.test(output)) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({ pattern, resolve, reject }));
    },
  };
}

function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "xterm-bashrc-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const proxy = path.join(home, "system-environment");
  return { home, proxy };
}

test("bashrc and su-shell are valid shell scripts", () => {
  for (const file of [bashrc, suShell])
    assert.equal(spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" }).status, 0, file);
});

test("history is written per command, survives SIGKILL and deduplicates repeats", { timeout: 15000 }, async (t) => {
  const { home, proxy } = await fixture(t);
  await writeFile(proxy, "");
  const shell = startShell({ home, proxy });
  shell.send("echo HIST_ALPHA\n");
  shell.send("echo HIST_ALPHA\n");
  shell.send("echo HIST_BETA\n");
  await shell.wait(/HIST_BETA/);
  await sleep(300);
  shell.child.kill("SIGKILL");
  await closed(shell.child);

  const history = await readFile(path.join(home, ".xterm_history"), "utf8");
  assert.equal(history.split("\n").filter((line) => line.includes("HIST_ALPHA")).length, 1);
  assert.equal(history.split("\n").filter((line) => line.includes("HIST_BETA")).length, 1);
  assert.equal((await stat(path.join(home, ".xterm_history"))).mode & 0o777, 0o600);

  const second = startShell({ home, proxy });
  second.send("history; echo HISTORY_READY\n");
  await second.wait(/HISTORY_READY/);
  second.send("exit\n");
  await closed(second.child);
  assert.equal(second.output.split("HIST_ALPHA").length - 1, 1);
  assert.equal(second.output.split("HIST_BETA").length - 1, 1);
});

test("history file is compacted before an interactive shell loads it", { timeout: 15000 }, async (t) => {
  const { home, proxy } = await fixture(t);
  await writeFile(proxy, "");
  await writeFile(path.join(home, ".xterm_history"), "echo OLD\necho OLD\necho NEW\n");
  const shell = startShell({ home, proxy });
  shell.send("history; echo COMPACT_READY\n");
  await shell.wait(/COMPACT_READY/);
  shell.send("exit\n");
  await closed(shell.child);
  assert.equal(shell.output.split("echo OLD").length - 1, 1);
  assert.equal(shell.output.split("echo NEW").length - 1, 1);
});

test("system proxy is imported, mirrored across cases and refreshed without reconnecting", { timeout: 20000 }, async (t) => {
  const { home, proxy } = await fixture(t);
  await writeFile(
    proxy,
    [
      "# system proxy",
      "PATH=/does/not/exist",
      'http_proxy="http://127.0.0.1:7890"',
      "HTTPS_PROXY='http://127.0.0.1:7890'",
      "NO_PROXY=localhost,127.0.0.1",
      "",
    ].join("\n"),
  );
  const shell = startShell({ home, proxy });
  shell.send(
    "printf 'PROXY1[%s][%s][%s][%s][%s]\\n' \"$http_proxy\" \"$HTTP_PROXY\" \"$https_proxy\" \"$HTTPS_PROXY\" \"$NO_PROXY\"\n",
  );
  shell.send("printf 'PATH1[%s]\\n' \"$PATH\"\n");
  await shell.wait(/PROXY1\[http:\/\/127\.0\.0\.1:7890\]\[http:\/\/127\.0\.0\.1:7890\]\[http:\/\/127\.0\.0\.1:7890\]\[http:\/\/127\.0\.0\.1:7890\]\[localhost,127\.0\.0\.1\]/);
  await shell.wait(/PATH1\[/);
  assert.doesNotMatch(shell.output, /PATH1\[[^\]]*\/does\/not\/exist/);

  await writeFile(proxy, "http_proxy=http://127.0.0.1:1111\n");
  await sleep(1200);
  shell.send("printf 'PROXY2[%s][%s]\\n' \"$http_proxy\" \"$HTTPS_PROXY\"\n");
  await shell.wait(/PROXY2\[http:\/\/127\.0\.0\.1:1111\]\[\]/);

  await writeFile(proxy, "# no proxy\n");
  await sleep(1200);
  shell.send("printf 'PROXY3[%s][%s]\\n' \"$http_proxy\" \"$HTTPS_PROXY\"\n");
  await shell.wait(/PROXY3\[\]\[\]/);

  shell.send("exit\n");
  await closed(shell.child);
});

test("su-shell keeps the app rcfile, history and system proxy", { timeout: 15000 }, async (t) => {
  const { home, proxy } = await fixture(t);
  await writeFile(proxy, "http_proxy=http://127.0.0.1:2222\n");
  // Simulate `su -`: the target shell no longer inherits XTERM_BASHRC or
  // XTERM_SU_SHELL, so the wrapper must locate the app directory itself.
  const shell = startShell({ home, proxy, wrapper: true, appEnv: false });
  shell.send("printf 'SU_PROXY[%s]\\n' \"$http_proxy\"\n");
  shell.send("echo SU_HISTORY\n");
  await shell.wait(/SU_HISTORY/);
  shell.send("exit\n");
  await closed(shell.child);
  assert.match(shell.output, /SU_PROXY\[http:\/\/127\.0\.0\.1:2222\]/);
  const history = await readFile(path.join(home, ".xterm_history"), "utf8");
  assert.match(history, /^echo SU_HISTORY$/m);
});
