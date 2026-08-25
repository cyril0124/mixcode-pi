#!/usr/bin/env bash
set -euo pipefail

# MixCode Pi installer — compile to standalone single binary
# Usage: ./install.sh [--prefix ~/.local]

INSTALL_NAME="mpi"
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

# Prepend bun's default install dir so an existing bun is found even when the
# shell profile has not added it to PATH.
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command_exists bun; then
  info "bun not found. Installing bun..."
  if command_exists curl; then
    curl -fsSL https://bun.sh/install | bash || error "Failed to install bun"
  elif command_exists wget; then
    wget -qO- https://bun.sh/install | bash || error "Failed to install bun"
  else
    error "Neither curl nor wget found. Please install curl or wget, or install bun manually: https://bun.sh"
  fi

  if ! command_exists bun; then
    error "bun was installed but is not found in PATH ($BUN_INSTALL/bin)"
  fi
fi

info "bun $(bun --version)"

# npm and pi are only needed for Pi extension install and headless
# `mpi --print/-p` delegation, not for the binary build — soft dependencies.
if command_exists npm; then
  if ! command_exists pi; then
    info "Installing pi CLI..."
    npm install -g @earendil-works/pi-coding-agent || warn "Failed to install the pi CLI"
  fi
else
  warn "npm not found. Extension install and 'mpi --print/-p' need Node.js/npm: https://nodejs.org"
fi

# --- Install deps ---

cd "$REPO_DIR"

info "Installing dependencies..."
bun install || error "bun install failed"

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
