#!/usr/bin/env bash
set -euo pipefail

# Install pi extensions for the project.
# Run once after cloning or when updating extension versions.

extensions=(
  # Core UI tools
  npm:@juicesharp/rpiv-todo
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
