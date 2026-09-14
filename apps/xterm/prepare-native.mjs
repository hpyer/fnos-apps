import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
// node-pty 1.1.0's npm tarball does not preserve the macOS helper mode.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  await chmod(
    path.join(
      path.dirname(require.resolve("node-pty/package.json")),
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    ),
    0o755,
  );
}
