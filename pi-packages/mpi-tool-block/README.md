# mpi-tool-block

Hide selected tools from the model by removing them from the active set. Definitions stay registered.

[中文文档](README.zh.md)

## Skill

`$mpi-tool-block` or `/skill:mpi-tool-block` loads the configuration cookbook. It stays out of the system prompt (`disable-model-invocation`). Pi loads `pi.skills` on a normal package install; MixCode installs the built-in under `<agentDir>/extensions/`, and `index.ts` contributes the same `skills/` tree through `resources_discover`. `$` completion scans that tree. Package skills are not copied into `<agentDir>/skills`.

Cookbook: [skills/mpi-tool-block/SKILL.md](skills/mpi-tool-block/SKILL.md).

## Command

`/tool-block` opens a settings-style overlay of every registered tool. Layer chooses where edits go. The value column is Visible, Hidden, or Inactive.

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
| Project | `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json` (e.g. `.pi`) immediately, only while the project is trusted | project file path |
| Session | in-memory for this MixCode tab | `session (in-memory)` |

The Layer row cycles Global → Project → Session, and skips Project while the project is untrusted.

Global and project merge. The hidden set is the union of both files, so a project file adds hides without restating the global list. `enabled: Off` on a layer drops that layer's hides and keeps its list.

A session config replaces that merge while it exists. Extra hides, unhides, and `enabled: Off` then apply only to this tab. Entering Session snapshots the merged set, and switching Layer back to Global only changes the edit target. The override lasts until process restart, `/reload`, tab close, or extension rebuild.

The list shows the file of the active layer. A name hidden by another layer shows as Inactive there: it is outside the active set and absent from this layer's `hidden`.

| State | Meaning |
|-------|---------|
| Visible | In the current active set and not in `hidden[]`. Same names `/system-tools` shows while this overlay is Enabled. |
| Hidden | In `hidden[]`. Removed from the active set when Enabled is on. |
| Inactive | Registered, not in the active set, not in `hidden[]` (Pi default `grep`/`find`/`ls`, undisclosed extension tools). |

Toggling Inactive writes `hidden[]` (pre-hide) but does not activate the tool. Unhiding it returns to Inactive. Toggles call `setActiveTools` immediately. Small terminals window the list; title and footer stay visible.

`enabled: Off` keeps the `hidden` list but puts those tools back in the active set. Overlay still labels them Hidden.

## Config

Global file: `<agentDir>/mpi-tool-block.json` (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Created on the first Global-layer toggle; survives restart.

Project file: `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json` (e.g. `.pi/mpi-tool-block.json`), read only while Pi trusts the project. An untrusted checkout contributes nothing, including its parse errors. Created on the first Project-layer toggle.

The package ships `mpi-tool-block.schema.json` (installed to `<agentDir>/extensions/mpi-tool-block/`); reference it via a `$schema` key for editor completion. The key survives overlay writes. The path resolves relative to the file holding it, so a project file needs an absolute path or an editor schema mapping.

Session config uses the same shape in memory. It is not written to disk.

```json
{
  "enabled": true,
  "hidden": ["browser_navigate"]
}
```

| Field | Type | Contract |
|-------|------|----------|
| `enabled` | boolean | Default `true`. `false` = do not hide. |
| `hidden[]` | string | Exact tool name. Names are global and unique, so each name appears at most once. |

Missing file = no-op for that layer. Invalid JSON, unknown keys, or a non-string entry fail loud: `/tool-block` names the file and does not open, and the file is not overwritten. A broken global file hides nothing; a broken project file contributes nothing while the global layer keeps applying.

`session_start` and `before_agent_start` re-read both files and re-apply the effective config. They do not clear an existing in-memory session override. MixCode `/reload` rebuilds the extension instance and drops the session override.

## Limits

- No `unregisterTool`. Hidden tools remain registered; the model does not receive them.
- Hiding is by tool name. There is no per-plugin scoping.
- A project file cannot un-hide what the global file hides; remove the name from the layer that hides it.
- Plugin tags are read from the live registry and shown in the overlay; the config stores tool names only.
- Only names this extension removed are restored when un-hidden or when `enabled` is off.
- Session override is per extension instance (one MixCode tab). There is no in-overlay clear; drop it by restart, `/reload`, or closing the tab.
