#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bunx vite build
mkdir -p dist
bun build --compile --target=bun-darwin-arm64 \
  --define WAVECREST_UI_DIR='"./dist/ui"' \
  --external node-pty \
  src/cli.ts \
  --outfile dist/wavecrest

echo "built: $ROOT/dist/wavecrest"
