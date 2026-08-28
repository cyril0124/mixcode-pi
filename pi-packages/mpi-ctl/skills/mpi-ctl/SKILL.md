---
name: mpi-ctl
description: Agent Tab collaboration — control a live MixCode (mpi) TUI from the CLI. To send a user message or slash command, use mpi ctl send-prompt (not send-keys), then close the loop in one mode — poll (wait + last-message) or callback (--expect-response, end your turn) — never fire-and-forget. Also list instances, target a tab, send-keys only for real keypresses. Use when the user says mpi ctl, mpi status, another mpi, another tab, Agent Tab collaboration, Agent Tab 协作, or remote-control the TUI.
---

# mpi status / ctl

Agent Tab collaboration: drive a **live** MixCode TUI. Never start a new TUI for this. The target process must already be running and listening on `<agentDir>/mixcode-pi/instances/<hostname>/<pid>.sock`.

Two roles, two flows. Flow A covers driving another tab. Flow B covers answering a prompt that arrived via ctl. The reference sections after the flows carry the full command, flag, and schema details.

## Flow A: drive another tab (sender)

**1. Locate.** Read your env, then list live instances:

```text
echo "$MIXCODE" "$MIXCODE_TAB_TITLE" "$MIXCODE_FOCUSED_TAB_TITLE"
mpi status --json
```

Use `MIXCODE_TAB_TITLE` as "me"; never default a target to your own title. Pick the target instance's `pid` and the target `tabs[].tabTitle` / `sessionId` from the status output. Target with `--tab` (or `--session`), which never changes UI focus; `--focus-tab` is only for deliberately leaving the UI on that tab or injecting live keys when no overlay is waiting. Full rules: [Targeting and focus](#targeting-and-focus).

**2. Send.** `send-prompt` (not `send-keys`) for every text or `/slash`. It is the same path as typing in the editor and pressing Enter. Multi-line via heredoc:

```text
mpi ctl --pid <n> --tab <title> send-prompt 'Review the current diff for risks only.'
mpi ctl --tab <title> send-prompt <<'EOF'
line1
line2
EOF
```

