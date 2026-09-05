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
| `/new-session` | `[--focus\|--no-focus] [title]` | Workdir | Opens a new agent tab with an optional custom title. Default focuses the new tab; `--no-focus` leaves the current tab focused. A taken title becomes `title-N`. See [Tab titles](workspace-and-tabs.md#tab-titles). |
| `/fork` | - | Workdir | Clones current conversation branch into a new tab that owns its runtime services. Title is `{source}-fork`, or `{source}-fork-N` if taken. See [Tab titles](workspace-and-tabs.md#tab-titles). |
| `/follow-up` | `<text>` | Session | Enqueues prompt into follow-up queue, prioritized after current turn finishes. |
| `/compact` | `[custom instructions]` | Session | Manually triggers context compaction on the current branch. |
| `/reset` | - | Session | Resets the conversation leaf to root while retaining session file and tab title. Earlier branches stay in `/tree`. |
| `/clear` | - | Session | Generates a fresh session file in the active tab and resets tab title. |
| `/close-session` | `[yes]` | Session | Closes the active tab and tears down in-memory agent runtime. `yes` skips the confirmation overlay. |
| `/close-all-sessions`| - | Session | Closes all open agent tabs after user confirmation. |
| `/delete-session` | `[yes]` | Session | Closes current tab and permanently deletes its `.jsonl` session file. `yes` skips the confirmation overlay. |
| `/delete-all-sessions` | - | Session | Permanently deletes all `.jsonl` session files for the current workspace. |
| `/tree` | - | Session | Opens interactive session branch tree viewer. |
| `/resume` | `[session-id \| N:<tab-name>]` | Session | Opens the interactive session selector; `/resume <session-id>` (exact id or prefix, current folder first, then all roots) resumes directly. `/resume N:<tab-name>` first matches an open tab title exactly, then an exact full session name (current folder first). Duplicate names report all candidate ids. |
| `/palette` | - | - | Opens the command palette. Same as `Ctrl+P`. |
| `/jump` | - | - | Opens the tab jump overlay. Same as `Ctrl+T`. |
| `/editor` | - | - | Edits the input draft in `$VISUAL` / `$EDITOR`. Same as `Ctrl+G`. |
| `/vim` | - | Session | Enters buffer-style Vim transcript navigation mode (`q` to leave). |
| `/toggle-zen-mode` | - | Session | Toggles tab bar visibility for distraction-free view. |
| `/toggle-inline-widgets` | - | Session | Toggles inline widget rendering in the chat scroll area vs above the editor. |
| `/toggle-hidden-messages` | - | Session | Reveals or hides internal custom extension messages. |
| `/hide-thinking` | - | `[global]` | Toggles whether thinking blocks are hidden. Hidden blocks render as `Thinking...` (or a `setHiddenThinkingLabel` override); set `ui.boxedHiddenThinking` in [mixcode_settings.json](mixcode-settings.md) for the 3-row tail preview. |
| `/settings` | - | Global | Opens interactive settings overlay for themes, icons, and UI preferences. |
| `/login` | `[provider]` | Global | Configures provider authentication. Without an argument, select subscription or API key first; an exact provider id or name opens that provider directly. Credentials are shared with Pi through `<agentDir>/auth.json`. |
| `/logout` | - | Global | Removes a credential saved by `/login`; environment variables and `models.json` authentication remain unchanged. |
| `/save-workspace` | `[name]` | Workdir | Saves multi-tab layout to `<stateDir>/workspaces.json`. |
| `/restore-workspace` | `[name]` | Workdir | Restores a saved workspace; omit name to open the picker. |
| `/delete-workspace` | `[name]` | Workdir | Deletes a saved workspace record. |
| `/export` | `[path]` | Session | Writes HTML into the tab workdir when `path` is omitted; JSONL when `path` ends with `.jsonl`. Relative `path` is resolved against the tab workdir. |
| `/import` | `<jsonl-path>` | Session | Imports an external session JSONL into the current workspace. Relative `jsonl-path` is resolved against the tab workdir. |
| `/extension-manager` | - | Workdir | Interactive manager to enable or disable discovered Pi extensions. |
| `/reload` | - | Session | Reloads model configurations, project skills, and rebinds extensions. |
| `/system-prompt` | - | Session | Inspects or edits the assembled system prompt in an external editor; a footer lists each section's size and estimated token share. |
| `/system-tools` | - | Session | Inspects active tool schemas and tool owners; a footer lists each tool's size and estimated token share, counting only what is sent to the model (name + description + parameter schema). |
| `/console-history` | - | - | Opens the latest 1,000 bridged `console.log/info/debug/warn/error` records from the current `mpi` process. Checks the project setting, global setting, `$VISUAL`, and `$EDITOR`, in that order. The selected command must pass a one-second `--version` probe. If none is set, MixCode tries `nvim` and then `vim`. If no external editor is available, MixCode opens the built-in read-only viewer. Restarting `mpi` clears the history. |
| `/hotkeys` | - | - | Displays full keyboard shortcut reference. |
| `/quit` / `/exit` | - | - | Safely persists state and exits MixCode. |
