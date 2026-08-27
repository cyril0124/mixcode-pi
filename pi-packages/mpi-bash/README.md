# mpi-bash

[中文文档](README.zh.md)

Bash execution policy: a default timeout, a foreground window, automatic detach to the background, an automatic completion notice, and `/bash-logs` for reading a background command's full log.

The extension registers its own `bash` tool definition, built from Pi's `createBashToolDefinition` with custom `BashOperations`. Tool arguments, rendering, output truncation, `commandPrefix`, `shellPath`, and MixCode's per-spawn tab environment stay as Pi left them. Only command execution changes.

## Behavior

| Phase | What happens |
| --- | --- |
| `0` → foreground window | Output streams into the transcript as the command produces it. |
| Command ends first | The tool result carries its output and exit code, matching Pi's builtin bash. |
| Window expires | The command keeps running in the background. The tool result gains a handle (pid + log path) and succeeds, so the turn continues. |
| Background command writes nothing | After 60s of log silence a `bash-detached-stall` message asks the model to check on the job; see [Stall reminders](#stall-reminders). |
| Background command ends | A `bash-detached-exit` message with the exit code and the last output is appended to the session and **starts a new turn**. |
| `timeout` reached | The command's process group is killed, in the foreground (Pi's `Command timed out after N seconds` error) or in the background (reported in the completion notice). |

