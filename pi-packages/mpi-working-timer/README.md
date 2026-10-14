# mpi-working-timer

[中文](README.zh.md)

Shows elapsed run time and the restored session's last visible message time in one footer entry. Runs under Pi and MixCode using public extension and session APIs.

## Display

| State | Footer entry |
| --- | --- |
| run in flight | `⏱ <elapsed>` or `⏱ <elapsed> · <idle> idle` |
| run settled | `✔ done <duration> at <local YYYY-MM-DD HH:MM:SS>` |
| session restored, with a visible message | `✔ done at <local YYYY-MM-DD HH:MM:SS>` |
| no visible message and no completed run | removed |

The idle suffix appears once a run is in flight. It shows how long since the last streaming activity (`turn_start`, `message_update`, `tool_execution_start`, or `tool_execution_end`), resetting to zero on each event and growing during silent stretches such as long tool calls.

Durations floor to whole seconds and render as `7s`, `2m 05s`, or `1h 02m 03s`. The finish stamp is local time, the same shape as the transcript's `Worked for 7s · at <stamp>` line.

At startup, reload, resume, fork, and tree navigation, the entry uses the last visible message in the selected branch's displayed history. MixCode displays the full branch; bare Pi uses its compaction-aware `buildContextEntries()` order. Context edits affect model input only and leave the original transcript message visible.

Ordinary messages use their own millisecond `timestamp`, rather than the enclosing session entry's timestamp or the current clock. Pi converts visible custom-message entries and summary entries into messages with timestamps derived from their entry timestamps. Restored history has no recorded run duration, so the restored entry omits it.

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

Both hosts render the joined status line into the terminal width, so on a narrow terminal, or alongside long sibling statuses, the tail of this entry is clipped rather than wrapped. The entry takes 40 columns for durations under 10 hours and 41 at 10 hours (`✔ done 10h 00m 00s at 2026-10-03 15:39:00`).

## Lifecycle

- `session_start` and `session_tree`: stop any interval, reset run state, and restore the last visible message's timestamp from the selected branch. Remove the entry when no visible message with a finite timestamp exists.
- `agent_start`: stamps the clock with `??=`, so agent loops belonging to one run (auto-retry, recovery, compaction, queued continuation) keep their elapsed time.
- During a run, `turn_start`, `message_update`, `tool_execution_start`, and `tool_execution_end` refresh the text and reset the idle counter, and a 1s interval keeps both the elapsed and idle durations moving through long silent tool calls.
- `agent_settled`: stops the interval and switches to `✔ done <duration> at <stamp>`.
- `session_shutdown`: stops the interval and removes the entry.

A run ends at `agent_settled`, not `agent_end`: Pi can continue automatically after `agent_end` (retry, recovery, compaction, queued work), and the settled total includes that work. `agent_end` is deliberately not handled.

The interval exists only while a run is in flight, is `unref()`-ed, and is replaced rather than stacked if a second `agent_start` arrives mid-run. After restoring the status once, an idle session schedules no timers and requests no further renders.

## Scope

- No commands, no configuration file, no tools, no skills, no JSON Schema.
- In non-interactive modes (print / RPC) `setStatus` is a no-op, so the handlers stay side-effect free.
- Out of scope: per-turn or per-tool durations, cost and token telemetry, replacing the working indicator itself.
