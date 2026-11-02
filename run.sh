#!/bin/sh
# Stays bash-free: minimal images (Alpine, busybox) ship no bash.
set -eu

repo_dir="$(cd "$(dirname "$0")" && pwd)"
workdir="$(pwd)"
cd "$repo_dir"

if [ ! -f vendor/pi/package.json ]; then
  git submodule update --init vendor/pi
fi
dependency_update=$(sh scripts/ensure-fork-dependencies.sh)

fork_entry="$repo_dir/vendor/pi/packages/coding-agent/dist/bun/cli.js"
needs_fork_build() {
  if [ -n "$dependency_update" ] || [ ! -f "$fork_entry" ]; then
    return 0
  fi
  if find vendor/pi/packages vendor/pi/scripts vendor/pi/package-lock.json \
    scripts/ensure-fork-model-data.sh scripts/ensure-fork-dependencies.sh \
    \( -name node_modules -o -name dist \
      -o -path vendor/pi/packages/coding-agent/docs \
      -o -path vendor/pi/packages/coding-agent/examples \) -prune \
    -o -type f -newer "$fork_entry" -print -quit | grep -q .; then
    return 0
  fi
  return 1
}

if needs_fork_build; then
  sh scripts/ensure-fork-model-data.sh
  (cd vendor/pi && npm run build:offline)
fi
bun scripts/generate-fork-docs.ts
bun scripts/generate-fork-examples.ts

binary="$repo_dir/dist/mpi"
needs_binary_build() {
  if [ ! -f "$binary" ] || [ "$fork_entry" -nt "$binary" ]; then
    return 0
  fi
  if find scripts/fork-binary-entry.ts scripts/fork-binary-assets.ts scripts/ensure-package-extensions.ts \
    scripts/generate-fork-docs.ts scripts/generate-fork-examples.ts \
    scripts/fork-docs.generated.ts scripts/fork-examples.generated.ts pi-packages \
    vendor/pi/docs vendor/pi/packages/coding-agent/docs vendor/pi/packages/coding-agent/examples \
    \( -name node_modules -o -name dist \) -prune \
    -o -type f -newer "$binary" -print -quit | grep -q .; then
    return 0
  fi
  return 1
}

if needs_binary_build; then
  bun build scripts/fork-binary-entry.ts \
    vendor/pi/packages/coding-agent/src/utils/image-resize-worker.ts \
    vendor/pi/packages/coding-agent/src/extensions/codemode/worker.ts \
    --compile --packages bundle --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
    --outfile "$binary"
fi

cd "$workdir"
exec "$binary" "$@"
