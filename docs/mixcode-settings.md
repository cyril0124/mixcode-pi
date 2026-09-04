# `mixcode_settings.json`

[中文文档](mixcode-settings.zh.md)

MixCode Pi reads `mixcode_settings.json` from its root state directory. By default, that is:

```text
~/.pi/agent/mixcode-pi/mixcode_settings.json
```

The file uses JSONC syntax: regular JSON plus comments and trailing commas. If the file does not exist, MixCode Pi uses the defaults below.

## Supported Settings

```jsonc
{
  "theme": "tokyo-night",
  "ui": {
    "icons": { "mode": "nerd" },
    "inlineWidgets": false,
    "boxedHiddenThinking": false,
    "oversizedAssistantMessage": {
      "enabled": true,
      "maxLines": 5000,
      "maxBytes": 131072,
    },
  },
  // Orthogonal to models.json: disable providers/models without deleting catalog entries.
  "disabledProviders": ["openai"],
  "disabledModels": ["anthropic/claude-opus-4-5"],
}
```

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| `theme` | theme id string | unset → runtime default | Explicit UI theme id. Built-ins (`mixcode-dark`, `claude-warm`, `tokyo-night`, `terminal`, `catppuccin`, `kanagawa`, `rose-pine`), Pi themes (`dark`/`light`), and any theme discovered by Pi (`~/.pi/agent/themes`, packages). Ids are exact; there are no MixCode aliases. Editable via `/settings`. |
| `ui.icons.mode` | `auto` \| `nerd` \| `ascii` | `nerd` | Glyph set for input-meta icons, context meter, zen status dots, and extension-manager status. `auto` picks nerd glyphs on known Nerd Font terminals, otherwise ascii. Editable via `/settings` as "Icon mode". |
| `ui.inlineWidgets` | boolean | `false` | Default for new tabs and process start: render `setWidget` above/below chrome in the chat tail. Changing it via `/settings` also applies to all open tabs immediately. Per-tab `/toggle-inline-widgets` is still session-only and is not written to `mixcode_state.json`. Editable via `/settings` as "Inline widgets". |
| `ui.boxedHiddenThinking` | boolean | `false` | With Pi `hideThinkingBlock` on: render each hidden thinking block as a boxed 3-row tail that follows the stream instead of the `Thinking...` placeholder. The title carries a live timer while the block streams and freezes it once thinking stops (a tool call or answer text follows, or the message ends). A `setHiddenThinkingLabel` override still replaces the whole block. Editable via `/settings` as "Boxed hidden thinking". |
| `ui.oversizedAssistantMessage.enabled` | boolean | `true` | Fold oversized assistant/thinking provider output in the TUI while keeping full content in the session; use `/transcript` to inspect the full content. |
| `ui.oversizedAssistantMessage.maxLines` | positive integer | `5000` | Fold assistant/thinking output above this line count. |
| `ui.oversizedAssistantMessage.maxBytes` | positive integer | `131072` | Fold assistant/thinking output above this UTF-8 byte size. |
| `disabledProviders` | string array of provider ids | `[]` | Globally disable providers across MixCode sessions and extension/subagent model discovery and execution. Models stay listed in `/models` but are dimmed as disabled and cannot be selected or used. Takes effect on `/reload` or restart. Editable via `/settings`. |
| `disabledModels` | string array of `provider/modelId` | `[]` | Globally disable individual models across the same paths as `disabledProviders`. Provider-level disable covers all of that provider's models. Takes effect on `/reload` or restart. Editable via `/settings`. |

Image display, Mermaid rendering, code-block indent, cache-miss notices, and the startup tool set are **not** configured in this file. They live in Pi global `settings.json` (same store as `hideThinkingBlock`):

