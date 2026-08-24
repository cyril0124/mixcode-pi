---
name: mpi-ctl
description: Agent Tab collaboration — control a live MixCode (mpi) TUI from the CLI. To send a user message or slash command, use mpi ctl send-prompt (not send-keys), then close the loop in one mode — poll (wait + last-message) or callback (--expect-response, end your turn) — never fire-and-forget. Also list instances, target a tab, send-keys only for real keypresses. Use when the user says mpi ctl, mpi status, another mpi, another tab, Agent Tab collaboration, Agent Tab 协作, or remote-control the TUI.
---

# mpi status / ctl

Agent Tab collaboration: drive a **live** MixCode TUI. Do not start a new TUI for this. The target process must already be running and listening on `<agentDir>/mixcode-pi/instances/<hostname>/<pid>.sock`.

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
<agentDir>/mixcode-pi/instances/<hostname>/<pid>.sock    # ctl socket (mode 0600)
<agentDir>/mixcode-pi/instances/<hostname>/<pid>.json    # status snapshot
```

`mpi status` and `mpi ctl` resolve this themselves. Only look at the files when you need to confirm a sock exists or debug a missing instance. If `PI_CODING_AGENT_DIR` differs between your bash and the target TUI, you will see the wrong instances.

## Locate yourself

`MIXCODE` and `MIXCODE_PID` live on the host process env, so every child sees them (bash tool, user `!` / `!!` shells, extension spawns). The tab titles are injected **per bash tool spawn only** and are unset in `!` / `!!` shells. Read them with `echo`.

| Variable | Meaning |
|---|---|
| `MIXCODE` | Set (`1`) when this process is MixCode, not bare `pi`. Off if unset / `0` / `false` / `off`. |
| `MIXCODE_PID` | PID of the **mpi host process** owning this agent (host env, inherited everywhere). `mpi ctl` uses it as an implicit `--pid` when you pass neither `--pid` nor `--workdir`; a stale value errors with `No live mpi instance matches MIXCODE_PID=<n>`. More durable than `$PPID` after nohup/setsid. |
| `MIXCODE_TAB_TITLE` | Title of **this** agent tab (follows rename on the next bash spawn). Survives display extensions that re-register the bash tool. |
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

`--tab` does not steal UI focus. **Default to `--tab` / `--session`.** Do not use `--focus-tab` / `--focus-session` unless the next action is UI keys on a picker or overlay that `--tab` cannot drive. **Always close the loop:** ACK from `send-prompt` only means accept, not done. Poll with `wait` then `last-message` (or `last-tool` / `dump-screen`) — unless you requested a reply (callback mode, see `send-prompt`).

Use **`send-keys` + `--focus-tab`** only after `dump-screen` shows an interactive picker/overlay that cannot take direct arguments (bare `/resume`, `/models` or `/thinking` without arguments, `/close-all-sessions`, `/delete-all-sessions`, extension question UI, `C-q`). For commands that accept arguments, **prefer passing arguments directly with `send-prompt`** (e.g. `send-prompt '/models gpt-4.1'`, `send-prompt '/thinking high'`, `send-prompt '/close-session yes'`, `send-prompt '/resume <session-id>'`) to avoid opening pickers and needing `dump-screen` / `send-keys`.

Common MixCode session/tab commands:

| Command | Effect |
|---|---|
| `/new-session` | Create a new agent tab. `/new-session Title` also names it. |
| `/rename Title` | Rename the **target** tab (the one `--tab` / `--focus-tab` selected). |
| `/close-session [yes]` | Close that tab; session file stays on disk. `yes` skips the Y/N overlay. |
| `/delete-session [yes]` | Delete that tab's session file and close the tab. `yes` skips the Y/N overlay. |
| `/close-all-sessions` | Close every agent tab; keep session files. Always Y/N — `--focus-tab` then `y`/`n`. |
| `/delete-all-sessions` | Delete every open agent session and close those tabs. Always Y/N — `--focus-tab` then `y`/`n`. |
| `/models [model]` | Set model directly (e.g. `/models openai/gpt-4.1`, `/models gpt-4.1`). Bare `/models` opens picker (needs `--focus-tab`). |
| `/thinking [level]` | Set thinking tier directly (e.g. `/thinking high`, `/thinking off`). Bare `/thinking` opens picker (needs `--focus-tab`). |
| `/context-limit [value]` | Set context limit directly (e.g. `/context-limit 32k`, `/context-limit reset`). Bare opens picker. |
| `/workdir [path]` | Change workdir directly (e.g. `/workdir /path/to/dir`). Bare opens picker. |
| `/resume` | Bare: opens the session picker (needs `--focus-tab`; it is UI). `/resume <session-id>` (id or prefix) and `/resume N:<tab-name>` (exact open tab title first, then exact full session name, current folder first) resume directly via plain `send-prompt`, no focus. Duplicate names report candidate ids. |
| `/clear` | Replace the tab's session with a fresh child (title resets). |
| `/reset` | Reset the branch to session root; keep title and tab slot. |
| `/compact` | Compact that tab's context. |
| `/mark-done` | Mark that tab done. |

Send these with `send-prompt` and `--tab`. **Prefer direct arguments** (e.g. `/models <model>`, `/thinking <level>`, `/resume <session-id>`, `/close-session yes`) so no picker opens. Bare `/resume`, bare `/models`, bare `/thinking`, close-all / delete-all, and other interactive overlays still need `--focus-tab` plus `send-keys`.

**Inspect slash command outcomes via `dump-screen`**: Slash commands execute asynchronously and report parameter or execution failures on the tab's chat surface / toast (prefixed with `Error:`). After `send-prompt /...` and `wait`, run `dump-screen` on the target tab and check the tail for any `Error: ...` lines (e.g. `Error: Unknown model: <name>`, `Error: Unknown thinking level: ...`, `Error: Unknown slash command: /...`). Do not assume a slash command succeeded merely because `send-prompt` returned an ACK.

Direct `/resume` commands return an ACK before asynchronous command handling finishes. Close the loop with `wait`, then use `dump-screen` on the target tab to read name-not-found or duplicate-name errors. Duplicate-name output includes candidate session ids; retry with `/resume <session-id>`.

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

- `--tab` / `--session`: operate this tab **without** changing UI focus. **Default.** Use these to read or prompt any tab.
- `--focus-tab` / `--focus-session`: operate and **leave** UI focus on that tab. Only for UI keys after `dump-screen` shows a picker/overlay `--tab` cannot drive.
- Targeting default (no `--pid` / `--workdir`): `MIXCODE_PID` env when set (host env, inherited by all children), else the unique live instance in `<cwd>`. With 0 or >1 matches it fails; >1 lists each candidate as `  <pid>  tabs: <n>  active: <title>` plus a `--pid` tip — copy one and retry.
- The four flags are mutually exclusive. Title match is exact; duplicates (possible after resume) need `--session` or `--focus-session`.
- `home` is Home (`--session home` or `--focus-session home`).
- Omit all four: live UI focus; header includes `reason: no --tab/--session/--focus-tab/--focus-session; using live UI focus`.

If the **target** agent tab is `Not Ready`, that ctl command fails: `Tab is still loading extensions. Please wait a moment.` Other tabs (and Home) stay usable. Restart a TUI that predates the ctl socket or whose ctl server failed to start (it showed a `mpi ctl server unavailable: …` notice; `<agentDir>/mixcode-pi/crash.log` may hold the trace); compiled `mpi` must include the server.

## Commands

| Command | Role |
|---|---|
| `last-message` | Last user **and** assistant lines (`role:` on each). |
| `last-assistant-message` | Last assistant only. |
| `last-user-message` | Last user only. |
| `last-tool` | Last tool / `!bash` (`tool:` / `status:` / optional `command:`). |
| `wait` | Block until not `running`/`thinking`, or until waiting for input. |
| `dump-screen` | Live TUI frame, or `--tab`/`--session` chat surface, plus extension overlay. |
| `send-prompt <text>` | **Default for text.** Submit a user message or `/slash` (newlines/heredoc OK). |
| `send-keys [key...]` | **Keys only** (`down`, `Enter` on a question, `C-q`). Not for prompts. |

### Ranges (`last-*` / `last-tool`)

`--from <n> --to <m>` must be a pair. 1-based from the end (`1` = newest), same role (or user+assistant for `last-message`; tools for `last-tool`). Print oldest-first. Too few lines: print what exists and add `messages: N (requested A-B)`. Home last-message / last-tool: header on stdout, then fail.

### `wait`

Always timed. `--timeout <sec>` defaults to 60; `0` checks once. The client socket stays open for `--timeout` plus 5s (a 10s idle timeout used to kill long `wait`).

`wait` watches the **target** tab only; it does not return early when your own tab receives a prompt. Do not use it to wait for a `send-prompt` reply — that is callback mode, see `send-prompt`.

Stdout:

```text
status: finished | wait-for-input | error
timeout: <sec>
```

Timeout (still `running`/`thinking`) prints `status:` + `timeout:` then fails. Home: `Home has no agent run`.

On `wait-for-input`, run `dump-screen` on that tab and **start from the tail**. Questions and Y/N confirms are at the end, not the chat JSON above. A leftover Notice/Error is not `wait-for-input`. If stdout is truncated, `read` the `/tmp/mpi-ctl-…` file from the end. Do not guess from `last-message`.

### `dump-screen`

Default: strip ANSI and trailing spaces. `--ansi` keeps color (still strips trailing spaces).

`--tab` / `--session` dump that tab's chat plus its extension overlay and the current MixCode app overlay (Y/N confirms, notices) — not the live workspace chrome. Implied / `--focus-*` dumps the live frame, then those overlays. Overlay width is `max(live TUI columns, 100)`. `--width <n>` sets both. **Start from the tail** (last ~30 lines). If truncated, open the `/tmp` file and seek the end.

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

Plain prompts (not `/…` or `!`/`!!`) are wrapped so the receiving tab can see they came from another MixCode tab via ctl, not the human:

```text
This prompt came from another MixCode tab (Agent-01, pid 4242) via `mpi ctl`, not from the human user.

