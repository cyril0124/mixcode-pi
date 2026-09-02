# `mpi-transcript`

[中文文档](README.zh.md)

`mpi-transcript` provides `/transcript` for viewing effective LLM context, chatlog, thinking blocks, and the latest user or assistant message.

## Commands

```text
/transcript [context|chatlog|thinking|latest-agent|latest-user] [N] [full]
/transcript config
```

`/transcript config` opens the transcript editor configuration panel. The panel always offers `auto` and `builtin`; `nvim` and `vim` appear only when their `--version` checks succeed.

`N` applies to `context`, `chatlog`, and `thinking`. `full` applies to `context` and `chatlog`. Every view starts with transcript statistics, including the current session file path or `In-memory` for an unpersisted session.

## Editor selection

Configuration is stored at `<agentDir>/mpi-transcript.json`:

```json
{
  "$schema": "./extensions/mpi-transcript/mpi-transcript.schema.json",
  "editor": "auto"
}
```

Supported values:

| Value | Behavior |
| --- | --- |
| `auto` | Use `nvim` when available, then `vim`, then the in-app viewer. |
| `nvim` | Open the read-only transcript in nvim with transcript navigation and styling. |
| `vim` | Open the read-only transcript in vim with transcript navigation and styling. |
| `builtin` | Use the in-app multi-line viewer. |

`nvim` and `vim` open with `--clean`, so your init config, plugins, and colorscheme are not loaded. The transcript view brings its own styling, keybindings, and clipboard (`unnamedplus`; nvim uses OSC 52 when `$TMUX` is unset so the outer terminal receives yanks). Startup stays fast even on multi-megabyte transcripts.

The package reads this file when `/transcript` runs. Missing configuration uses `auto`. Invalid configuration is reported as an error and the transcript does not open. If a selected external editor cannot start, the package reports the error and opens the in-app viewer.

The package ships `mpi-transcript.schema.json` next to the extension. The optional `$schema` field is preserved when the configuration is written.
