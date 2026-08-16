# Built-in Extensions (`mpi-*`)

[中文文档](builtin-extensions.zh.md)

MixCode ships first-party built-in extensions located in `pi-packages/mpi-*`. These packages conform to Pi extension standards and are automatically materialized and installed into `<agentDir>/extensions/` at startup.

## Catalog

| Package | Command / Trigger | Description |
|---|---|---|
| `mpi-goal` | `/goal [objective]`, `/goal tools`, `/goal pause\|resume\|clear` | Session-scoped goal tracking with progressive dynamic tool disclosure, continuation budgets, and live status widget. |
| `mpi-loop` | `/loop [interval] <prompt>`, `/loop stop <id\|name>`, `/loop interval <id> <time>` | Recurring prompt execution engine with timer conflict policies (`skip` / `defer`), editor dock status widget, and interactive management overlay. |
| `mpi-optimize-prompt` | `/optimize-prompt [prompt]`, `/optimize-prompt-config` | Metaprompt-based prompt optimizer that refines vague user instructions into structured, executable prompts. |
| `mpi-auto-rename` | Auto on turn 1, `/auto-rename [name]` | Background lightweight LLM invocation generating concise tab titles from initial user prompts. |
| `mpi-skill-refs` | `$` completion trigger | Project and global skill autocomplete and in-prompt expansion. |
| `mpi-prompt-history` | `/prompt-history` | Interactive prompt history browser, filtering, and insertion into the active editor. |
| `mpi-chat-view` | `/view [chat\|thinking\|last\|user]` | Views conversation transcripts, thinking blocks, or last messages in `$VISUAL` / `$EDITOR` or within the in-app viewer. |
| `mpi-diff-viewer` | `/diff [ref]` | Terminal diff viewer with hunk navigation and inline review comments. |
| `mpi-command-browser` | Slash `/` autocomplete | Fuzzy browser for discovering built-in slash commands and third-party extension actions. |
| `mpi-model-skills` | `/model-skills`, `<agentDir>/model-skills.json` | Attaches or detaches skills from rules matched against the current model. |
| `mpi-model-extensions` | `/model-extensions`, `<agentDir>/model-extensions.json` | Dynamically loads model-specific Pi extensions. |
| `mpi-mid-turn-compact` | Auto on token threshold | Mid-turn compaction strategy preventing context window overflow during multi-turn tool loops. |
| `mpi-search-guard` | Auto on high-cardinality search | Intercepts broad directory traversals in root/home directories and guides agents to narrower paths. |
| `mpi-tool-block` | `/tool-block`, `<agentDir>/tool-block.json` | Overlay to hide selected tools from the model by dropping them from the active set. |
| `mpi-bash-default-timeout` | Auto on bash spawn | Enforces explicit default execution timeouts on bash commands. |
| `mpi-image-hoist` | Auto on multimodal prompt | Re-orders and extracts image payloads for multimodal tool compatibility. |
| `mpi-herdr-report` | `HERDR_ENV=1` | Notifies Herdr terminal multiplexer panes of agent status (working / idle / waiting). |
| `mpi-ctl` | `$mpi-ctl`, `mpi status` / `mpi ctl` | Skill that teaches the model to locate tabs via `MIXCODE_*` and drive a live TUI with `mpi status` / `mpi ctl`. |

## Extension Loading Lifecycle

```text
Startup (MixCode Interactive / TUI)
  │
  ├─ Materialize binary assets -> runtimeDir/packages/ (temp dir for compiled mpi)
  ├─ ensurePackageExtensions -> copy mpi-* to <agentDir>/extensions/
  └─ Pi Resource Loader discovers extensions
        │
        ├─ bindExtensions()
        └─ session_start lifecycle event
```

## Running Only Built-ins

To isolate execution and disable third-party npm packages:

```bash
mpi --builtin-extensions-only
```
