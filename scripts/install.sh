#!/bin/sh
# wavecrest installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/doyled-it/wavecrest/main/scripts/install.sh | sh
#
# Environment variables:
#   WAVECREST_PREFIX   install root (default: $HOME/.local/share/wavecrest)
#   WAVECREST_BIN_DIR  bin dir for symlink (default: $HOME/.local/bin)
#   WAVECREST_VERSION  pin a specific tag (default: latest release)

set -eu

REPO="doyled-it/wavecrest"
PREFIX="${WAVECREST_PREFIX:-$HOME/.local/share/wavecrest}"
BIN_DIR="${WAVECREST_BIN_DIR:-$HOME/.local/bin}"

# ─── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$(printf '\033[0m')
  C_BOLD=$(printf '\033[1m')
  C_GREEN=$(printf '\033[32m')
  C_RED=$(printf '\033[31m')
  C_DIM=$(printf '\033[2m')
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""; C_DIM=""
fi

info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

# ─── platform detection ──────────────────────────────────────────────────────
UNAME_MS=$(uname -ms)
case "$UNAME_MS" in
  "Darwin arm64") ASSET="wavecrest-darwin-arm64.tar.gz" ;;
  *) die "unsupported platform: $UNAME_MS (wavecrest currently ships darwin-arm64 only; Linux/x64 in phase 2)" ;;
esac

# ─── required tools ──────────────────────────────────────────────────────────
for cmd in curl tar shasum mkdir ln; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

# ─── resolve target version ──────────────────────────────────────────────────
TAG="${WAVECREST_VERSION:-}"
if [ -z "$TAG" ]; then
  info "resolving latest release from github.com/$REPO"
  # GitHub redirects /releases/latest → /releases/tag/<tag>; grab the tag from
  # the Location header to avoid needing jq.
  LATEST_URL=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest")
  TAG="${LATEST_URL##*/}"
  [ -n "$TAG" ] || die "could not determine latest release tag"
fi
ok "version: $TAG"

# ─── download + verify ───────────────────────────────────────────────────────
TMPDIR=$(mktemp -d -t wavecrest.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
SUM_URL="$URL.sha256"

info "downloading $ASSET"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMPDIR/$ASSET" "$URL" \
  || die "failed to download $URL"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMPDIR/$ASSET.sha256" "$SUM_URL" \
  || die "failed to download checksum $SUM_URL"

info "verifying checksum"
(
  cd "$TMPDIR"
  # `shasum -c` requires the file to live next to the listed name
  shasum -a 256 -c "$ASSET.sha256" >/dev/null 2>&1 \
    || die "checksum verification failed for $ASSET"
)
ok "checksum ok"

# ─── install ─────────────────────────────────────────────────────────────────
info "installing to $PREFIX"
mkdir -p "$PREFIX"
# Wipe prior contents but keep the directory itself (it may be a user-chosen path)
find "$PREFIX" -mindepth 1 -delete
tar -xzf "$TMPDIR/$ASSET" -C "$PREFIX"
chmod +x "$PREFIX/wavecrest"
ok "extracted bundle"

mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/wavecrest" "$BIN_DIR/wavecrest"
ok "symlinked $BIN_DIR/wavecrest -> $PREFIX/wavecrest"

# ─── PATH advice ─────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK=1 ;;
  *) PATH_OK=0 ;;
esac

echo
printf '%swavecrest %s installed%s\n' "$C_BOLD" "$TAG" "$C_RESET"
echo
if [ "$PATH_OK" -ne 1 ]; then
  printf '%s%s%s is not on your PATH. Add it to your shell rc:\n' "$C_BOLD" "$BIN_DIR" "$C_RESET"
  printf '  %sexport PATH="%s:$PATH"%s\n' "$C_DIM" "$BIN_DIR" "$C_RESET"
  echo
fi
echo "Next steps:"
echo "  1. wavecrest install        # claude hooks + wave widget + launchd"
echo "  2. In a FRESH Wave terminal block (not inside tmux): wavecrest auth-set"
echo "  3. Restart Wave Terminal and drag the wavecrest widget into a block"
echo
echo "Run 'wavecrest doctor' to verify your setup."
