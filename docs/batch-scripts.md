# Batch Scripts

[中文文档](batch-scripts.zh.md)

Run Lua or TypeScript scripts to batch-open agent tabs and dispatch prompts after launch. Ideal for monorepo parallel workflows, model comparisons, and resuming conversations in existing tabs.

Script language is chosen by file extension: `.lua` runs under fengari, `.ts` / `.mts` / `.js` / `.mjs` are imported as ES modules. Both produce the same execution plan and share every validation, dry-run, and dispatch path.

## Design Motivation

In large multi-package repositories (monorepos) or comparative evaluation tasks, manually opening dozens of tabs, switching working directories, configuring models/thinking tiers, and dispatching prompts is repetitive, error-prone, and non-reproducible.

Batch scripting is a **programmable, declarative dispatch language**:
- Parameterize runs with CLI flags (`-- <args...>`) and environment variables (`os.getenv`).
- Validate model and thinking compatibility before any work is dispatched.
- Dry-run the execution plan without starting TUI instances or touching disk state.

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
validate (model / thinking / context limit / mode)
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
| `mixcode.resolve_model(query)` | Resolve an exact model id to an enabled `provider/modelId`; see [model resolution](#model-resolution) |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` template; `{{` / `}}` escape literals |

Standard Lua libraries are available (including `os.getenv`, `io`, etc.). The root [`mixcode-batch.d.lua`](../mixcode-batch.d.lua) symlinks to the [Lua API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.lua) shipped with `mpi-batch-skill`.

### `open_tab` Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tab title; exact match when reusing |
| `prompt` | No | If omitted, creates/reuses/clears/deletes tab without submitting a prompt |
| `workdir` | No | Working directory for this tab |
| `model` | No | e.g. `anthropic/claude-sonnet-4-20250514` |
| `thinking` | No | Based on model capability: `off` / `minimal` / `low` / … / `max` |
| `context_limit` | No | `number \| string`; session token budget or `"reset"`. See [context limits](#context-limits) |
| `system_prompt` | No | Replaces base/identity only (same as SYSTEM.md slot); tools/AGENTS.md/skills are still assembled by MixCode. Requires a new tab or `mode="delete"`. Rejected with `mode="clear"`, even without a matching tab, and with `append` on an existing session |
| `mode` | No | When tab already exists: `append` (default) / `clear` / `delete` |

`mode`:

- `append`: Continue on existing session
- `clear`: Reset the current branch to session root before sending the prompt, like interactive `/reset`. Keeps the title, session ID/file, workdir, and system prompt; earlier history remains in `/tree` but is excluded from the new conversation context. Does not reload extensions or rebuild services. Refused while the agent is streaming or bash is running
- `delete`: Delete tab + session files before recreating

With no matching tab, a new tab is created. `clear` + `system_prompt` is always rejected during validation before any tab changes, including when `system_prompt` is an empty string. For repeated names, only the first request controls creation/reset/deletion. Every request applies its model/thinking, then context limit, then optional prompt, in order within the same title. Later requests do not repeat creation/reset/deletion. Interactive `/clear` still replaces the session and resets its title.

Prompts use the [shared input dispatch](architecture.md#runtime-mapping), including
plain text, paths, skills, prompt templates, extension commands, and `!shell` / `!!shell`.
Registered MixCode local slash commands are rejected during prompt dispatch;
use the interactive TUI to execute them.

Tabs with a custom `system_prompt` display a `[sys]` badge beside the editor title.

### Context limits

`context_limit` in Lua and `contextLimit` in TypeScript/JavaScript accept a number or string. Numbers must be positive safe integer token counts. Strings use the existing `/context-limit` parser (`parseContextLimitValue`): `"32000"`, `"32k"`, `"32.5k"`, and `"reset"` are accepted, with surrounding whitespace trimmed and case ignored. Numeric strings retain the command's rounding behavior; normalized token counts must be positive safe integers. TS/JS `undefined` or `null` and Lua `nil` mean omitted.

The value applies after each request's model/thinking and before its prompt, including requests without a prompt and later same-name requests. It works for new tabs and all `append`/`clear`/`delete` modes. `"reset"` restores the selected model's canonical context window. When omitted, new tabs use the model default; reused tabs retain their current limit unless explicit model selection resets it.

The override synchronizes runtime session `contextWindow`, UI, and compaction budgets for the current session only; it changes no global config. Values above model capacity are accepted with the existing warning and do not expand provider capacity. Invalid inputs fail before any tab changes. The error includes `Error:` and the tab name; the script loader adds the script path.

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
    context_limit = "32k",
    prompt = render("Run lint and typecheck in {pkg}. Fix errors only.", { pkg = pkg }),
  })
end

-- Reset an existing named tab and restore its model's canonical window, without a prompt
mixcode.open_tab({ name = "review", mode = "clear", context_limit = "reset" })
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
      contextLimit: "32k",
      prompt: `Run lint and typecheck in ${pkg}. Fix errors only.`,
    });
  }
};

