#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper around the clack-based installer (skills-style UI).
# Package list and flow live in src/cli/install-extensions.ts (also exposed
# as `mpi install-extensions` in the compiled binary).
#
# Usage:
#   ./install-pi-extensions.sh              # interactive UI if TTY
#   ./install-pi-extensions.sh --yes        # install missing, no prompt
#   ./install-pi-extensions.sh --postinstall

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to run the extension installer." >&2
  exit 1
fi

exec bun "$REPO_DIR/scripts/install-pi-extensions.ts" "$@"
