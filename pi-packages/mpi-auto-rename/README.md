# mpi-auto-rename

[中文文档](README.zh.md)

Lightweight background tab title generator for MixCode.

## Overview

After Turn 1 of a new agent conversation settles, `mpi-auto-rename` calls a fast model in the background to generate a concise, 2-to-5 word kebab-case title (e.g. `fix-auth-token`) and automatically updates `open_tabs.json`.

## Usage & Configuration

```bash
/auto-rename [name]          # Manually trigger or set title
/auto-rename-config          # Pick model for auto-rename
```

Configuration is persisted to `~/.pi/agent/auto-rename.json`:

```jsonc
{
  "model": "anthropic/claude-3-5-haiku" // Or "inherit"
}
```
