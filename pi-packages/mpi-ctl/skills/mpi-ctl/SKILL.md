---
name: mpi-ctl
description: Control a live MixCode (mpi) TUI from the CLI. To send a user message or slash command, use mpi ctl send-prompt (not send-keys), then always wait and read last-message (or last-tool / dump-screen) — never fire-and-forget. Also list instances, target a tab, send-keys only for real keypresses. Use when the user says mpi ctl, mpi status, another mpi, another tab, or remote-control the TUI.
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
| `MIXCODE_PID` | PID of the **mpi host process** owning this agent. `mpi ctl` uses it as an implicit `--pid` when you pass neither `--pid` nor `--workdir`; a stale value errors with `No live mpi instance matches MIXCODE_PID=<n>`. More durable than `$PPID` after nohup/setsid. |
| `MIXCODE_TAB_TITLE` | Title of **this** agent tab (follows rename on the next bash spawn). |
| `MIXCODE_FOCUSED_TAB_TITLE` | Title of the **UI-focused** agent tab. Unset when focus is Home or unknown. Differs from `MIXCODE_TAB_TITLE` when a background tab runs bash. |

Use `MIXCODE_TAB_TITLE` as "me". To talk to another tab, do **not** default `--focus-tab` to yourself. Use `mpi status` titles, or `MIXCODE_FOCUSED_TAB_TITLE` only when you intend the current UI focus.

## List TUI slash commands (`mpi commands`)

This is **not** a catalog of `mpi` CLI subcommands (`status`, `ctl`, `commands`). Those are argv to the `mpi` binary.

`mpi commands` lists **in-TUI slash commands** — the `/compact`, `/rename`, `/loop` you type in a tab editor (or send with `send-prompt /…`).

```text
mpi commands
mpi commands --json
```

Prints `/name [hint]` and the description for slashes this workdir would register (local MixCode, extension `registerCommand`, prompt templates). Does not list `/skill:*`. `--json` adds `path` on extension/prompt entries (extension file or package directory). Does not start the TUI.

## Run a slash command

Use **`send-prompt`**, not `send-keys`. Same path as typing `/…` in the editor and pressing Enter.

```text
mpi ctl --tab Agent-01 send-prompt /compact
mpi ctl --tab Agent-01 send-prompt '/rename New Title'
mpi ctl --tab Agent-01 send-prompt '/new-session Worker'
```

`--tab` does not steal UI focus. **Always close the loop:** `wait` then `last-message` (or `last-tool` / `dump-screen`). ACK from `send-prompt` only means accept, not done.

Use **`send-keys` + `--focus-tab`** only when the command opens a picker/overlay (`/resume`, question dialogs, `C-q`).

Common MixCode session/tab commands:

| Command | Effect |
|---|---|
| `/new-session` | Create a new agent tab. `/new-session Title` also names it. |
| `/rename Title` | Rename the **target** tab (the one `--tab` / `--focus-tab` selected). |
| `/close-session` | Close that tab; session file stays on disk. |
| `/delete-session` | Delete that tab's session file and close the tab. |
| `/close-all-sessions` | Close every agent tab; keep session files. |
| `/delete-all-sessions` | Delete every open agent session and close those tabs. |
| `/resume` | Open the session picker (needs `--focus-tab`; it is UI). |
| `/clear` | Replace the tab's session with a fresh child (title resets). |
| `/reset` | Reset the branch to session root; keep title and tab slot. |
| `/compact` | Compact that tab's context. |
| `/mark-done` | Mark that tab done. |

