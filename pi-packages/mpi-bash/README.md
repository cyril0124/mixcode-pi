# mpi-bash

[中文文档](README.zh.md)

Bash execution policy: a default timeout, a foreground window, automatic detach to the background, an automatic completion notice, and `/bash-jobs` for reading a background command's full log.

The extension registers its own `bash` tool definition, built from Pi's `createBashToolDefinition` with custom `BashOperations`. Tool arguments, rendering, output truncation, `commandPrefix`, `shellPath`, and MixCode's per-spawn tab environment are unchanged — only command execution is replaced.

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
 ○ Jobs · 2 running · /bash-jobs to inspect
 ├ ⠋ 1m12s bun run check · #111
 └ ⠹ 5s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done' · #222
```

The header shows how many jobs are running and that `/bash-jobs` opens their logs. Each run is a `warning` spinner, bold `accent` elapsed time, a `dim` command, and its pid. A command too wide for the terminal is elided so every run costs exactly one line. The widget disappears when the last run finishes.

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

A detached command's log outlives it, so `/bash-jobs` can still open it; logs older than seven days are removed when a session starts. If the log cannot be written, the failure is named in the completion notice and the command keeps running.

The foreground part is replayed from memory, which is capped at 4 MB. A command that prints more than that before detaching loses its earliest output, and the log opens with `[mpi-bash] earlier output dropped`.

## `/bash-jobs`

Opens a picker of every command this session sent to the background: running ones first, then the last 50 finished ones.

```text
Background jobs
→ ● running     10s  printf "FOREGROUND-OUTPUT"; sleep 12; printf 'd…   #1258366
  ✓ exit 0      22s  bun run build                                     #1260309
  ✗ exit 1       3s  cargo test                                        #1260501
  ⏱ timeout   5m00s  pytest -k slow                                    #1260702
```

The pid doubles as the row's identity, so running the same command twice still yields two rows.

Selecting a row opens the log in a pager. It never edits the log. The only thing it can change is whether the job is still running, with `x`:

```text
┌ mpi-bash-473568.log · following 6 lines ───────────────────┐
│                                                            │
│ 1  # Command: printf "FOREGROUND-OUTPUT"; sleep 12; pri... │
│ 2  # ---                                                   │
│ 3  tick 04/24 at 21:16:43                                  │
│ 4  npm warn deprecated inflight@1.0.6: This module is not  │
│    supported, and leaks memory.                            │
│ 5  tick 06/24 at 21:16:44                                  │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  ↑↓/jk scroll  g/G top/bottom  ^e/v editor  x kill  q/esc  │
└────────────────────────────────────────────────────────────┘
```

Line numbers are the log's own. A line too wide for the panel continues on the next row with an empty gutter, so wrapping is never mistaken for new output.

| Keys | Action |
| --- | --- |
| `↓` `j` / `↑` `k` | One line |
| `Ctrl+D` / `Ctrl+U` | Half page |
| `Ctrl+F` `PgDn` `Space` / `Ctrl+B` `PgUp` | Full page |
| `g` `Home` / `G` `End` | Top / bottom |
| `Ctrl+E` `v` | Close the pager and open the log in `$VISUAL`/`$EDITOR` |
| `x` | Kill the running job, after a confirmation |
| `q` `Esc` | Close |

The pager opens on the newest output. While the command is still running it re-reads the log every second and stays pinned to the end, marked `following` in the header; scrolling up parks the view so later output cannot pull it away, and `G` returns to the end and resumes following. A finished run's log is read once.

The header carries the log's file name and the visible range (`1-21/3574`). Space goes to the name first: a narrow panel shortens `following` to `▼`, then drops the range, and truncates the name only as a last resort. A narrow panel likewise drops the middle key hints and keeps the scroll and close ones.

`x` arms a confirmation in the hint line, `kill job #<pid> and its children? y confirms, any other key cancels`. Only `y` kills. Every other key, including `q` and `Esc`, cancels and leaves the pager open. `y` sends `SIGKILL` to the whole process group, the same signal a timeout sends, and the job's usual completion notice reports the result. A finished run offers no `x`, because its pid may already belong to an unrelated process.

At most the last 200000 bytes are read into the pager, which says so in its first line when it skipped anything. `Ctrl+E` hands the log file itself to `$VISUAL`/`$EDITOR`, so the editor always sees the whole log. The TUI is suspended while the editor owns the terminal and resumes when it exits; if the editor cannot be launched, the failure is reported as a notification.

Reading a log this way costs no model context: nothing is sent to the session. The history is per tab and lives as long as the session.

## Limits

- A detached command is a process-group leader that outlives both the turn and `mpi` itself. Stop it with `kill -- -<pid>` (the pid in the handle); killing only that pid leaves the command's own children running.
- When `mpi` exits, a still-running command keeps going but no completion notice is delivered, and its `timeout` is no longer enforced. The log file keeps whatever it writes.
- Aborting a turn kills a command that is still in the foreground; a command that already detached keeps running.
- The completion notice is dropped when its session was replaced or closed while the command ran.
