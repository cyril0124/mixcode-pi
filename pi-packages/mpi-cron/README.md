# mpi-cron

[中文文档](README.zh.md)

Schedule prompts from any MixCode tab. Jobs belong to a working directory, not to a session, so a job created by another tab, by a subagent, or before a restart keeps firing. The widget shows the jobs this tab created, plus jobs a subagent created; `/cron` lists every job in the directory.


## Surfaces

| Surface | Purpose |
|---|---|
| `cron` tool | Agents create, list, update, remove, enable/disable, fire, and clean up jobs. |
| `/cron` | Management overlay: filtered job list with schedule, run count, and last-run age; an inline create wizard; job detail with the prompt, pause/resume, fire now, remove, cleanup. |
| `/cron stop <id\|name>` | Remove a job by id or name without opening the overlay. Tab-completion lists active jobs. |
| Widget | `belowEditor` dock showing this tab's own jobs and subagent-created jobs, with status, schedule, time to next run, and run count. Hidden while it has none to show. |
| Transcript marker | Every finished run appends a `scheduled_prompt` entry to the session that received the prompt, with the run outcome. |

The widget and the list share one set of run-state glyphs: `~` running, `!` the last run failed, `*` enabled, `x` paused.

## Schedule formats

Times are local; a 5-field expression means second 0.

| Form | Examples | Notes |
|---|---|---|
| Cron, 5 fields | `0 9 * * *`, `*/15 * * * *`, `0 9-17 * * MON-FRI` | `*`, `n`, `n-m`, `n-m/s`, `*/s`, comma lists, month and day names. Day-of-month and day-of-week are OR'ed when both are restricted, as in cron. |
| Cron, 6 fields | `0 */5 * * * *`, `*/10 * * * * *` | Leading seconds field. |
| Interval | `5m`, `every 2h`, `90s` | Anchored to the epoch grid: fire times are multiples of the interval, so a restart or another tab does not shift them. |
| Relative | `+30s`, `+5m`, `+2h`, `+1d` | Fires once, then the job disables itself. |
| ISO timestamp | `2026-09-23T09:00:00Z`, `2026-09-23 09:00` | A value without a timezone designator is local time. Fires once, then disables. |

## Job ownership and the exactly-once claim

```text
tab A ─┐
tab B ─┼─► module-level hub (one per process) ─► timer per enabled job
child ─┘         │
                 ▼  fire
     <cwd>/.pi/cron/jobs.json   claim(id, token) under an exclusive lock
                 │
        winner ──┴── loser: token already stored, run skipped
```

- The store is `<cwd>/.pi/cron/jobs.json`, written through a `<jobs.json>.lock` sidecar and an atomic rename, so concurrent tabs and separate `mpi` processes never interleave a read-modify-write.
- A fire claims the job with a token (the planned fire time for timer runs). The hub writes the claim before it delivers the prompt, so a second tab or a second process sees the token and skips the run. A claim is also refused when the stored `nextRun` has already moved past the tick being fired, so a plan that went stale while a peer ran the same tick cannot deliver it twice.
- A claim left behind by a crashed run is recoverable once it is 30 minutes old; until then the job stays claimed. A crash can therefore delay a run, not drop it.
- A run with no live session still records its outcome in the store and keeps the schedule moving.

## Delivery

- The prompt is injected with `expandPromptTemplates`, so a job may hold `/command`, `$skill`, or a prompt template, exactly like typed input.
- A busy agent receives the prompt as a follow-up instead of losing it.
- Delivery prefers the session that created the job, so a run reports back to the tab where it was set up; otherwise it goes to the first interactive tab. A subagent session is never a delivery target, because subagent sessions do not register.
- One run reaches one session: the store claim picks the delivering process first, and that process picks the target above.

## Subagent sessions

`pi-subagents` names a child session `<type>#<8 characters>`. A session with that name may create and read jobs. The job lands in the parent directory's store and appears in the interactive tabs' widgets, but that session owns no timers and no widget.

## Tool actions

| Action | Required parameters | Notes |
|---|---|---|
| `add` | `schedule`, `prompt` | Optional `name`, `description`. Refused from inside a fired prompt, which prevents a job from scheduling its own chain. |
| `list` | none | Summarises every job in this directory. |
| `update` | `jobId` | Any of `name`, `description`, `prompt`, `schedule`, `enabled`. |
| `remove` | `jobId` | Deletes the job. |
| `enable` / `disable` | `jobId` | Resumes or pauses without deleting. |
| `fire` | `jobId` | Runs now; still claims, so a manual fire cannot duplicate a pending run. |
| `cleanup` | none | Deletes the paused jobs in this directory. |

`jobId` accepts an exact id, a unique name, or a unique id prefix. A job with an exhausted schedule (a spent one-shot, or a cron form that will never match again) disables itself instead of firing forever.

## Overlay keys

| Key | Action |
|---|---|
| `↑` `↓`, `j` `k` | Move the selection |
| `Enter` | Open the job; the detail view scrolls the prompt with `↑`/`↓`, `j`/`k`, `Ctrl+D`/`Ctrl+U`, `g`/`G` |
| `n` | Create a job: schedule, then prompt, then an optional name |
| `space` | Pause or resume the selected job |
| `f` | Fire the selected job now |
| `d` | Remove the selected job. Asks for `y` first |
| `c` | Clean up paused jobs. Asks for `y` first |
| printable characters | Filter; `Ctrl+U` clears the filter |
| `q`, `Esc`, `Ctrl+C` | Close (in the detail view `Esc` returns to the list) |

Inside the create wizard, `Enter` confirms the field and `Esc` returns to the previous field.

## Related

- Built-in package catalog: `docs/builtin-extensions.md`.
