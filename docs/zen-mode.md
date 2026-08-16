# Zen Mode & Ambient Background Status

[中文文档](zen-mode.zh.md)

MixCode Pi provides **Zen Mode** (`/toggle-zen-mode`), a distraction-free view that hides the top multi-tab bar while preserving ambient status awareness of background agents.

## Overview & Layout

In multi-tab workflows, the top tab bar occupies a vertical row and visual attention. Zen mode collapses the tab bar to maximize vertical space for conversation logs while providing ambient status dots for background agent activity.

```text
┌─ Normal Multi-Tab View ──────────────────────────────────────────────────┐
│ [Home] [Agent-01*] [Agent-02] [Agent-03]                     Ctrl+T:Jump │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Zen Mode (Distraction-Free) ────────────────────────────────────────────┐
│ ── ● (running) ● (waiting) [+1] ──────────────────────────────────────── │
│                                                                          │
│ [Chat Message Surface]                                                   │
│                                                                          │
│ ── [ZEN] ───────────────────────────────────────────────── Agent-01 ──── │
│ > prompt editor                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Behaviors

### 1. Ambient Background Status Dots (`zenStatusMarkers`)

When the tab bar is hidden, other background agents that require attention or have notable state transitions render as compact status dots on the top separator:

- **Solid Dots (`●`)**: Represent active background states (e.g. running, thinking, waiting for input, error, or unread completion).
- **Overflow Counter (`[+N]`)**: Groups excess background indicators when terminal width is constrained.
- **Mouse Clickable**: Clicking a background marker switches focus directly to that agent tab.

### 2. Seamless Mode Migration

Zen mode is per-window state that automatically migrates with user navigation:
- Switching tabs via `Ctrl+T` (Tab Jump) transfers Zen mode to the newly focused agent tab. `Tab` / `Shift+Tab` are swallowed in Zen mode.
- Opening Home/Config (`[Home]`) temporarily restores the config surface without resetting the agent's Zen preference.

### 3. Badge Hierarchy on Editor Border

The prompt editor's top border displays active state badges in strict priority order:

```text
── [VIM] [ZEN] [INL] ────────────────────────── Agent-01 [sys] ──
```

- `[VIM]`: Vim transcript navigation mode active.
- `[ZEN]`: Zen mode active (tab bar hidden).
- `[INL]`: Inline widgets mode active.
- `[sys]`: Custom `system_prompt` active on this tab (after the title).

## Usage & Keybindings

| Action | Command / Shortcut | Description |
|---|---|---|
| Toggle Zen Mode | `/toggle-zen-mode` | Hides or restores the top tab bar. |
| Command Palette | `Ctrl+P` → `Toggle Zen Mode` | Accessible via fuzzy search palette. |
| Tab Jump in Zen | `Ctrl+T` | Jump to any background tab without leaving Zen mode. |
