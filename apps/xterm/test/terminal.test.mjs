import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTerminalFactory } from "../src/terminal.mjs";
test(
  "real PTY supports TTY, Unicode, resize, Ctrl+C and disconnect cleanup",
  { timeout: 15000 },
  async (t) => {
    const home = await mkdtemp(tmpdir() + "/xterm-pty-");
    t.after(() => rm(home, { recursive: true, force: true }));
    const userBashrc = home + "/bashrc";
    await writeFile(userBashrc, "alias usercmd='printf USER_CONFIG_OK'\n");
    let output = "",
      terminal;
    const waiters = [];
    function wait(pattern) {
      if (pattern.test(output)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ pattern, resolve }));
    }
    terminal = createTerminalFactory({
      home,
      worker: fileURLToPath(new URL("../src/worker.mjs", import.meta.url)),
      environment: {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        XTERM_USER_BASHRC: userBashrc,
      },
    })({ type: "open", cols: 80, rows: 24 }, (message) => {
      if (message.type === "data") {
        output += message.data;
        terminal.ack(message.data.length);
        for (const w of waiters) if (w.pattern.test(output)) w.resolve();
      }
    });
    t.after(() => terminal.stop());
    await wait(/\x1b\[1;32m/);
    terminal.input("type ll\r");
    await wait(/ll is aliased to .*ls -alF/);
    terminal.input("type usercmd\r");
    await wait(/usercmd is aliased to .*printf USER_CONFIG_OK/);
    terminal.input(
      "printf '\\120\\124\\131_READY'; test -t 0 && printf '\\124\\124\\131_OK'; printf '\\344\\270\\255\\346\\226\\207'; echo $$\r",
    );
    await wait(/PTY_READYTTY_OK中文\d+/);
    const pid = Number(output.match(/PTY_READYTTY_OK中文(\d+)/)[1]);
    terminal.resize({ cols: 101, rows: 31 });
    terminal.input("stty size\r");
    await wait(/31 101/);
    terminal.input("sleep 30\r");
    await new Promise((r) => setTimeout(r, 100));
    terminal.input("\x03");
    terminal.input("printf '\\103\\124\\122\\114_OK'\r");
    await wait(/CTRL_OK/);
    terminal.stop();
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(alive, false, "Shell must exit when owner disconnects");
  },
);
