# mpi-auto-rename

[中文文档](README.zh.md)

Generate a short kebab-case session title from the current conversation.

## Commands

```bash
/auto-rename                 # Generate a title from recent conversation
/auto-rename config          # Settings list: model, thinking, first-message auto
/auto-rename-cancel          # Abort an in-flight generate
```

## Config (`<agentDir>/auto-rename.json`)

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "onFirstMessage": true
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | inherit active session model | `provider/modelId` |
| `thinking` | inherit active session thinking | Chosen model's supported levels, e.g. `off`, `low`, `high` |
| `onFirstMessage` | `false` (omit) | If `true`, generate a title when the session's first user message is sent. Skips named sessions and later turns. |

`/auto-rename config` opens a settings list. Enter edits a row (toggles `onFirstMessage`); Esc closes. Changes write immediately. Omit `model` / `thinking` (or `"inherit"`) to follow the active session.
