# mpi-tool-display

[中文文档](README.zh.md)

Render-only transcript presentation for `bash`, `read`, `edit`, `write`, and Thinking blocks. Native tool definitions, ownership, execution, settings, and session environment remain unchanged. An optional global debug setting appends formatted JSON arguments beneath every tool call.

## Behavior

| Surface | Collapsed / idle | Expanded / running |
| --- | --- | --- |
| `bash` | `↳ N lines returned • Ctrl+O to expand` | 10-frame spinner with elapsed time; live output remains uncollapsed; expanded preview is capped at 4000 lines |
| `read` | `↳ loaded N lines • Ctrl+O to expand` | Expanded preview is capped at 4000 lines |
| `read` of `SKILL.md` | `[skill] <parent directory>`; collapsed result is empty | File body |
| `edit` | Diff capped at 24 lines with a remainder hint | Pending diff preview while running; full diff when expanded |
| `write` | Overwrite diff against pre-execution content; new files render as additions | Pending diff preview while running; full diff when expanded |
| Thinking | Themed `Thinking:` prefix | Streaming updates remain labeled |

Call rows use `$ command [timeout]`, `read path[:range]`, `edit path (N lines)`, and `write path (N lines • size)`.

Diff presentation uses bars, split layout at widths of 120 columns or more, unified layout below 120 columns, word wrapping, and Pi syntax highlighting. Diff knobs live in `DEFAULT_TOOL_DISPLAY_CONFIG`. Raw argument display is configured separately.

## Configuration

Run `/mpi-tool-display config` to open the global settings overlay. Changes persist immediately to `<agentDir>/mpi-tool-display.json`, where `<agentDir>` follows `PI_CODING_AGENT_DIR` and otherwise defaults to `~/.pi/agent`.

```json
{
  "showRawToolArguments": false
}
```

`showRawToolArguments` defaults to `false`. When enabled, every tool call keeps its specialized, native, or title fallback presentation and appends `JSON.stringify(args, null, 2)`. Tool results are unchanged. Later calls in the current tab use the new value; `/reload` rebuilds existing rows. Other tabs reread the file before their next agent turn.

Arguments can include credentials, prompts, file contents, or large payloads. Invalid JSON, unknown keys, and non-boolean values are rejected.

## Thinking contract

Thinking blocks are labeled through Pi's `message_update` and `message_end` extension events. Formatting is API-aware and idempotent.

Before each model call, the `context` handler removes the label and ANSI presentation sequences from assistant Thinking blocks. Display formatting never enters model context.

## Execution contract

The package does not call `registerTool`, create tool definitions, wrap `execute`, read shell settings, or claim tool ownership. A guarded, reload-safe adapter selects call/result renderers through Pi's `ToolExecutionComponent` for `bash`, `read`, `edit`, and `write`. When `read` targets `SKILL.md`, the adapter uses the tool definition's native renderer, which draws `[skill] <parent directory>` when collapsed. Other defined tools use their own renderers. The call wrapper preserves each renderer's `lastComponent` state while optionally appending raw arguments. Tools without a definition keep Pi's generic formatter, including its native result text. With `showRawToolArguments` off, that formatter receives no argument object.

Native definitions preserve cwd, shell path/prefix, permission wrappers, and the bash child environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`). The public `tool_call` event captures write's previous file content for display only; it does not block or mutate tool input.

## License notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
