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
| Dequeue Key | `Ctrl+U` when Follow-up is empty; `Ctrl+U,S` when both queues contain messages | `Ctrl+U` when Steer is empty; `Ctrl+U,F` when both queues contain messages |

### Editing Queued Messages

`Ctrl+U` uses the visible queue state:

- Exactly one non-empty queue: pops its newest message directly into the editor.
- Both queues non-empty: arms a one-second choice without changing either queue. Press `S` for Steer, `F` for Follow-up, or `Esc` to cancel.
- Both queues empty: arms Vim entry; press `u` or `Ctrl+U` within one second.

A queue choice never falls back to the other queue if the selected queue becomes empty before confirmation.

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
- With one non-empty queue, its edit hint is `Ctrl+U->edit`.
- With both queues non-empty, Steer shows `Ctrl+U,S->edit` and Follow-up shows `Ctrl+U,F->edit`.
- Steer also shows `Esc->send now`; Follow-up does not because it survives interruption.
