# mpi-bash

[中文文档](README.zh.md)

Bash execution policy: a default timeout, a foreground window, automatic detach to the background, an automatic completion notice, and `/bash-logs` for reading a background command's full log.

The extension registers `bash` through Pi's `createBashToolDefinition` with custom `BashOperations`. It uses Pi's tool parameters, rendering, and output truncation, honors `commandPrefix` and `shellPath`, and passes MixCode's per-spawn tab environment.

## Behavior

| Phase | What happens |
| --- | --- |
| `0` → foreground window | Output streams into the transcript as the command produces it. |
| Command ends first | The tool result carries its output and exit code, matching Pi's builtin bash. |
| Window expires | The command keeps running in the background. The tool result gains a handle (pid + log path) and succeeds, so the turn continues. |
| Background command writes nothing | After 60s of log silence a `bash-detached-stall` message asks the model to check on the job; see [Stall reminders](#stall-reminders). |
| Background command ends | After the log stream finishes or fails, a `bash-detached-exit` message carries the exit code and last output. It uses `steer` while the model is busy and starts a turn when idle. |
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

Every detach, completion, and stall notice includes `Still running: N jobs · PIDs: ... · at notification time`. This is a snapshot of this session's detached commands, oldest first; foreground commands and other sessions are excluded. A newly detached command is included, and a command removed from the running list after exit/stdio drain is excluded even while its log is flushing. With no remaining jobs the footer reads `Still running: 0 jobs · at notification time`, without a PID list.

The model text and chat use the same send-time snapshot. Long PID lists wrap in the chat without dropping entries; old notices do not change when jobs finish. A batch of stall reminders has one shared footer, including jobs that are still producing output. The live widget remains the current-state view.

When a background command ends, the chat shows a `Background job finished · PID <pid>` heading, how long it ran, the command, and, if there is output, a rule then the last 10 lines with their log line numbers. Earlier output is marked `… N lines omitted (full log at <path>)`.

The model receives XML-style completion messages. The formatter escapes `&`, `<`, and `>` in commands, paths, errors, and output so those values cannot close or add elements.

A successful command sets `outcome="success"`.

```xml
<bash_completion job_id="109" outcome="success">
  <summary>Background job #109 succeeded after 22s.</summary>
  <command>bun run build</command>
  <exit_code>0</exit_code>
  <log_path>/tmp/mpi-bash-109-1.log</log_path>
  <output truncated="false">Build complete.</output>
  <logs_hint>Read /tmp/mpi-bash-109-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 2 jobs · PIDs: 111, 222 · at notification time</running_jobs>
</bash_completion>
```

A non-zero exit sets `outcome="failure"`.

```xml
<bash_completion job_id="108" outcome="failure">
  <summary>Background job #108 failed with exit code 2 after 3s.</summary>
  <command>cargo test</command>
  <exit_code>2</exit_code>
  <log_path>/tmp/mpi-bash-108-1.log</log_path>
  <output truncated="false">FAILED tests/retry.rs</output>
  <logs_hint>Read /tmp/mpi-bash-108-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 1 job · PIDs: 111 · at notification time</running_jobs>
</bash_completion>
```

A background command killed by its timeout sets `outcome="timeout"`.

```xml
<bash_completion job_id="107" outcome="timeout">
  <summary>Background job #107 timed out after 5m00s.</summary>
  <command>pytest -k slow</command>
  <log_path>/tmp/mpi-bash-107-1.log</log_path>
  <output truncated="false"></output>
  <logs_hint>Read /tmp/mpi-bash-107-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 0 jobs · at notification time</running_jobs>
</bash_completion>
```

An unknown exit also uses `outcome="failure"`. The formatter omits `<exit_code>` when the process provides no code, adds `<log_error>` when it cannot write the complete log, and sets `<output truncated="true">` when it keeps only the last 2000 bytes. The chat renderer reads `details` and does not display the XML body:

```text
 Background job finished · PID 1258366
 ✓ 12s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done'
 ────────────────────────────────
 … 16 lines omitted (full log at /tmp/mpi-bash-1258366-1.log)
 24 │ tick 23/24 at 21:16:43
 25 │ tick 24/24 at 21:16:44
 26 │ done
 Still running: 2 jobs · PIDs: 111, 222 · at notification time

 Background job finished · PID 108
 ✗ 3s cargo test                                            1
 ────────────────────────────────
 18 │ FAILED tests/retry.rs
 Still running: 1 job · PIDs: 111 · at notification time

 Background job finished · PID 107
 ⏱ 5m00s pytest -k slow                               timeout
 Still running: 0 jobs · at notification time
```

Completion `details` carries `id` for the child PID and `runningPids: number[]` for the snapshot; the count is the array length. Stall `details` is `{ jobs: StallDetails[], runningPids: number[] }`. Stored completion messages without `id`/`runningPids`, and stored stall messages containing only `StallDetails[]`, still render without inventing a running count.

## Stall reminders

Stall reminders report background commands whose logs have stopped changing. Total runtime does not determine whether a reminder is due.

The check interval is one quarter of the silence window, clamped to 500ms-15s. Logs are checked only while the session is idle. While busy, timer ticks set a single pending check. Pi's `agent_settled` event runs that check after queued continuations, retries, and compaction finish. Each session runs at most one check at a time.

Silence is measured from the log's mtime. The reminder interval changes as follows:

| Condition | Result |
| --- | --- |
| Silence below `MPI_BASH_STALL_SECONDS` (default 60s) | No reminder. |
| Silence reaches the threshold | Reminder becomes due at the next idle check. |
| Reminder delivered | Next wait doubles: 2m, 4m, 8m, 16m... with the default threshold. |
| New output | Wait resets to `MPI_BASH_STALL_SECONDS`. |

The chat panel uses the completion panel's layout, with the silence where a finished job shows its exit code:

```text
 Background job stalled · PID 1258366
 ⏳ 8s printf 'connecting to build-box...'; sleep 45; …           silent 6s
 ────────────────────────────────
 connecting to build-box...
 Still running: 2 jobs · PIDs: 1258366, 1258367 · at notification time
```

The model receives `<bash_stall>`. It includes the job ID, command, silence duration, total runtime, up to the last three non-empty lines from the final 2000 bytes of log output, and commands to inspect the log or stop the process. A line may be partial when the tail starts mid-line:

```xml
<bash_stall job_id="1258366">
  <summary>Background job #1258366 may be stuck after 5m02s of silence.</summary>
  <command>ssh build-box make release</command>
  <silence>5m02s</silence>
  <elapsed>8m14s</elapsed>
  <log_path>/tmp/mpi-bash-1258366-1.log</log_path>
  <output>Compiling serde v1.0.219</output>
  <logs_hint>Use tail -n 50 /tmp/mpi-bash-1258366-1.log to inspect recent output.</logs_hint>
  <stop_hint>Use kill -- -1258366 to stop the whole process group.</stop_hint>
  <action_hint>Ignore this event if long periods without output are expected for this command.</action_hint>
</bash_stall>

  <running_jobs>Still running: 2 jobs · PIDs: 1258366, 1258367 · at notification time</running_jobs>
```

The shared `<running_jobs>` element follows all `<bash_stall>` elements in the message.

Before sending a `followUp` reminder, the extension rechecks that the session is idle and the jobs are running. The idle check reads current log state; reminder text is not queued during a busy period. If the session becomes busy during a log read, delivery waits without advancing the reminder interval. Jobs still due share one message and one model turn. Shutdown cancels pending checks.

A job whose log cannot be read, from an unwritable tmpdir or a log the user deleted, is never reported this way. Its completion notice still arrives.

## Background output

A command that finishes in the foreground never touches the disk: its whole output is in the tool result. When a command detaches, everything it printed so far is flushed to `<tmpdir>/mpi-bash-<pid>-<n>.log` and the rest is appended there, so that file is the single complete record:

| Where | Holds |
| --- | --- |
| Tool result | Output up to the detach point. It is finalized there and never grows again. |
| `<tmpdir>/mpi-bash-<pid>-<n>.log` | **Everything**, foreground part included. Read it to see the full output. |
| Completion notice | The last 2000 bytes, plus the log path. |

After the process exits and stdout/stderr have drained, it leaves the running list. `/bash-logs` disables termination while the log finishes writing. The completion notice is sent after the log stream finishes or fails. At delivery, the log is fully written or the notice contains `logError`. Command elapsed time excludes this write wait.

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

The preview starts at the newest output. A live or flushing log is re-read every second and stays pinned to the end (`following`). Scroll up to park. `G` jumps to the end and follows again. Once the log has finished flushing, the preview takes one final read and stops refreshing.

The hint under the preview is the visible range, like `1-21/3574`. If the overlay is too narrow, it drops hints from the middle.

Press `x` and the hint becomes `kill job #<pid> and its children? y confirms, any other key cancels`. Only `y` sends `SIGKILL` to the process group, the same signal a timeout uses. The usual completion notice reports the result. `q`, `Esc`, `j`, `k`, and every other key cancel and leave the overlay open. Finished jobs have no `x`. Their pid may already belong to something else.

The preview loads at most the last 200000 bytes. If it skipped earlier output, the first line says so. `Ctrl+E` or `v` closes the overlay and opens the log file in `$VISUAL`/`$EDITOR`. The TUI stops while the editor runs and starts again when it exits. If the editor cannot start, a notification names the failure.

`/bash-logs` does not send log text to the model. History is per tab and lasts for the session.

## Limits

- A detached command is a process-group leader that outlives both the turn and `mpi` itself. Stop it with `kill -- -<pid>` (the pid in the handle); killing only that pid leaves the command's own children running.
- When `mpi` exits, a still-running command keeps going but no completion notice is delivered, and its `timeout` is no longer enforced. The log file keeps whatever it writes.
- Aborting a turn kills a command that is still in the foreground; a command that already detached keeps running.
- The completion notice is dropped when its session was replaced or closed while the command ran.
