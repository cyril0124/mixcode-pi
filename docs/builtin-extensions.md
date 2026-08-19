# Built-in Extensions (`mpi-*`)

[中文文档](builtin-extensions.zh.md)

MixCode ships first-party built-in Pi packages located in `pi-packages/mpi-*`. Startup synchronizes each package into `<agentDir>/extensions/` using a content hash: matching packages skip destination writes, while changed packages replace the installed package tree. Package extensions contribute any runtime-discovered skills through Pi's public `resources_discover` event without copying them into `<agentDir>/skills`.

## Catalog

| Package | Command / Trigger | Description |
|---|---|---|
| `mpi-goal` | `/goal [objective]`, `/goal tools`, `/goal pause\|resume\|clear` | Session-scoped goal tracking with progressive dynamic tool disclosure, continuation budgets, and live status widget. |
| `mpi-loop` | `/loop [interval] <prompt>`, `/loop stop <id\|name>`, `/loop interval <id> <time>` | Recurring prompt execution engine with configurable total runs, timer conflict policies (`skip` / `defer`), editor dock status widget, and interactive management overlay. |
| `mpi-optimize-prompt` | `/optimize-prompt [prompt]`, `/optimize-prompt-config` | Metaprompt-based prompt optimizer that refines vague user instructions into structured, executable prompts. |
| `mpi-auto-rename` | Optional auto on first message, `/auto-rename` | Generates a kebab-case session title; enable `onFirstMessage` in `<agentDir>/auto-rename.json`. |
| `mpi-skill-refs` | `$` completion trigger | Project and global skill autocomplete and in-prompt expansion. |
| `mpi-prompt-history` | `/prompt-history` | Interactive prompt history browser, filtering, and insertion into the active editor. |
| `mpi-chat-view` | `/view [chat\|thinking\|last\|user]` | Views conversation transcripts, thinking blocks, or last messages in `$VISUAL` / `$EDITOR` or within the in-app viewer. |
| `mpi-diff-viewer` | `/diff [ref]` | Terminal diff viewer with hunk navigation and inline review comments. |
| `mpi-command-browser` | Slash `/` autocomplete | Fuzzy browser for discovering built-in slash commands and third-party extension actions. |
| `mpi-model-skills` | `/model-skills`, `<agentDir>/model-skills.json` | Attaches or detaches skills from rules matched against the current model. |
| `mpi-model-extensions` | `/model-extensions`, `<agentDir>/model-extensions.json` | Dynamically loads model-specific Pi extensions. |
| `mpi-mid-turn-compact` | Auto on token threshold | Mid-turn compaction strategy preventing context window overflow during multi-turn tool loops. |
| `mpi-search-guard` | Auto on high-cardinality search | Intercepts broad directory traversals in root/home directories and guides agents to narrower paths. |
| `mpi-tool-block` | `/tool-block`, `<agentDir>/tool-block.json` or in-memory session | Overlay to hide selected tools from the model by dropping them from the active set. |
| `mpi-bash-default-timeout` | Auto on bash spawn | Enforces explicit default execution timeouts on bash commands. |
| `mpi-image-hoist` | Auto on multimodal prompt | Re-orders and extracts image payloads for multimodal tool compatibility. |
| `mpi-herdr-report` | `HERDR_ENV=1` | Notifies Herdr terminal multiplexer panes of agent status (working / idle / waiting). |
| `mpi-ctl` | `$mpi-ctl`, `mpi status` / `mpi ctl` | Skill that teaches the model to locate tabs via `MIXCODE_*` and drive a live TUI with `mpi status` / `mpi ctl`. |

## Built-in Package Loading Lifecycle

```text
Startup (MixCode Interactive / TUI or independent Pi subagent)
  │
  ├─ Materialize binary assets -> runtimeDir/packages/ (compiled mpi only)
  ├─ installMixcodeDocs -> write docs/*.md to <agentDir>/mixcode-docs/ (compiled mpi only)
  ├─ ensurePackageExtensions -> hash-sync mpi-* to <agentDir>/extensions/
  ├─ Pi Resource Loader discovers package extensions
  └─ AgentSession.bindExtensions()
        ├─ session_start lifecycle event
        ├─ resources_discover -> package skills/ roots
        └─ Pi Resource Loader extends the loaded skills
```

`ensurePackageExtensions` computes a deterministic SHA-256 over each package's relative file paths and contents. The installed package records the hash in `<agentDir>/extensions/<package>/.mixcode-package-hash`; matching hashes skip writes, while changed hashes replace the installed package tree before publishing the new marker. Package-contained skills stay under the extension directory and are loaded through `resources_discover`.

`installMixcodeDocs` runs only in the compiled binary, which has no source tree
on disk. It writes MixCode's own `docs/*.md` to `<agentDir>/mixcode-docs/` — a
stable sibling of `<agentDir>/extensions/`, not the per-process runtime dir — so
the system prompt can point the model at them. Source and npm installs skip it
and resolve the repository's `docs/` directly. Pi's own documentation is never
copied here; it is resolved from the pi package by Pi's `config.ts` helpers.

## Running Only Built-ins

To isolate execution and disable third-party npm packages:

```bash
mpi --builtin-extensions-only
```
