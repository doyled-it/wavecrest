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

# Place binary + ui/ side-by-side in a bundle directory for the production layout.
rm -rf dist/wavecrest-bundle
mkdir -p dist/wavecrest-bundle
cp dist/wavecrest dist/wavecrest-bundle/wavecrest
cp -R dist/ui dist/wavecrest-bundle/ui

echo "built: $ROOT/dist/wavecrest (single binary)"
echo "       $ROOT/dist/wavecrest-bundle/  (binary + ui/ for production install)"