Send these with `send-prompt` and `--tab`. `/resume` and other pickers still need `--focus-tab` plus `send-keys` UI keys.

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
mpi ctl [--pid <n> | --workdir <path>] [--tab <title> | --session <id> | --focus-tab <title> | --focus-session <id>] <command>
```

- `--tab` / `--session`: operate this tab **without** changing UI focus. Prefer these to read or prompt a background tab.
- `--focus-tab` / `--focus-session`: operate and **leave** UI focus on that tab.
- Targeting default (no `--pid` / `--workdir`): `MIXCODE_PID` env when set (bash tool children), else the unique live instance in `<cwd>`.
- The four flags are mutually exclusive. Title match is exact; duplicates need `--session` or `--focus-session`.
- `home` is Home (`--session home` or `--focus-session home`).
- Omit all four: live UI focus; header includes `reason: no --tab/--session/--focus-tab/--focus-session; using live UI focus`.

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
| `send-prompt <text>` | **Default for text.** Submit a user message or `/slash` (newlines/heredoc OK). |
| `send-keys [key...]` | **Keys only** (`down`, `Enter` on a question, `C-q`). Not for prompts. |

### Ranges (`last-*` / `last-tool`)

`--from <n> --to <m>` must be a pair. 1-based from the end (`1` = newest), same role (or user+assistant for `last-message`; tools for `last-tool`). Print oldest-first. Too few lines: print what exists and add `messages: N (requested A-B)`. Home last-message / last-tool: header on stdout, then fail.

### `wait`

Always timed. `--timeout <sec>` defaults to 60; `0` checks once. The client socket stays open for `--timeout` plus 5s (a 10s idle timeout used to kill long `wait`).

Stdout:

```text
status: finished | wait-for-input | error
timeout: <sec>
```

Timeout (still `running`/`thinking`) prints `status:` + `timeout:` then fails. Home: `Home has no agent run`.

### `dump-screen`

Default: strip ANSI and trailing spaces. `--ansi` keeps color (still strips trailing spaces).

### `send-keys`

With live focus or `--focus-*`: tokens inject into the keyboard path (`Enter`, `Escape`, `Tab`, `BSpace`, arrows, `C-a`…`C-z`, `M-x`, literals). Each token is one inject. `--literal` / `-l` disables named-key mapping. Answer a question overlay: `down` / `up` then `Enter`. Quit TUI: `C-q` then `y`.

With `--tab` / `--session`: **do not** switch UI focus. Only text and `Enter` are allowed. `Enter` submits (Home-send). Text without `Enter` appends draft. Other UI keys fail — use `--focus-tab`.

### `send-prompt`

Submit one prompt to the target tab (Home-send, no focus steal with `--tab`). Prefer this over `send-keys` for multi-line text. No argv text (or a lone `-`) reads stdin, so a shell heredoc works:

```text
mpi ctl --tab Agent-01 send-prompt hello world
mpi ctl --tab Agent-01 send-prompt <<'EOF'
line1
line2
EOF
```

Joins remaining args with spaces. TTY + no text errors (does not hang). Home fails. ACK after accept; not truncated.

Plain prompts (not `/…` or `!`/`!!`) are wrapped so the receiving tab can see they came from ctl, not the human:

```text
[mpi ctl] from tab: Agent-01

