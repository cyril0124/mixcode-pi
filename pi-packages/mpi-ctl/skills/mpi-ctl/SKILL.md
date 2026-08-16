---
name: mpi-ctl
description: Control a live MixCode (mpi) TUI from the CLI — list instances, focus a tab, read last messages/tools/screen, wait for idle or a question, inject keys. Use when the user says mpi ctl, mpi status, another mpi, another tab, remote-control the TUI, or you need to inspect or drive a running MixCode instance.
---

# mpi status / ctl

Drive a **live** MixCode TUI. Do not start a new TUI for this. The target process must already be running and listening on `<agentDir>/mixcode-pi/instances/<pid>.sock`.

## agentDir

Same contract as Pi `getAgentDir()` / `mpi status` / `mpi ctl`:

```text
agentDir = $PI_CODING_AGENT_DIR   # if set, non-empty; leading ~ is expanded
         | ~/.pi/agent            # default
```

Read it from the bash tool (inherited from the TUI):

```text
echo "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

Then:

```text
<agentDir>/mixcode-pi/instances/<pid>.sock    # ctl socket (mode 0600)
<agentDir>/mixcode-pi/instances/<pid>.json    # status snapshot
```

`mpi status` and `mpi ctl` resolve this themselves. Only look at the files when you need to confirm a sock exists or debug a missing instance. If `PI_CODING_AGENT_DIR` differs between your bash and the target TUI, you will see the wrong instances.

## Locate yourself (bash tool env only)

These exist only in the **agent bash tool** child. They are unset on the host and in user `!` / `!!` shells. Read them with `echo`.

| Variable | Meaning |
|---|---|
| `MIXCODE` | Set (`1`) when this process is MixCode, not bare `pi`. Off if unset / `0` / `false` / `off`. |
| `MIXCODE_TAB_TITLE` | Title of **this** agent tab (follows rename on the next bash spawn). |
| `MIXCODE_FOCUSED_TAB_TITLE` | Title of the **UI-focused** agent tab. Unset when focus is Home or unknown. Differs from `MIXCODE_TAB_TITLE` when a background tab runs bash. |

Use `MIXCODE_TAB_TITLE` as "me". To talk to another tab, do **not** default `--focus-tab` to yourself. Use `mpi status` titles, or `MIXCODE_FOCUSED_TAB_TITLE` only when you intend the current UI focus.

## Discover instances

```text
mpi status
mpi status --json
mpi status --workdir <path>
```

`status` takes only `--json` and `--workdir` (default: cwd). The `--pid` / `--workdir`
mutual-exclusion and unique-match rules apply to `mpi ctl` below.

## Target and focus

```text
mpi ctl [--pid <n> | --workdir <path>] [--focus-tab <title> | --focus-session <id>] <command>
```

- `--focus-tab` / `--focus-session` are mutually exclusive. Title match is exact; duplicates need `--focus-session`.
- `--focus-session home` focuses Home.
- Omit focus: uses live UI focus; stdout header includes `reason: no --focus-tab/--focus-session; using live UI focus`.

If any agent tab is `Not Ready`, every ctl command fails: `Tab is still loading extensions. Please wait a moment.` Restart a TUI that predates the ctl socket; compiled `mpi` must include the server.

## Commands

| Command | Role |
|---|---|
| `last-message` | Last user **and** assistant lines (`role:` on each). |
| `last-assistant-message` | Last assistant only. |
| `last-user-message` | Last user only. |
| `last-tool` | Last tool / `!bash` (`tool:` / `status:` / optional `command:`). |
| `wait` | Block until not `running`/`thinking`, or until waiting for input. |
| `dump-screen` | Focused tab/home surface as text. |
| `send-keys [key...]` | Inject tmux-style keys into the real input path. |

### Ranges (`last-*` / `last-tool`)

`--from <n> --to <m>` must be a pair. 1-based from the end (`1` = newest), same role (or user+assistant for `last-message`; tools for `last-tool`). Print oldest-first. Too few lines: print what exists and add `messages: N (requested A-B)`. Home last-message / last-tool: header on stdout, then fail.

### `wait`

Always timed. `--timeout <sec>` defaults to 60; `0` checks once.

Stdout:

```text
status: finished | wait-for-input | error
timeout: <sec>
```

Timeout (still `running`/`thinking`) prints `status:` + `timeout:` then fails. Home: `Home has no agent run`.

### `dump-screen`

Default: strip ANSI and trailing spaces. `--ansi` keeps color (still strips trailing spaces).

### `send-keys`

Tokens: `Enter`, `Escape`, `Tab`, `BSpace`, arrows (`up`/`down`/`left`/`right`), `C-a`…`C-z`, `M-x`, plus literal strings. Each token is one inject. `--literal` / `-l` disables named-key mapping.

Answer a question overlay: `down` / `up` then `Enter`. Quit TUI: `C-q` then `y`.

## Output / truncation

`last-message`, `last-*-message`, `last-tool`, `dump-screen`: over 8192 bytes, stdout keeps 4096; full text at `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt` (mode `0600`). `send-keys` and `wait` are never truncated.

## Typical loop

```text
echo "$MIXCODE" "$MIXCODE_TAB_TITLE" "$MIXCODE_FOCUSED_TAB_TITLE"
mpi status --json
mpi ctl --pid <n> --focus-tab <other> send-keys '…' Enter
mpi ctl --pid <n> --focus-tab <other> wait --timeout 90
# status: wait-for-input  -> send-keys down Enter  (or dump-screen)
# status: finished        -> last-message / last-tool
```
