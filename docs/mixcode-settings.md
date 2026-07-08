# `mixcode_settings.json`

MixCode Pi reads `mixcode_settings.json` from its root state directory. By default, that is:

```text
~/.pi/agent/mixcode-pi/mixcode_settings.json
```

The file uses JSONC syntax: regular JSON plus comments and trailing commas. If the file does not exist, MixCode Pi uses the defaults below.

## Supported Settings

```jsonc
{
  "history": {
    "maxBytes": 5242880,
  },
  "ui": {
    "oversizedAssistantMessage": {
      "enabled": true,
      "maxLines": 5000,
      "maxBytes": 131072,
    },
  },
}
```

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| `history.maxBytes` | positive integer | `5242880` | Maximum size, in bytes, kept in `history.jsonl`. Older entries are trimmed when the file exceeds this size. |
| `ui.oversizedAssistantMessage.enabled` | boolean | `true` | Fold oversized assistant/thinking provider output in the TUI while keeping full content in the session; use `/view` to inspect the full content. |
| `ui.oversizedAssistantMessage.maxLines` | positive integer | `5000` | Fold assistant/thinking output above this line count. |
| `ui.oversizedAssistantMessage.maxBytes` | positive integer | `131072` | Fold assistant/thinking output above this UTF-8 byte size. |

## Parsing Rules

- Missing file: uses the default settings.
- JSONC comments and trailing commas are accepted.
- `history.maxBytes`: must be a positive integer; invalid values fall back to `5242880`.
- `ui.oversizedAssistantMessage.enabled`: must be a boolean.
- `ui.oversizedAssistantMessage.maxLines` and `.maxBytes`: must be positive integers.
- Invalid `ui.oversizedAssistantMessage` values are reported as settings errors.
- Unknown fields are ignored.
- Invalid JSONC is reported as a settings error.

Prompt history cannot be disabled through `mixcode_settings.json`; submitted prompts are saved when they have a valid session id and non-empty text.

## Example

Cap prompt history at 1 MiB:

```jsonc
{
  // Keep at most 1 MiB of prompt history.
  "history": {
    "maxBytes": 1048576,
  },
}
```

Retry settings such as `retry.maxRetries` and `retry.baseDelayMs` are not read from `mixcode_settings.json`; they come from Pi's normal SettingsManager configuration.