| Pi setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `terminal.showImages` | boolean | `true` | Show image blocks in user messages and tool results. |
| `terminal.imageWidthCells` | positive integer | `60` | Max image width in terminal cells. |
| `images.blockImages` | boolean | `false` | Strip images before they reach the model (SDK `convertToLlm`). |
| `markdown.mermaid` | `off` \| `final` \| `streaming` | `streaming` | When to turn ` ```mermaid ` fences into terminal diagrams. |
| `markdown.codeBlockIndent` | string | two spaces (`"  "`) | Prefix on each rendered code-block line. Empty string aligns code with the fence so a copied block stays flush Markdown. Edit `settings.json` directly; `/settings` does not expose this row. |
| `showCacheMissNotices` | boolean | `false` | Show transcript warnings for significant prompt-cache misses, including re-billed tokens and estimated excess cost when it is at least `$0.01`. |
| `defaultTools` | string array of tool names | unset (`read`, `bash`, `edit`, `write`) | Built-in tools active at session start. Narrowing it removes built-ins, including MixCode's own `bash` wrapper, from every new session; extension-registered tools stay active, matching Pi. Edit `settings.json` directly; `/settings` does not expose this row. |
| `externalEditor` | command string | unset → `$VISUAL`/`$EDITOR`, else `nano` (`notepad` on Windows) | Editor command for Ctrl+G, `/editor`, `/system-prompt`, and `/system-tools`. `/console-history` checks the project value, global value, `$VISUAL`, and `$EDITOR`; if all are unset, it tries `nvim`, `vim`, then the built-in viewer. |
| `editorPaddingX` | non-negative integer | unset → `1` | Horizontal padding of the prompt editor. |
| `autocompleteMaxVisible` | positive integer | unset → `8` | Max visible autocomplete rows in the prompt editor and extension editor overlays. |
| `treeFilterMode` | `default` \| `no-tools` \| `user-only` \| `labeled-only` \| `all` | `default` | Initial filter of the session tree selector (double-Esc tree, `/tree`). |
| `showHardwareCursor` | boolean | `false` (or `PI_HARDWARE_CURSOR=1`) | Show the terminal hardware cursor instead of the drawn cursor. |
| `terminal.clearOnShrink` | boolean | `false` (or `PI_CLEAR_ON_SHRINK=1`) | Full re-render clearing emptied rows when content shrinks. |
| `terminal.showTerminalProgress` | boolean | `false` | Drive the terminal progress indicator (OSC 9;4) while any tab is working. |

## Parsing Rules

- Missing file: uses the default settings.
- JSONC comments and trailing commas are accepted.
- Legacy `ui.renderMermaid` is ignored (use Pi `markdown.mermaid`).
- `ui.icons.mode`: must be one of `auto`, `nerd`, `ascii`; invalid values are reported as settings errors.
- `ui.inlineWidgets`: must be a boolean; invalid values are reported as settings errors.
- `ui.boxedHiddenThinking`: must be a boolean; invalid values are reported as settings errors.
- `ui.oversizedAssistantMessage.enabled`: must be a boolean.
- `ui.oversizedAssistantMessage.maxLines` and `.maxBytes`: must be positive integers.
- Invalid `ui.oversizedAssistantMessage` values are reported as settings errors.
- Unknown fields are ignored.
- Invalid JSONC is reported as a settings error.
- `disabledProviders` / `disabledModels`: non-array values are treated as empty; only non-empty trimmed strings are kept.
- Disabled lists do not edit `models.json`. `/login` still lists disabled providers so credentials can be configured.
- Extensions and subagents do not receive disabled models from `ctx.modelRegistry.getAvailable()`, and runtime execution rejects an already-resolved disabled model. The full catalog remains available through `getAll()`/`find()` for configuration and re-enabling.
- A tab whose current model becomes disabled keeps that model reference (no auto-switch); sending a prompt or selecting the model is rejected until you pick an enabled model or re-enable and `/reload`.

Prompt history is not configured here. It belongs to the `mpi-prompt-history` package and is configured in `<agentDir>/mpi-prompt-history.json`; see [its README](../pi-packages/mpi-prompt-history/README.md).

## Example

Use ASCII icons and keep inline widgets on:

```jsonc
{
  // Terminals without a Nerd Font render the ASCII set.
  "ui": {
    "icons": { "mode": "ascii" },
    "inlineWidgets": true,
  },
}
```

Retry settings such as `retry.maxRetries` and `retry.baseDelayMs`, as well as image/Mermaid rendering and cache-miss notices (`terminal.showImages`, `terminal.imageWidthCells`, `images.blockImages`, `markdown.mermaid`, `showCacheMissNotices`), are not read from `mixcode_settings.json`; they come from Pi's normal SettingsManager configuration and can be edited from `/settings` (Pi global `settings.json`).

Editing settings through `/settings` rewrites `mixcode_settings.json` as pure JSON (comments are not preserved).
