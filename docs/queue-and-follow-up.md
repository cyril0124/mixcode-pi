# Steering and follow-up queues

[中文文档](queue-and-follow-up.zh.md)

MixCode separates mid-turn steering from user follow-ups. Both queues belong to the live tab session. Pending messages, round boundaries, and pause state are not persisted across restarts.

## Queue semantics

| Input | While busy | While idle |
|---|---|---|
| Ordinary prompt | Steer the current turn at the next delivery point | Start an ordinary turn without resuming paused follow-ups |
| `/follow-up <text>` | Append a batch follow-up | Start immediately if unpaused; otherwise append without resuming |
| `Alt+Enter` | Append a batch follow-up | Submit normally if unpaused; otherwise append a batch follow-up without resuming |
| `/follow-up-next <text>` | Append an exclusive follow-up round | Start immediately if unpaused; otherwise append without resuming |
| `/follow-up-next` | Resume the user follow-up queue; wait for the active turn | Resume and dispatch queued user follow-ups |

`/follow-up` requires text and reports `Error: Usage: /follow-up <message>` if it is missing. `/follow-up-next` without text reports `Error: No follow-up messages to resume` when the user follow-up queue is empty. Text prompts and explicit resume require an enabled model; queued local commands use their own command validation.

### Follow-up rounds

User follow-ups keep FIFO insertion order. Adjacent batch entries from `/follow-up` or `Alt+Enter` run together in one round. Each `/follow-up-next <text>` entry occupies its own round and separates the batches before and after it. It does not jump ahead of earlier messages.

```text
Enqueue: batch A, batch B, next C, batch D
Run:     [A + B] -> [C] -> [D]
Round:      1       2      3
```

After the current agent run becomes idle, MixCode dispatches one user round. A successful completion permits the next round. A round means a complete agent run, including its tool loop, not one model response or tool call.

### Queued slash commands

Both `/follow-up /color red` and `/follow-up-next /color red` execute the MixCode local command when it reaches the queue head, on the tab that queued it even if focus has changed. Local commands form separate queue steps and are never merged with neighboring text or sent to the model. Their existing confirmations and validation still apply. A thrown command error pauses the remaining queue; the failed command is not automatically repeated. Ctrl+U restores the original follow-up prefix for queued commands.

For `/close-session`, `/delete-session`, `/close-all-sessions`, and `/delete-all-sessions`, the queue waits for confirmation and the confirmed operation, including persistence. Cancelling consumes that command and pauses the remaining tasks. Replacing the dialog with another overlay, including quit confirmation, also cancels queued confirmations waiting for its shared slot. Queued confirmations from different tabs share one dialog slot; a single-session dialog focuses its owning tab when displayed. Other local commands retain their handler completion semantics, including selectors that return after opening.

Registered extension commands, `/skill:<name>`, and named prompt templates form separate queue steps, so adjacent ordinary text never becomes command arguments. They retain Pi SDK dispatch and expansion. Both follow-up wrappers preserve internal whitespace and newlines in their payload.

Reloading extensions or changing the workdir retains the live queue and transfers dispatch to the rebuilt SDK session. Closing or clearing the owning conversation discards its remaining tasks.

### Pause and resume

`Esc` or a final agent failure pauses the entire remaining user follow-up queue. Messages stay visible and retain their order and round boundaries. Tool errors and recoverable retries do not pause the queue.

Only `/follow-up-next` without text explicitly resumes paused follow-ups. An ordinary prompt, `/follow-up <text>`, `/follow-up-next <text>`, or `Alt+Enter` does not clear the pause. Resuming during an active run waits until that run becomes idle.

Steering remains separate: `Esc` flushes pending steering into an immediate turn. During compaction, steering waits for compaction to finish and `Esc` interrupts compaction instead. Neither action resumes paused user follow-ups.

### Editing queued messages

`Ctrl+U` uses the visible queue state:

- Exactly one non-empty queue: pop its newest message into the editor.
- Both queues non-empty: arm a one-second choice without changing either queue. Press `S` for Steer, `F` for Follow-up, or `Esc` to cancel.
- Both queues empty: arm Vim entry; press `u` or `Ctrl+U` within one second.

A choice never falls back to the other queue if the selected queue becomes empty before confirmation. Popping a `next` entry restores `/follow-up-next <text>` to the editor so resubmitting preserves its exclusive-round intent. Popping does not resume the queue.

## Runtime ownership and concurrency

`MixCodeTabInfo.followUpQueue` stores user entries as `{ text: string, kind: "batch" | "next", command?: boolean }`; `followUpsPaused` gates their dispatch. `pendingFollowUps` is the display aggregate: local user texts first, followed by SDK follow-up texts.

The SDK follow-up mode remains `all`. Extensions' companion messages and internal continuations stay in the SDK queue and keep their SDK delivery behavior; user round boundaries and pause state do not reclassify them. The TUI labels these entries `SDK`, without assigning user round numbers.

`dispatchTurn` serializes prompt preflight through the tab's `promptDispatchGate`, releasing it when preflight completes or fails. This prevents rapid submissions from racing through the busy-state check. User follow-up dispatch waits for the active agent run to become idle.

## TUI queue display

Steer and Follow-up share the chat tail above the editor, each in its own box. Each box shows its count and at most the latest five messages.

- User follow-ups show `Round N`; adjacent batch entries share a number, and exclusive entries also show `next`. Numbers are relative to the full pending user queue, even when older entries are outside the five-message preview.
- A paused Follow-up box shows `Paused · /follow-up-next to resume` on a separate line.
- A single non-empty queue shows `Ctrl+U->edit`. With both queues populated, Steer shows `Ctrl+U,S->edit` and Follow-up shows `Ctrl+U,F->edit`.
- Steer shows `Esc->send now` unless compaction is active. Follow-up never shows this hint.
