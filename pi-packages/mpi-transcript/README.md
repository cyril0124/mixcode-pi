# `mpi-transcript`

[中文文档](README.zh.md)

`mpi-transcript` provides `/transcript` for viewing effective LLM context, chatlog, thinking blocks, per-turn context growth, and the latest user or assistant message.

## Commands

```text
/transcript [context|chatlog|growth|thinking|latest-agent|latest-user] [N] [full]
/transcript config
```

`/transcript config` opens the transcript settings panel. The editor choices include `auto` and `builtin`; `nvim` and `vim` appear when their `--version` checks succeed.

To change the folding threshold, select `Fold threshold` and press Enter. Ctrl+U clears the input, Enter saves, and Esc cancels the edit.

`N` applies to `context`, `chatlog`, and `thinking`. `full` applies to `context` and `chatlog`. Every view starts with transcript statistics, including the current session file path or `In-memory` for an unpersisted session.

## Context growth

`/transcript growth` charts the context size of every assistant turn, read from its request usage: a summary header (turn count, window, peak), a three-row sparkline of per-turn sizes, and a table listing each turn's window share, a bar, the signed delta vs the previous turn, and that step's percentage growth (`%delta`). Rows carry `<- compaction` when a compaction entry sits between the row and the previous turn, and `(!) cache miss` when the turn re-billed enough tokens to count. The view always covers the whole session; `N` and `full` do not apply. Turns without usage (aborted requests) are skipped, and the bars scale to the latest model's context window, or to the session peak when the window is unknown.

## Configuration

Settings are shared across workdirs that use the same `<agentDir>` and stored at `<agentDir>/mpi-transcript.json`:

```json
{
  "$schema": "./extensions/mpi-transcript/mpi-transcript.schema.json",
  "editor": "auto",
  "foldThreshold": 20
}
```

`editor` values:

| Value | Behavior |
| --- | --- |
| `auto` | Use `nvim` when available, then `vim`, then the in-app viewer. |
| `nvim` | Open the read-only transcript in nvim with transcript navigation and styling. |
| `vim` | Open the read-only transcript in vim with transcript navigation and styling. |
| `builtin` | Use the in-app multi-line viewer. |

`nvim` and `vim` open with `--clean`, so your init config, plugins, and colorscheme are not loaded. The transcript view brings its own styling, keybindings, and clipboard (`unnamedplus`; nvim uses OSC 52 when `$TMUX` is unset so the outer terminal receives yanks). Startup stays fast even on multi-megabyte transcripts.

The package reads this file when `/transcript` runs. A missing `editor` uses `auto`; a missing `foldThreshold` uses the default described below. Invalid configuration is reported as an error and the transcript does not open. If a selected external editor cannot start, the package reports the error and opens the in-app viewer.

The package ships `mpi-transcript.schema.json` next to the extension. The optional `$schema` field is preserved when the configuration is written.

## Tool folding

`foldThreshold` defaults to 20 and accepts integers from 0 through 9007199254740991. In nvim/vim, tool input and output bodies fold independently when their text line count exceeds this value. With the default, 20 lines stay expanded and 21 lines fold. Zero folds every non-empty, closed tool body.

The count includes blank body lines and excludes titles and code fences. Screen wrapping does not add lines. Tool titles and statuses remain visible. User and assistant prose, Thinking, Skill cards, and unterminated tool fences stay expanded. Folding is unavailable in the built-in viewer.

Tool output is truncated before folding. By default, successful output keeps the first 20 lines and failed output keeps the last 20, so both stay expanded at the default threshold. Use `/transcript chatlog full` or `/transcript context full` to retain all output and apply the threshold to its full length.

In nvim/vim, `za` toggles the fold under the cursor, `zR` opens all folds, and `zM` closes all folds. Bodies at or below the threshold have no automatic fold to toggle.