export default script;
```

The root [`mixcode-batch.d.ts`](../mixcode-batch.d.ts) symlinks to the [TypeScript API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.ts) shipped with `mpi-batch-skill`. It declares globals, so a `/// <reference path="..." />` line is enough; scripts also run untyped without it.

Names map one-to-one; TypeScript uses camelCase:

| Lua | TypeScript |
|-----|------------|
| `mixcode.open_tab(opts)` | `mixcode.openTab(opts)` |
| `opts.context_limit` | `opts.contextLimit` |
| `opts.system_prompt` | `opts.systemPrompt` |
| `mixcode.args()` (1-indexed table) | `mixcode.args()` (`string[]`) |
| `mixcode.current_workdir()` | `mixcode.currentWorkdir()` |
| `mixcode.tab_exists(name)` | `mixcode.tabExists(name)` |
| `mixcode.list_tabs()` → `session_id`, `model` | `mixcode.listTabs()` → `sessionId`, `model` |
| `mixcode.list_models()` → `model_id`, `display_name`, `context_window` | `mixcode.listModels()` → `modelId`, `displayName`, `contextWindow` |
| `mixcode.resolve_model(query)` | `mixcode.resolveModel(query)` |
| `mixcode.render(tpl, vars)` / global `render` | `mixcode.render(tpl, vars)` (or template literals) |

Field semantics, `mode`, the `systemPrompt` fresh-session rule, prompt support, and validation are identical to the Lua tables above.

Errors thrown for malformed scripts: missing or non-function default export, `name` missing or not a non-empty string, invalid option types or context limits, and unknown `openTab` fields (for example the Lua spellings `system_prompt` and `context_limit`). Script load and runtime failures are wrapped as `Batch script error in <path>`.

**No sandbox**: a TypeScript script runs in the MixCode process with full host privileges (file system, network, `process`). Treat batch scripts as trusted local code, exactly like the shell commands you would run yourself.

## Model Resolution

Resolve a model ID to a local provider before opening a tab:

```lua
mixcode.open_tab({ name = "review", model = mixcode.resolve_model("claude-sonnet-4-5") })
```

```ts
export default (mixcode: MixCodeBatchApi) => {
  mixcode.openTab({ name: "review", model: mixcode.resolveModel("claude-sonnet-4-5") });
};
```

`resolve_model(query)` / `resolveModel(query)` takes one non-empty string and returns a canonical `provider/modelId` string. It trims surrounding whitespace and matches case-sensitively against the startup catalog:

1. An exact canonical reference wins, even if the same string is another model's bare id. A disabled explicit reference fails without changing provider.
2. Otherwise match the entire model id, including any `/` characters, excluding disabled candidates.
3. Prefer the startup default model's provider when it has a candidate. Otherwise choose the smallest provider name in JavaScript string order, independent of catalog order.

The resolver reads the startup snapshot. Its preferred provider comes from MixCode's startup model, which honors Pi's `defaultProvider` / `defaultModel` settings when that model is configured. Restored tabs do not determine this preference.

Matching is exact, with no version substitution. Resolution makes no network requests and does not verify credentials or service availability. Automatic selection does not compare prices or data policies; pass a full `provider/modelId` to choose a specific provider.

| Failure | Error |
| --- | --- |
| Empty or non-string query | `Error: Model query must be a non-empty string` |
| No enabled match | `Error: No available model matches: <query>` |
| Disabled explicit reference | `Error: Model is disabled: <query>` |

Script errors include the script path. Model resolution happens during script collection, before batch requests are applied.

Dry-run uses the same selection rules and displays the resolved reference in `model=...`. It reads global and project settings without write locks; read or parse errors abort validation. It does not load runtime extensions or fetch network-discovered models, so its catalog may differ from a live launch. Validation failures write no state, sessions, or crash log; scripts themselves still have host privileges.

## Dry-run Output

```text
Batch dry-run: 2 request(s)
1. name=lint-packages/core thinking=low context_limit=32000 workdir=packages/core
   prompt: Run lint and typecheck in packages/core. Fix errors only.
2. name=scratch context_limit=reset
   prompt: (none)
```

Performs model, thinking, and context-limit validation; invalid configurations fail and exit. A supplied limit is printed in normalized form: `context_limit=32000` for `"32k"`, or `context_limit=reset`. Check these values along with the request options and prompts before launching.

## Boundaries

| In scope | Out of scope |
|---|---|
| Batch dispatch tabs + prompts | Wait for agent completion / inspect responses |
| Introspection snapshot at startup | Live `list_tabs` during execution |
| Parallel across distinct tabs + serial per tab | Concurrency limit / DAG / dependency edges |
| CLI arguments + environment variables (`os.getenv`, `process.env`) | Second configuration format (JSON/YAML) |
| Lua (`.lua`) and TypeScript/JavaScript (`.ts`/`.mts`/`.js`/`.mjs`) | Sandboxing TypeScript scripts |

Errors: script syntax/runtime errors, unknown models, invalid thinking/context limit/mode throw errors; apply failures write to stderr and set `exitCode=1`.
