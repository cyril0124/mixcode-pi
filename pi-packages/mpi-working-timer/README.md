# mpi-working-timer

[中文](README.zh.md)

Shows elapsed run time, average assistant-message duration, and the restored session's last visible message time in one footer entry. Runs under Pi and MixCode using public extension and session APIs.

## Display

| State | Footer entry |
| --- | --- |
| run in flight, no assistant message started | `⏱ <elapsed>` or `⏱ <elapsed> · <idle> idle` |
| run in flight, with an active or completed assistant message | `⏱ 12s · avg 4s/msg · 2s idle` |
| run settled, no completed assistant messages | `✔ done <duration> at <local YYYY-MM-DD HH:MM:SS>` |
| run settled, with completed assistant messages | `✔ done 18s · avg 4s/msg at 2026-10-03 15:39:00` |
| session restored, with a visible message | `✔ done at <local YYYY-MM-DD HH:MM:SS>` |
| no visible message and no completed run | removed |

The idle suffix appears once a run is in flight. It shows how long since the last streaming activity (`turn_start`, `message_update`, `tool_execution_start`, or `tool_execution_end`), resetting to zero on each event and growing during silent stretches such as long tool calls.

`avg` is the mean assistant-message duration in the current run. It combines the measured durations from assistant `message_start` to `message_end` with the elapsed time of the currently streaming assistant message, counting that active message once. Streaming updates and the 1s ticker refresh the value; tool execution between assistant messages and time before streaming starts do not increase it.

A new run clears the previous average, and the first assistant `message_start` shows `avg 0s/msg`. Retry, recovery, compaction, and queued continuations before `agent_settled` keep the same run's average. At settlement, only completed messages remain in the average; an unfinished message is discarded. Measurements stay in memory and are cleared on reload or branch navigation.

Starting another assistant message adds a sample with zero elapsed time, so the average can initially decrease. The mean is calculated in milliseconds and then floored to whole seconds; consecutive refreshes can therefore display the same value.

All durations floor to whole seconds and render as `7s`, `2m 05s`, or `1h 02m 03s`. The finish stamp is local time, the same shape as the transcript's `Worked for 7s · at <stamp>` line.

At startup, reload, resume, fork, and tree navigation, the entry uses the last visible message in the selected branch's compaction-aware displayed history. The fork places a leading compaction summary between retained history and later entries; bare Pi leaves it at the head of `buildContextEntries()`. Context edits affect model input only and leave the original transcript message visible.

Ordinary messages use their own millisecond `timestamp`, rather than the enclosing session entry's timestamp or the current clock. Pi converts visible custom-message entries and summary entries into messages with timestamps derived from their entry timestamps. Restored history has no recorded run duration or average, so the restored entry omits both.

Hidden custom messages (`display: false`), system messages, state-only entries, and messages with no visible content or container are excluded.

The visibility checks follow each host's transcript rules:

| Message | MixCode | Bare Pi |
| --- | --- | --- |
| empty redacted thinking | visible placeholder | hidden |
| user image without text | visible image | hidden |
| assistant error, abort, or truncation without content | hidden in restored chat | visible notice |
| tool result | updates any preceding call row, including repeated results | updates a pending call once; calls from aborted/error assistants and calls outside the displayed history do not match |

Under MixCode the working line already carries its own `(12s • esc to interrupt)`; the footer entry is an independent second display and both stay visible.

## Status key

The entry is written under the status key `mpi-working-timer`. Pi and MixCode both sort extension statuses by key, so its position among other extensions' entries is stable. `setStatus` is additive: sibling extensions keep their own keys, and `ctx.ui.setWorkingMessage`, the working indicator, and Pi's retry / compaction status lines are never touched.

Both hosts render the joined status line into the terminal width, so on a narrow terminal, or alongside long sibling statuses, the tail of this entry is clipped rather than wrapped. Without an average, the entry takes 40 columns for durations under 10 hours and 41 at 10 hours (`✔ done 10h 00m 00s at 2026-10-03 15:39:00`). With an average, the entry is longer; `avg` precedes the idle suffix or finish timestamp so it remains visible longer when the tail is clipped.

## Lifecycle

State and tickers are keyed by session id: one extension instance can observe several sessions (MixCode reuses extension services for in-tab session replacement), so a run started for one session never renders into another or stops another session's ticker. `session_shutdown` deletes only its own state.

- `session_start` and `session_tree`: stop any interval, reset run state and the in-memory average, and restore the last visible message's timestamp from the selected branch. Remove the entry when no visible message with a finite timestamp exists.
- `agent_start`: clears measurements when a new run starts. Stamps the clock with `??=`, so agent loops belonging to one run (auto-retry, recovery, compaction, queued continuation) keep their elapsed time and average.
- Assistant `message_start` adds a live sample to the average. A matching `message_end` commits its duration without counting it twice. Other message roles do not affect it.
- During a run, `turn_start`, `message_update`, `tool_execution_start`, and `tool_execution_end` refresh the text and reset the idle counter. A 1s interval keeps both the elapsed and idle durations moving through long silent tool calls.
- `agent_settled`: stops the interval and switches to `✔ done <duration> at <stamp>`.
- `session_shutdown`: stops the interval and removes the entry.

A run ends at `agent_settled`, not `agent_end`: Pi can continue automatically after `agent_end` (retry, recovery, compaction, queued work), and the settled total includes that work. `agent_end` is deliberately not handled.

The interval exists only while a run is in flight, is `unref()`-ed, and is replaced rather than stacked if a second `agent_start` arrives mid-run. After restoring the status once, an idle session schedules no timers and requests no further renders.

## Scope

- No commands, no configuration file, no tools, no skills, no JSON Schema.
- In non-interactive modes (print / RPC) `setStatus` is a no-op, so the handlers stay side-effect free.
- Out of scope: per-turn or per-tool durations, cost and token telemetry, replacing the working indicator itself.
