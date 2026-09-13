# Multi-Tab Workspaces & Tab Management

[中文文档](workspace-and-tabs.zh.md)

MixCode Pi provides native multi-tab agent sessions, cross-instance synchronization, and workspace persistence to overcome the single-session limitation of standard terminal agents.

## Design Motivation

- **Parallel Exploration & Execution**: Standard single-session agents force developers to block on long-running compiles, test suites, or heavy refactoring before starting a new conversation. MixCode allows running multiple isolated agent conversations side by side in independent tabs within a single terminal instance.
- **Recent Access (`recentAgentTabIds`)**: Tracks agent focus order. See [Tab appearance](#tab-appearance) for the theme-driven visual hierarchy.
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

Tabs display live status glyphs: `●` (running/working), `-` (idle/ready), `✓` (done/unread), `?` (waiting for input), and `x` (error).

| Action | Key / Command | Behavior |
|---|---|---|
| New Tab | `/new-session [--focus\|--no-focus] [title]` | Spawns a clean agent tab with an optional custom title. Default focuses the new tab; `--no-focus` leaves the current tab focused. |
| Close Tab | `/close-session [yes]` | Closes the current tab and cleans up its in-memory runtime. `yes` skips confirmation. |
| Reset Session | `/reset` | Resets tree leaf back to root in the same tab, retaining title and session ID. Chat is empty. `/tree` still lists earlier branches. |
| Clear Session | `/clear` | Generates a fresh session file in the same tab, resetting the title. |
| Fork Tab | `/fork` | Clones conversation history into a new tab with its own runtime services. |
| Rename Tab | `/rename <title>` | Sets the active tab title. |
| Color Tab | `/color [name\|clear]` | Sets the active tab color from the fixed palette, or clears it when the argument is omitted or `clear`. Persisted per session. See [Tab colors](#tab-colors). |
| Tab Jump | `Ctrl+T` / `/jump` | Displays an interactive modal to jump to any open tab. |
| Tab Cycle | `Tab` / `Shift+Tab` | Cycles tabs when autocomplete is closed. Swallowed in Zen mode (use `Ctrl+T`). |
| Zen Mode | `/toggle-zen-mode` | Toggles the top tab bar for an uncluttered focus view. |

### Tab appearance

Tab styling comes from the current theme, except for a tab with an explicit `/color` assignment (see [Tab colors](#tab-colors)). The active tab, including Home, uses `selectedBg` with bold `text`. All inactive tabs use `toolPendingBg`: ordinary titles use `muted`, the two most recent inactive agents use `text`, and Home uses `accent`. On Home, the two most recently visited agents receive the recent styling.

Completed/unread tabs use `✓` and a bold title in the theme's `doneFg` color, independent of recency. They retain the ordinary background unless focused. Focusing a tab clears its completion badge and emphasis; a running, waiting, or error state takes priority over an unread completion. Other status colors apply only to the glyph. The active tab retains its left focus marker and the title's three-second shimmer cycle; the glyph retains its status color during the sweep. The `terminal` theme uses reverse video for selection and terminal-default backgrounds for inactive tabs.

### Tab colors

`/color <name>` sets the active tab's chip background to one of eight named colors: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`. Each name maps to an ANSI 16-color background with a fixed contrast foreground, so the same name looks the same under every theme. `/color` with no argument, or `/color clear`, removes the color. An unknown name reports `Error: Unknown color: <value> (valid: red, green, …, clear)` and leaves the tab unchanged; autocomplete offers the palette and `clear`.

On a colored tab the chip background comes from the color, and the chip foreground is the color's contrast pair. The theme's active, recency, and completion backgrounds do not apply, and the title shimmer is replaced by bold text. A done or unread tab keeps the theme's bold success color for the whole chip so completion stays recognizable; other status colors (running, waiting, error) stay shape-only. The active tab is still marked by its left focus marker. Uncolored tabs keep the theme's chip styling. Home's agent card paints the same color behind its title segment.

Colors are stored per session id under `tab_colors` in the current workdir's `mixcode_state.json`, so they survive restart. Titles and colors both follow the session id, so `/clear` (a new session file) drops the color. A color name that is no longer in the palette is ignored when the state file loads, and `/save-workspace` does not store colors.

### Tab titles

`/fork` names the new tab `{source}-fork`. `/new-session <name>` uses the given name. If that exact title is already open, MixCode appends `-1`, `-2`, … to the **new** tab only and persists the uniquified name. A nameless `/new-session` still uses the next free `Agent-NN`.

`/rename` refuses a title already used by another open tab (`Error:` system message; no change). The session-selector rename refuses the same clash with a warning toast. Resume, workspace restore, peer sync, and auto-rename keep the persisted session name even when it matches another open tab. `mpi ctl --tab` still errors when more than one open tab has the same title.

In the prompt editor, `@` fuzzy-matches the open tab titles of this instance (excluding the prompt-target tab itself) above file results. Selecting one inserts a plain-text mention: `@Title` when quoting is unnecessary, or a JSON-quoted value such as `@"My Title"`; embedded quotes are escaped.

## Agent Tab Collaboration

Tabs prompt peer tabs with `mpi status` / `mpi ctl` (same TUI, or another instance via `--pid` / `--workdir`). This is not the `open_tabs.json` peer-sync below. That only reconciles the open-tab set across processes.

- CLI contract: [Ctl Subcommand](cli-and-flags.md#ctl-subcommand)
- Agent cookbook: [mpi-ctl skill](../pi-packages/mpi-ctl-skill/skills/mpi-ctl/SKILL.md)

## Workspace Persistence

Workspaces store multi-tab layouts, active tab focus, working directories, and model assignments for quick restoration.

### File Contract

Each `workspaces.json` record stores tab order and identity only in the required `tabs` array. The record fields are `name`, `startup_workdir`, `updated_at`, optional `active_session_id`, and `tabs`. Each tab entry stores `session_id`, optional `session_path`, `title`, `workdir`, optional `model`, and optional `thinking_level`.

A named record without a `tabs` array is invalid. `loadWorkspaces()` throws `Invalid workspace file: <path>: workspaces[<index>].tabs must be an array`. No parallel session-ID list is written.

### Commands

| Command | Description |
|---|---|
| `/save-workspace [name]` | Writes the current tab layout into `<agentDir>/mixcode-pi/workdirs/<sha16>/workspaces.json`. |
| `/restore-workspace [name]` | Restores a named workspace, or opens the picker when name is omitted. |
| `/delete-workspace [name]` | Deletes a saved workspace record from `workspaces.json`. |

## Multi-Instance Tab Synchronization

### Session replacement

Extension `ctx.newSession()`, `ctx.switchSession()`, `ctx.fork()`, and `/import` replace the current tab's session through one runtime commit. The target JSONL exists before publication. Before `withSession` runs, the host synchronously updates `open_tabs.json`, the runtime ID, and the initiating instance's focus mapping. The tab keeps its position, and recent-tab references follow the new ID. A background replacement leaves Home or another tab focused.

Cancellation leaves the source session and shared membership unchanged. An unreadable shared snapshot rejects replacement before source shutdown.

If publication fails after replacement preparation, the host shuts down the uncommitted runtime, rebinds the source session, and reports the publication error. If rebinding also fails, it reports both errors in an `AggregateError`. Neither session file is deleted. A `withSession` failure occurs after commit: the replacement remains active with any messages the callback has already added.

The session selector creates a temporary tab, then uses this commit. `/clear` publishes its replacement ID before switching sessions. Peers reconcile the shared list every 2 seconds.

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
