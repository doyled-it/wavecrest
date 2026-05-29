#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Targets to produce. Override by passing names, e.g. `scripts/build.sh darwin-arm64`.
if [ $# -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=(darwin-arm64 darwin-x64)
fi

# Build the UI bundle once; same assets ship in every per-arch bundle.
bunx vite build
mkdir -p dist

for TARGET in "${TARGETS[@]}"; do
  BIN="dist/wavecrest-${TARGET}"
  BUNDLE="dist/wavecrest-bundle-${TARGET}"

  bun build --compile --target=bun-${TARGET} \
    --external node-pty \
    src/cli.ts \
    --outfile "$BIN"

  # Stage node-pty as a sibling so the daemon can dynamic-import the native addon
  # at runtime (bun --compile can't bundle .node files).
  NODE_MODULES_DIR="dist/node_modules-${TARGET}"
  rm -rf "$NODE_MODULES_DIR"
  mkdir -p "$NODE_MODULES_DIR"
  cp -R node_modules/node-pty "$NODE_MODULES_DIR/node-pty"
  # node-pty's spawn-helper must be executable; cp -R doesn't always preserve +x,
  # and posix_spawnp returns EACCES (shown as "posix_spawnp failed") if it isn't.
  if [ -e "$NODE_MODULES_DIR/node-pty/prebuilds/${TARGET}/spawn-helper" ]; then
    chmod +x "$NODE_MODULES_DIR/node-pty/prebuilds/${TARGET}/spawn-helper"
  fi

  # Ad-hoc codesign with a stable identifier so macOS TCC treats every rebuild
  # as the same app and doesn't re-prompt for Accessibility / Automation grants.
  if [[ "$TARGET" == darwin-* ]]; then
    codesign --force --sign - --identifier "com.doyled-it.wavecrest" "$BIN" 2>/dev/null || true
  fi

  # Bundle: binary + ui/ + node_modules/ side-by-side, production layout.
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE"
  cp "$BIN" "$BUNDLE/wavecrest"
  cp -R dist/ui "$BUNDLE/ui"
  cp -R "$NODE_MODULES_DIR" "$BUNDLE/node_modules"

  echo "built: $ROOT/$BIN  -->  $ROOT/$BUNDLE/"
done

# Back-compat aliases for the local-dev path: the launchd plist and `wavecrest
# install` reference dist/wavecrest, so keep an arm64 alias when we built one.
if [ -e dist/wavecrest-darwin-arm64 ]; then
  cp dist/wavecrest-darwin-arm64 dist/wavecrest
  rm -rf dist/wavecrest-bundle dist/node_modules
  cp -R dist/wavecrest-bundle-darwin-arm64 dist/wavecrest-bundle
  cp -R dist/node_modules-darwin-arm64 dist/node_modules
fi
