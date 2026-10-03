# mpi-working-timer

[中文](README.zh.md)

Shows how long the current agent run has been working, as one footer status entry. The same package runs under bare upstream Pi and under MixCode; it uses only the public `ExtensionAPI` and `ctx.ui.setStatus`.

## Display

| State | Footer entry |
| --- | --- |
| run in flight | `⏱ <elapsed>` |
| run settled | `✔ done <duration> at <local YYYY-MM-DD HH:MM:SS>` |
| idle, or no run in this session yet | removed |

Durations floor to whole seconds and render as `7s`, `2m 05s`, or `1h 02m 03s`. The finish stamp is local time, the same shape as the transcript's `Worked for 7s · at <stamp>` line.

Under MixCode the working line already carries its own `(12s • esc to interrupt)`; the footer entry is an independent second display and both stay visible.

## Status key

The entry is written under the status key `mpi-working-timer`. Pi and MixCode both sort extension statuses by key, so its position among other extensions' entries is stable. `setStatus` is additive: sibling extensions keep their own keys, and `ctx.ui.setWorkingMessage`, the working indicator, and Pi's retry / compaction status lines are never touched.

Both hosts render the joined status line into the terminal width, so on a narrow terminal, or alongside long sibling statuses, the tail of this entry is clipped rather than wrapped. The entry takes 40 columns for durations under 10 hours and 41 at 10 hours (`✔ done 10h 00m 00s at 2026-10-03 15:39:00`).

## Lifecycle

- `session_start`: clears state and removes the entry.
- `agent_start`: stamps the clock with `??=`, so agent loops belonging to one run (auto-retry, recovery, compaction, queued continuation) keep their elapsed time.
- During a run, `turn_start`, `message_update`, `tool_execution_start`, and `tool_execution_end` refresh the text, and a 1s interval keeps the seconds moving through long silent tool calls.
- `agent_settled`: stops the interval and switches to `✔ done <duration> at <stamp>`.
- `session_shutdown`: stops the interval and removes the entry.

A run ends at `agent_settled`, not `agent_end`: Pi can continue automatically after `agent_end` (retry, recovery, compaction, queued work), and the settled total includes that work. `agent_end` is deliberately not handled.

The interval exists only while a run is in flight, is `unref()`-ed, and is replaced rather than stacked if a second `agent_start` arrives mid-run. An idle session schedules no timers and requests no renders.

## Scope

- No commands, no configuration file, no tools, no skills, no JSON Schema.
- In non-interactive modes (print / RPC) `setStatus` is a no-op, so the handlers stay side-effect free.
- Out of scope: per-turn or per-tool durations, cost and token telemetry, replacing the working indicator itself.
