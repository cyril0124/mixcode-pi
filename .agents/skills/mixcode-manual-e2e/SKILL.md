---
name: mixcode-manual-e2e
description: Creates isolated, user-operated manual E2E demos for MixCode/Pi features through the real CLI/TUI and verifies them in tmux without external model APIs. Use when asked for a MixCode manual E2E, reproducible TUI demo, real mpi validation flow, or user-runnable feature reproducer.
disable-model-invocation: true
---

# MixCode Manual E2E

Create the smallest self-contained demo a user can launch and operate. The demo proves a real MixCode/Pi path; it is not an automated test and must not replace deterministic coverage.

## Boundaries

- Only create or update `tmp/<feature-slug>-manual/`. Do not change product source, formal tests, or permanent user configuration.
- If that directory exists, read it first and patch it minimally. Never replace the directory or overwrite unrelated work; ask only when intent conflicts.
- Never use external model APIs, user credentials, synthetic internal events, direct UI-state mutation, mock success, or swallowed errors.
- If the feature has no real public path or cannot run offline, report the blocker instead of adding a test hook or fake path.

## 1. Discover the Real Flow

1. Turn the request into observable checkpoints: setup, user trigger, in-progress state when relevant, and completion or failure result.
2. Inspect `run.sh`, the relevant product path and callers, installed `@earendil-works/pi-*` APIs, and Pi/local docs before designing the demo.
3. Prefer an existing command or keyboard flow. If a demo extension is necessary, expose a command that calls the real public Pi API such as `ctx.compact()`; never emit lifecycle events directly.
4. Derive everything available from the repository. Ask the user only for unresolved behavior or acceptance details.

## 2. Build the Demo

Keep only files required by the scenario. A typical directory contains:

```text
tmp/<feature-slug>-manual/
├── README.md
├── run.sh
├── agent-models.json
└── project-pi/
    ├── settings.json
    └── extensions/<feature>.ts   # only when needed
```

Start `run.sh` from this skeleton and add only what the scenario needs. Never instantiate `MixCodeRuntime` or `AgentSession` directly; always launch through the repository's real `./run.sh`. Make the file executable.

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/mixcode-<feature-slug>-manual.XXXXXX")"
agent_dir="$runtime_dir/agent"
workdir="$runtime_dir/workdir"

cleanup() {
  rm -rf "$runtime_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$agent_dir" "$workdir"
cp "$script_dir/agent-models.json" "$agent_dir/models.json"
ln -sfn "$script_dir/project-pi" "$workdir/.pi"

cd "$workdir"
MIXCODE_DEV=1 \
PI_CODING_AGENT_DIR="$agent_dir" \
PI_OFFLINE=1 \
  "$repo_dir/run.sh"
```

- `MIXCODE_DEV=1` runs `bun src/cli/main.ts` from the working tree; without it the launcher rebuilds the repository `dist/`.
- `PI_CODING_AGENT_DIR` points every agent-side path at the isolated dir: models, auth, settings, sessions, and scratch.

Provide a feature-scoped local model using Pi's installed `fauxProvider`. Its deterministic responses may supply normal model traffic, but the feature result must come from the real production path. Provider id, model id, and `api` must match literally across all three files, or model selection silently falls through to a real provider:

```text
project-pi/extensions/<model>.ts   pi.registerProvider("demo-id", { api: "openai-completions", ... })
agent-models.json                  providers["demo-id"].api === "openai-completions"
                                   providers["demo-id"].models[].id === "alpha"
project-pi/settings.json           defaultProvider "demo-id" + defaultModel "alpha"
                                   retry.enabled false
```

- Select the local model statically in the isolated project settings; never switch models from `session_start`.
- Tune context and fixtures only to establish real preconditions and avoid accidental triggers. Do not manufacture the state being verified.
- Require zero user configuration: one launcher command followed by normal TUI input.

## 3. Write the README

Match the current user's language while preserving literal commands, keys, and UI text. Include:

1. the exact `./tmp/<feature-slug>-manual/run.sh` command;
2. numbered setup and interaction steps a user performs inside the real TUI;
3. exact visible checkpoints and the expected completion result;
4. an explicit statement that the model is local/offline and runtime state is removed on exit.

## 4. Verify Before Delivery

Run demo-specific checks only; do not run the full repository gate when no product code changed.

1. Check shell syntax and executable mode, parse every JSON file, and type-check or import every extension with the repository's existing tooling.
2. Launch the demo through an isolated tmux socket. Never use the default socket or kill an unrelated tmux server.
3. Drive the exact README keyboard flow and capture panes at the trigger, progress, and completion checkpoints. A plausible code path is not evidence.
4. Confirm the process tree includes the demo launcher and the real MixCode CLI, the selected model is the isolated faux model, and no user config or external provider is used.
5. Exercise required preconditions and failure messages. Treat an unexpected alternative result as failure, not an acceptable fallback.
6. Exit normally, then confirm the isolated tmux session and runtime directory are gone.
7. Summarize exact observed evidence, then delete capture panes, process-tree files, and other verification scratch. Keep the demo source and README.

## Delivery

Report the demo path, launch command, user steps, observed checkpoints, focused validation results, offline model identity, and cleanup result. State any unverified item explicitly. Never claim the TUI works from source inspection or unit tests alone.
