---
name: mpi-batch
description: Write, validate, and launch MixCode Lua or TypeScript batch scripts for agent tabs.
disable-model-invocation: true
---

# MixCode batch scripts

With no task or script attached, ask what tabs and prompts the user wants. Default to writing and validating the script; launch only when the user requests execution.

## Workflow

1. Identify the script path, launch directory, tab names, workdirs, and prompts. Read existing scripts before editing and preserve their language. Use Lua for new scripts when the user does not specify a language. Read the matching API reference below before writing requests. Use absolute paths when directories differ.
2. Use distinct tab names for independent work. For existing tabs, default to `append`; obtain authorization before clearing or deleting sessions. Leave model and thinking unset unless requested. Choose explicit models from `mpi --list-models --json` or the script API's model snapshot.
3. Write the tab requests using the API reference. Use `mode="clear"` to start a new conversation in the same named tab while retaining its session and tree history. To change `system_prompt` / `systemPrompt`, use a new tab or `mode="delete"`; combining it with `clear` fails before any tab changes, even without a matching tab. Keep script evaluation limited to collecting requests and reading necessary inputs. Before running an existing script, inspect its imports and side effects; dry-run executes them too.
4. Run dry-run from the intended launch directory. Require exit code zero and check that the printed requests match the intended titles, prompts, workdirs, models, thinking levels, and modes. Correct failures before launching. If `mpi` is unavailable, report that validation could not run.
5. Return the script's absolute path, dry-run result, and launch command. When execution is requested, launch in an isolated tmux session, capture its screen, and provide the attach command. Report tab dispatch separately from completed agent work.

## API references

Read the file for the script's language. Paths are relative to this skill directory.

- TypeScript/JavaScript: [references/mixcode-batch.d.ts](references/mixcode-batch.d.ts). Declares the API, tab options, snapshot rows, and script function type. Scripts default-export a function receiving `mixcode`; it may be `async`. For editor types, use a triple-slash reference to this file's resolved path. Scripts also run without type annotations.
- Lua: [references/mixcode-batch.d.lua](references/mixcode-batch.d.lua). Annotates the global `mixcode` table, tab options, snapshots, and `render` helper. Read it as a reference; the batch runtime supplies these functions, so do not execute or `require` the stub.

## Model selection

When a requested model should work across providers, resolve its exact ID:

```ts
const model = mixcode.resolveModel("claude-sonnet-4-5");
```

```lua
local model = mixcode.resolve_model("claude-sonnet-4-5")
```

Pass the result as the tab's `model`. Check the selected provider in dry-run output. Use a full `provider/modelId` when the provider must be fixed; see the API reference for selection rules and errors.

## CLI

```bash
# Inspect authenticated models and supported thinking levels.
mpi --list-models --json

# Execute the script and validate its plan without dispatching tabs.
mpi --batch "/abs/project/batch-review.ts" --batch-dry-run -- "/abs/project/core" "/abs/project/cli"

# Start a MixCode TUI instance and apply the script's plan.
mpi --batch "/abs/project/batch-review.ts" -- "/abs/project/core" "/abs/project/cli"
```

`--workdir <directory>` selects the launch working directory; otherwise it is the command's current directory. A relative script path resolves from that directory. Everything after `--` is passed to `mixcode.args()`, not parsed as MixCode flags. Quote paths and arguments as shell data. Substitute `.lua` to run Lua.

Supported extensions: `.lua`, `.ts`, `.mts`, `.js`, `.mjs`. The command launches a MixCode instance; it does not inject work into the current TUI.

Use an unused tmux socket name and replace the path and argument placeholders:

```bash
tmux -L <unique-socket> new-session -d -s batch -c <workdir> mpi --batch <absolute-script> -- <args...>
tmux -L <unique-socket> capture-pane -p -t batch
tmux -L <unique-socket> attach-session -t batch
```

A successful dry-run prints `Batch dry-run: N request(s)` followed by each request's options and prompt. An omitted prompt is shown as `prompt: (none)`. Dry-run executes script code but does not apply the plan or write batch sessions. It is not a sandbox and does not prove authentication or prompt dispatch will succeed.

## Script examples

The examples take working directories after `--`. With no arguments, they collect no tab requests. Replace the review prompt with the task to run.

### TypeScript

```ts
export default (mixcode) => {
  for (const workdir of mixcode.args()) {
    mixcode.openTab({
      name: `review-${workdir}`,
      workdir,
      prompt: "Review this directory for correctness issues. Report file references; do not edit.",
    });
  }
};
```

### Lua

```lua
for _, workdir in ipairs(mixcode.args()) do
  mixcode.open_tab({
    name = "review-" .. workdir,
    workdir = workdir,
    prompt = "Review this directory for correctness issues. Report file references; do not edit.",
  })
end
```

## Reset a named tab

```lua
mixcode.open_tab({ name = "review", mode = "clear" })
```

This resets without sending a prompt; add `prompt` to submit the next task. Batch `clear` uses interactive `/reset` semantics, not interactive `/clear`. See the language reference for retained state and busy-session errors.

## Execution and errors

Batch collects requests, validates them, then applies the plan. It cannot wait for agent results or branch on responses. Introspection reads the startup snapshot; collecting a request does not update it. Tab creation and resets run serially. Prompt dispatch runs in parallel across distinct titles and serially within each title. There is no dependency graph or configurable concurrency limit.

For repeated requests with the same title, the first request controls creation, clearing, or deletion. Later requests configure model/thinking and submit prompts in order; they are not additional reset steps. Put creation options on the first request.

Prompts support plain text, skills, prompt templates, extension commands, and `!shell` / `!!shell`. Batch rejects registered MixCode local commands during prompt dispatch. Pi handles other slash input; unmatched input, including absolute paths and `/unknown`, becomes message text.

Script syntax and runtime errors identify the script path. Invalid tab options fail validation. JS scripts also reject missing or non-function default exports and unknown option names, including the Lua spelling `system_prompt`.

Apply failures appear in a TUI notice and set the process exit code to 1 without immediately exiting. Inspect the captured screen for errors. Tabs already created and prompts already dispatched are not rolled back.

TypeScript runs with full host privileges; Lua runs under fengari with its standard libraries. Dry-run does not prevent file, process, or network side effects. Include such operations only when the task requires them and the user has authorized them.
