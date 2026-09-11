#!/usr/bin/env bash
set -euo pipefail

# GitHub Actions uses the official Linux amd64 fnpack binary. The target FPK
# platform is selected in the manifest, so one host-side packer can produce
# both x86 and arm packages.
VERSION="${FNPACK_VERSION:-1.2.3}"
TARGET="${1:-${FNPACK_BIN:-${RUNNER_TEMP:-/tmp}/fnpack}}"
URL="${FNPACK_URL:-https://static2.fnnas.com/fnpack/fnpack-${VERSION}-linux-amd64}"
EXPECTED_SHA256="${FNPACK_SHA256:-54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93}"

mkdir -p "$(dirname "$TARGET")"
curl --fail --location --silent --show-error --retry 3 "$URL" --output "$TARGET"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$TARGET" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$TARGET" | awk '{print $1}')"
fi
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || {
  echo "fnpack SHA-256 校验失败：期望 $EXPECTED_SHA256，实际 $ACTUAL_SHA256" >&2
  exit 1
}
chmod 0755 "$TARGET"
echo "已安装并校验 fnpack ${VERSION}：${TARGET}"
