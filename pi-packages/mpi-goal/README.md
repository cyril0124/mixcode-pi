# mpi-goal

MixCode built-in goal tracking for long-running agent work.

## Credits

This package is adapted from the community **pi-goals** extension
([transcendr/pi-goals](https://github.com/transcendr/pi-goals)), which in turn
was inspired by Codex CLI’s `/goal` workflow.

mpi-goal keeps a similar capability surface (persistent goal, queue, templates,
budgets/floors, continuation, `/goal` UI) while changing packaging and runtime
behavior for MixCode:

- First-party package under `pi-packages/mpi-goal/` (loaded via
  `ensurePackageExtensions` / binary embed)
- Progressive Dynamic Tool Loading: goal tools are registered at load but stay
  out of the active set until `/goal`, `/goal tools`, overlay `t`, or restore of
  an unfinished goal
- No external churn-monitor subprocess
- Session custom entry types use the `mpi-goal-*` prefix

Upstream license: MIT (see `LICENSE` in this package / the original repository).

## Usage (short)

| Command | Effect |
|---------|--------|
| `/goal` | Open management overlay |
| `/goal <objective>` | Create / replace / queue a goal |
| `/goal tools` | Activate all goal model tools |
| `/goal pause` / `resume` / `clear` | Lifecycle |
| `/goal queue …` | List or enqueue |

Goal state is session-scoped (Pi `appendEntry` on the current branch), not a
global database.
