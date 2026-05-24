#!/usr/bin/env bash
set -euo pipefail

# MixCode Pi installer — compile to standalone binary and install
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
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        error "--prefix requires a path"
      fi
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#--prefix=}"
      if [ -z "$PREFIX" ]; then
        error "--prefix requires a path"
      fi
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [OPTIONS]

Options:
  --prefix <path>   Install to <path>/lib and <path>/bin (default: ~/.local)
  -h, --help        Show this help

Environment variables:
  MIXCODE_INSTALL_PREFIX  Same as --prefix
EOF
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/lib/$INSTALL_NAME"

# --- Preflight ---

info "Checking prerequisites..."

if ! command_exists bun; then
  error "bun is required to compile the binary. Install: curl -fsSL https://bun.sh/install | bash"
fi

info "bun $(bun --version)"

# --- Install deps ---

cd "$REPO_DIR"

if [ ! -d node_modules ]; then
  info "Installing dependencies..."
  bun install
fi

# --- Compile binary ---

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Compiling standalone binary..."
bun build src/cli/main.ts --compile --packages bundle --outfile "$TMPDIR/$INSTALL_NAME"

if [ ! -f "$TMPDIR/$INSTALL_NAME" ]; then
  error "Compilation failed"
fi

# --- Install ---

info "Installing to $LIB_DIR..."
rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR" "$BIN_DIR"

# Binary
mv "$TMPDIR/$INSTALL_NAME" "$LIB_DIR/$INSTALL_NAME"
chmod +x "$LIB_DIR/$INSTALL_NAME"

# Runtime metadata — pi-coding-agent reads package.json from the binary's directory
cp "$REPO_DIR/package.json" "$LIB_DIR/package.json"

# Runtime resources used by pi-coding-agent when running as compiled binary
PI_AGENT_DIR="$REPO_DIR/node_modules/@earendil-works/pi-coding-agent"
copy_if_exists() {
  local src="$1" dst="$2"
  if [ -d "$src" ]; then
    cp -r "$src" "$dst"
  fi
}
copy_if_exists "$PI_AGENT_DIR/dist/modes/interactive/theme" "$LIB_DIR/theme"
copy_if_exists "$PI_AGENT_DIR/dist/modes/interactive/assets" "$LIB_DIR/assets"
copy_if_exists "$PI_AGENT_DIR/dist/core/export-html" "$LIB_DIR/export-html"

# Wrapper script
cat > "$BIN_DIR/$INSTALL_NAME" <<WRAPPER
#!/usr/bin/env bash
exec "$LIB_DIR/$INSTALL_NAME" "\$@"
WRAPPER
chmod +x "$BIN_DIR/$INSTALL_NAME"

# --- PATH check ---

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  warn "$BIN_DIR is not in your PATH."
  echo ""
  echo "  Add to your shell profile:"
  echo ""
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# --- Done ---

info "Done!"
echo ""
echo "  Binary:  $LIB_DIR/$INSTALL_NAME"
echo "  Command: $BIN_DIR/$INSTALL_NAME"
echo ""
echo "  Run '$INSTALL_NAME' to start."
