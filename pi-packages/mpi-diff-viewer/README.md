# mpi-diff-viewer

[中文文档](README.zh.md)

MixCode built-in terminal-native interactive diff inspection and code review component registered under `/diff`.

## Core Capabilities

- **Unified Session Diffing**: Reconstructs file modifications across tool calls (`edit`, `write`, unified patch hunks) across the active session branch.
- **Git Reference Inspection**: Compares current workspace status against Git refs (`HEAD`, branches, commits, or working tree).
- **In-TUI Interactive Code Review**: Attach inline review comments (`fix` / `discuss`) to specific hunk lines and compose structured follow-up prompts back to the agent.

## Usage

| Command | Description |
|---|---|
| `/diff` | Opens interactive Diff Viewer comparing current session modifications. |
| `/diff HEAD` | Inspects uncommitted Git working tree modifications against `HEAD`. |
| `/diff <ref>` | Inspects git diff against a specific branch or commit hash. |

## Keybindings

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Switch between file list and diff hunk view. |
| `j` / `k` or `Down` / `Up` | Scroll lines within the active diff pane. |
| `n` / `p` | Jump to next / previous diff hunk. |
| `c` | Add / edit inline review comment on current line (`fix` / `discuss`). |
| `Enter` | Collapse or expand the selected navigator folder. |
| `Escape` / `q` | Close Diff Viewer overlay without submitting comments. |
