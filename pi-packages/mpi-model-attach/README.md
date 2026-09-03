# mpi-model-attach

Adds or removes skills for the current model by rewriting the system prompt `<available_skills>` block. Loads extra Pi extensions by calling their factories with the host `ExtensionAPI`.

[中文文档](README.zh.md)

## Config

File: `~/.pi/agent/mpi-model-attach.json` (or `$PI_CODING_AGENT_DIR`).

The package ships `mpi-model-attach.schema.json` at `<agentDir>/extensions/mpi-model-attach/`. Put that path in a `$schema` key for editor completion. The loader accepts the key and keeps it on write.

```json
{
  "skills": {
    "rules": [
      {
        "match": { "missingInput": ["image"] },
        "add": ["$HOME/.agents/skills/vision-proxy"]
      }
    ]
  },
  "extensions": {
    "rules": [
      {
        "match": { "model": "deepseek/*" },
        "add": ["$HOME/.pi/agent/model-exts/vision-helper"]
      }
    ]
  }
}
```

Leave out `skills` or `extensions` if you do not want that half to run.

### `match`

| Field | Meaning |
|-------|---------|
| `model` | Glob on `provider/modelId` (`*`, e.g. `deepseek/*`) |
| `missingInput` | Every listed modality is absent from `model.input` |
| `hasInput` | Every listed modality is present |

Empty `match: {}` matches every model. Matching rules run in array order.

### `skills.add`

| Form | Meaning |
|------|---------|
| `skill-name` | Take the skill from the currently loaded set |
| `/abs/path`, `~/…`, `$VAR/…`, `${VAR}/…` | Load a skill from an absolute path (directory or `SKILL.md`) |

Relative paths are rejected. A later add with the same skill name replaces the earlier one.

### `skills.remove`

Skill names only. A missing name warns and is otherwise a no-op.

### `extensions.add`

| Form | Meaning |
|------|---------|
| `/abs`, `~/…`, `$VAR/…` | Load an extension entry (file, or a directory with `index.ts` / `index.js`) |
| `name` | Resolve `<agentDir>/extensions/<name>` |

Relative paths are rejected. The same path is loaded once per session.

### `extensions.remove`

Friendly names only (package directory or entry basename). This drops the path from this package's load plan. It does not unload an extension Pi already loaded.

## Commands

- `/model-attach` (`[global]`) status: config path, matching rules, effective skills, planned and loaded extensions
- `/model-attach help` config schema as markdown
- `/model-attach skills on` / `off` writes `skills.enabled`
- `/model-attach extensions on` / `off` writes `extensions.enabled`
- Slash autocomplete hint: `[help|skills on|off|extensions on|off]`
- Config reloads on session start and `/reload`, not on every prompt
- Extension loads run on `session_start` for the current model, and on `model_select` for newly matched paths only

## Placement

If an extension should exist only for some models, keep it out of Pi's always-discovered roots. Point at a side directory with an absolute path. If Pi already loaded that path, this package still calls the factory the first time the plan hits it, so tools can register twice.

## Limits

- This package calls factories. It does not filter Pi's discovery list.
- Switching to a model that no longer matches does not unload anything. Use `/reload` or a new session.
- `model_select` only adds newly matched paths. It does not replay a child factory's missed `session_start` hooks.
- `mpi-skill-refs` (`$SkillName`) still resolves against Pi's original loaded skill list, not the rewritten prompt.
