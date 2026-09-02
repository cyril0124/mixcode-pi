# Built-in Extensions (`mpi-*`)

[中文文档](builtin-extensions.zh.md)

MixCode ships first-party built-in Pi packages located in `pi-packages/mpi-*`. Startup synchronizes each package into `<agentDir>/extensions/` using a content hash: matching packages skip destination writes, while changed packages replace the installed package tree. Package extensions contribute any runtime-discovered skills through Pi's public `resources_discover` event without copying them into `<agentDir>/skills`.

Every package with a user-edited JSON config ships a JSON Schema next to its extension (`<agentDir>/extensions/<pkg>/<config>.schema.json`, e.g. `mpi-permission.schema.json`, `mpi-tool-block.schema.json`). Reference it from the config file via a `$schema` key for editor completion; the key is accepted by the loader and preserved on writes. Details live in each package README.

## Catalog

| Package | Command / Trigger | Description |
|---|---|---|
| `mpi-goal` | `/goal [objective]`, `/goal tools`, `/goal pause\|resume\|clear` | Session-scoped goal tracking with progressive dynamic tool disclosure, continuation budgets, and live status widget. |
| `mpi-loop` | `/loop [interval] <prompt>`, `/loop stop <id\|name>`, `/loop interval <id> <time>` | Recurring prompt execution engine with configurable total runs, timer conflict policies (`skip` / `defer`), editor dock status widget, and interactive management overlay. |
| `mpi-optimize-prompt` | `/optimize-prompt [prompt]`, `/optimize-prompt-config` | Metaprompt-based prompt optimizer that refines vague user instructions into structured, executable prompts. |
| `mpi-auto-rename` | Optional auto on first message, `/auto-rename` | Generates a kebab-case session title; enable `onFirstMessage` in `<agentDir>/mpi-auto-rename.json`. |
| `mpi-skill-refs` | `$` completion trigger | Project and global skill autocomplete and in-prompt expansion. |
| `mpi-prompt-history` | `/prompt-history` | Interactive prompt history browser, filtering, and insertion into the active editor. |
| `mpi-transcript` | `/transcript [context\|chatlog\|thinking\|latest-agent\|latest-user] [N] [full]` | Views transcript slices (effective LLM context, chatlog, thinking, latest messages; optional `N` = last N turns; `full` = untruncated tool output on chatlog/context, any position) in nvim, vim, or the in-app viewer. Use `/transcript config` to choose the editor; nvim and vim appear only when their `--version` checks succeed. Each view starts with a rounded statistics box showing session turns, message count, duration, session file path (`In-memory` when unpersisted), tool result status, per-tool call counts, and `SKILL.md` read counts. The `context` view opens with a chars/4 size estimate — `system prompt + tool schemas + all messages`, plus the share of the context window when the model's window is known; it always covers the whole context, so `N` cuts the display but not the number. nvim adds a User/Assistant winbar, `]t`/`[t` to jump turns and `]u`/`[u` to jump user messages, role badge chips and full-width rules drawn as overlay `virt_text` over concealed markup, a current-turn gutter bar, folded tool in/out fences, dimmed meta/thinking, wrap/linebreak, and `conceallevel=2`. vim adds a User/Assistant statusline, `]t`/`[t` to jump turns and `]u`/`[u` to jump user messages, role-colored headings with concealed `##`/`###` prefixes, `---` concealed as `─`, folded tool in/out fences, dimmed meta/thinking, wrap/linebreak, and `conceallevel=2`. Colors come from `MpiTranscript*` highlight groups, linked with `default = true` so a colorscheme can override them. Successful `read`s of a `SKILL.md` render as a skill card with name, path, description, and the frontmatter-stripped body as markdown, capped at 20 lines (`full` uncaps). nvim gives the skill heading its own badge chip. |
| `mpi-diff-viewer` | `/diff [ref]` | Terminal diff viewer with hunk navigation and inline review comments. |
| `mpi-model-skills` | `/model-skills`, `<agentDir>/mpi-model-skills.json` | Attaches or detaches skills from rules matched against the current model. |
| `mpi-model-extensions` | `/model-extensions`, `<agentDir>/mpi-model-extensions.json` | Dynamically loads model-specific Pi extensions. |
| `mpi-length-resume` | Auto on length-truncated answers | Auto-continue after a length-truncated answer: resumes via a hidden follow-up after native automatic compaction, or when a run settles on a length stop near the context ceiling. Pi core owns mid-run threshold compaction. |
| `mpi-search-guard` | Auto on high-cardinality search | Intercepts broad directory traversals in root/home directories and guides agents to narrower paths. |
| `mpi-tool-block` | `/tool-block`, `<agentDir>/mpi-tool-block.json` or in-memory session | Overlay to hide selected tools from the model by dropping them from the active set. |
| `mpi-permission` | `/permission`, `$mpi-permission`, `<agentDir>/mpi-permission.json`, `<cwd>/.pi/mpi-permission.json` | Gates tool calls with allow / ask / deny wildcard rules, including static paths from common Bash file commands; external-directory and doom-loop guards; ask prompts once / always / reject (doom-loop ask: once / reject only). `$mpi-permission` writes a JSON policy. See [pi-packages/mpi-permission/README.md](../pi-packages/mpi-permission/README.md). |
| `mpi-bash` | Auto on bash spawn, `/bash-logs` | Default execution timeout, foreground window with auto-detach to the background, automatic completion and stall notices, and a two-pane overlay for reading or killing a background command. |
| `mpi-tool-display` | Auto on tool/thinking render; `/mpi-tool-display config` | Render-only `ToolExecutionComponent` adapter for compact `bash`/`read`/`edit`/`write` rows, bars/split-view diffs, and context-safe themed Thinking labels; its global debug setting can append raw JSON arguments to every tool call without changing native ownership, execution, or `PI_*`. |
| `mpi-image-hoist` | Auto on multimodal prompt | Re-orders and extracts image payloads for multimodal tool compatibility. |
| `mpi-herdr-report` | `HERDR_ENV=1` | Notifies Herdr terminal multiplexer panes of agent status (working / idle / waiting). |
| `mpi-ctl` | `$mpi-ctl`, `mpi status` / `mpi ctl` | Agent Tab collaboration skill: locate tabs via `MIXCODE_*` and prompt/wait/read peers with `mpi status` / `mpi ctl`. |

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
on disk. It writes MixCode's own `docs/*.md` to `<agentDir>/mixcode-docs/`, a
stable sibling of `<agentDir>/extensions/` rather than the per-process runtime
dir, so the system prompt can point the model at them. Source and npm installs skip it
and resolve the repository's `docs/` directly. Pi's own documentation is never
copied here; it is resolved from the pi package by Pi's `config.ts` helpers.

## Running Only Built-ins

To isolate execution and disable third-party npm packages:

```bash
mpi --builtin-extensions-only
```
