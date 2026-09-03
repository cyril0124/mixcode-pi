# Keybindings, Hotkeys & Escape Dispatch

[中文文档](keybindings-and-escape.zh.md)

MixCode Pi provides comprehensive global and context-sensitive keyboard shortcuts (`src/core/keymap.ts`) and intelligent two-stage Escape sequence handling (`src/core/escape.ts`).

## Global & Surface Keybindings

| Key | Scope | Action | Description |
|---|---|---|---|
| `Tab` | Global | Next Tab | Next tab. No-op when autocomplete is open, and swallowed in Zen mode (use `Ctrl+T`). |
| `Shift+Tab` | Global | Previous Tab | Previous tab. Same autocomplete / Zen exceptions as `Tab`. |
| `Ctrl+P` | Global | Command Palette | Opens fuzzy searchable command palette. Same as `/palette`. |
| `Ctrl+T` | Global | Tab Jump | Opens interactive full-screen tab switcher. Same as `/jump`. |
| `Ctrl+J` / `Ctrl+K` | Tab Jump | Next / Previous Result | Moves the Tab Jump selection down / up. |
| `Ctrl+F` | Home | Non-idle filter | Toggles Agent View to non-idle agents only. Same rule as Tab Jump `Ctrl+F`. |
| `Ctrl+G` | Global | External Editor | Opens the current input draft in `$VISUAL` / `$EDITOR`. Same as `/editor`. |
| `Ctrl+Q` | Global | Quit | Safely persists workspace state and exits. |
| `Ctrl+C` | Global | Clear Input | Clears the editor. Does not abort a running turn (`Esc` does). |
| `Ctrl+U` | Input / Queue | Dequeue / Choose / Vim | Pops the sole non-empty queue; with both queues non-empty, arms an explicit choice; with both empty, arms Vim entry. |
| `Alt+Enter` | Input | Follow-up | Queue the editor draft as follow-up when the agent is running. Submit when idle. |
| `Ctrl+U,S` / `Ctrl+U,F` | Queue choice | Edit Steer / Follow-up | Pops the selected queue after dual-queue `Ctrl+U`. See [queue management](queue-and-follow-up.md). |
| `Right` | Empty Input | Side Panel | Expands / collapses right-hand extension widget panel. |
| `$` | Editor | Skill Completion | Triggers project, global, and installed package skill autocompletion. |
| `@` | Editor | File / Tab Completion | Fuzzy-matches peer tab titles above workspace file paths. |
| `!` | Editor | Bash Execution | Enters single-line inline bash command mode. |

## Custom Keybindings (`keybindings.json`)

MixCode supports custom keybindings configured in `~/.pi/agent/keybindings.json` (or `$PI_CODING_AGENT_DIR/keybindings.json`).

### Common Action Identifiers

| Action ID | Default Key | Action |
|---|---|---|
| `"app.model.cycleForward"` | `ctrl+p` | Open command palette |
| `"app.model.cycleBackward"` | `ctrl+t` | Open tab jump overlay |
| `"app.thinking.toggle"` | `ctrl+r` | Prepare tab rename command |
| `"app.editor.external"` | `ctrl+g` | Open input draft in external editor |
| `"app.tools.expand"` | `ctrl+o` | Toggle tool output expand/collapse |
| `"app.interrupt"` | `escape` | Cancel or abort current operation |
| `"app.clear"` | `ctrl+c` | Clear editor input |
| `"app.exit"` | `ctrl+q` | Quit MixCode |
| `"app.thinking.cycle"` | `shift+tab` | Cycle thinking level |
| `"app.message.followUp"` | `alt+enter` | Queue follow-up message |
| `"app.clipboard.pasteImage"` | `ctrl+v` (`alt+v`) | Paste image/text from clipboard |

### Configuration Example

Add your overrides to `~/.pi/agent/keybindings.json`:

```json
{
  "app.model.cycleForward": "ctrl+f",
  "app.model.cycleBackward": "ctrl+g",
  "app.thinking.toggle": "ctrl+w",
  "app.editor.external": "ctrl+alt+e"
}
```

- Each action accepts a single key string (e.g. `"ctrl+f"`) or an array of keys (e.g. `["ctrl+f", "alt+f"]`).
- Run `/reload` inside MixCode to hot-reload changes without restarting.

## Escape Dispatch & Retraction Flow (`src/core/escape.ts`)

Pressing `Escape` executes prioritized state-aware operations:

```text
User presses Escape
        │
        ├─ 1. Overlay Open? ─────────> Closes active Overlay (Tab Jump / Picker)
        ├─ 2. Autocomplete Active? ──> Closes candidate popup
        ├─ 3. Queue edit armed? ──────> Cancels queue choice; preserves both queues
        ├─ 4. Steer queue non-empty? ─> Flushes queued steer now (aborts current turn if streaming)
        ├─ 5. Agent Running?
        │      ├─ 1st press ─────────> Arms abort window (PENDING_ESCAPE_CONFIRM_WINDOW_MS = 1000ms)
        │      └─ 2nd press (Double) ─> Aborts turn / retracts prompt if the run produced no output
        │                               (no assistant/thinking text and no tool call) AND the run was
        │                               started by this turn's own user message (extension custom-message
        │                               runs always plain-abort)
        └─ 6. Empty Editor (Idle) ───> Double-Esc within 500ms opens session tree or fork.
                                       No-op in Vim mode.
```
