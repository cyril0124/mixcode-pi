#!/usr/bin/env bash
set -euo pipefail

# Build multi-arch standalone binaries via bun --compile --target.
# Usage: ./release.sh [--out-dir dist/release] [target ...]
#
# Default targets (when none given):
#   bun-linux-x64 bun-linux-arm64 bun-darwin-arm64 bun-darwin-x64
#
# Example:
#   ./release.sh
#   ./release.sh --out-dir /tmp/mpi-release
#   ./release.sh bun-linux-x64 bun-darwin-arm64
#   ./release.sh --all   # also musl + windows

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="mpi"
ENTRY="src/cli/binary-entry.ts"
OUT_DIR="$REPO_DIR/dist/release"

DEFAULT_TARGETS=(
  bun-linux-x64
  bun-linux-arm64
  bun-darwin-arm64
  bun-darwin-x64
)

ALL_TARGETS=(
  bun-linux-x64
  bun-linux-arm64
  bun-linux-x64-musl
  bun-linux-arm64-musl
  bun-darwin-arm64
  bun-darwin-x64
  bun-windows-x64
  bun-windows-arm64
)

info()  { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# bun-linux-x64 → mpi-linux-x64 ; windows → .exe
outfile_for() {
  local target="$1"
  local suffix="${target#bun-}"
  if [[ "$target" == bun-windows-* ]]; then
    printf '%s-%s.exe' "$INSTALL_NAME" "$suffix"
  else
    printf '%s-%s' "$INSTALL_NAME" "$suffix"
  fi
}

TARGETS=()
USE_ALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ $# -lt 2 ] && error "--out-dir requires an argument"
      OUT_DIR="$2"; shift 2 ;;
    --out-dir=*)
      OUT_DIR="${1#--out-dir=}"
      [ -z "$OUT_DIR" ] && error "--out-dir must not be empty"
      shift ;;
    --all)
      USE_ALL=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: release.sh [OPTIONS] [target ...]

Compile standalone mpi binaries for one or more Bun compile targets.

Options:
  --out-dir <path>  Output directory (default: dist/release)
  --all             Build all supported targets (linux/darwin/windows + musl)
  -h, --help        Show this help

Targets (Bun --target values), e.g.:
  bun-linux-x64 bun-linux-arm64 bun-darwin-arm64 bun-darwin-x64
  bun-linux-x64-musl bun-windows-x64 ...

With no targets and without --all, builds:
  ${DEFAULT_TARGETS[*]}
EOF
      exit 0
      ;;
    bun-*)
      TARGETS+=("$1"); shift ;;
    *)
      error "Unknown argument: $1 (targets must start with bun-)"
      ;;
  esac
done

if [ "$USE_ALL" -eq 1 ]; then
  TARGETS=("${ALL_TARGETS[@]}")
elif [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

if ! command_exists bun; then
  error "bun is required to compile. Install: curl -fsSL https://bun.sh/install | bash"
fi

cd "$REPO_DIR"

info "bun $(bun --version)"
info "Installing dependencies..."
# postinstall applies patches with --error-on-fail; a failed patch aborts here.
bun install --frozen-lockfile

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

info "Output directory: $OUT_DIR"
info "Targets: ${TARGETS[*]}"

failed=0
built=()

for target in "${TARGETS[@]}"; do
  name="$(outfile_for "$target")"
  out="$OUT_DIR/$name"
  info "Compiling $target → $name"
  if bun build "$ENTRY" --compile --packages bundle --target="$target" --outfile "$out"; then
    if [ -f "$out" ]; then
      built+=("$out")
      info "  ok  $(du -h "$out" | awk '{print $1}')"
    else
      warn "  missing output: $out"
      failed=1
    fi
  else
    warn "  failed: $target"
    failed=1
  fi
done

echo ""
info "Built ${#built[@]}/${#TARGETS[@]} binary(ies) in $OUT_DIR"
# Guard: "${built[@]}" on an empty array errors under bash 3.2 with set -u.
if [ "${#built[@]}" -gt 0 ]; then
  for f in "${built[@]}"; do
    printf '  %s\n' "$f"
  done
fi

if [ "$failed" -ne 0 ]; then
  error "One or more targets failed"
fi

info "Done."
