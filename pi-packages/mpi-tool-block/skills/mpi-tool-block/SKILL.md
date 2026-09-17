---
name: mpi-tool-block
description: Configure MixCode tool blocking so selected tools are removed from the model's active tool set.
disable-model-invocation: true
---

# Tool blocking

`mpi-tool-block` drops selected tool names from the active set, so the model cannot see or call them. The definitions stay registered.

## Workflow

1. Read `<agentDir>/mpi-tool-block.json` and, in a trusted project, `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json`.
2. Ask which tool names to hide if the request does not specify them. When the user prefers picking from `/tool-block`, select Project in its Layer row for the default project scope; the overlay writes the same files.
3. Default to writing `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json`, keeping `$schema` and the entries the user still wants. Use Global or Session only when explicitly requested. If the project is untrusted, explain that its config will not apply until Pi trusts it; do not silently switch to Global.
4. Verify: the next agent turn re-reads the file and applies it. `/system-tools` shows the resulting active set.

## Layers

- Global: `<agentDir>/mpi-tool-block.json`, re-read on `session_start` and before every agent turn.
- Project: `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json` (e.g. `.pi`), read only while Pi trusts the project. An untrusted checkout contributes nothing, including its parse errors.
- Session: in-memory for one MixCode tab, created when the overlay's Layer row cycles to Session.
- Global and project merge. The hidden set is the union of both enabled layers. A project file adds hides without restating the global list, and it cannot un-hide what the global file hides.
- A session config replaces that merge while it exists. It disappears on restart, `/reload`, tab close, or extension rebuild.
- `enabled: false` keeps `hidden` and makes that layer contribute no hides.

## Config

```json
{
  "$schema": "<agentDir>/extensions/mpi-tool-block/mpi-tool-block.schema.json",
  "enabled": true,
  "hidden": ["browser_navigate"]
}
```

- `hidden` holds exact tool names. Registry names are unique, so each name appears at most once; a duplicate is rejected.
- Both files use this shape. `$schema` resolves relative to the file holding it, so a project file needs an absolute path.
- Keys beyond `$schema`, `enabled`, and `hidden` are rejected, and every entry must be a non-empty string.
- A missing file hides nothing.
- An invalid file fails loud: `/tool-block` reports the error and does not open, and the file is left untouched. A broken global file hides nothing; a broken project file contributes nothing while the global layer keeps applying.
- A saved edit applies to the next agent turn; no restart is needed.

## Overlay

`/tool-block` lists every registered tool with its state, and toggles it on Space or Enter. The Layer row cycles Global → Project → Session and picks the edit target. The Enabled row bypasses hiding for the active layer without dropping its list. Typing filters by name, plugin, or `hidden` / `visible` / `inactive`.

| State | Meaning |
|-------|---------|
| Visible | In the active set and not in `hidden` |
| Hidden | In `hidden`; removed from the active set while Enabled is on |
| Inactive | Registered, outside the active set, absent from `hidden` (Pi's default `grep`/`find`/`ls`, undisclosed extension tools) |

Hiding an Inactive tool records it without activating it. Un-hiding returns it to Inactive.

## Limits

- No `unregisterTool`. A hidden tool remains registered; only the model stops receiving it.
- Hiding is by tool name, with no per-plugin scoping.
- Only names this extension removed are restored on un-hide or when `enabled` turns off.
