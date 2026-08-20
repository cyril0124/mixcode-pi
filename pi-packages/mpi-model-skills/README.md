# mpi-model-skills

Per-model skill **add/remove** by rebuilding the system prompt `<available_skills>` section.

[中文文档](README.zh.md)

## Config

`~/.pi/agent/model-skills.json` (or `$PI_CODING_AGENT_DIR`):

The package ships `model-skills.schema.json` (installed to `<agentDir>/extensions/mpi-model-skills/`); reference it via a `$schema` key for editor completion — the key is accepted and preserved on writes.

```json
{
  "rules": [
    {
      "match": { "missingInput": ["image"] },
      "add": ["vision-proxy"],
      "remove": []
    },
    {
      "match": { "model": "deepseek/*" },
      "add": ["$HOME/.agents/skills/vision-proxy"],
      "remove": ["some-skill"]
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
| `skill-name` | Resolve from currently loaded skills |
| `/abs/path`, `~/…`, `$VAR/…`, `${VAR}/…` | Load skill from absolute path (dir or `SKILL.md`) |

Relative paths are **rejected**. Same skill name: **add overwrites**.

### `remove`

Skill **names** only. Missing name → warning notify (idempotent).

## Commands

- `/model-skills` — `[global]` show config path, matching rules, effective skill names (markdown panel, purple bg)
- `/model-skills help` — full config schema as markdown
- `/model-skills on` / `/model-skills off` — enable/disable rule application (writes `enabled` in config)
- Slash autocomplete: argument hint `[help|on|off]`
- Config reloads on session start / `/reload` (not every prompt)

## Example: vision polyfill

1. Install a vision skill under a known path (or as a normal discovered skill named `vision-proxy`).
2. Config:

```json
{
  "rules": [
    {
      "match": { "missingInput": ["image"] },
      "add": ["$HOME/.agents/skills/vision-proxy"]
    }
  ]
}
```

3. `/reload`, then use a text-only model — system prompt skills list should include the vision skill.

## Known limit (deferred)

`mpi-skill-refs` (`$SkillName`) still resolves against Pi’s original loaded skill list, not this extension’s rewritten system prompt. Track as a follow-up if `$` refs must stay in sync.
