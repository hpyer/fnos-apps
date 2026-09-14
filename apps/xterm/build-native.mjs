import { spawnSync } from "node:child_process";
import { mkdir, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, index, args) =>
        index % 2 ? pairs : [...pairs, [value, args[index + 1]]],
      [],
    ),
);
if (!options["--zig"] || !options["--headers"])
  throw Error(
    "用法：node apps/xterm/build-native.mjs --zig /path/to/zig --headers /path/to/include/node",
  );
const root = fileURLToPath(new URL("../../", import.meta.url));
const pty = path.dirname(require.resolve("node-pty/package.json"));
const addon = path.dirname(
  createRequire(path.join(pty, "package.json")).resolve(
    "node-addon-api/package.json",
  ),
);
for (const [arch, target] of [
  ["x64", "x86_64-linux-gnu.2.31"],
  ["arm64", "aarch64-linux-gnu.2.31"],
]) {
  const out = path.join(root, ".cache/xterm-native", `linux-${arch}`);
  await mkdir(out, { recursive: true });
  const result = spawnSync(
    options["--zig"],
    [
      "c++",
      "-target",
      target,
      "-shared",
      "-fPIC",
      "-O2",
      "-DNAPI_VERSION=8",
      "-DNAPI_CPP_EXCEPTIONS",
      "-I",
      options["--headers"],
      "-I",
      addon,
      path.join(pty, "src/unix/pty.cc"),
      "-o",
      path.join(out, "pty.node"),
      "-lutil",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: path.join(root, ".cache/xterm-zig"),
        ZIG_LOCAL_CACHE_DIR: path.join(root, ".cache/xterm-zig-local"),
      },
    },
  );
  for (const name of ["libcxx", "libcxxabi", "libunwind"])
    await cp(
      path.join(path.dirname(options["--zig"]), "lib", name, "LICENSE.TXT"),
      path.join(out, name + "-LICENSE.txt"),
    );
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Linux ${arch} 原生编译失败`);
}
