# Batch Scripts

[中文文档](batch-scripts.zh.md)

Run Lua or TypeScript scripts to batch-open agent tabs and dispatch prompts after launch. Ideal for monorepo parallel workflows, model comparisons, and resuming conversations in existing tabs.

Script language is chosen by file extension: `.lua` runs under fengari, `.ts` / `.mts` / `.js` / `.mjs` are imported as ES modules. Both produce the same execution plan and share every validation, dry-run, and dispatch path.

## Design Motivation

In large multi-package repositories (monorepos) or comparative evaluation tasks, manually opening dozens of tabs, switching working directories, configuring models/thinking tiers, and dispatching prompts is repetitive, error-prone, and non-reproducible.

Batch scripting acts as a **programmable, declarative dispatch language**:
- **Scriptable Automation**: Parameterize runs with CLI flags (`-- <args...>`) and environment variables (`os.getenv`).
- **Fail-Fast Validation**: Pre-validates model and thinking compatibility before dispatching work.
- **Dry-Run Predictability**: Inspects execution plans without spinning up TUI instances or mutating disk state.

## Running

```bash
# Launch TUI and execute script (Lua or TypeScript)
mpi --batch examples/batch/simple.lua
mpi --batch examples/batch/simple.ts

# Pass arguments to the script (everything after `--` belongs to the script)
mpi --batch script.ts -- packages/core packages/cli

# Validate and print execution plan only: no TUI, no runtime bootstrap, no state/session writes
mpi --batch script.ts --batch-dry-run -- packages/core
```

Execution model:

```text
script completes (.lua via fengari | .ts/.js via dynamic import)
   │  collect open_tab / openTab calls
   v
validate (model / thinking / mode)
   │
   ├─ --batch-dry-run → print plan → exit
   │
   v
apply
  phase 1: create / clear / delete serially per tab
  phase 2: dispatch prompts in parallel across distinct tabs;
           strictly serial within identical tab names
```

**Not an orchestration engine**: Scripts cannot `wait` for agent results, nor branch based on responses. Single collect pass, single apply pass.

## Lua API (`mixcode` Global Table)

| API | Purpose |
|-----|---------|
| `mixcode.open_tab(opts)` | Create tab or reuse by **exact title**, optionally dispatch prompt |
| `mixcode.args()` | Arguments after CLI `--`, 1-indexed array |
| `mixcode.current_workdir()` | Current working directory |
| `mixcode.tab_exists(name)` | Launch snapshot: whether a tab with the given name exists |
| `mixcode.list_tabs()` | Launch snapshot: list of existing tabs |
| `mixcode.list_models()` | Launch snapshot: list of available models (`id`/`provider`/`model_id`/`display_name`/`context_window`/`reasoning`) |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` template; `{{` / `}}` escape literals |

Standard Lua libraries are available (including `os.getenv`, `io`, etc.). Type stubs are at repository root [`mixcode.lua`](../mixcode.lua).

### `open_tab` Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tab title; exact match when reusing |
| `prompt` | No | If omitted, creates/reuses/clears/deletes tab without submitting a prompt |
| `workdir` | No | Working directory for this tab |
| `model` | No | e.g. `anthropic/claude-sonnet-4-20250514` |
| `thinking` | No | Based on model capability: `off` / `minimal` / `low` / … / `max` |
| `system_prompt` | No | Replaces base/identity only (same as SYSTEM.md slot); tools/AGENTS.md/skills are still assembled by MixCode. **Requires fresh session**: new tab, or `mode="clear"` / `mode="delete"`. Error thrown if used with `append` on existing session |
| `mode` | No | When tab already exists: `append` (default) / `clear` / `delete` |

`mode`:

- `append`: Continue on existing session
- `clear`: Clear session before sending prompt
- `delete`: Delete tab + session files before recreating

Prompts support plain text, skills, prompt templates, extension commands, and `!shell`.
MixCode local slash commands are **not supported** (they require interactive UI).

Tabs with a custom `system_prompt` display a `[sys]` badge beside the editor title.

### Example

```lua
local pkgs = mixcode.args()
if #pkgs == 0 then
  pkgs = { "packages/core", "packages/cli" }
