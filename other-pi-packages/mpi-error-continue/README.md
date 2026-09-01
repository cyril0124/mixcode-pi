# mpi-error-continue

Automatically resumes an agent that stopped without finishing. Every continue is gated by a
countdown confirmation dialog, so the user can always cancel before anything is sent.

## Triggers

| Settle condition | Flow |
|---|---|
| `stopReason: "error"` (Pi built-in auto-retry did not recover) | error backoff |
| Empty response — no text, thinking, or tool calls (the "Agent finished without a response." case) | error backoff |
| Non-error stop whose last assistant block is a `thinking` block or a `toolCall` (agent stopped mid-work) | mid-work |

User-initiated aborts (`stopReason: "aborted"` or `ctx.signal.aborted` at `agent_end`) never
trigger continues, even if the last assistant still looks like mid-work.

## Error backoff

Up to **3 invisible continues** (hidden custom marker, filtered out of LLM context), then up to
**5 visible** `continue` user prompts. Status bar shows the current phase and the cumulative number
of continues sent this session:

```text
error-continue: on · total 7
error-continue: on · invisible 1/3 · total 7
error-continue: on · visible 2/5 · total 8
error-continue: on · mid-work · total 9
```

`invisible N/3` and `visible N/5` describe the current error-retry phase. `mid-work` identifies the
`continue $simple-plan` wait. `total N` counts only continues actually sent; waiting, timeout,
Esc/No cancellation, and external abort do not increase it.

## Mid-work

Sends one visible `continue $simple-plan` so the simple-plan skill is loaded on resume. One send
per stop; phase counters are not involved.

## Confirmation dialog

Each continue shows a confirm dialog before sending:

| Action | Result |
|---|---|
| Timeout (no key pressed) | Send the continue — unattended recovery is unchanged |
| `Yes` | Send immediately, skipping the rest of the countdown |
| `Esc` or `No` | Cancel. Error backoff: reset the phase counters and stop this retry loop. Mid-work: skip this one send |

Cancelling never disables the extension: the status bar keeps `error-continue: on · total N`,
clears the current phase, and `N` is not incremented. The next settle that qualifies starts a fresh
phase at invisible 1/3. Use `/error-continue off` to disable it for the session.

The dialog is the only Esc-reachable surface for this wait. By the time `agent_settled` fires, the
host has already marked the tab idle, so its Esc-abort path does not apply, and the host consumes
Esc before extension shortcut dispatch.

### Wait duration

`max(exponential backoff, 5s)` — the dialog timeout doubles as the retry backoff, and a 1s dialog
is not clickable.

| Attempt | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| invisible | 5s | 5s | 5s | — | — |
| visible | 5s | 5s | 5s | 8s | 16s |

Mid-work uses a fixed 5s.

When `ctx.hasUI` is false (print mode `-p`, JSON mode) no dialog is shown: the wait is a plain
timer and the continue is sent on elapse. Nobody can press Esc there, and the no-op UI context
resolves `confirm()` to `false`, which would otherwise be misread as a cancel.

## Commands

| Command | Effect |
|---------|--------|
| `/error-continue on` | Enable for this session (default if no state) |
| `/error-continue off` | Disable; persists in session branch |
| `/error-continue reset` | Reset retry phase and session counters; keep enabled state |

## Local load (not installed by MixCode)

```bash
pi -e ./other-pi-packages/mpi-error-continue/index.ts
# or
mpi -e ./other-pi-packages/mpi-error-continue/index.ts
```

## Test

```bash
bun test --isolate --timeout=60000 other-pi-packages/mpi-error-continue/error-continue.test.ts
```
