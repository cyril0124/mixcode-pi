# Vim Mode & Transcript Search

[中文文档](vim-and-navigation.zh.md)

MixCode features a built-in terminal Vim mode for fast chat navigation, message jumping, and transcript search.

## Design Motivation

Terminal-native coding agents should not force developers to reach for a mouse to review conversation history or locate earlier prompts. MixCode treats the entire conversation transcript as a scrollable, searchable Vim text buffer:
- **Mouse-Free Navigation**: Complete cursor, page, and jump control directly from home-row keys.
- **User-Turn Jumping (`Right` / `Shift+Right`)**: Fast traversal across milestone user prompts without scrolling past thousands of intermediate tool output lines.
- **WeakMap Corpus Caching**: Renders the conversation once and caches line indices to make live regex/substring searching lag-free even in massive sessions.

## Entering & Exiting Vim Mode

- **Enter**:
  - Run `/vim`.
  - Press `Ctrl+U` on an empty message queue to arm, then press `u` (or `Ctrl+U` a second time) within 1 second.
- **Exit**: Press `i`, `a`, or `Escape` to return to normal prompt editing.
- Double-Esc on an empty idle editor opens the session tree (or fork), not Vim.

## Keybindings

| Key | Mode | Description |
|---|---|---|
| `j` / `k` or `Down` / `Up` | Vim | Scroll transcript viewport by line. |
| `Ctrl+F` / `Ctrl+B` | Vim | Page down / Page up. |
| `g` / `G` | Vim | Jump to the very top (oldest) / bottom (newest) of chat. |
| `Right` | Vim | Jump forward to the next user message; jumping past the last selects `[NEWEST]`. |
| `Shift+Right` | Vim | Jump backward to the previous user message. |
| `/` | Vim | Open Vim transcript search bar. |
| `n` | Vim | Navigate to next search match. |
| `N` | Vim | Navigate to previous search match. |
| `i` / `a` / `Escape` | Vim | Exit Vim mode and focus the prompt editor. |

## Transcript Search Architecture

```text
Vim Mode (/)
    │
    ▼
VimTranscriptSearchState
    │
    ├─ Rendered Corpus cached in WeakMap
    ├─ Substring / Regex Match Scanning
    └─ Active Match Line Highlighted in Chat Viewport
```
