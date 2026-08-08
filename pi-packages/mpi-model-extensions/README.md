# mpi-model-extensions

Per-model extension **load** by dynamically invoking extension factories with the host `ExtensionAPI`.

Independent Pi package — no MixCode `src/` runtime coupling.

## Config

`~/.pi/agent/model-extensions.json` (or `$PI_CODING_AGENT_DIR` / `$MIXCODE_CODING_AGENT_DIR`):

```json
{
  "rules": [
    {
      "match": { "model": "deepseek/*" },
      "add": ["$HOME/.pi/agent/model-exts/vision-helper"]
    },
    {
      "match": { "missingInput": ["image"] },
      "add": ["vision-helper"],
      "remove": []
    }
  ]
}
```

### `match`

| Field | Meaning |
|-------|---------|
| `model` | Glob on `provider/modelId` (`*`, e.g. `deepseek/*`) |
| `missingInput` | All listed modalities must be **absent** from `model.input` |
| `hasInput` | All listed modalities must be **present** |

Empty `match: {}` matches every model. Multiple matching rules apply **in array order**.

### `add` (string list)

| Form | Meaning |
|------|---------|
| `/abs`, `~/…`, `$VAR/…` | Load extension entry (file or dir with `index.ts`/`index.js`) |
| `name` | Resolve `<agentDir>/extensions/<name>` |

Relative paths are **rejected**. Same path loads **once** per session.

### `remove`

Friendly **names** only (package dir / entry basename). Removes from this package's load plan. Does **not** unload extensions already loaded by Pi.

## Commands

- `/model-extensions` — `[global]` status panel
- `/model-extensions help` — schema
- `/model-extensions on` / `off` — persist `enabled`

Config reloads on session start / `/reload`. Loads run on `session_start` (current model) and `model_select` (**add-only**).

## Placement

Keep model-only extensions **out of** always-discovered roots if you only want them via this package. If Pi already loaded the same path, this package will still invoke the factory on first plan hit (tools may double-register) — prefer side directories referenced by absolute path.

## Limits

- Loads factories; does not filter Pi's discovery list.
- Switching away from a matching model does **not** unload; use `/reload` or a new session.
- `model_select` only adds newly matched paths (does not replay missed `session_start` hooks of child factories).
