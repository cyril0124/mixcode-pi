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

`--max-runs N` sets the total at creation. Place it after the optional interval and before the prompt; omitting it means unlimited runs. `N` must be a decimal positive safe integer, at most `9007199254740991`. Missing values, invalid counts, and duplicate options before the prompt report `Error:` without creating a loop.

The immediate first run and subsequent timer or deferred deliveries count toward the total. Reaching the limit removes the loop and cancels its timers. Skipped ticks and manual `f` fires do not change the counter. A limit of `1` delivers only the immediate first run.

`/loop max-runs <id|name> <N|unlimited>` changes an active loop's total, not its remaining runs. It preserves the executed count, interval, next run time, and pending state, without firing. A total below the executed count reports `Error:`; a total equal to it stops the loop and discards any pending delivery. `unlimited` removes the count limit. Existing expiry and conflict rules still apply.

The detail view uses the same validation: open `/loop`, select a loop, press `Enter`, then `c`. Enter a total, or leave it blank to remove the limit. Both interfaces update the same limit shown in `RUNS`.

Options are parsed only before the prompt; `check --max-runs 3` remains literal prompt text. Use `--` to make everything after it literal, including a trailing `every` clause:

```bash
/loop 2h -- --max-runs 3
/loop --max-runs 3 -- check every 2h
```

Without `--`, the default-interval form can use a trailing interval clause, such as `/loop --max-runs 3 check every 2 hours`. An explicit leading interval takes precedence.

## Overlay Keybindings

| Key | Action |
|---|---|
| `Down` / `Up` or `Tab` / `Shift+Tab` | Select loop from list |
| `Enter` | Open the selected loop details |
| `f` | Fire the selected loop immediately |
| `x` | Remove the selected loop |
| `c` | Remove all loops after confirmation |
| `Escape` / `q` | Close the management overlay |
| `c` (details) | Set total runs; blank means unlimited |
| `m` (details) | Toggle conflict mode (`skip` / `defer`) |
| `f` (details) | Fire the loop immediately |
| `x` (details) | Remove the loop |
| `Left` / `Escape` (details) | Return to the loop list |
