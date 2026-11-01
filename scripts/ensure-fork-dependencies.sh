#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fork_dir="$repo_dir/vendor/pi"
stamp="$repo_dir/dist/fork-lock.sha256"
mode="${1:-}"
if [ "$#" -gt 1 ] || { [ -n "$mode" ] && [ "$mode" != "--force" ]; }; then
  echo "Usage: ensure-fork-dependencies.sh [--force]" >&2
  exit 2
fi

lock_hash=$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$fork_dir/package-lock.json")
if [ "$mode" != "--force" ] && [ -x "$fork_dir/node_modules/.bin/tsc" ] &&
  [ -r "$stamp" ] && [ "$(cat "$stamp")" = "$lock_hash" ]; then
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
echo installed
