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
- **Thinking Tier**: Run `/thinking [tier]` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

## Global Model & Provider Disablement

Disablement lives in [`mixcode_settings.json`](mixcode-settings.md) (`disabledProviders` / `disabledModels`). Do not duplicate the schema here.

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
