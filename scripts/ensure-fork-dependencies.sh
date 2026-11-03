#!/bin/sh
# Stays bash-free: minimal images (Alpine, busybox) ship no bash.
set -eu

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
fork_dir="$repo_dir/vendor/pi"
stamp="$repo_dir/dist/fork-lock.sha256"
mode="${1:-}"
if [ "$#" -gt 1 ] || { [ -n "$mode" ] && [ "$mode" != "--force" ]; }; then
  echo "Usage: ensure-fork-dependencies.sh [--force]" >&2
  exit 2
fi

# TypeScript 7 ships a native compiler per platform. Where none exists (for
# example OpenHarmony) tsc cannot start, so the JavaScript build replaces it.
tsc_runs_here() {
  [ -x "$fork_dir/node_modules/.bin/tsc" ] && "$fork_dir/node_modules/.bin/tsc" --version >/dev/null 2>&1
}

lock_hash=$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$fork_dir/package-lock.json")
if [ "$mode" != "--force" ] && [ -r "$stamp" ] && [ "$(cat "$stamp")" = "$lock_hash" ] &&
  tsc_runs_here; then
  exit 0
fi

# An interrupted install must not leave an old successful-install stamp trusted.
rm -f "$stamp"
(cd "$fork_dir" && npm ci --ignore-scripts) >&2
mkdir -p "$repo_dir/dist"
temporary_stamp=$(mktemp "$stamp.XXXXXX")
trap 'rm -f "$temporary_stamp"' EXIT
printf "%s\n" "$lock_hash" > "$temporary_stamp"
mv -f "$temporary_stamp" "$stamp"
trap - EXIT

if ! tsc_runs_here; then
  echo "typescript has no binary for this platform; installing typescript@6.0.3" >&2
  (cd "$fork_dir" && npm install --no-save --no-package-lock --no-audit --no-fund typescript@6.0.3) >&2
fi

echo installed
