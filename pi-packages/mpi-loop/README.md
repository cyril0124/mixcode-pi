# mpi-loop

[中文文档](README.zh.md)

MixCode built-in recurring prompt execution engine with timer conflict handling, editor dock widget, and interactive management overlay.

## Usage

```bash
/loop                          # Open management overlay
/loop [interval] <prompt>      # Start new loop (e.g. /loop 5m /review)
/loop stop <id|name>           # Stop specific loop
/loop interval <id> <interval> # Reschedule existing loop
/loop prompt <id> <prompt>     # Rewrite prompt for existing loop
```

- **Intervals**: `s`, `m`, `h`, `d` (e.g. `10s`, `5m`, `1h`). Minimum is `10s`, defaults to `10m`.
- **Total runs**: Open `/loop`, select a loop, press `Enter`, then press `c`. Enter a positive integer, or leave it blank for unlimited execution. The immediate first run counts toward the total.
- **Conflict Modes**: `skip` (drops timer tick if agent is busy) or `defer` (coalesces and executes when agent becomes idle).
- **Prompt expansion**: a loop prompt is delivered like typed input — slash commands are dispatched, and `/skill:<name>` and prompt templates are expanded, exactly as if you had typed them into the editor.

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