Review the current diff for risks only.
```

`from tab:` is `MIXCODE_TAB_TITLE`. If that env is unset (plain terminal), the prompt is submitted unchanged — no `[mpi ctl]` header. Do **not** write “I am &lt;title&gt;” yourself. Slash and shell lines are never wrapped.

**Required follow-up (do not stop after ACK):**

```text
mpi ctl --tab <title> wait --timeout 90
# finished        -> mpi ctl --tab <title> last-message
# wait-for-input  -> dump-screen or --focus-tab send-keys, then wait again
# error / timeout -> last-message / dump-screen; do not assume success
```

## Output / truncation

`last-message`, `last-*-message`, `last-tool`, `dump-screen`: over 8192 bytes, stdout keeps 4096; full text at `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt` (mode `0600`). Notice: `[Full output: <path>. Truncated: N lines shown (4.0KB limit)]`. `send-keys`, `send-prompt`, and `wait` are never truncated.

## JSON schemas

`mpi ctl` itself has **no** `--json`. Only `mpi status` and `mpi commands` emit JSON (`JSON.stringify(..., null, 2)`).

### `mpi status --json`

```text
{
  "instances": [
    {
      "pid": 1234,                    // number, process id
      "workdir": "~/proj",            // string, ~ for $HOME
      "activeTabTitle": "Agent-01",   // string, omitted if unknown; Home is "home"
      "tabs": [
        {
          "state": "idle",            // waiting-for-input | error | working | finished | idle
          "status": "idle",           // Not Ready | idle | running | thinking | error | done
          "tabTitle": "Agent-01",     // string, exact --tab / --focus-tab value
          "sessionId": "01a0…"        // string, exact --session / --focus-session value
        }
      ]
    }
  ]
}
```

Empty live set: `{ "instances": [] }`. `state` is derived (`waiting-for-input` if dialogs; `working` if running/thinking; `finished` if done/unread). Use `tabTitle`/`sessionId` for ctl flags, `pid` for `--pid`.

### `mpi commands --json`

TUI slash catalog only — not `mpi status` / `mpi ctl` / `mpi commands` itself.

A JSON **array** (not wrapped):

```text
[
  {
    "name": "compact",               // string, no leading /
    "usage": "/compact",             // string, `/name` plus argumentHint if any
    "description": "Compact context", // string, may be empty
    "source": "local"                // local | extension | prompt
  },
  {
    "name": "loop",
    "usage": "/loop",
    "description": "…",
    "source": "extension",
    "path": "/home/…/extensions/mpi-loop/index.ts"  // string, only extension and prompt
  }
]
```

No `/skill:*`. Same `name` as a local command: local wins, no `path`. `path` is Pi `sourceInfo.path` (extension file or package directory).

## Typical loop

```text
echo "$MIXCODE" "$MIXCODE_TAB_TITLE" "$MIXCODE_FOCUSED_TAB_TITLE"
mpi status --json
mpi ctl --pid <n> --tab <other> send-prompt '…'
mpi ctl --pid <n> --tab <other> wait --timeout 90
# status: wait-for-input  -> --focus-tab <other> send-keys down Enter
# status: finished        -> last-message / last-tool
```

## Pitfalls (common agent mistakes)

- **Do not start another `mpi` TUI** to inspect a tab. Use `status`/`ctl` against the live process.
- **`--tab` vs `--focus-tab`:** prefer `--tab` so you do not steal the user's cursor. `--focus-tab` leaves the UI on that tab. `--session` is not an alias of `--focus-session`.
- **After `send-prompt`, always `wait` then read output.** ACK ≠ finished. Skipping `wait`/`last-message` is a bug.
- **Do not preface prompts with “I am &lt;tab&gt;”.** ctl already wraps plain text as `[mpi ctl] from tab: …`. Slash/`!` are not wrapped.
- **`mpi commands` is TUI slashes (`/compact`), not CLI subcommands (`mpi ctl`).** Slash commands: `send-prompt /compact`, not `send-keys '/compact' Enter`. `send-keys` is for real keypresses (pickers, `down`/`Enter` on a question, `C-q`). `--tab` send-keys is text+Enter only; multi-line body uses `send-prompt <<'EOF'`. `--literal` makes `Enter` the letters E-n-t-e-r.
- **`--from` and `--to` must both be present.** One alone errors. `1` is newest, print is oldest-first. `last-message` is user+assistant only; tools are `last-tool`.
- **`wait` always has a timeout** (default 60s). Client waits `--timeout`+5s; `ctl socket timed out` before that is a bug. `wait-for-input` means a question/dialog — do not keep waiting. `finished` is idle/done. Home: `Home has no agent run`.
- **Not Ready / no sock:** any tab still loading fails every ctl. No `.sock` means that TUI predates ctl — restart it. `status` 0 or >1 instance without `--pid` fails; same workdir with two TUIs needs `--pid` or `MIXCODE_PID`.
- **Env:** `MIXCODE_*` exist only in the **bash tool**, not `!` shells. Do not `--tab`/`--focus-tab` yourself (`MIXCODE_TAB_TITLE`) when the user asked about another tab. `MIXCODE_FOCUSED_TAB_TITLE` is empty on Home. Wrong `PI_CODING_AGENT_DIR` lists the wrong instances.
- **`/close-session` keeps the file; `/delete-session` removes it.** `/clear` makes a new child session; `/reset` stays on the same file. `/new-session Title` creates a **new** tab; `/rename Title` renames the target tab.
- **`dump-screen` is for overlays/drafts/streaming**, not history. Default is no ANSI; `--ansi` keeps color. Huge output is truncated to `/tmp/mpi-ctl-…`.
- **Home** has no last-message / last-tool / wait / `--tab` send-keys. `--session home` is Home, not `config`.
