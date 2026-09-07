# mpi-herdr-report

Reports MixCode pane activity to Herdr. [中文](README.zh.md)

## Activation

Requires truthy `MIXCODE`, `HERDR_ENV=1`, and nonempty `HERDR_SOCKET_PATH` and
`HERDR_PANE_ID`. For `MIXCODE`, unset, empty, `0`, `false`, and `off` disable the
extension after trimming whitespace and normalizing case. Pure Pi stays silent.

## Pane state

Only sessions started with `ctx.mode === "tui"` are tracked. Each runtime has an
independent busy flag, even when several runtimes share a session file or ID.
A shutdown without a matching TUI start has no effect.

State priority is `blocked` > `working` > `idle`. A positive process-wide count
from `mpi:waiting-for-input` means `blocked`. Otherwise, any busy runtime means
`working`; all idle means `idle`. `agent_settled` clears a runtime's busy flag
only when `ctx.isIdle()` returns true.

Every 2 seconds, the extension checks each live context's `ctx.isIdle()` and
resends the pane state. This covers activity without Agent lifecycle events,
such as manual compaction, and restores reports lost during a Herdr restart.
Stale contexts retain their last known activity until shutdown or replacement.
Tracking and delivery state are process-wide and survive module reloads.
Closing the last tracked session stops the timer, clears activity and waiting
counts, and waits for the final idle report's delivery attempts to finish.

## Delivery

Requests use newline-delimited socket JSON-RPC with source and agent both `mpi`:
`pane.report_agent` for state and `pane.report_agent_session` for session fields.
A valid acknowledgement must be a complete line with the matching request ID,
no `error`, and an object `result` containing a string `type`.

Sequences follow `max(previousSeq + 1, Date.now() * 1000)`. Herdr acknowledges
reports with stale sequences but does not apply them. Advancing with the current
time lets later refreshes overtake timestamp-based reports from newer processes.
An acknowledgement alone does not prove that Herdr applied the state.

The first attempt has a 500 ms timeout; one retry has a 1500 ms timeout. If both
fail, the latest failed state's deduplication entry is cleared so it can be sent
again. An older failure cannot clear a newer entry. Periodic refreshes continue
while TUI sessions remain live. Delivery is best-effort, with no durable queue.

`mpi:mark-done` sends `notification.show` with sound `done`. Duplicate events
within 100 ms are suppressed.

## Exit cleanup

The first TUI session registers an exit hook. Processes that only load the
extension or run non-TUI sessions do not release the pane.

On exit, the hook starts a detached `herdr pane release-agent` child with a
sequence higher than the process's pending reports. `HERDR_BIN_PATH` selects
the executable, defaulting to `herdr` on `PATH`. Cleanup requires a working CLI
and reachable Herdr server.

## Tests

```sh
bun test --isolate --timeout=60000 pi-packages/mpi-herdr-report/
```

Tests cover Pi extension loading, module re-evaluation, local Unix socket
responses, and process exit. They do not exercise the Herdr server or UI.
