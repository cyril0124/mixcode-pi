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
- **Conflict Modes**: `skip` (drops timer tick if agent is busy) or `defer` (coalesces and executes when agent becomes idle).

## Overlay Keybindings

| Key | Action |
|---|---|
| `j` / `k` or `Down` / `Up` | Select loop from list |
| `Space` | Toggle conflict mode (`skip` / `defer`) |
| `f` | Fire immediate run now (bypasses timer) |
| `i` | Edit interval for selected loop |
| `p` | Edit prompt for selected loop |
| `d` / `Backspace` | Delete selected loop |
| `Escape` / `q` | Close management overlay |
