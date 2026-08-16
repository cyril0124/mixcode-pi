# CLI Entrypoint, Flags & Upstream Delegation

[中文文档](cli-and-flags.zh.md)

This document describes the CLI interface, command-line arguments, and Pi delegation rules implemented in `src/cli/main.ts`.

## Synopsis

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
mpi ctl [--pid <n> | --workdir <path>] [--focus-tab <title> | --focus-session <id>] <command>
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
```

- Target: explicit `--pid` or `--workdir` (same resolve rules as `status`), not both; then `MIXCODE_PID` when set; otherwise cwd. Invalid or stale `MIXCODE_PID` values fail. Zero matches, or more than one cwd/workdir match, exits non-zero.
- Every command prints a header then a blank line: `tab:`, `session:`, and `reason:` only when no `--focus-tab`/`--focus-session` was given. `last-message` / `last-assistant-message` / `last-user-message` start each message with `----------` then `time:` (local `YYYY-MM-DD HH:MM:SS ±HH:MM`, or `unknown`) then the body. `last-message` also prints `role:` and counts both user and assistant lines. `last-tool` prints `tool:` / `status:` / optional `command:` / `time:` then the tool or `!bash` output. Optional `--from <n> --to <m>` (both required) selects a 1-based range from the end (`1` is newest; role-filtered commands count only that role) and prints oldest-first. If fewer messages exist, print what exists and add `messages: N (requested A-B)` to the header. Home last-message / last-tool commands print that header on stdout then fail on stderr.
- `wait`: block until the focused agent tab is not `running`/`thinking`, or is waiting for input (`pendingDialogs` / extension UI). Always timed: `--timeout <sec>` defaults to 60; `0` checks once. Prints `status:` (`finished` / `wait-for-input` / `error`, or `running`/`thinking` on timeout) and `timeout:`. Timeout fails after printing those lines. Home has no agent run.
- `dump-screen`: text from `renderAgentSurface` / `renderConfig` (not a PNG / tty pixel dump). Client output strips ANSI and trailing spaces by default; `--ansi` keeps color. Trailing spaces are stripped in both modes.
- `--focus-tab <title>` and `--focus-session <id>` are mutually exclusive. Title match is exact; duplicates require `--focus-session`. `--focus-session home` focuses Home.
- `send-keys`: inject tmux-style keys into the same input path as the keyboard (`Enter`, `Escape`, `Tab`, `BSpace`, arrows, `C-a`…`C-z`, `M-x`, plus literal strings). After an optional focus switch, keys hit that tab. `--literal` / `-l` disables named-key mapping.
- If any agent tab is `Not Ready`, every `ctl` command fails (`Tab is still loading extensions. Please wait a moment.`), including Home.
- `ctl` uses the same lightweight startup path as `status` (no TUI boot, compiled binary skips materialize).
- `last-message`, `last-assistant-message`, `last-user-message`, `last-tool`, and `dump-screen` truncate stdout above 8192 bytes (preview 4096 bytes). The full text is written to `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt` (mode `0600`). `send-keys` and `wait` are never truncated.

## Upstream Pi Delegation Rules

When argv contains `--print` or `-p`, MixCode delegates to the upstream `pi` binary on `$PATH` instead of launching the TUI:
- Environment variable `MIXCODE` is not set on delegated processes.
- Exit code from upstream `pi` is forwarded directly.
