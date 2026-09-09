# Batch scripts

[中文文档](batch-scripts.zh.md)

Run Lua or TypeScript scripts to batch-open agent tabs and dispatch prompts, either at startup or inside the current TUI. Use them for monorepo parallel workflows, model comparisons, and resuming conversations in existing tabs.

Script language is chosen by file extension: `.lua` runs under fengari, `.ts` / `.mts` / `.js` / `.mjs` are imported as ES modules. Both produce the same execution plan and share every validation, dry-run, and dispatch path.

## Running

### Current TUI

Enter this command in an Agent tab or Home:

```text
/batch <script> [-- <args...>]
/batch "scripts/review batch.ts" -- "packages/core" '' 'literal\path'
```

Script arguments must follow `--`. Single and double quotes group arguments; empty quoted strings survive. Backslash escapes the next character except inside single quotes. Unclosed quotes and trailing escapes fail before loading. There is no shell variable, command, or glob expansion.

The invocation directory is the calling Agent tab's workdir, or the instance workdir on Home. Relative script paths and new-tab workdirs resolve against this directory; `currentWorkdir()` / `current_workdir()` returns it. Existing tabs keep their workdir under `append` and `clear`.

`/batch` leaves `process.cwd()` unchanged. For the script's own relative file I/O, resolve paths against the API workdir explicitly.

Each invocation captures a fixed snapshot of tabs, models, disabled model IDs, and the instance default provider before evaluating the script.

