# Slash Commands & Commands Reference

[中文文档](commands.zh.md)

MixCode provides built-in local slash commands registered in `src/core/commands.ts`. These commands power the autocomplete engine and the Command Palette (`Ctrl+P`).

## Persistence Tiers

Commands operate across three distinct persistence tiers:

1. **Global (`[global]`)**: Persists to Pi's global `<agentDir>/settings.json`. Survives restart and shared across workdirs.
2. **Workdir**: Persists to `mixcode_state.json` for the current working directory.
3. **Session**: Applied in memory or via session overrides; discarded on restart.

## Commands Catalog

| Command | Argument Hint | Tier | Description |
|---|---|---|---|
| `/models` | `[provider/modelId]` | Session | Opens interactive model selector or switches model directly. |
| `/thinking` | `[off\|minimal\|low\|medium\|high\|xhigh\|max]` | Session | Sets model reasoning/thinking effort level. |
| `/context-limit` | `<tokens\|reset>` | Session | Sets artificial context window limit for testing or compaction tuning. |
| `/workdir` | `[path]` | Workdir | Switches active agent working directory and updates file watchers. |
| `/new-session` | `[title]` | Workdir | Opens a new agent tab with an optional custom title. A taken title becomes `title-N`. See [Tab titles](workspace-and-tabs.md#tab-titles). |
| `/fork` | - | Workdir | Clones current conversation branch into a new tab, reusing underlying runtime services. Title is `{source}-fork`, or `{source}-fork-N` if taken. See [Tab titles](workspace-and-tabs.md#tab-titles). |
| `/follow-up` | `<text>` | Session | Enqueues prompt into follow-up queue, prioritized after current turn finishes. |
| `/compact` | `[custom instructions]` | Session | Manually triggers context compaction on the current branch. |
| `/reset` | - | Session | Resets the conversation leaf to root while retaining session file and tab title. |
| `/clear` | - | Session | Generates a fresh session file in the active tab and resets tab title. |
| `/close-session` | `[yes]` | Session | Closes the active tab and tears down in-memory agent runtime. `yes` skips the confirmation overlay. |
| `/close-all-sessions`| - | Session | Closes all open agent tabs after user confirmation. |
| `/delete-session` | `[yes]` | Session | Closes current tab and permanently deletes its `.jsonl` session file. `yes` skips the confirmation overlay. |
| `/delete-all-sessions` | - | Session | Permanently deletes all `.jsonl` session files for the current workspace. |
| `/tree` | - | Session | Opens interactive session branch tree viewer. |
| `/resume` | `[session-id]` | Session | Opens the interactive session selector; `/resume <session-id>` (exact id or prefix, current folder first, then all roots) resumes that session directly. |
| `/navigate` | - | Session | Opens message navigator filtered to user turns. |
| `/vim` | - | Session | Enters buffer-style Vim transcript navigation and search mode. |
| `/toggle-zen-mode` | - | Session | Toggles tab bar visibility for distraction-free view. |
| `/toggle-inline-widgets` | - | Session | Toggles inline widget rendering in the chat scroll area vs above the editor. |
| `/toggle-hidden-messages` | - | Session | Reveals or hides internal custom extension messages. |
| `/hide-thinking` | - | `[global]` | Toggles whether thinking blocks are hidden behind placeholders. |
| `/settings` | - | Global | Opens interactive settings overlay for themes, icons, and UI preferences. |
| `/save-workspace` | `[name]` | Workdir | Saves multi-tab layout to `<stateDir>/workspaces.json`. |
| `/restore-workspace` | `[name]` | Workdir | Restores a saved workspace; omit name to open the picker. |
| `/delete-workspace` | `[name]` | Workdir | Deletes a saved workspace record. |
| `/export` | `[path]` | Session | Exports the session as HTML, or JSONL when the path ends with `.jsonl`. |
| `/import` | `<jsonl-path>` | Session | Imports an external session JSONL into the current workspace. |
| `/extension-manager` | - | Workdir | Interactive manager to enable or disable discovered Pi extensions. |
| `/reload` | - | Session | Reloads model configurations, project skills, and rebinds extensions. |
| `/system-prompt` | - | Session | Inspects or edits the assembled system prompt in an external editor; a footer lists each section's size and estimated token share. |
| `/system-tools` | - | Session | Inspects active tool schemas and tool owners. |
| `/hotkeys` | - | - | Displays full keyboard shortcut reference. |
| `/quit` / `/exit` | - | - | Safely persists state and exits MixCode. |
