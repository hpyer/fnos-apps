import pty from "node-pty";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const bashrc = fileURLToPath(new URL("./bashrc", import.meta.url));
const suShell = fileURLToPath(new URL("./su-shell", import.meta.url));
let terminal,
  stopping = false,
  pending = 0;
const send = (message) => {
  if (process.connected)
    process.send(message, (error) => {
      if (error) stop();
    });
};
// PTY job control creates additional process groups. Kill all processes in
// the Linux terminal session, including foreground jobs, before the shell.
function stop() {
  if (stopping) return;
  stopping = true;
  if (terminal) {
    if (process.platform === "linux") {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (
            Number(fields[3]) === terminal.pid &&
            Number(entry) !== terminal.pid
          )
            process.kill(Number(entry), "SIGKILL");
        } catch {}
      }
    }
    try {
      process.kill(-terminal.pid, "SIGKILL");
    } catch {}
    try {
      terminal.kill("SIGKILL");
    } catch {}
  }
  process.exit(0);
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", () => {
  send({ type: "exit", code: 1 });
  stop();
});
process.on("message", (message) => {
  if (message.type === "start" && !terminal) {
    terminal = pty.spawn("/bin/bash", ["--noprofile", "--rcfile", bashrc], {
      name: "xterm-256color",
      cols: message.cols,
      rows: message.rows,
      cwd: message.home,
      env: {
        ...process.env,
        HOME: message.home,
        XTERM_BASHRC: bashrc,
        XTERM_SU_SHELL: suShell,
        TERM: "xterm-256color",
        PS1: "\\u@\\h:\\w\\$ ",
      },
    });
    terminal.onData((data) => {
      pending += data.length;
      if (pending > 262144) return stop();
      if (pending >= 65536) terminal.pause();
      send({ type: "data", data });
    });
    terminal.onExit(({ exitCode }) => {
      send({ type: "exit", code: exitCode });
      stop();
    });
    send({ type: "ready" });
  } else if (message.type === "input") terminal?.write(message.data);
  else if (message.type === "resize")
    terminal?.resize(message.cols, message.rows);
  else if (message.type === "ack") {
    if (message.count > pending) return stop();
    pending -= message.count;
    if (pending < 32768) terminal?.resume();
  }
});
