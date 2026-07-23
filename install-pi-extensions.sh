#!/usr/bin/env bash
set -euo pipefail

# Install optional Pi packages into the agent dir via `pi install`.
# Run after clone, or when this list changes.
#
# Built-in packages live under pi-packages/ and are loaded by the app itself
# (ensurePackageExtensions / binary-entry). Do not list them here or tools and
# widgets can double-register. Vendored example: pi-packages/rpiv-todo.

# `pi` ships as npm package @earendil-works/pi-coding-agent.
if ! command -v pi >/dev/null 2>&1; then
  echo "pi CLI not found; installing @earendil-works/pi-coding-agent globally ..."
  npm install -g @earendil-works/pi-coding-agent
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "Error: 'pi' still not found after 'npm install -g @earendil-works/pi-coding-agent'." >&2
  echo "Check that your npm global bin directory is on PATH (npm bin -g)." >&2
  exit 1
fi

extensions=(
  npm:@juicesharp/rpiv-ask-user-question
  npm:@narumitw/pi-btw
  npm:pi-tool-display
  npm:pi-schedule-prompt
  npm:@tintinweb/pi-subagents
  npm:pi-invisible-continue
  npm:@juicesharp/rpiv-web-tools
  npm:@monotykamary/pi-tps
)

for ext in "${extensions[@]}"; do
  echo "Installing $ext ..."
  pi install "$ext"
done

echo "Done. ${#extensions[@]} extensions installed."
