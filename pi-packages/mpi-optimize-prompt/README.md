# mpi-optimize-prompt

[中文文档](README.zh.md)

Rewrite the input-editor draft (or slash args) into a clearer coding-agent prompt.

## Commands

```bash
/opt-prompt                  # Optimize the current editor draft
/opt-prompt <text>           # Optimize the given text into the editor
/opt-prompt config           # Overlay: model, thinking, system prompt
/opt-prompt help             # Usage and config docs
/opt-prompt cancel           # Abort in-flight optimize (draft kept)
/opt-prompt undo             # Restore the pre-optimize draft
```

`Ctrl+Shift+C` also cancels an in-flight optimize.

## Config (`<agentDir>/mpi-optimize-prompt.json`)

The package ships `mpi-optimize-prompt.schema.json` (installed to `<agentDir>/extensions/mpi-optimize-prompt/`); reference it via a `$schema` key for editor completion — the key is accepted and preserved on writes.

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "systemPrompt": "Your custom rewrite instructions..."
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | inherit active session model | `provider/modelId` |
| `thinking` | inherit active session thinking | Chosen model's supported levels, e.g. `off`, `low`, `high` |
| `systemPrompt` | built-in rewrite instructions | Full override; must ask for rewritten prompt only |

`/opt-prompt config` writes model/thinking immediately. Omit a field (or `"inherit"`) to follow the active session.
