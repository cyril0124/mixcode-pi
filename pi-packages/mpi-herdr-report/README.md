# mpi-herdr-report

Reports MixCode pane activity to Herdr. [中文](README.zh.md)

## Activation

The extension requires truthy `MIXCODE`, `HERDR_ENV=1`, and nonempty
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. Unset, empty, `0`, `false`, and `off`
disable `MIXCODE` after trimming and case normalization. Pure Pi stays silent.

## Lifecycle

Only sessions started with `ctx.mode === "tui"` join the pane ledger. A shutdown
without a matching TUI start does not change it. Each TUI session contributes
its busy state; `agent_settled` clears it only when `ctx.isIdle()` returns true.
The pane reports `blocked` when the host's process-wide `mpi:waiting-for-input`
count is positive, otherwise `working` if any tracked session is busy, else `idle`.

The ledger, report sequence, latest-state queue, deduplication state, notification
debounce, and exit-hook registration share one process-global object. Extension
module reloads reuse it while existing tabs remain alive. Closing the last tracked
session clears busy/waiting state and awaits an idle report.

Reports use newline-delimited socket JSON-RPC: `pane.report_agent` and
`pane.report_agent_session`, with source and agent both `mpi`. Only a complete
newline-terminated response with the matching request ID, a typed `result`, and no
`error` confirms delivery. Socket chunks are buffered until the full response arrives.
Attempts time out after 500 ms and retry once with 1500 ms. If both attempts fail,
the latest failed state's deduplication entry is cleared so a later lifecycle event
can report the same state again; failure of an older send does not clear a newer
entry. There is no background retry after these attempts: reporting is best-effort,
not durable delivery. `mpi:mark-done` sends a `notification.show` request with
sound `done`; duplicate events within 100 ms are suppressed.

The first TUI session start registers process-exit cleanup. Processes that only
load the extension or run non-TUI sessions do not release the pane on exit.
For a process that owned a TUI session, exit starts a detached
`herdr pane release-agent` child with a sequence higher than all reports allocated
by that process. `HERDR_BIN_PATH` selects the CLI executable, defaulting to `herdr`
on `PATH`. Release requires a working CLI and reachable Herdr server.

## Verification

```sh
bun test --isolate --timeout=60000 pi-packages/mpi-herdr-report/
```

The lifecycle regressions use Pi's extension loader and a local Unix socket
server, including fresh module evaluation with native import caching disabled.
They do not validate the Herdr UI or server implementation.
