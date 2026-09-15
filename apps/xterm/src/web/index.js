import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily:
    'Menlo, Consolas, "Liberation Mono", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace',
  scrollback: 3000,
  theme: {
    background: "#101112",
    foreground: "#e1e4e8",
    cursor: "#65b3df",
    selectionBackground: "#30516a",
  },
  allowProposedApi: true,
});
const fit = new FitAddon();
const unicodeGraphemes = new UnicodeGraphemesAddon();
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
term.loadAddon(fit);
term.loadAddon(unicodeGraphemes);
term.open(document.querySelector("#terminal"));
term.registerCharacterJoiner((text) => {
  const ranges = [];
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    if (
      [...segment].length > 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment)
    )
      ranges.push([index, index + segment.length]);
  }
  return ranges;
});
const $ = (id) => document.getElementById(id);
let socket,
  connecting = false,
  ready = false;
const send = (data) => {
  if (ready && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(data));
};
function resize() {
  fit.fit();
  $("size").textContent = `${term.cols} × ${term.rows}`;
  send({ type: "resize", cols: term.cols, rows: term.rows });
}
new ResizeObserver(resize).observe($("terminal"));
term.onData((data) => {
  for (let i = 0; i < data.length; i += 4096)
    send({ type: "input", data: data.slice(i, i + 4096) });
});
term.onBinary((data) => {
  send({ type: "input", data });
});
$("clear").onclick = () => {
  term.clear();
  term.focus();
};
$("disconnect").onclick = () => {
  socket?.close(1000, "用户断开");
};
$("connect").onclick = async () => {
  if (connecting || socket) return;
  connecting = true;
  $("connect").disabled = true;
  $("status").textContent = "正在连接…";
  try {
    const result = await fetch("./api/ticket", {
      method: "POST",
      headers: { "x-fnos-request": "1" },
    });
    if (!result.ok) throw Error((await result.json()).error);
    const { ticket, identity } = await result.json();
    $("identity").textContent =
      `${identity.mode} · ${identity.username} (UID ${identity.uid})`;
    const url = new URL("./ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "open",
          ticket,
          cols: term.cols,
          rows: term.rows,
        }),
      );
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        ready = true;
        term.reset();
        resize();
        $("empty").hidden = true;
        $("status").textContent = "已连接";
        $("disconnect").disabled = false;
        term.focus();
      }
      if (message.type === "data")
        term.write(message.data, () => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({ type: "ack", count: message.data.length }),
            );
        });
      if (message.type === "exit")
        $("status").textContent = `Shell 已退出 (${message.code})`;
    };
    ws.onclose = (event) => {
      ready = false;
      socket = null;
      $("connect").disabled = false;
      $("disconnect").disabled = true;
      $("connect").textContent = "新建会话";
      $("status").textContent = event.reason || "连接已结束";
    };
    ws.onerror = () => {
      $("status").textContent = "连接失败，请重新打开应用后重试";
    };
  } catch (error) {
    $("status").textContent = error.message;
    $("connect").disabled = false;
  } finally {
    connecting = false;
  }
};
addEventListener("pagehide", () => socket?.close());
resize();