`timeout` bounds the command's total life, foreground plus background. When the model passes a `timeout` shorter than the foreground window, the command is killed before it can ever detach.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MPI_BASH_FOREGROUND_SECONDS` | `30` | Foreground blocking window in seconds. `0` disables detaching entirely: bash blocks until the command ends or its timeout kills it. A non-numeric or negative value fails loudly at session start. |
| `MPI_BASH_STALL_SECONDS` | `60` | Log silence before the first [stall reminder](#stall-reminders); later reminders double it. `0` disables stall reminders entirely. A non-numeric or negative value fails loudly when the extension loads. |

The injected default `timeout` is `300` seconds and applies only when the model omits `timeout`.

## Visibility

While at least one command runs in the background, a widget above the editor lists them as a tree, oldest first:

```text
 ○ Jobs · 2 running · /bash-logs to inspect
 ├ ⠋ 1m12s bun run check · #111
 └ ⠹ 5s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done' · #222
```

The header shows how many jobs are running and that `/bash-logs` opens their logs. Each run is a `warning` spinner, bold `accent` elapsed time, a `dim` command, and its pid. A command too wide for the terminal is elided so every run costs exactly one line. The widget disappears when the last run finishes.

When a background command ends, the chat shows a `Background job finished` heading, how long it ran, the command, and, if there is output, a rule then the last 10 lines with their log line numbers. Earlier output is marked `… N lines omitted (full log at <path>)`.

```text
 Background job finished
 ✓ 12s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done'
 ────────────────────────────────
 … 16 lines omitted (full log at /tmp/mpi-bash-1258366-1.log)
 24 │ tick 23/24 at 21:16:43
 25 │ tick 24/24 at 21:16:44
 26 │ done

 Background job finished
 ✗ 3s cargo test                                            1
 ────────────────────────────────
 18 │ FAILED tests/retry.rs

 Background job finished
 ⏱ 5m00s pytest -k slow                               timeout
```

## Stall reminders

Between the detach notice and the exit notice the model hears nothing, so nothing surfaces a hung command until its timeout kills it. Reminders track silence, not age. A build that streams output for ten minutes is healthy and costs no turn; a log that stopped growing is what gets reported.

A running job's log is stat'ed every quarter of the silence window, at most every 15s. Silence runs from the log's mtime, and each reminder doubles the wait for the next one, so a job hung for hours produces a handful of reminders instead of one a minute:

| Silence | What happens |
| --- | --- |
| < `MPI_BASH_STALL_SECONDS` (60s) | Nothing. |
| 60s | First reminder. |
| then | 2m, 4m, 8m, 16m... of silence, doubling with every reminder. |
| any new output | The ladder resets: the next reminder needs a fresh 60s of silence. |

The chat panel uses the completion panel's layout, with the silence where a finished job shows its exit code:

```text
 Background job stalled
 ⏳ 8s printf 'connecting to build-box...'; sleep 45; …           silent 6s
 ────────────────────────────────
 connecting to build-box...
```

What the model receives names the job, how long it has been silent, how long it has run, its last three lines of output, and the commands to inspect or kill it:

```text
[mpi-bash] Background job #1258366 has written nothing for 5m02s (running 8m14s) and may be stuck.
Command: ssh build-box make release
Its last output:
  Compiling serde v1.0.219
Check it with `tail -n 50 /tmp/mpi-bash-1258366-1.log`, stop it with `kill -- -1258366` (the whole process group).
If this command is expected to be silent for this long, ignore this notice and continue with your work.
```

Delivery is `followUp`, so a silent job never cuts into a running turn. On an idle session it does start one, and the model decides to wait or kill instead of blocking until the timeout. Jobs that come due in the same check share one message and one turn.

A job whose log cannot be read, from an unwritable tmpdir or a log the user deleted, is never reported this way. Its completion notice still arrives.

## Background output

A command that finishes in the foreground never touches the disk: its whole output is in the tool result. When a command detaches, everything it printed so far is flushed to `<tmpdir>/mpi-bash-<pid>-<n>.log` and the rest is appended there, so that file is the single complete record:

| Where | Holds |
| --- | --- |
| Tool result | Output up to the detach point. It is finalized there and never grows again. |
| `<tmpdir>/mpi-bash-<pid>-<n>.log` | **Everything**, foreground part included. Read it to see the full output. |
| Completion notice | The last 2000 bytes, plus the log path. |

A detached command's log outlives it, so `/bash-logs` can still open it; logs older than seven days are removed when a session starts. If the log cannot be written, the failure is named in the completion notice and the command keeps running.

The foreground part is replayed from memory, which is capped at 4 MB. A command that prints more than that before detaching loses its earliest output, and the log opens with `[mpi-bash] earlier output dropped`.

## `/bash-logs`

`/bash-logs` lists this session's background commands. Running jobs come first, then the last 50 that finished. The top of the overlay is the list. The bottom is a live tail of the selected log, about 60% of the terminal height. Rows are keyed by pid, so running the same command twice gives two rows.

```text
╭ 2/4 running ── Bash logs ─────────────────────────────────────────╮
│> ● running     10s  #111  printf "FOREGROUND-OUTPUT"; sleep 12    │
│  ✓ exit 0      22s  #109  bun run build                           │
│  ✗ exit 1       3s  #108  cargo test                              │
│  ⏱ timeout   5m00s  #107  pytest -k slow                          │
│───────────────────────────────────────────────────────────────────│
│  24  tick 23/24 at 21:16:43                                       │
│  25  tick 24/24 at 21:16:44                                       │
│  26  Compiling serde v1.0.219                                     │
│  following  24-31/40  (J/K scroll)                                │
├───────────────────────────────────────────────────────────────────┤
│  j/k move  J/K scroll  g/G top/bot  ^e editor  x kill  q close    │
╰───────────────────────────────────────────────────────────────────╯
```

The overlay is read-only except `x`, which kills a still-running job. Line numbers come from the log. A long line wraps onto the next row with an empty gutter.

| Keys | Action |
| --- | --- |
| `j` / `k` | Next / previous job |
| `J` / `K` | Preview down / up one line |
| `↓` / `↑` | Preview down / up one line |
| `Ctrl+D` / `Ctrl+U` | Preview half page |
| `Ctrl+F` `PgDn` `Space` / `Ctrl+B` `PgUp` | Preview full page |
| `g` `Home` / `G` `End` | Preview top / bottom |
| `Ctrl+E` `v` | Close the overlay and open the selected log in `$VISUAL`/`$EDITOR` |
| `x` | Kill the selected running job, after a confirmation |
| `q` `Esc` | Close |

The preview starts at the newest output. A live job is re-read every second and stays pinned to the end (`following`). Scroll up to park. `G` jumps to the end and follows again. A finished job is read once.

The hint under the preview is the visible range, like `1-21/3574`. If the overlay is too narrow, it drops hints from the middle.

Press `x` and the hint becomes `kill job #<pid> and its children? y confirms, any other key cancels`. Only `y` sends `SIGKILL` to the process group, the same signal a timeout uses. The usual completion notice reports the result. `q`, `Esc`, `j`, `k`, and every other key cancel and leave the overlay open. Finished jobs have no `x`. Their pid may already belong to something else.

The preview loads at most the last 200000 bytes. If it skipped earlier output, the first line says so. `Ctrl+E` or `v` closes the overlay and opens the log file in `$VISUAL`/`$EDITOR`. The TUI stops while the editor runs and starts again when it exits. If the editor cannot start, a notification names the failure.

`/bash-logs` does not send log text to the model. History is per tab and lasts for the session.

## Limits

- A detached command is a process-group leader that outlives both the turn and `mpi` itself. Stop it with `kill -- -<pid>` (the pid in the handle); killing only that pid leaves the command's own children running.
- When `mpi` exits, a still-running command keeps going but no completion notice is delivered, and its `timeout` is no longer enforced. The log file keeps whatever it writes.
- Aborting a turn kills a command that is still in the foreground; a command that already detached keeps running.
- The completion notice is dropped when its session was replaced or closed while the command ran.
