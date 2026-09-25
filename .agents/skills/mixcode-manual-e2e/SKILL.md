---
name: mixcode-manual-e2e
description: Use for user-runnable MixCode TUI demos or reproducers.
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

1. Enumerate the surface's user-visible states: idle, running/streaming, success, failure, timeout, aborted, empty output, and any feature-specific state. Give each one a trigger and the wording it displays.
2. Design the demo as a state machine over that list, driven by one user input: the demo extension emits the trigger for each state in turn. That list is the demo's scope; every state it cannot reach goes in the README's coverage table as uncovered.
3. Inspect `run.sh`, the relevant product path and callers, installed `@earendil-works/pi-*` APIs, and Pi/local docs before designing the demo.
4. Prefer an existing command or keyboard flow. If a demo extension is necessary, expose a command that calls the real public Pi API such as `ctx.compact()`; never emit lifecycle events directly.
5. Derive everything available from the repository. Ask the user only for unresolved behavior or acceptance details.

## 2. Build the Demo

Keep only files required by the scenario. A typical directory contains:

```text
tmp/<feature-slug>-manual/
├── README.md
├── run.sh
├── agent-models.json
├── evidence/                    # per-state captures and real outputs from the verified run
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
evidence_dir="$script_dir/evidence"

cleanup() {
  rm -rf -- "$runtime_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$agent_dir" "$workdir" "$evidence_dir"
cp "$script_dir/agent-models.json" "$agent_dir/models.json"
ln -sfn "$script_dir/project-pi" "$workdir/.pi"
printf 'Runtime: %s\n' "$runtime_dir"

cd "$workdir"
env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  TERM="${TERM:-xterm-256color}" \
  LANG="${LANG:-C.UTF-8}" \
  MIXCODE_DEV=1 \
  MIXCODE_EVIDENCE_DIR="$evidence_dir" \
  PI_CODING_AGENT_DIR="$agent_dir" \
  PI_OFFLINE=1 \
  VISUAL=/bin/true \
  EDITOR=/bin/true \
  "$repo_dir/run.sh"
```

- `MIXCODE_DEV=1` runs `bun src/cli/main.ts` from the working tree; without it the launcher rebuilds the repository `dist/`.
- `PI_CODING_AGENT_DIR` points every agent-side path at the isolated dir: models, auth, settings, sessions, and scratch.
- `env -i` with an explicit whitelist keeps the surrounding environment out of the run, so the user's own agent dir, provider credentials, and editor cannot leak in. The whitelist also passes `MIXCODE_EVIDENCE_DIR`, the demo's `evidence/` directory: it is the only path inside the demo directory that the run can write to, since the demo directory is not otherwise reachable from the isolated workdir. The `printf` line lets the user verify cleanup after exit.

Provide a feature-scoped local model using Pi's installed `fauxProvider`. Its deterministic responses may supply normal model traffic, but the feature result must come from the real production path. Provider id, model id, and `api` must match literally across all three files, or model selection silently falls through to a real provider:

```text
project-pi/extensions/<model>.ts   pi.registerProvider("demo-id", { api: "openai-completions", ... })
agent-models.json                  providers["demo-id"].api === "openai-completions"
                                   providers["demo-id"].models[].id === "alpha"
project-pi/settings.json           defaultProvider "demo-id" + defaultModel "alpha"
                                   retry.enabled false
```

A minimal `agent-models.json` — verify exact field requirements against Pi's installed `fauxProvider` before use:

```json
{
  "providers": {
    "demo-id": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:0",
      "models": [{ "id": "alpha", "name": "Demo Alpha" }]
    }
  }
}
```

- Select the local model statically in the isolated project settings; never switch models from `session_start`.
- Tune context and fixtures only to establish real preconditions and avoid accidental triggers. Do not manufacture the state being verified.
- Hold every transient state long enough to read: pace the stream with `tokensPerSecond` in the single digits for streaming states, and drive long-running work with a slow fixture (`sleep`) instead of a command that returns at once. An instant response leaves `running` unobservable, which is a demo defect rather than a missing capture.
- Drive the whole scenario from one user input. Before each trigger the extension prints `CHECKPOINT n/N: <what to look at>` to the terminal **and** appends the same line to `$MIXCODE_EVIDENCE_DIR/checkpoints.log`. Any other path is lost: the process working directory is the isolated workdir under `$runtime_dir`, which cleanup deletes on exit, and `$workdir/.pi` is a symlink into the demo directory, so the extension's own location does not resolve to the demo root either. Do not rely on terminal scroll alone — the checkpoint line may be off-screen by the time the capture runs.
- Keep the launcher argument-free and the user's configuration empty: one command to start, then one input.

## 3. Write the README

Match the current user's language while preserving literal commands, keys, and UI text. Include:

1. the exact `./tmp/<feature-slug>-manual/run.sh` command;
2. the single input that drives the scenario, then the states it walks through in order, each with the exact visible wording to expect;
3. the keyboard-only actions the user still performs (expand, resize, abort, quit), one line each in the order they occur;
4. a coverage table of every state from Discover: trigger, observed wording, and for an uncovered state the reason it is out of scope here;
5. an explicit statement that the model is local/offline and runtime state is removed on exit.

## 4. Verify Before Delivery

Run demo-specific checks only; do not run the full repository gate when no product code changed.

1. Check shell syntax and executable mode, parse every JSON file, and type-check or import every extension with the repository's existing tooling.
2. Launch the demo through an isolated tmux socket: `tmux -L <feature-slug>-e2e new-session -s demo "$script_dir/run.sh"`. Never use the default socket or kill an unrelated tmux server.
3. Drive the scenario with the README's single input and capture one pane per state in the coverage table, including at least one `running` frame: `tmux -L <feature-slug>-e2e capture-pane -t demo -p > tmp/<feature-slug>-manual/evidence/<state-name>.txt`, run from the repository root. The `evidence/` directory belongs to the demo directory, next to `run.sh`, not to the runtime directory. A state with no capture is unverified; a plausible code path is not evidence.
4. Confirm the process tree includes the demo launcher and the real MixCode CLI, the selected model is the isolated faux model, and no user config or external provider is used.
5. Exercise required preconditions and failure messages. Treat an unexpected alternative result as failure, not an acceptable fallback.
6. Exit normally, then confirm the isolated tmux session and runtime directory are gone.
7. Keep the per-state captures and process-tree files under `tmp/<feature-slug>-manual/evidence/` so the run stays re-checkable, and delete only tmux scratch. Keep the demo source and README.

## Delivery

Report the demo path, launch command, single driving input, coverage table with per-state evidence, focused validation results, offline model identity, and cleanup result. State any unverified item explicitly. Never claim the TUI works from source inspection or unit tests alone.
