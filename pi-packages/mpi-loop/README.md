# mpi-loop

[中文文档](README.zh.md)

MixCode built-in recurring prompt execution engine with timer conflict handling, editor dock widget, and interactive management overlay.

## Usage

```bash
/loop                          # Open management overlay
/loop [interval] [--max-runs N] [--] <prompt> # Start a loop
/loop max-runs <id|name> <N|unlimited>      # Set total runs
/loop stop <id|name>           # Stop specific loop
/loop interval <id> <interval> # Reschedule existing loop
/loop prompt <id> <prompt>     # Rewrite prompt for existing loop
```

- **Intervals**: `s`, `m`, `h`, `d` (e.g. `10s`, `5m`, `1h`). Minimum is `10s`, defaults to `10m`.
- **Next run display**: The widget and overlay show hours with remaining minutes (`in 1h59m`) and days with remaining hours (`in 1d23h`). Zero remainders are omitted; durations below one hour use whole minutes or seconds. These labels do not change the timer interval.
- **Total runs**: Set a limit at creation, through `/loop max-runs`, or in the detail view. See [Run limits](#run-limits).
- **Conflict Modes**: `skip` (drops timer tick if agent is busy) or `defer` (coalesces and executes when agent becomes idle).
- **Prompt expansion**: a loop prompt is delivered like typed input — slash commands are dispatched, and `/skill:<name>` and prompt templates are expanded, exactly as if you had typed them into the editor.

## Run limits

```bash
/loop 2h --max-runs 3 check deploy status
/loop --max-runs 3 check deploy status
/loop max-runs 1 5
/loop max-runs 1 unlimited
```

`--max-runs N` sets the total at creation. Place it before the prompt; the interval may appear before or after it, so `30m --max-runs 3 x` and `--max-runs 3 30m x` are equivalent. Omitting the option means unlimited runs. `N` must be a decimal positive safe integer, at most `9007199254740991`. Missing values, invalid counts, and duplicate options before the prompt report `Error:` without creating a loop.

The immediate first run and subsequent timer or deferred deliveries count toward the total. Reaching the limit removes the loop and cancels its timers. Skipped ticks and manual `f` fires do not change the counter. A limit of `1` delivers only the immediate first run.

`/loop max-runs <id|name> <N|unlimited>` changes an active loop's total, not its remaining runs. It preserves the executed count, interval, next run time, and pending state, without firing. A total below the executed count reports `Error:`; a total equal to it stops the loop and discards any pending delivery. `unlimited` removes the count limit. Existing expiry and conflict rules still apply.

The detail view uses the same validation: open `/loop`, select a loop, press `Enter`, then `c`. Enter a total, or leave it blank to remove the limit. Both interfaces update the same limit shown in `RUNS`.

Options are parsed only before the prompt; `check --max-runs 3` remains literal prompt text. Use `--` to make everything after it literal, including a trailing `every` clause:

```bash
/loop 2h -- --max-runs 3
/loop --max-runs 3 -- check every 2h
```

Without `--`, the default-interval form can use a trailing interval clause, such as `/loop --max-runs 3 check every 2 hours`. An interval token right after `--max-runs N`, or an explicit leading interval, takes precedence.

## Management layout

The bottom widget uses the original table layout with `ON`, `ID`, `M`, `NAME`, `INTERVAL`, `PROMPT`, `NEXT`, and `RUNS` columns. The header, active check mark and mode marker make it clear which fields belong to each task. The `NEXT` column shows the more precise countdown, such as `in 1h59m`, and finite totals appear as `1/3`.

The management list uses two rows per task. The first row shows its ID, prompt summary, and right-aligned next run time. The second shows the interval, run count, and conflict mode. Narrow panels omit the mode first, then the interval; the countdown and count take priority over the summary. Both rows of the selected task share the selection background. `waiting` uses the warning color and means the loop is waiting for the agent to become idle.

Details show the next run time and total count above the full, scrollable prompt. Short panels omit secondary metadata before reducing the prompt area. The panel height includes borders and hints, so scrolling keeps complete items and the footer visible. Width pressure removes secondary key hints; the keys still work when their hints are hidden.

Remove and clear confirmations replace the footer while keeping the current task context visible. Only `y` confirms. Every other key cancels the confirmation without also triggering its normal action.

## Overlay Keybindings

| Key | Action |
|---|---|
| `Down` / `Up` or `Tab` / `Shift+Tab` | Select loop from list |
| `Enter` | Open the selected loop details |
| `f` | Fire the selected loop immediately |
| `x` | Remove the selected loop |
| `c` | Remove all loops after confirmation |
| `Escape` / `q` | Close the management overlay |
| `Ctrl+U` (list) | Clear the search query |
| `Down` / `Up`, `j` / `k` (details) | Scroll the prompt one line |
| `Ctrl+D` / `Ctrl+U` (details) | Scroll half a prompt page |
| `PageDown` / `PageUp` (details) | Scroll one prompt page |
| `End` / `Home`, `G` / `g` (details) | Jump to the end / beginning |
| `q` (details) | Close the manager |
| `y` (confirmation) | Confirm removal or clear; every other key cancels |
| `c` (details) | Set total runs; blank means unlimited |
| `m` (details) | Toggle conflict mode (`skip` / `defer`) |
| `f` (details) | Fire the loop immediately |
| `x` (details) | Remove the loop |
| `Left` / `Escape` (details) | Return to the loop list |