end

for _, pkg in ipairs(pkgs) do
  mixcode.open_tab({
    name = "lint-" .. pkg,
    workdir = pkg,
    thinking = "low",
    prompt = render("Run lint and typecheck in {pkg}. Fix errors only.", { pkg = pkg }),
  })
end

-- Pre-open empty tab without dispatching prompt
mixcode.open_tab({ name = "scratch" })
```

See [`examples/batch/`](../examples/batch/) for more examples.

## TypeScript API

A TypeScript/JavaScript script default-exports a function that receives the same API as an object. The function may be `async`; the plan is collected after it resolves.

```ts
/// <reference path="/path/to/mixcode-batch.d.ts" />

const script: MixCodeBatchScript = async (mixcode) => {
  for (const pkg of mixcode.args()) {
    mixcode.openTab({
      name: `lint-${pkg}`,
      workdir: pkg,
      thinking: "low",
      prompt: `Run lint and typecheck in ${pkg}. Fix errors only.`,
    });
  }
};

export default script;
```

Type stub: [`mixcode-batch.d.ts`](../mixcode-batch.d.ts) at repository root (the TypeScript counterpart of `mixcode.lua`). It declares globals, so a `/// <reference path="..." />` line is enough; scripts also run untyped without it.

Names map one-to-one; TypeScript uses camelCase:

| Lua | TypeScript |
|-----|------------|
| `mixcode.open_tab(opts)` | `mixcode.openTab(opts)` |
| `opts.system_prompt` | `opts.systemPrompt` |
| `mixcode.args()` (1-indexed table) | `mixcode.args()` (`string[]`) |
| `mixcode.current_workdir()` | `mixcode.currentWorkdir()` |
| `mixcode.tab_exists(name)` | `mixcode.tabExists(name)` |
| `mixcode.list_tabs()` → `session_id`, `model` | `mixcode.listTabs()` → `sessionId`, `model` |
| `mixcode.list_models()` → `model_id`, `display_name`, `context_window` | `mixcode.listModels()` → `modelId`, `displayName`, `contextWindow` |
| `mixcode.render(tpl, vars)` / global `render` | `mixcode.render(tpl, vars)` (or template literals) |

Field semantics, `mode`, the `systemPrompt` fresh-session rule, prompt support, and validation are identical to the Lua tables above.

Errors thrown for malformed scripts: missing or non-function default export, `name` missing or not a non-empty string, any non-string option field, and unknown `openTab` fields (for example the Lua spelling `system_prompt`). Script load and runtime failures are wrapped as `Batch script error in <path>`.

**No sandbox**: a TypeScript script runs in the MixCode process with full host privileges (file system, network, `process`). Treat batch scripts as trusted local code, exactly like the shell commands you would run yourself.

## Dry-run Output

```text
Batch dry-run: 2 request(s)
1. name=lint-packages/core thinking=low workdir=packages/core
   prompt: Run lint and typecheck in packages/core. Fix errors only.
2. name=scratch
   prompt: (none)
```

Performs model and thinking validation; invalid configurations fail and exit.

## Boundaries

| In scope | Out of scope |
|---|---|
| Batch dispatch tabs + prompts | Wait for agent completion / inspect responses |
| Introspection snapshot at startup | Live `list_tabs` during execution |
| Parallel across distinct tabs + serial per tab | Concurrency limit / DAG / dependency edges |
| CLI arguments + environment variables (`os.getenv`, `process.env`) | Second configuration format (JSON/YAML) |
| Lua (`.lua`) and TypeScript/JavaScript (`.ts`/`.mts`/`.js`/`.mjs`) | Sandboxing TypeScript scripts |

Errors: script syntax/runtime errors, unknown models, invalid thinking/mode throw errors; apply failures write to stderr and set `exitCode=1`.
