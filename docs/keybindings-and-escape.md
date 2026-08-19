# Keybindings, Hotkeys & Escape Dispatch

[中文文档](keybindings-and-escape.zh.md)

MixCode Pi provides comprehensive global and context-sensitive keyboard shortcuts (`src/core/keymap.ts`) and intelligent two-stage Escape sequence handling (`src/core/escape.ts`).

## Global & Surface Keybindings

| Key | Scope | Action | Description |
|---|---|---|---|
| `Tab` | Global | Next Tab | Next tab. No-op when autocomplete is open, and swallowed in Zen mode (use `Ctrl+T`). |
| `Shift+Tab` | Global | Previous Tab | Previous tab. Same autocomplete / Zen exceptions as `Tab`. |
| `Ctrl+P` | Global | Command Palette | Opens fuzzy searchable command palette. |
| `Ctrl+T` | Global | Tab Jump | Opens interactive full-screen tab switcher. |
| `Ctrl+F` | Home | Non-idle filter | Toggles Agent View to non-idle agents only. Same rule as Tab Jump `Ctrl+F`. |
| `Ctrl+E` | Global | External Editor | Opens the current input draft in `$VISUAL` / `$EDITOR`. |
| `Ctrl+Q` | Global | Quit | Safely persists workspace state and exits. |
| `Ctrl+C` | Global | Clear Input | Clears the editor. Does not abort a running turn (`Esc` does). |
| `Ctrl+U` | Input / Queue | Dequeue / Vim | Pops queued messages back into editor; on empty queue arms entry to Vim mode. |
| `Right` | Empty Input | Side Panel | Expands / collapses right-hand extension widget panel. |
| `$` | Editor | Skill Completion | Triggers project, global, and installed package skill autocompletion. |
| `@` | Editor | File Completion | Triggers workspace file path autocompletion. |
| `!` | Editor | Bash Execution | Enters single-line inline bash command mode. |

## Escape Dispatch & Retraction Flow (`src/core/escape.ts`)

Pressing `Escape` executes prioritized state-aware operations:

```text
User presses Escape
        │
        ├─ 1. Overlay Open? ─────────> Closes active Overlay (Tab Jump / Picker)
        ├─ 2. Autocomplete Active? ──> Closes candidate popup
        ├─ 3. In Vim Mode? ──────────> Exits Vim mode, focuses Editor
        ├─ 4. Steer queue non-empty? ─> Flushes queued steer now (aborts current turn if streaming)
        ├─ 5. Agent Running?
        │      ├─ 1st press ─────────> Arms abort window (PENDING_ESCAPE_CONFIRM_WINDOW_MS = 1000ms)
        │      └─ 2nd press (Double) ─> Aborts turn / retracts prompt if the run produced no output
        │                               (no assistant/thinking text and no tool call) AND the run was
        │                               started by this turn's own user message (extension custom-message
        │                               runs always plain-abort)
        └─ 6. Empty Editor (Idle) ───> Double-Esc within 500ms opens session tree (or fork)
```
