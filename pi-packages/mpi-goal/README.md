# mpi-goal

[中文文档](README.zh.md)

MixCode built-in goal tracking for long-running agent work.

## Overview

`mpi-goal` is a session-scoped autonomous goal tracking engine with dynamic progressive tool disclosure, continuation budgets, and queue orchestration.

## Usage

| Command | Effect |
|---|---|
| `/goal` | Open management overlay |
| `/goal <objective>` | Create / replace / queue a goal |
| `/goal tools` | Activate all goal model tools |
| `/goal pause` / `resume` / `clear` | Goal lifecycle |
| `/goal queue …` | List or enqueue |

- **Session-Scoped Isolation**: State is persisted via `mpi-goal-state` session entries on the current branch.
- **Progressive Dynamic Tool Loading**: Tools are only loaded into the LLM context when active.
- **Active Time Accounting**: Measures wall-clock execution time during active agent turns only (excluding idle/paused periods).
