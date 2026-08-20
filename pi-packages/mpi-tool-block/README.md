# mpi-tool-block

Hide selected tools from the model by removing them from the active set. Definitions stay registered.

[中文文档](README.zh.md)

## Command

`/tool-block` — opens a settings-style overlay of every registered tool. Layer chooses where edits go. The value column is Visible, Hidden, or Inactive.

```text
┌─ Tool Block ───────────────────────────────────┐
│  filter: type to filter                        │
│  session (in-memory)                           │
│  › Layer                           Session     │
│    Enabled                         On          │
│    bash                            Visible     │
│    grep                            Inactive    │
│    create_goal                     Hidden      │
│  ↑↓ select  ⏎ toggle  Hidden/Visible/Inactive  │
└────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| Type | Filter by tool name, plugin, or `hidden` / `visible` / `inactive` |
| Space / Enter | Toggle Layer, Enabled, or Hidden / Visible / Inactive |
| Esc | Clear search, or close |

| Layer | Persist | Location line |
|-------|---------|---------------|
| Global | `<agentDir>/mpi-tool-block.json` immediately | file path; if a session override exists, prefixed with `session override ·` |
| Session | in-memory for this MixCode tab | `session (in-memory)` |

First switch to Session snapshots the current global config. While a session config exists it is the entire effective config (`session ?? global`): extra hides, unhides, and `enabled: Off` apply only to this tab. Switching Layer back to Global changes the edit target only; the session override stays until process restart, `/reload`, tab close, or extension rebuild.

| State | Meaning |
|-------|---------|
| Visible | In the current active set and not in `hidden[]`. Same names `/system-tools` shows while this overlay is Enabled. |
| Hidden | In `hidden[]`. Removed from the active set when Enabled is on. |
| Inactive | Registered, not in the active set, not in `hidden[]` (Pi default `grep`/`find`/`ls`, undisclosed extension tools). |

Toggling Inactive writes `hidden[]` (pre-hide) but does not activate the tool. Unhiding it returns to Inactive. Toggles call `setActiveTools` immediately. Small terminals window the list; title and footer stay visible.

`enabled: Off` keeps the `hidden` list but puts those tools back in the active set. Overlay still labels them Hidden.

## Config

Global file: `<agentDir>/mpi-tool-block.json` (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Created on the first Global-layer toggle; survives restart.

The package ships `mpi-tool-block.schema.json` (installed to `<agentDir>/extensions/mpi-tool-block/`); reference it via a `$schema` key for editor completion — the key is accepted and preserved on writes.

Session config uses the same shape in memory. It is not written to disk.

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

Missing file = no-op (no global hides). Invalid JSON or unknown keys fail loud: `/tool-block` notifies and does not open; the file is not overwritten.

`session_start` and `before_agent_start` re-read the global file and re-apply the effective config. They do not clear an existing in-memory session override. MixCode `/reload` rebuilds the extension instance and drops the session override.

## Limits

- No `unregisterTool`. Hidden tools remain registered; the model does not receive them.
- Tool names are unique. Hiding `foo` hides that name, not "plugin A's copy".
- Only names this package removed are restored when un-hidden or when `enabled` is off.
- Session override is per extension instance (one MixCode tab). There is no in-overlay clear; drop it by restart, `/reload`, or closing the tab.
