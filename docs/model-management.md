# Model Management, Routing & Dynamic Rules

[中文文档](model-management.zh.md)

MixCode Pi provides model discovery, selection, thinking tier adjustments, provider disablement, and dynamic per-model capability binding.

## Model Configuration Files

```text
~/.pi/agent/models.json            Model definitions & custom endpoint configurations
~/.pi/agent/auth.json              API keys & provider credentials
~/.pi/agent/mixcode-pi/mixcode_settings.json   disabledProviders & disabledModels
~/.pi/agent/mpi-model-attach.json      Per-model skill and extension rules (mpi-model-attach)
```

## Model Selection & Thinking

- **Select Model**: Run `/models [provider/modelId]` or press `Ctrl+P` → **Choose Model**.
- **Thinking Tier**: Run `/thinking [tier]`. The accepted tiers are per model. A model's `thinkingLevelMap` may hide any of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `/thinking <unknown>` answers with that model's valid values.

## Listing Models From the CLI

```bash
mpi --list-models [search] [--json]
```

Prints one row per model with configured auth, plus the thinking tiers that model accepts:

```text
provider  model              context  thinking
faux      faux-1             200K     off,minimal,low,medium,high
deepseek  deepseek-v4-flash  1M       off,low,high,max
deepseek  deepseek-v4-pro    1M       off,high,max                 (disabled)
```

`search` filters case-insensitively on `provider/modelId`. `--json` emits an array of
`{ id, provider, modelId, displayName, contextWindow, reasoning, disabled, thinking }`.

Scope, identical to what `/models` offers:

- Only providers whose auth resolves (`auth.json`, `models.json` `apiKey`, or environment variables) appear; the rest are absent, as in the picker.
- The faux default heads the list; entries matched by `disabledProviders` / `disabledModels` are kept and marked `(disabled)`.
- Providers registered at runtime by extensions (`pi.registerProvider`) are **not** covered: the command reads `models.json` and the built-in catalog without loading extensions.
- No TUI, no network, no running instance required, so it is safe to call from scripts and from another agent tab.

## Global Model & Provider Disablement

Disablement lives in [`mixcode_settings.json`](mixcode-settings.md) (`disabledProviders` / `disabledModels`). Do not duplicate the schema here.

The surviving catalogue is also the session's model scope: extensions read it as `ctx.scopedModels`. With nothing disabled the scope is empty, which is Pi's "unscoped" contract.

## Per-Model Dynamic Rules

Config file: `~/.pi/agent/mpi-model-attach.json`. Schema and commands: [pi-packages/mpi-model-attach/README.md](../pi-packages/mpi-model-attach/README.md).

```jsonc
{
  "skills": {
    "rules": [
      {
        "match": { "model": "anthropic/*" },
        "add": ["tdd", "generic-writing"],
        "remove": ["caveman"]
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
