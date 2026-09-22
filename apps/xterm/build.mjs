import "./prepare-native.mjs";
import { build } from "esbuild";
import { cp, mkdir, realpath, rm, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("./", import.meta.url));
const root = path.resolve(source, "../.."),
  target = path.join(root, "dist/xterm-for-fnos");
await rm(target, { recursive: true, force: true });
await cp(path.join(source, "native"), target, { recursive: true });
await mkdir(path.join(target, "app/web"), { recursive: true });
await build({
  entryPoints: [path.join(source, "src/main.mjs")],
  outfile: path.join(target, "app/main.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});
await cp(
  path.join(source, "src/worker.mjs"),
  path.join(target, "app/worker.mjs"),
);
await cp(path.join(source, "src/bashrc"), path.join(target, "app/bashrc"));
await cp(path.join(source, "src/su-shell"), path.join(target, "app/su-shell"));
for (const name of ["node-pty", "ws"]) {
  const installed = await realpath(path.join(source, "node_modules", name)),
    out = path.join(target, "app/node_modules", name);
  await mkdir(out, { recursive: true });
  for (const file of ["package.json", "LICENSE", "lib"])
    await cp(path.join(installed, file), path.join(out, file), {
      recursive: true,
    });
  if (name === "ws")
    for (const file of ["index.js", "wrapper.mjs"])
      await cp(path.join(installed, file), path.join(out, file));
  if (name === "node-pty") {
    const native = path.join(
      out,
      "prebuilds",
      `${process.platform}-${process.arch}`,
    );
    await mkdir(native, { recursive: true });
    const built = path.join(installed, "build/Release");
    const prebuilt = path.join(
      installed,
      "prebuilds",
      `${process.platform}-${process.arch}`,
    );
    let from = prebuilt;
    try {
      await access(path.join(built, "pty.node"));
      from = built;
    } catch {}
    for (const file of process.platform === "darwin"
      ? ["pty.node", "spawn-helper"]
      : ["pty.node"])
      await cp(path.join(from, file), path.join(native, file));
    const cached = path.join(root, ".cache/xterm-native");
    for (const arch of ["x64", "arm64"]) {
      try {
        await access(path.join(cached, `linux-${arch}/pty.node`));
        await cp(
          path.join(cached, `linux-${arch}`),
          path.join(out, "prebuilds", `linux-${arch}`),
          { recursive: true },
        );
      } catch {}
    }
  }
}
await build({
  entryPoints: [
    path.join(source, "src/web/index.js"),
    path.join(source, "src/web/index.css"),
  ],
  outdir: path.join(target, "app/web"),
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  minify: true,
});
for (const name of ["index.html", "icon.png"])
  await cp(
    path.join(source, "src/web", name),
    path.join(target, "app/web", name),
  );
await mkdir(path.join(target, "app/licenses"), { recursive: true });
for (const name of [
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-unicode-graphemes",
])
  await cp(
    path.join(source, "node_modules", name, "LICENSE"),
    path.join(target, "app/licenses", name.split("/")[1] + "-LICENSE"),
  );
console.log(
  `已构建 ${target}（原生依赖：${process.platform}/${process.arch}；打包时校验 Linux 目标文件）`,
);

const addonRequire = (await import("node:module")).createRequire(
  path.join(
    await realpath(path.join(source, "node_modules/node-pty")),
    "package.json",
  ),
);
await cp(
  path.join(
    path.dirname(addonRequire.resolve("node-addon-api/package.json")),
    "LICENSE.md",
  ),
  path.join(target, "app/licenses/node-addon-api-LICENSE.md"),
);
