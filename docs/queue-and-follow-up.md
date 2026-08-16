# Steering & Follow-up Queue Management

[中文文档](queue-and-follow-up.zh.md)

MixCode Pi provides dual-queue execution semantics for queuing messages while an agent is busy: **Steering** (mid-turn steering) and **Follow-up** (next-turn queue).

## Design Motivation

When an agent is actively streaming output or executing a multi-tool loop, user inputs have distinct intentions that single-queue models conflate:
1. **Urgent Intervention (Steer)**: The user spots an incorrect command or wrong file and needs the agent to pivot immediately without throwing away work already accomplished.
2. **Queued Next Step (Follow-up)**: The user wants to plan the next phase of work (e.g. "now run tests") to execute cleanly only after the current agent step completes.

MixCode separates these into dedicated queues with distinct lifecycle, delivery, and persistence rules.

## Queue Semantics

```text
User Submits Message While Agent Is Running
   │
   ├─ Regular Prompt ───────────> Steer Queue (Mid-turn injection)
   │                                 │
   │                                 ├─ Injected into current model context on next tool completion
   │                                 └─ `Esc` → Flushes / sends immediately
   │
   └─ `/follow-up <text>` ──────> Follow-up Queue (Post-turn dispatch)
                                     │
                                     └─ Survives `Esc` / abort; dispatched as fresh prompt when idle
```

### Differences at a Glance

| Feature | Steer Queue | Follow-up Queue |
|---|---|---|
| Command / Trigger | Regular Prompt (while running) | `/follow-up <text>` |
| Ingestion Point | Mid-turn context injection | Fresh user prompt turn after `waitForIdle` |
| Interruption Behavior (`Esc`) | Flushes to start turn immediately | Preserved across turns and aborts |
| Dequeue Key | `Ctrl+U` (pops newest back into editor) | `Ctrl+U` (pops newest back into editor) |

## Concurrency Protection (`dispatchTurn`)

To prevent multiple `prompt()` invocations from racing through `isStreaming` state checks during rapid transitions:

```text
dispatchTurn(tab, send)
   │
   ├─ Acquires tab.promptDispatchGate (Promise.withResolvers)
   ├─ Executes send() with preflightResult signal
   └─ Releases gate once prompt preflight completes or errors
```

## TUI Queue Rendering

Queued items render directly above the prompt editor in distinctive themed borders:
- `┌ Steer ─┐`: Displays queued steering messages with `Esc->send now` and `Ctrl+U->edit` hints.
- `┌ Follow-up ─┐`: Displays pending next-turn follow-ups.
