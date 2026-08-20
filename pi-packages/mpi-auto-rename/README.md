# mpi-auto-rename

[中文文档](README.zh.md)

Generate a short kebab-case session title from the current conversation.

## Commands

```bash
/auto-rename                 # Generate a title from recent conversation
/auto-rename config          # Settings list: model, thinking, first-message auto, max context chars
/auto-rename-cancel          # Abort an in-flight generate
```

If the session already has a title, choose **Yes** to overwrite, **No** to keep it, or **Regenerate** to generate another title.

## Config (`<agentDir>/mpi-auto-rename.json`)

The package ships `mpi-auto-rename.schema.json` (installed to `<agentDir>/extensions/mpi-auto-rename/`); reference it via a `$schema` key for editor completion — the key is accepted and preserved on writes.

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "onFirstMessage": true,
  "maxContextChars": 4000
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | inherit active session model | `provider/modelId` |
| `thinking` | inherit active session thinking | Chosen model's supported levels, e.g. `off`, `low`, `high` |
| `onFirstMessage` | `false` (omit) | If `true`, generate a title when the session's first user message is sent. Skips named sessions and later turns. |
| `maxContextChars` | `4000` (omit) | Positive integer. Last 20 user/assistant sections, then tail-sliced to this many characters. |

`/auto-rename config` opens a settings list. Enter edits a row (toggles `onFirstMessage`; `maxContextChars` picks `1000` / `4000` / `8000` / `16000`). Esc closes. Changes write immediately. Omit `model` / `thinking` (or `"inherit"`) to follow the active session. Omit `maxContextChars` (or set `4000`) to use the default. JSON accepts any positive integer.
