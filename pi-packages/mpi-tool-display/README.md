# mpi-tool-display

[中文文档](README.zh.md)

Render-only transcript presentation for `bash`, `read`, `edit`, `write`, and Thinking blocks. Native tool definitions, ownership, execution, settings, and session environment remain unchanged.

## Behavior

| Surface | Collapsed / idle | Expanded / running |
| --- | --- | --- |
| `bash` | `↳ N lines returned • Ctrl+O to expand` | 10-frame spinner with elapsed time; live output remains uncollapsed; expanded preview is capped at 4000 lines |
| `read` | `↳ loaded N lines • Ctrl+O to expand` | Expanded preview is capped at 4000 lines |
| `edit` | Diff capped at 24 lines with a remainder hint | Pending diff preview while running; full diff when expanded |
| `write` | Overwrite diff against pre-execution content; new files render as additions | Pending diff preview while running; full diff when expanded |
| Thinking | Themed `Thinking:` prefix | Streaming updates remain labeled |

Call rows use `$ command [timeout]`, `read path[:range]`, `edit path (N lines)`, and `write path (N lines • size)`.

Diff presentation uses bars, split layout at widths of 120 columns or more, unified layout below 120 columns, word wrapping, and Pi syntax highlighting. The fixed display profile is defined by `DEFAULT_TOOL_DISPLAY_CONFIG`; no runtime configuration is exposed.

## Thinking contract

Thinking blocks are labeled through Pi's `message_update` and `message_end` extension events. Formatting is API-aware and idempotent.

Before each model call, the `context` handler removes the label and ANSI presentation sequences from assistant Thinking blocks. Display formatting never enters model context.

## Execution contract

The package does not call `registerTool`, create tool definitions, wrap `execute`, read shell settings, or claim tool ownership. A guarded, reload-safe adapter selects call/result renderers through Pi's `ToolExecutionComponent` for `bash`, `read`, `edit`, and `write`; all other tools retain their native renderers.

Native definitions preserve cwd, shell path/prefix, permission wrappers, and the bash child environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`). The public `tool_call` event captures write's previous file content for display only; it does not block or mutate tool input.

## License notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
