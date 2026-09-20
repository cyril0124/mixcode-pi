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

Pi's model registry sends each request through the selected model's configured provider. It resolves authentication for each request and applies OAuth refresh, base URLs, headers, and environment settings. Local providers can run without API keys.

Provider or authentication errors appear as `Optimize failed: ...`. The editor draft and undo entry stay unchanged. Cancelling clears progress immediately. A late response cannot replace the draft or clear another request's progress widget.

## Config (`<agentDir>/mpi-optimize-prompt.json`)

The package installs `mpi-optimize-prompt.schema.json` under `<agentDir>/extensions/mpi-optimize-prompt/`. Reference it with `$schema` for editor completion. Config writes preserve this key.

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
