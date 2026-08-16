# Multi-Tab Workspaces & Tab Management

[中文文档](workspace-and-tabs.zh.md)

MixCode Pi provides native multi-tab agent sessions, cross-instance synchronization, and workspace persistence to overcome the single-session limitation of standard terminal agents.

## Design Motivation

- **Parallel Exploration & Execution**: Standard single-session agents force developers to block on long-running compiles, test suites, or heavy refactoring before starting a new conversation. MixCode allows running multiple isolated agent conversations side by side in independent tabs within a single terminal instance.
- **Recent-Access Decay Hierarchy (`recentTabIds`)**: Visually prioritizes active and recently focused tabs (`recent1`, `recent2`, `inactive`) with tiered styling so users maintain context across dozens of tabs.
- **State Continuity**: Workspaces persist layout, focus, models, and session linkages across machine restarts.

## Tab Lifecycle

```text
Create Tab (/new-session / Ctrl+T)
  │
  ├─ Dedicated Session File (`~/.pi/agent/sessions/...`)
  ├─ Independent Agent Instance & Tool Runtimes
  └─ Real-time State Tracked in `open_tabs.json`
```

### Tab Actions & Real-Time Glyphs

Tabs display live status glyphs: `●` (running/working), `-` (idle/ready), `!` (done/unread), and `x` (error).

| Action | Key / Command | Behavior |
|---|---|---|
| New Tab | `/new-session [title]` | Spawns a clean agent tab with an optional custom title. |
| Close Tab | `/close-session` | Closes the current tab and cleans up its in-memory runtime. |
| Reset Session | `/reset` | Resets tree leaf back to root in the same tab, retaining title and session ID. |
| Clear Session | `/clear` | Generates a fresh session file in the same tab, resetting the title. |
| Fork Tab | `/fork [suffix]` | Clones conversation history into a new tab with reused services. |
| Tab Jump | `Ctrl+T` | Displays an interactive modal to jump to any open tab. |
| Tab Cycle | `Tab` / `Shift+Tab` | Cycles tabs when autocomplete is closed. Swallowed in Zen mode (use `Ctrl+T`). |
| Zen Mode | `/toggle-zen-mode` | Toggles the top tab bar for an uncluttered focus view. |

## Workspace Persistence

Workspaces store multi-tab layouts, active tab focus, working directories, and model assignments for quick restoration.

### Commands

| Command | Description |
|---|---|
| `/save-workspace [name]` | Writes the current tab layout into `<agentDir>/mixcode-pi/workdirs/<sha16>/workspaces.json`. |
| `/restore-workspace [name]` | Restores a named workspace, or opens the picker when name is omitted. |
| `/delete-workspace [name]` | Deletes a saved workspace record from `workspaces.json`. |

## Multi-Instance Tab Synchronization

MixCode coordinates open tabs across multiple terminal processes or tmux panes using an atomic lock over `open_tabs.json`.

```text
Instance A (Modifies tabs)
    │
    ▼
open_tabs.json (File lock coordination)
    │
    ▼
Instance B (Peer-tab-sync listener reconciles tab set)
```
