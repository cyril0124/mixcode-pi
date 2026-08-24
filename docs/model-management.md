# Model Management, Routing & Dynamic Rules

[中文文档](model-management.zh.md)

MixCode Pi provides model discovery, selection, thinking tier adjustments, provider disablement, and dynamic per-model capability binding.

## Model Configuration Files

```text
~/.pi/agent/models.json            Model definitions & custom endpoint configurations
~/.pi/agent/auth.json              API keys & provider credentials
~/.pi/agent/mixcode-pi/mixcode_settings.json   disabledProviders & disabledModels
~/.pi/agent/mpi-model-skills.json      Per-model dynamic skill attachments (mpi-model-skills)
~/.pi/agent/mpi-model-extensions.json  Per-model dynamic extension attachments (mpi-model-extensions)
```

## Model Selection & Thinking

- **Select Model**: Run `/models [provider/modelId]` or press `Ctrl+P` → **Choose Model**.
- **Thinking Tier**: Run `/thinking [tier]`. The accepted tiers are per model — a model's `thinkingLevelMap` may hide any of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `/thinking <unknown>` answers with that model's valid values.

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

### 1. Dynamic Skills (`mpi-model-skills`)

Configured via `~/.pi/agent/mpi-model-skills.json`:

```jsonc
{
  "rules": [
    {
      "match": { "model": "anthropic/*" },
      "add": ["tdd", "generic-writing"],
      "remove": ["caveman"]
    }
  ]
}
```

### 2. Dynamic Extensions (`mpi-model-extensions`)

Configured via `~/.pi/agent/mpi-model-extensions.json`:

```jsonc
{
  "rules": [
    {
      "match": { "provider": "deepseek" },
      "add": ["npm:pi-web-access"]
    }
  ]
}
```
