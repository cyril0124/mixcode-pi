# Vim Mode & Navigation

[中文文档](vim-and-navigation.zh.md)

MixCode features a built-in terminal Vim mode for fast chat navigation and message jumping.

## Design Motivation

Terminal-native coding agents should not force developers to reach for a mouse to review conversation history or locate earlier prompts. MixCode treats the entire conversation transcript as a scrollable Vim text buffer:
- **Mouse-Free Navigation**: Complete cursor, page, and jump control directly from home-row keys.
- **User-Turn Jumping (`Right` / `Shift+Right`)**: Fast traversal across milestone user prompts without scrolling past thousands of intermediate tool output lines.

## Entering & Exiting Vim Mode

- **Enter**:
  - Run `/vim`.
  - Press `Ctrl+U` on an empty message queue to arm, then press `u` (or `Ctrl+U` a second time) within 1 second.
- **Exit**: Press `q`.
- Double-Esc on an empty idle editor opens the session tree or fork. No-op while Vim is on.

## Keybindings

| Key | Mode | Description |
|---|---|---|
| `j` / `k` or `Down` / `Up` | Vim | Scroll transcript viewport by line. |
| `Ctrl+U` / `Ctrl+D` or `PageUp` / `PageDown` | Vim | Page up / Page down. |
| `g` / `G` | Vim | Jump to the very top (oldest) / bottom (newest) of chat. |
| `Home` / `End` | Vim | Jump to the very top / bottom of chat. |
| `Right` | Vim | Jump forward to the next user message; jumping past the last selects `[NEWEST]`. |
| `Shift+Right` | Vim | Jump backward to the previous user message. |
| `q` | Vim | Exit Vim mode. |
