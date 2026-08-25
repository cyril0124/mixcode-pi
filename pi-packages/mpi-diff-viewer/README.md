# mpi-diff-viewer

[中文文档](README.zh.md)

MixCode built-in terminal-native interactive diff inspection and code review component registered under `/diff`.

## Core Capabilities

- **Unified Session Diffing**: Reconstructs file modifications across tool calls (`edit`, `write`, unified patch hunks) across the active session branch.
- **Git Reference Inspection**: Compares tracked text changes in the working tree and index against Git refs (`HEAD`, branches, or commits).
- **In-TUI Interactive Code Review**: Attach inline review comments (`fix` / `discuss`) to specific hunk lines and compose structured follow-up prompts back to the agent.

## Usage

| Command | Description |
|---|---|
| `/diff` | Opens interactive Diff Viewer comparing current session modifications. |
| `/diff last` | Last user turn only (`/diff 1`). |
| `/diff N` / `/diff N-M` | Session changes from the Nth-to-last turn, or a turn range. |
| `/diff HEAD` | Uncommitted tracked text changes against `HEAD`. |
| `/diff <ref>` | Tracked text changes in the working tree and index against a branch or commit. |

Refs named `last`, digits, or `N-M` must use a full name such as `refs/heads/last`; those short forms select session turns.
Invalid Git refs are reported as `Error: ...` notifications.

## Keybindings

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Switch between file list and diff hunk view. |
| `j` / `k` or `Down` / `Up` | Scroll lines within the active diff pane. |
| `n` / `p` | Jump to next / previous diff hunk. |
| `c` | Add / edit inline review comment on current line (`fix` / `discuss`). |
| `Enter` | Collapse or expand the selected navigator folder. |
| `Escape` / `q` | Close Diff Viewer overlay without submitting comments. |
