# mpi-auto-rename

[中文文档](README.zh.md)

Generate a short kebab-case session title from the current conversation.

## Commands

```bash
/auto-rename                 # Generate a title from recent conversation
/auto-rename config          # Pick model and thinking
/auto-rename-cancel          # Abort an in-flight generate
```

## Config (`<agentDir>/auto-rename.json`)

```json
{
  "model": "provider/modelId",
  "thinking": "low"
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | inherit active session model | `provider/modelId` |
| `thinking` | inherit active session thinking | Chosen model's supported levels, e.g. `off`, `low`, `high` |

`/auto-rename config` writes both fields. Omit a field (or `"inherit"`) to follow the active session.