To preview a plan, use [CLI dry-run](#startup-cli).

### Startup CLI

`--workdir <directory>` selects the launch workdir; otherwise the shell cwd is used. Relative script paths and new-tab workdirs use the launch directory. The CLI starts a new TUI instance.

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

Scripts collect a plan once, before dispatch. They cannot read agent replies or branch on results.

## Lua API (`mixcode` global table)

| API | Purpose |
|-----|---------|
| `mixcode.open_tab(opts)` | Create tab or reuse by **exact title**, optionally dispatch prompt |
| `mixcode.args()` | Arguments after `--` in either entry point, 1-indexed array |
| `mixcode.current_workdir()` | Invocation directory; see [running](#running) |
| `mixcode.tab_exists(name)` | Invocation snapshot: whether a tab with the given name exists |
| `mixcode.list_tabs()` | Invocation snapshot: list of existing tabs |
| `mixcode.list_models()` | Invocation model catalog, including disabled entries without a disabled field (`id`/`provider`/`model_id`/`display_name`/`context_window`/`reasoning`) |
| `mixcode.resolve_model(query)` | Resolve an exact model id to an enabled `provider/modelId`; see [model resolution](#model-resolution) |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` template; `{{` / `}}` escape literals |

Lua rereads and executes the file on each invocation. Standard libraries such as `os.getenv` and `io` are available. The root [`mixcode-batch.d.lua`](../mixcode-batch.d.lua) symlinks to the [Lua API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.lua) shipped with `mpi-batch-skill`.

### `open_tab` fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tab title; exact match when reusing |
| `prompt` | No | If omitted, creates/reuses/clears/deletes tab without submitting a prompt |
| `workdir` | No | New-tab directory; defaults and relative paths use the invocation directory. Reuse/clear preserves the existing directory |
| `model` | No | e.g. `anthropic/claude-sonnet-4-20250514` |
| `thinking` | No | Based on model capability: `off` / `minimal` / `low` / … / `max` |
| `context_limit` | No | `number \| string`; session token budget or `"reset"`. See [context limits](#context-limits) |
| `system_prompt` | No | Replaces base/identity only (same as SYSTEM.md slot); tools/AGENTS.md/skills are still assembled by MixCode. Requires a new tab or `mode="delete"`. Rejected with `mode="clear"`, even without a matching tab, and with `append` on an existing session |
| `mode` | No | When tab already exists: `append` (default) / `clear` / `delete` |

`mode`:

- `append`: Continue on the existing session; prompts sent while streaming use steering
- `clear`: Reset the current branch to session root before sending the prompt, like interactive `/reset`. Keeps the title, session ID/file, workdir, and system prompt; earlier history remains in `/tree` but is excluded from the new conversation context. Does not change focus, reload extensions, or rebuild services. Refused while the agent is streaming or bash is running
- `delete`: Delete tab + session files before recreating

New tabs, including `delete` replacements, take focus.

With no matching tab, a new tab is created. `clear` + `system_prompt` is always rejected during validation before any tab changes, including when `system_prompt` is an empty string. For repeated names, only the first request controls creation/reset/deletion. Interactive `/clear` still replaces the session and resets its title.

Prompts use the [shared input dispatch](architecture.md#runtime-mapping), including
plain text, paths, skills, prompt templates, extension commands, and `!shell` / `!!shell`.
Registered MixCode local slash commands, including `/batch`, are rejected during prompt dispatch;
use the interactive TUI to execute them. Other slash input and paths pass unchanged to Pi;
unmatched input such as `/unknown` becomes message text.

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
    prompt = render("Run lint and typecheck in {pkg}. Fix errors only.", { pkg = pkg }),
  })
end

-- Reset an existing named tab without submitting a prompt
mixcode.open_tab({ name = "review", mode = "clear" })
```

See [`examples/batch/`](../examples/batch/) for more examples.

## TypeScript API

A TypeScript/JavaScript script default-exports a function that receives the API object. The function may be `async`; the plan is collected after it resolves. Each invocation calls this function with fresh context. ES modules remain cached, so module-level state persists and file edits require restarting MixCode.

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

TypeScript scripts run with full host access to files, the network, and processes. Execute only trusted scripts; dry-run executes their code too.

## Model resolution

Resolve a model ID to a local provider before opening a tab:

```lua
mixcode.open_tab({ name = "review", model = mixcode.resolve_model("claude-sonnet-4-5") })
```

```ts
export default (mixcode: MixCodeBatchApi) => {
  mixcode.openTab({ name: "review", model: mixcode.resolveModel("claude-sonnet-4-5") });
};
```

`resolve_model(query)` / `resolveModel(query)` takes one non-empty string and returns a canonical `provider/modelId` string. It trims surrounding whitespace and matches case-sensitively against the invocation catalog:

1. An exact canonical reference wins, even if the same string is another model's bare id. A disabled explicit reference fails without changing provider.
2. Otherwise match the entire model id, including any `/` characters, excluding disabled candidates.
3. Prefer the invocation's instance default model provider when it has a candidate. Otherwise choose the smallest provider name in JavaScript string order, independent of catalog order.

The resolver uses the captured instance default model provider and disabled model IDs. For `/batch`, these are refreshed on each invocation, independently of the calling tab's model. Startup uses MixCode's startup model, which honors Pi's `defaultProvider` / `defaultModel` settings when configured; restored tabs do not determine this preference.

Matching is exact, with no version substitution. Resolution makes no network requests and does not verify credentials or service availability. Automatic selection does not compare prices or data policies; pass a full `provider/modelId` to choose a specific provider.

| Failure | Error |
| --- | --- |
| Empty or non-string query | `Error: Model query must be a non-empty string` |
| No enabled match | `Error: No available model matches: <query>` |
| Disabled explicit reference | `Error: Model is disabled: <query>` |

Script errors include the script path. Model resolution happens during script collection, before batch requests are applied.

Dry-run uses the same selection rules and displays the resolved reference in `model=...`. It reads global and project settings without write locks; read or parse errors abort validation. It does not load runtime extensions or fetch network-discovered models, so its catalog may differ from a live launch. Validation failures write no state, sessions, or crash log; scripts themselves still have host privileges.

## Dry-run output

```text
Batch dry-run: 2 request(s)
1. name=lint-packages/core thinking=low workdir=packages/core
   prompt: Run lint and typecheck in packages/core. Fix errors only.
2. name=scratch
   prompt: (none)
```

Performs model, thinking, and context-limit validation; invalid configurations fail and exit. Supplied limits print as `context_limit=32000` for `"32k"`, or `context_limit=reset`.

## Execution and errors

Different tab groups run in parallel without a configurable concurrency limit. Requests within one group run in order.

For `/batch`, a target marked `Not Ready` fails before any requests are applied: `Error: Batch tab is still loading: <name>`. State saves run serially after tab operations, settled submissions, and completion or failure of the apply step.

A failure during serial tab setup stops the batch before prompt dispatch. During parallel dispatch, a failed group leaves other groups running. Applied changes remain in both cases. Failed requests are not retried automatically. `/batch` reports an `Error:` message without changing the process exit code. Startup CLI apply failures appear in a TUI notice and set `exitCode=1`; script or validation errors also fail the CLI command.