Review the current diff for risks only.
```

The tab name is `MIXCODE_TAB_TITLE`; `pid` is the sender instance's `MIXCODE_PID` (omitted when unset). If that env is unset (plain terminal), the prompt is submitted unchanged. Do **not** write “I am &lt;title&gt;” yourself. Slash and shell lines are never wrapped.

`--expect-response` (requires `MIXCODE_TAB_TITLE`; fails on `/` or `!`) adds the installed mpi-ctl skill path and the reply command:

```text
This prompt came from another MixCode tab (Agent-01, pid 4242) via `mpi ctl`, not from the human user.
When finished, follow the mpi-ctl skill at:
<agentDir>/extensions/mpi-ctl/skills/mpi-ctl/SKILL.md
Send your result back with `mpi ctl`:
mpi ctl --pid 4242 --tab 'Agent-01' send-prompt <<'EOF'
<your result>
EOF
Do not pass --expect-response on that reply.

Review the current diff for risks only.
```

If you receive that block: read the skill at the given path, finish the request, then send the result with that `send-prompt` (do **not** add `--expect-response` unless asked). Reply with the exact `--pid`/`--tab` shown in the block — the sender may live in another mpi instance. After that reply is ACKed, **end your turn** — do not `wait` on the requester; it may still be mid-turn, and your reply is already queued for it.

**Close the loop — pick exactly one mode per prompt; never stop at ACK:**

**Poll** (default; you did not request a reply) — pull the result yourself:

```text
mpi ctl --tab <title> wait --timeout 90
# finished        -> mpi ctl --tab <title> last-message
# wait-for-input  -> mpi ctl --tab <title> dump-screen  (start from the tail)
#                   single-tab Y/N -> send-prompt /close-session yes or /delete-session yes
#                   picker / close-all / delete-all / question overlay -> --focus-tab send-keys; wait again
# error / timeout -> last-message / dump-screen; do not assume success
```

**Callback** (`--expect-response`, or your prompt asks for a reply) — the peer pushes the result back to your tab. After ACK, at most one short check (`wait --timeout 5`; on `wait-for-input`, unblock the peer first), then **end your turn** and say you are waiting for that tab's reply. Never sit in a long `wait` for the reply: it arrives as a queued message that is injected only after your current tool call returns, so a long `wait` delays your own wake-up — and if the peer also `wait`s on you, both tabs stall until timeout (mutual wait).

## Output / truncation

`last-message`, `last-*-message`, `last-tool`, `dump-screen`: over 8192 bytes, stdout keeps the last 4096 bytes (tail); full text at `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt` (mode `0600`). Notice: `[Full output: <path>. Truncated: showing last N lines (4.0KB tail limit)]`. `send-keys`, `send-prompt`, and `wait` are never truncated.

## JSON schemas

`mpi ctl` itself has **no** `--json`. Only `mpi status` and `mpi commands` emit JSON (`JSON.stringify(..., null, 2)`).

### `mpi status --json`

```text
{
  "instances": [
    {
      "pid": 1234,                    // number, process id
      "workdir": "~/proj",            // string, ~ for $HOME
      "focus": "tab",                 // "home" | "tab"; omitted if unknown
      "activeTabTitle": "Agent-01",   // string, only when focus is "tab"; a tab named "home" still gives focus "tab"
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

Empty live set: `{ "instances": [] }`. `state` is derived (`waiting-for-input` if extension UI is waiting for input; `working` if running/thinking; `finished` if done/unread). Use `tabTitle`/`sessionId` for ctl flags, `pid` for `--pid`.

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
# status: wait-for-input  -> dump-screen (start from the tail); --focus-tab send-keys only if it is a picker/overlay you must click
# status: finished        -> last-message / last-tool
```

Callback variant (`--expect-response` / reply requested): stop after the `send-prompt` ACK (plus at most a short `wait`), end your turn, and let the reply wake this tab.

## Pitfalls (common agent mistakes)

- **Do not start another `mpi` TUI** to inspect a tab. Use `status`/`ctl` against the live process.
- **Never default to `--focus-tab`.** Use `--tab`. `--focus-tab` leaves the UI on that tab — only after `dump-screen` shows a picker/overlay that needs keys. `--session` is not an alias of `--focus-session`.
- **After `send-prompt`, close the loop in exactly one mode.** ACK ≠ finished. Poll: `wait` then `last-message` (for prompts) or `dump-screen` (for slash commands to verify no `Error:` appeared). Callback (`--expect-response` / reply requested): end your turn after ACK. Fire-and-forget is a bug; so is a long `wait` for a reply — the reply injects only after your current tool call returns, so poll+callback stalls both tabs until timeout.
- **Check `dump-screen` for `Error:` on slash commands.** Slash commands do not generate assistant chat turns, so `last-message` will not reflect slash errors. Always run `dump-screen` on the target tab after running a slash command to verify it took effect and check for `Error:` notices at the tail.
- **On `wait-for-input`, `dump-screen` first and start from the tail.** The confirm or question is at the end. If truncated, read `/tmp/mpi-ctl-…` from the end. Single-tab close/delete: `send-prompt /close-session yes` (or `/delete-session yes`). close-all / delete-all and pickers: `--focus-tab` + `send-keys`. Do not answer from `last-message` alone.
- **Do not preface prompts with “I am &lt;tab&gt;”.** ctl already wraps plain text with the MixCode-tab preface. Slash/`!` are not wrapped. If the preface includes `--expect-response` instructions, follow the skill path and reply with the given `send-prompt`; do not add `--expect-response` on that reply. After replying, end your turn — do not `wait` on the requester.
- **`mpi commands` is TUI slashes (`/compact`), not CLI subcommands (`mpi ctl`).** Slash commands: `send-prompt /compact`, not `send-keys '/compact' Enter`. `send-keys` is for real keypresses (pickers, `down`/`Enter` on a question, `C-q`). `--tab` send-keys is text+Enter only; multi-line body uses `send-prompt <<'EOF'`. `--literal` makes `Enter` the letters E-n-t-e-r.
- **`--from` and `--to` must both be present.** One alone errors. `1` is newest, print is oldest-first. `last-message` is user+assistant only; tools are `last-tool`.
- **`wait` always has a timeout** (default 60s). Client waits `--timeout`+5s; `ctl socket timed out` before that is a bug. `wait-for-input` means a question/dialog — do not keep waiting. `finished` is idle/done. Home: `Home has no agent run`.
- **Not Ready / no sock:** only the target tab still loading fails that ctl command. No `.sock` means that TUI predates ctl or its ctl server failed to start (the TUI showed a `mpi ctl server unavailable` notice) — restart it. `status` 0 or >1 instance without `--pid` fails; same workdir with two TUIs needs `--pid` or `MIXCODE_PID` (the >1 error lists candidate pids with active tab titles — pick from there or `mpi status`).
- **Env:** the tab titles exist only in the **bash tool**, not `!` shells; `MIXCODE` / `MIXCODE_PID` are host env and show up everywhere. Do not `--tab`/`--focus-tab` yourself (`MIXCODE_TAB_TITLE`) when the user asked about another tab. `MIXCODE_FOCUSED_TAB_TITLE` is empty on Home. Wrong `PI_CODING_AGENT_DIR` lists the wrong instances.
- **`/close-session` keeps the file; `/delete-session` removes it.** Pass `yes` to skip the single-tab Y/N overlay. **Do not** pass `yes` to `/close-all-sessions` or `/delete-all-sessions` — those always confirm; use `--focus-tab` and `y`/`n`. `/clear` makes a new child session; `/reset` stays on the same file. `/new-session Title` creates a **new** tab; `/rename Title` renames the target tab.
- **`dump-screen` is for overlays/drafts/streaming**, not history. **Start from the tail.** Default is no ANSI; `--ansi` keeps color. Huge output is truncated to `/tmp/mpi-ctl-…` — read that file from the end.
- **Home** has no last-message / last-tool / wait / `--tab` send-keys. `--session home` is Home, not `config`.
