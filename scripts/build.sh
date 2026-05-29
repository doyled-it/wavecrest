#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bunx vite build
mkdir -p dist
bun build --compile --target=bun-darwin-arm64 \
  --external node-pty \
  src/cli.ts \
  --outfile dist/wavecrest

# Stage node-pty as a sibling so the daemon can dynamic-import the native addon
# at runtime (bun --compile can't bundle .node files).
rm -rf dist/node_modules
mkdir -p dist/node_modules
cp -R node_modules/node-pty dist/node_modules/node-pty
# node-pty's spawn-helper must be executable; npm/bun install doesn't guarantee
# the +x bit survives, and posix_spawnp returns EACCES (shown as "posix_spawnp
# failed") if it isn't.
chmod +x dist/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# Ad-hoc codesign with a stable identifier so macOS TCC treats every rebuild as
# the same app. Without this, every rebuild looks like a brand-new binary to TCC
# and the user re-grants Accessibility / Automation permissions on each build.
codesign --force --sign - --identifier "com.doyled-it.wavecrest" dist/wavecrest 2>/dev/null || true

# Place binary + ui/ + node_modules side-by-side in a bundle directory for the production layout.
rm -rf dist/wavecrest-bundle
mkdir -p dist/wavecrest-bundle
cp dist/wavecrest dist/wavecrest-bundle/wavecrest
cp -R dist/ui dist/wavecrest-bundle/ui
cp -R dist/node_modules dist/wavecrest-bundle/node_modules

echo "built: $ROOT/dist/wavecrest (single binary; usage-poller uses dist/node_modules/node-pty sibling)"
echo "       $ROOT/dist/wavecrest-bundle/  (binary + ui/ + node_modules/ for production install)"