Plain prompts are auto-wrapped so the receiver sees they came from another tab via ctl. Do not write "I am <title>" yourself. Wrapping rules: [send-prompt](#send-prompt).

**3. Close the loop in exactly one mode per prompt.** ACK from `send-prompt` means accepted, not done. Fire-and-forget is a bug.

**Poll** (default, when you did not request a reply):

```text
mpi ctl --tab <title> wait --timeout 90
# finished            -> last-message (or last-tool)
# wait-for-input      -> dump-screen, read from the tail. The question lives on the
#                        screen, not in the chat JSON, so answer from the tail.
#                        an open overlay is answered with keys, never with send-prompt:
#                        Y/N confirm  -> --tab send-keys y  (🔴 read the question first) or n
#                        picker       -> --tab send-keys Escape to leave it unchanged
#                        question / settings -> --tab send-keys, then wait again
# error | Not Ready   -> the command failed; read last-message / dump-screen for the cause
# running | thinking  -> it timed out (stderr: `Timed out after <n>s`); the turn is still live
```

**Callback** (`--expect-response`, or your prompt asks for a reply): the peer pushes the result back to your tab. After the ACK, at most one short check (`wait --timeout 5`; on `wait-for-input`, unblock the peer first), then **end your turn** and say you are waiting for that tab's reply. Never sit in a long `wait` for it. The reply is a queued message injected only after your current tool call returns, so a long wait delays your own wake-up. If the peer also `wait`s on you, both tabs stall until timeout (mutual wait).

**Slash commands.** Send with `send-prompt`, and prefer argument forms so no overlay opens: `/models <id>`, `/thinking <level>`, `/resume <session-id>` (no overlay, but it does take UI focus), `/close-session yes`. The `yes` argument only skips the dialog when *you* invoke the command; it cannot answer a dialog that is already open. Slash execution is asynchronous and failures surface on the tab's chat surface / toast (`Error: …`), not via ACK. After `wait`, run `dump-screen` on that tab and check the tail for `Error:`. Before `/models` or `/thinking`, read valid ids with `mpi --list-models`. Bare `/models`, bare `/resume`, `/close-all-sessions`, `/delete-all-sessions`, `/settings` and other overlays open on the target tab. Drive them with `--tab send-keys` (`down` / `up` + `Enter`; `y`/`n` for the always-confirm ones). New tab: `send-prompt '/new-session --no-focus Title'`. Full catalog: [Slash commands](#slash-commands).

**🔴 STOP. Confirm with the user before sending these.** They hit a live tab a human may be watching, and ctl cannot undo them: `/delete-session yes`, `/delete-all-sessions`, `/close-all-sessions`, and `send-keys C-q` + `y` (quits the whole TUI, every tab). Re-read the target from `mpi status --json` and get an explicit OK in the same turn. Everything else needs no confirmation: plain prompts, `/models`, `/thinking`, `wait`, all reads. Do not gate those.

## Flow B: you received a prompt via ctl (receiver)

Your prompt starts with `This prompt came from another MixCode tab (<title>, pid <n>) via \`mpi ctl\`, not from the human user.`

- **Without reply instructions.** Treat it as a normal request from a peer agent. No reply obligation unless the prompt asks for one. Do not add "I am <tab>" prefaces. ctl adds them automatically to whatever you send.
- **With `--expect-response` instructions.** The block names the skill path and gives a reply command. Finish the request, then send the result exactly as that block says:

  ```text
  mpi ctl --pid <n> --tab '<sender title>' send-prompt <<'EOF'
  <your result>
  EOF
  ```

  - Use the exact `--pid` / `--tab` shown in the block. The sender may live in another mpi instance.
  - Do **not** pass `--expect-response` on that reply (only if explicitly asked).
  - After the reply is ACKed, **end your turn**. Your reply is already queued for the requester, so a `wait` on it only buys a mutual wait (Flow A step 3).

---

## Red lines

Check this table before every send.

| Never | Why | Instead |
|---|---|---|
| Start a new TUI to get a target | ctl only drives an already-running instance | Ask the user to open the tab |
| `send-keys` to submit a prompt | Text lands in the draft unwrapped and unattributed, and multi-line text breaks | `send-prompt` |
| Stop at the ACK | ACK means accepted, not done | Poll or callback, exactly one per prompt |
| Long `wait` for an `--expect-response` reply | Mutual wait: both tabs stall to timeout | Short check, then end your turn |
| Answer a `wait-for-input` from `last-message` | The question is on the screen tail, not in the chat JSON | `dump-screen`, read the last ~30 lines |
| Target your own `MIXCODE_TAB_TITLE`, or default to it | You prompt yourself | Pick the target from `mpi status --json` |
| `--focus-tab` / `--focus-session` as the default | Steals UI focus from the human | `--tab` / `--session` |
| Write "I am \<title\>" into the prompt | ctl already wraps plain prompts | Send bare text |
| Treat a slash ACK as success | Failures surface as `Error:` on the tab, not in the ACK | `wait`, then `dump-screen` tail |
| Send a 🔴 command without the user's OK | `/delete-*` cannot be undone, and the `*-all-sessions` pair hits every tab in that instance | The 🔴 STOP gate in Flow A |

---

# Reference

Run `mpi ctl --help` for the command list, every flag, and its default. That output is the source of truth for the flag surface; this file covers only what `--help` leaves out.

## agentDir and instance files

Same contract as Pi `getAgentDir()` / `mpi status` / `mpi ctl`:

```text
agentDir = $PI_CODING_AGENT_DIR   # if set, non-empty; leading ~ is expanded
         | ~/.pi/agent            # default
```

Read it from the bash tool (inherited from the TUI): `echo "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"`. Then:

```text
<agentDir>/mixcode-pi/instances/<hostname>/<pid>.sock    # ctl socket (mode 0600)
<agentDir>/mixcode-pi/instances/<hostname>/<pid>.json    # status snapshot
```

`mpi status` and `mpi ctl` resolve this themselves; only inspect the files to confirm a sock exists or debug a missing instance. If `PI_CODING_AGENT_DIR` differs between your bash and the target TUI, you will see the wrong instances.

## Environment variables

`MIXCODE` and `MIXCODE_PID` are host-process env; every child sees them (bash tool, `!` / `!!` shells, extension spawns). Tab titles are injected **per bash tool spawn only** and are unset in `!` / `!!` shells.

| Variable | Meaning |
|---|---|
| `MIXCODE` | Set (`1`) when this process is MixCode, not bare `pi`. Off if unset / `0` / `false` / `off`. |
| `MIXCODE_PID` | PID of the **mpi host process** owning this agent. Implicit `--pid` when you pass neither `--pid` nor `--workdir`; a stale value errors with `No live mpi instance matches MIXCODE_PID=<n>`. More durable than `$PPID` after nohup/setsid. |
| `MIXCODE_TAB_TITLE` | Title of **this** agent tab (follows rename on the next bash spawn). Survives display extensions that re-register the bash tool. |
| `MIXCODE_FOCUSED_TAB_TITLE` | Title of the **UI-focused** agent tab. Unset when focus is Home or unknown. Differs from `MIXCODE_TAB_TITLE` when a background tab runs bash. |

Use `MIXCODE_FOCUSED_TAB_TITLE` as a target only when you intend the current UI focus.

## Targeting and focus

- `--tab` / `--session` is the default for reads and prompts; reach for `--focus-*` only when you mean to move the human's UI, or to inject live keys with no overlay waiting (`C-q`).
- The >1-instance error lists each candidate as `  <pid>  tabs: <n>  active: <title>` plus a `--pid` tip. Copy one and retry.
- Title match is exact; duplicates (possible after resume) need `--session` or `--focus-session`.
- Omit all four: live UI focus; the header includes `reason: no --tab/--session/--focus-tab/--focus-session; using live UI focus`.
- If the target tab is `Not Ready`, that ctl command fails: `Tab is still loading extensions. Please wait a moment.` Other tabs (and Home) stay usable.
- No `.sock`: that TUI predates the ctl socket or its ctl server failed to start (it showed `mpi ctl server unavailable: …`; `<agentDir>/mixcode-pi/crash.log` may hold the trace). Restart it; compiled `mpi` must include the server.

`mpi status` is not a ctl command and shares none of the rules above. It accepts `--json` and `--workdir <path>` only; every other flag, `--pid` included, fails with `Unknown status argument: <flag>`. Without `--workdir` it does not filter by cwd, it lists every live instance on this host, and it never fails on 0 or many matches (it prints `No live mpi instances.` or the full table). Pass `--workdir <path>` when you want the cwd-scoped list, and read `pid` from the output to target ctl.

## ctl commands

Output shapes `--help` does not show: `last-message` prefixes every line with `role:`; `last-tool` prints `tool:` / `status:` / an optional `command:`. `wait` also returns when the tab is waiting for input, not only when it goes idle. `send-keys` is for real keypresses; prompts go through `send-prompt`.

**Home** (`--session home`) has no agent run: `wait` / `send-prompt` fail with `Home has no agent run`, `last-message` / `last-tool` print the header on stdout then fail, and `--tab` `send-keys` is not available.

### Ranges (`last-*` / `last-tool`)

The range counts within one role set: user+assistant for `last-message`, tools for `last-tool`. Print is oldest-first. Too few lines: print what exists and add `messages: N (requested A-B)`.

### `wait`

The client socket stays open for `--timeout` plus 5s (a 10s idle timeout used to kill long `wait`); `ctl socket timed out` before that is a bug.

`wait` watches the **target** tab only; it does not return early when your own tab receives a prompt. Do not use it to wait for a `send-prompt` reply; that is callback mode (Flow A step 3).

Stdout:

```text
status: finished | wait-for-input | error | Not Ready   # settled
status: running | thinking                              # timed out
timeout: <sec>
```

`finished` covers idle and done. A timeout prints both lines too, so the status value alone does not tell you it timed out; the tell is the stderr line `Timed out after <sec>s (status: <status>)` plus a non-zero exit. Only `running` and `thinking` can time out, because every other status counts as settled. `wait-for-input` means a question/dialog is open; do not keep waiting. A leftover Notice/Error line is **not** `wait-for-input`. If stdout is truncated, `read` the `/tmp/mpi-ctl-…` file from the end; do not guess from `last-message`.

### `dump-screen`

Trailing spaces are stripped in both modes, `--ansi` included.

`--tab` / `--session` dumps that tab's chat plus its extension overlay, any picker/confirm/resume selector that tab owns, and the current MixCode app overlay (Y/N confirms, notices), not the live workspace chrome. Implied / `--focus-*` dumps the live frame, then those overlays. `--width <n>` sets the frame and the overlay together.

This is for overlays/drafts/streaming, not history. **Start from the tail** (last ~30 lines); if truncated, open the `/tmp` file and seek the end.

### `send-keys`

With live focus or `--focus-*`: tokens inject into the keyboard path (`Enter`, `Escape`, `Tab`, `BSpace`, arrows, `C-a`…`C-z`, `M-x`, literals). Each token is one inject; `--literal` / `-l` disables named-key mapping. Answer a question overlay: `down` / `up` then `Enter`. Leave a picker unchanged: `Escape` (`app-key-handlers.ts` clears `state.picker` without selecting). In a picker's custom-input mode the first `Escape` only returns to the list, so send `Escape` twice. `Enter` on a picker selects whatever row is highlighted, so never use it to dismiss one. 🔴 Quit TUI: `C-q` then `y`. This kills every tab in that instance, so confirm with the user first.

With `--tab` / `--session`: UI focus is **not** switched. A waiting overlay on that tab, or any open instance overlay (close-all, settings, quit confirm, palette), receives UI keys. Otherwise only text and `Enter` are allowed: `Enter` submits (Home-send); text without `Enter` appends to the draft. Other UI keys fail unless `--focus-tab` is used.

### `send-prompt`

Submit one prompt to the target tab (Home-send, no focus steal with `--tab`). Prefer over `send-keys` for multi-line text. No argv text (or a lone `-`) reads stdin, so a shell heredoc works; remaining args are joined with spaces. TTY + no text errors (does not hang). Home fails. ACK after accept; never truncated.

Plain prompts (not `/…` or `!`/`!!`) are wrapped so the receiving tab sees they came from another MixCode tab:

```text
This prompt came from another MixCode tab (Agent-01, pid 4242) via `mpi ctl`, not from the human user.
```

The tab name is the sender's `MIXCODE_TAB_TITLE`; `pid` is the sender's `MIXCODE_PID` (omitted when unset; plain terminal → prompt submitted unchanged). Slash and shell lines are never wrapped.

`--expect-response` (requires `MIXCODE_TAB_TITLE`; fails on `/` or `!`) appends the mpi-ctl skill path and the exact reply command (the block shown in Flow B).

## Slash commands

`mpi commands` lists **in-TUI slash commands**, the `/compact`, `/rename`, `/loop` you type in a tab editor (or send with `send-prompt /…`). It is **not** a catalog of `mpi` CLI subcommands (`status`, `ctl`, `commands`).

```text
mpi commands [--json]
```

Prints `/name [hint]` and the description for slashes this workdir would register (local MixCode, extension `registerCommand`, prompt templates). No `/skill:*`. `--json` adds `path` on extension/prompt entries. Does not start the TUI.

Common MixCode session/tab commands:

| Command | Effect |
|---|---|
| `/new-session [--focus\|--no-focus] [title]` | Create a new agent tab. `--no-focus` keeps the UI where it is; `--focus` switches to the new tab. Optional Title names it. |
| `/rename Title` | Rename the **target** tab (the one `--tab` / `--focus-tab` selected). |
| `/close-session [yes]` | Close that tab; session file stays on disk. `yes` skips the Y/N overlay. |
| 🔴 `/delete-session [yes]` | Delete that tab's session file and close the tab. `yes` skips the Y/N overlay. Irreversible. |
| 🔴 `/close-all-sessions` | Close every agent tab; keep session files. Always Y/N. Answer with `--tab send-keys` `y`/`n`. |
| 🔴 `/delete-all-sessions` | Delete every open agent session and close those tabs. Always Y/N. Answer with `--tab send-keys` `y`/`n`. Irreversible. |
| `/models [model]` | Set model directly (e.g. `/models openai/gpt-4.1`). Bare opens a picker on the target tab. |
| `/thinking [level]` | Set thinking tier directly (e.g. `/thinking high`). Bare opens a picker. |
| `/context-limit [value]` | Set context limit directly (e.g. `/context-limit 32k`, `/context-limit reset`). Bare opens picker. |
| `/workdir [path]` | Change workdir directly. Bare opens picker. |
| `/resume` | Bare: opens the session picker. `/resume <session-id>` (id or prefix) and `/resume N:<tab-name>` (exact open tab title first, then exact full session name, current folder first) resume without opening the picker. Duplicate names report candidate ids. **Unlike every other row, direct resume switches UI focus**, and it opens a **new** tab instead of rebinding the one you targeted. The new tab inherits workdir, model, context limit and thinking level from whichever tab held UI focus, not from your `--tab`. Set them explicitly afterwards if they matter. |
| `/clear` | Replace the tab's session with a fresh child (title resets). |
| `/reset` | Reset the branch to session root; keep title and tab slot. |
| `/compact` | Compact that tab's context. |
| `/mark-done` | Mark that tab done. |

### Valid models / thinking levels (`mpi --list-models`)

Read options with `mpi --list-models`, never by opening the `/models` or `/thinking` picker. It takes no `--pid` / `--tab` and touches no TUI instance: it reads `models.json`, whatever auth resolves (`auth.json`, `models.json` `apiKey`, or provider env vars), and the `mixcode_settings` disable lists. No network, no extensions.

```text
mpi --list-models [filter] [--json]   # case-insensitive filter on provider/modelId
```

```text
provider  model              context  thinking
deepseek  deepseek-v4-flash  1M       off,low,high,max
deepseek  deepseek-v4-pro    1M       off,high,max                 (disabled)
```

Run this before every `send-prompt '/models <id>'` or `'/thinking <level>'`: the `model` column is what `/models` accepts, the `thinking` column is that model's accepted `/thinking` values (they differ per model). Rows marked `(disabled)` are refused by `/models`. `--json` yields `[{ id, provider, modelId, displayName, contextWindow, reasoning, disabled, thinking }]`. Runtime-registered third-party providers are not listed.

## Output truncation

`mpi ctl --help` gives the byte limits, the `/tmp` path pattern, and the Notice string. What it leaves out: `send-keys`, `send-prompt`, and `wait` are never truncated, so no `/tmp` file is written for them.

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

TUI slash catalog only. A JSON **array** (not wrapped):

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
