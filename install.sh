#!/usr/bin/env bash
set -euo pipefail

# MixCode Pi installer — compile to standalone single binary
# Usage: ./install.sh [--prefix ~/.local]

INSTALL_NAME="mixcode-pi"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Helpers ---

info()  { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- Parse args ---

PREFIX="${MIXCODE_INSTALL_PREFIX:-$HOME/.local}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -lt 2 ] && error "--prefix requires an argument"
      PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"
      [ -z "$PREFIX" ] && error "--prefix must not be empty"
      shift ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [OPTIONS]

Options:
  --prefix <path>   Install binary to <path>/bin (default: ~/.local)
  -h, --help        Show this help

Environment variables:
  MIXCODE_INSTALL_PREFIX  Same as --prefix
EOF
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

# Strip trailing slashes for consistent PATH matching
PREFIX="${PREFIX%/}"
BIN_DIR="$PREFIX/bin"

# --- Preflight ---

info "Checking prerequisites..."

if ! command_exists bun; then
  error "bun is required to compile. Install: curl -fsSL https://bun.sh/install | bash"
fi

info "bun $(bun --version)"

# --- Install deps ---

cd "$REPO_DIR"

info "Installing dependencies..."
bun install

# Apply patches (patch-package may fail under bun's postinstall; apply manually)
if [ -d "$REPO_DIR/patches" ]; then
  info "Applying patches..."
  ./node_modules/.bin/patch-package --patch-dir patches \
    || true
fi

# --- Compile ---

BUILD_TMPDIR=$(mktemp -d)
trap 'rm -rf "$BUILD_TMPDIR"' EXIT

info "Compiling standalone binary..."
bun build src/cli/binary-entry.ts --compile --packages bundle --outfile "$BUILD_TMPDIR/$INSTALL_NAME"

if [ ! -f "$BUILD_TMPDIR/$INSTALL_NAME" ]; then
  error "Compilation failed"
fi

# --- Install ---

mkdir -p "$BIN_DIR"

info "Installing to $BIN_DIR/$INSTALL_NAME..."
mv -f "$BUILD_TMPDIR/$INSTALL_NAME" "$BIN_DIR/$INSTALL_NAME" 2>/dev/null \
  || cp "$BUILD_TMPDIR/$INSTALL_NAME" "$BIN_DIR/$INSTALL_NAME"
chmod +x "$BIN_DIR/$INSTALL_NAME"

# --- PATH check ---

if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$BIN_DIR"; then
  warn "$BIN_DIR is not in your PATH."
  echo ""
  echo "  Add to your shell profile:"
  echo ""
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# --- Done ---

info "Done! Single binary at $BIN_DIR/$INSTALL_NAME"
