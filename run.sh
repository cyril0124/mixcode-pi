#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="$(pwd)"
cd "$repo_dir"

if [ ! -d node_modules ]; then
  bun install
fi

export PATH="$repo_dir/node_modules/.bin:$PATH"

dist_entry="$repo_dir/dist/cli/main.js"

needs_build() {
  if [ ! -f "$dist_entry" ]; then
    return 0
  fi
  if find "$repo_dir/src" \
    "$repo_dir/package.json" \
    "$repo_dir/bun.lock" \
    "$repo_dir/tsconfig.json" \
    "$repo_dir/biome.jsonc" \
    -newer "$dist_entry" -print -quit | grep -q .; then
    return 0
  fi
  return 1
}

if [ "${MIXCODE_DEV:-0}" = "1" ]; then
  if [ "${1:-}" = "status" ]; then
    cd "$workdir"
    exec bun "$repo_dir/src/cli/main.ts" "$@"
  fi
  exec bun src/cli/main.ts --workdir "$workdir" "$@"
fi

if needs_build; then
  bun run build
fi

if [ "${1:-}" = "status" ]; then
  cd "$workdir"
  exec bun "$dist_entry" "$@"
fi

exec bun "$dist_entry" --workdir "$workdir" "$@"
