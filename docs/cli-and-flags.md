# CLI Entrypoint, Flags & Upstream Delegation

[中文文档](cli-and-flags.zh.md)

This document describes the CLI interface, command-line arguments, and Pi delegation rules implemented in `src/cli/main.ts`.

## Synopsis

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
mpi ctl [--pid <n> | --workdir <path>] [--tab <title> | --session <id> | --focus-tab <title> | --focus-session <id>] <command>
mpi commands [--json] [--workdir <path>]
```

## Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `--workdir <path>` | string | Current working directory (`process.cwd()`) | Target working directory. Also accepts `--workdir=<path>`. There is no `-w` short flag. |
| `--builtin-extensions-only` | boolean | `false` | Disables third-party package discovery under `settings.json` `packages` and loads only first-party built-in extensions under `pi-packages/mpi-*`. |
| `--batch <script.lua>` | string | unset | Executes a Lua batch automation script after bootstrapping runtime. |
| `--batch-dry-run` | boolean | `false` | Validates model/thinking configurations and prints the batch execution plan without starting TUI or modifying state files. |
| `--help`, `-h` | boolean | `false` | Prints CLI usage text and exits immediately. |

## Status Subcommand

Inspects running MixCode instances and tab heartbeats across the machine:

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- `--json`: Outputs structured machine-readable JSON matching the table fields (`pid`, `workdir`, `activeTabTitle`, tabs).
- `--workdir <path>`: Filters to instances whose root workdir equals the resolved path. Relative paths resolve against the current working directory. `~` and `~/...` expand to the home directory. Also accepts `--workdir=<path>`.
- The `status` command executes on a fast lightweight path that directly reads the instance registry without booting the TUI, importing Pi runtime components, or materializing binary assets.

## Ctl Subcommand

Control one live MixCode TUI over a per-process Unix socket at `<agentDir>/mixcode-pi/instances/<pid>.sock`.

```bash
mpi ctl last-message
mpi ctl last-assistant-message
mpi ctl last-user-message
mpi ctl last-tool
mpi ctl wait --timeout 60
mpi ctl --pid 4104920 dump-screen
mpi ctl --workdir ~/proj send-keys /compact Enter
mpi ctl send-keys --literal Enter
mpi ctl --tab Agent-01 send-prompt <<'EOF'
line1
line2
EOF
```

- Target: explicit `--pid` or `--workdir` (same resolve rules as `status`), not both; then `MIXCODE_PID` when set; otherwise cwd. Invalid or stale `MIXCODE_PID` values fail. Zero matches, or more than one cwd/workdir match, exits non-zero.
- Every command prints a header then a blank line: `tab:`, `session:`, and `reason:` only when none of `--tab` / `--session` / `--focus-tab` / `--focus-session` was given. `last-message` / `last-assistant-message` / `last-user-message` start each message with `----------` then `time:` (local `YYYY-MM-DD HH:MM:SS ±HH:MM`, or `unknown`) then the body. `last-message` also prints `role:` and counts both user and assistant lines. `last-tool` prints `tool:` / `status:` / optional `command:` / `time:` then the tool or `!bash` output. Optional `--from <n> --to <m>` (both required) selects a 1-based range from the end (`1` is newest; role-filtered commands count only that role) and prints oldest-first. If fewer messages exist, print what exists and add `messages: N (requested A-B)` to the header. Home last-message / last-tool commands print that header on stdout then fail on stderr.
- `wait`: block until the focused agent tab is not `running`/`thinking`, or is waiting for input (extension UI or a capturing MixCode app overlay such as a Y/N confirm or picker; not a Notice/Error). Always timed: `--timeout <sec>` defaults to 60; `0` checks once. Client socket stays open for `--timeout` plus 5s. Prints `status:` (`finished` / `wait-for-input` / `error`, or `running`/`thinking` on timeout) and `timeout:`. Timeout fails after printing those lines. Home has no agent run.
- `dump-screen`: implied focus / `--focus-*` dumps the live TUI frame. `--tab` / `--session` dump that tab's chat surface only (no workspace tab bar / footer). Then any extension custom overlay (`ctx.ui.custom`) and the current MixCode app overlay (`showLinesOverlay` / `showComponentOverlay`, including Y/N confirms and notices). Not a PNG. Chrome uses the live TUI width; overlays use `max(live, 100)` so a narrow pane still dumps a readable dialog. `--width <n>` sets both. Client output strips ANSI and trailing spaces by default; `--ansi` keeps color.
- `--tab <title>` / `--session <id>` target a tab without changing UI focus. `--focus-tab` / `--focus-session` target and leave UI focus there. The four flags are mutually exclusive. Title match is exact; duplicates require `--session` or `--focus-session`. `home` is Home.
- `send-keys`: with live focus or `--focus-*`, inject tmux-style keys into the keyboard input path (`Enter`, `Escape`, `Tab`, `BSpace`, arrows, `C-a`…`C-z`, `M-x`, plus literal strings). With `--tab` / `--session`, only text and `Enter` are allowed: `Enter` submits via Home-send (no `activeTabId` change); leftover text appends `draftInput`. ACK after accept. UI keys require `--focus-tab`. `--literal` / `-l` disables named-key mapping.
- `send-prompt [text...]`: submit joined argv text (newlines in one argument are kept). With no text or a lone `-`, read stdin (shell heredoc/pipe). Errors if stdin is a TTY and no text was given. Home fails. ACK after accept; not truncated. When `MIXCODE_TAB_TITLE` is set, plain prompts (not `/` or `!`/`!!`) get a short English preface that the text came from that MixCode tab via ctl, not the human. `--expect-response` adds the mpi-ctl skill absolute path (`<agentDir>/extensions/mpi-ctl/skills/mpi-ctl/SKILL.md`) and a `` `mpi ctl` --tab <title> send-prompt `` heredoc to send the result back; requires `MIXCODE_TAB_TITLE` and fails on `/` or `!` lines. No title (plain terminal) leaves the text unchanged. `--tab` send-keys submits use the short preface only. Editor-typed input is unchanged.
- If the target agent tab is `Not Ready`, that `ctl` command fails (`Tab is still loading extensions. Please wait a moment.`). Other tabs and Home stay usable.
- `ctl` uses the same lightweight startup path as `status` (no TUI boot, compiled binary skips materialize).
- `last-message`, `last-assistant-message`, `last-user-message`, `last-tool`, and `dump-screen` truncate stdout above 8192 bytes (preview 4096 bytes). The full text is written to `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt` (mode `0600`). Notice: `[Full output: <path>. Truncated: N lines shown (4.0KB limit)]`. `send-keys`, `send-prompt`, and `wait` are never truncated.

## Commands Subcommand

List slash commands that this workdir would register (does not start the TUI).

```bash
mpi commands
mpi commands --json --workdir ~/proj
```

- Prints `/name` plus optional `argumentHint`, then the description. Includes MixCode local commands, extension `registerCommand` names, and prompt templates. Does not list `/skill:*`.
- `--json` is an array of `{ name, usage, description, source, path? }` where `source` is `local` | `extension` | `prompt`. Extension and prompt entries set `path` to the extension/template file or package directory from Pi `sourceInfo.path`. Same-name local commands win.
- Loads extensions and skills for the workdir (same `agentDir` as the TUI). Not on the status/ctl fast path.

## Upstream Pi Delegation Rules

When argv contains `--print` or `-p`, MixCode delegates to the upstream `pi` binary on `$PATH` instead of launching the TUI:
- Environment variable `MIXCODE` is not set on delegated processes.
- Exit code from upstream `pi` is forwarded directly.
