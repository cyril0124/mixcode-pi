# mpi-tool-block

Hide selected tools from the model by removing them from the active set. Definitions stay registered.

[中文文档](README.zh.md)

## Command

`/tool-block` — `[global]` opens a settings-style overlay of every registered tool.

```text
┌─ Tool Block ───────────────────────────────────┐
│  filter: type to filter                        │
│  ~/.pi/agent/tool-block.json                   │
│   mpi-goal ──────────────────────────────────  │
│  › Enabled                         On          │
│    bash                            Visible     │
│    create_goal                     Hidden      │
│  ↑↓ select  ⏎ toggle  type to filter  esc      │
└────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| Type | Filter by tool name or plugin |
| Space / Enter | Toggle Hidden / Visible, or Enabled |
| Esc | Clear search, or close |

Toggles write `<agentDir>/tool-block.json` immediately and call `setActiveTools`. Small terminals window the list; title and footer stay visible.

`enabled: Off` keeps the `hidden` list but puts those tools back in the active set.

## Config

`<agentDir>/tool-block.json` (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Created on the first toggle; survives restart.

```json
{
  "enabled": true,
  "hidden": [
    { "tool": "browser_navigate", "plugin": "pi-web-access" }
  ]
}
```

| Field | Type | Contract |
|-------|------|----------|
| `enabled` | boolean | Default `true`. `false` = do not hide. |
| `hidden[].tool` | string | Exact tool name (names are global). |
| `hidden[].plugin` | string? | Optional extension tag (`npm:` package or `extensions/<name>`). Omitted for core/Pi tools. |

Missing file = no-op. Invalid JSON or unknown keys fail loud: `/tool-block` notifies and does not open; the file is not overwritten.

Reload on `session_start` / `/reload`. `before_agent_start` re-reads the file and re-applies.

## Limits

- No `unregisterTool`. Hidden tools remain registered; the model does not receive them.
- Tool names are unique. Hiding `foo` hides that name, not "plugin A's copy".
- Only names this package removed are restored when un-hidden or when `enabled` is off.
