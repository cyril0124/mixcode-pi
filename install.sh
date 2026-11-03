#!/bin/sh
# Stays bash-free: minimal images (Alpine, busybox) ship no bash.
set -eu

# MixCode Pi installer — compile to standalone single binary
# Usage: ./install.sh [--prefix ~/.local] [--name mpi]

INSTALL_NAME="mpi"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

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
    --name)
      [ $# -lt 2 ] && error "--name requires an argument"
      INSTALL_NAME="$2"; shift 2 ;;
    --name=*) INSTALL_NAME="${1#--name=}"; shift ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [OPTIONS]

Options:
  --prefix <path>   Install binary to <path>/bin (default: ~/.local)
  --name <name>     Installed binary filename (default: mpi)
  -h, --help        Show this help

Environment variables:
  MIXCODE_INSTALL_PREFIX  Same as --prefix
EOF
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

case "$INSTALL_NAME" in
  ""|"."|".."|*/*|*\\*) error "--name must be a filename without path separators" ;;
esac

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
  # Bun ships its installer as a bash script, so it cannot run without bash.
  command_exists bash ||
    error "Automatic bun installation needs bash. Install bun manually (https://bun.sh) or install bash, then re-run."
  info "bun not found. Installing bun..."
  if command_exists curl; then
    installer_script=$(curl -fsSL https://bun.sh/install) || error "Failed to download the bun installer"
  elif command_exists wget; then
    installer_script=$(wget -qO- https://bun.sh/install) || error "Failed to download the bun installer"
  else
    error "Neither curl nor wget found. Please install curl or wget, or install bun manually: https://bun.sh"
  fi
  printf '%s\n' "$installer_script" | bash || error "Failed to install bun"

  if ! command_exists bun; then
    error "bun was installed but is not found in PATH ($BUN_INSTALL/bin)"
  fi
fi

info "bun $(bun --version)"

# npm is a build prerequisite for the fork workspace, not a runtime dependency.
command_exists npm || error "npm is required to build the Pi fork"

# --- Install deps ---

cd "$REPO_DIR"

if [ ! -f vendor/pi/package.json ]; then
  command_exists git || error "git is required to initialize the Pi fork submodule"
  git submodule update --init vendor/pi || error "Pi fork submodule checkout failed"
fi

info "Preparing Pi fork dependencies..."
sh scripts/ensure-fork-dependencies.sh || error "Pi fork dependency install failed"

info "Building the Pi fork..."
sh scripts/ensure-fork-model-data.sh || error "Pi fork model data preparation failed"
(cd vendor/pi && npm run build:offline) || error "Pi fork build failed"
bun scripts/generate-fork-docs.ts || error "Pi fork documentation packaging failed"
bun scripts/generate-fork-examples.ts || error "Pi fork example packaging failed"

# --- Compile ---

BUILD_TMPDIR=$(mktemp -d)
trap 'rm -rf "$BUILD_TMPDIR"' EXIT

info "Compiling standalone binary..."
bun build scripts/fork-binary-entry.ts \
  src/utils/image-resize-worker.ts \
  src/extensions/codemode/worker.ts \
  --compile --packages bundle --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  --outfile "$BUILD_TMPDIR/$INSTALL_NAME"

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
