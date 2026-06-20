#!/usr/bin/env bash
set -euo pipefail

# Install pi extensions for the project.
# Run once after cloning or when updating extension versions.

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
  npm:pi-mono-loop
  npm:pi-schedule-prompt

  # Agent capabilities
  npm:@tintinweb/pi-subagents
  npm:pi-interactive-shell

  # Web & search
  npm:pi-web-access

  # Session management
  npm:@tmustier/pi-session-recap
)

for ext in "${extensions[@]}"; do
  echo "Installing $ext ..."
  pi install "$ext"
done

echo "Done. ${#extensions[@]} extensions installed."
