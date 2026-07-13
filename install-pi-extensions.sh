#!/usr/bin/env bash
set -euo pipefail

# Install pi extensions for the project.
# Run once after cloning or when updating extension versions.

# The `pi` CLI is distributed as the npm package @earendil-works/pi-coding-agent.
# If it isn't already available on PATH, install it globally the official way.
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
  # Core UI tools
  # NOTE: rpiv-todo is vendored in-tree under pi-packages/rpiv-todo (patched for
  # per-session state isolation across tabs) and is loaded as a built-in package.
  # Do NOT add npm:@juicesharp/rpiv-todo here — it would double-register the
  # `todo` tool and fight over the overlay widget.
  npm:@juicesharp/rpiv-ask-user-question
  npm:@narumitw/pi-btw
  npm:pi-tool-display

  # Goal & workflow
  npm:pi-goals
  npm:pi-schedule-prompt

  # Agent capabilities
  npm:@tintinweb/pi-subagents
  npm:pi-interactive-shell

  # Web & search
  npm:@juicesharp/rpiv-web-tools

  # Session management
  # npm:@tmustier/pi-session-recap
)

for ext in "${extensions[@]}"; do
  echo "Installing $ext ..."
  pi install "$ext"
done

echo "Done. ${#extensions[@]} extensions installed."
