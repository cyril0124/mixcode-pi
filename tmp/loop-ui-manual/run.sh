#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/mixcode-loop-ui-manual.XXXXXX")"
agent_dir="$runtime_dir/agent"
workdir="$runtime_dir/workdir"

cleanup() {
  rm -rf -- "$runtime_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$agent_dir" "$workdir"
cp "$script_dir/agent-models.json" "$agent_dir/models.json"
cp -R "$script_dir/project-pi" "$workdir/.pi"
# Resolve extension imports from the installed worktree dependencies.
ln -s "$repo_dir/node_modules" "$runtime_dir/node_modules"
printf 'Starting offline Loop UI demo\n'
cd "$workdir"
# Pass only terminal essentials. User provider keys and parent-instance overrides stay out.
env -i \
  PATH="$PATH" \
  TERM="${TERM:-xterm-256color}" \
  LANG="${LANG:-C.UTF-8}" \
  COLORTERM="${COLORTERM:-truecolor}" \
  MIXCODE=1 \
  MIXCODE_DEV=1 \
  PI_OFFLINE=1 \
  PI_CODING_AGENT_DIR="$agent_dir" \
  "$repo_dir/run.sh"
