import { fork } from "node:child_process";
export function createTerminalFactory({ home, worker, environment }) {
  return (size, onMessage) => {
    const child = fork(worker, [], {
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let ended = false,
      queued = 0;
    const send = (message) => {
      if (!child.connected) return;
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (queued + bytes > 65536) {
        child.disconnect();
        return;
      }
      queued += bytes;
      child.send(message, () => {
        queued -= bytes;
      });
    };
    child.on("message", onMessage);
    child.on("error", () => {
      if (!ended) {
        ended = true;
        onMessage({ type: "exit", code: 1 });
      }
    });
    child.on("exit", (code) => {
      if (!ended) {
        ended = true;
        onMessage({ type: "exit", code: code ?? 1 });
      }
    });
    send({ type: "start", cols: size.cols, rows: size.rows, home });
    return {
      input: (data) => send({ type: "input", data }),
      resize: (size) => send({ type: "resize", ...size }),
      ack: (count) => send({ type: "ack", count }),
      stop() {
        if (child.connected) child.disconnect();
      },
    };
  };
}
