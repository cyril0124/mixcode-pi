# mpi-tool-display

[中文文档](README.zh.md)

Render-only transcript presentation for `bash`, `read`, `edit`, `write`, and Thinking blocks. Native tool definitions, ownership, execution, settings, and session environment remain unchanged. An optional global debug setting appends formatted JSON arguments beneath every tool call.

## Behavior

| Surface | Collapsed / idle | Expanded / running |
| --- | --- | --- |
| `bash` | One line: `bash <label>`, a dim excerpt of the command, and right-aligned status meta; the result region is empty. A failure keeps its tail below the row. See *Collapsed bash row* | 10-frame spinner with elapsed time; live output streams uncollapsed; expanded preview is capped at 4000 lines |
| `read` | `↳ loaded N lines • Ctrl+O to expand` | Expanded preview is capped at 4000 lines |
| `read` of `SKILL.md` | `[skill] <parent directory>`; collapsed result is empty | File body |
| `edit` | Diff capped at 24 content lines before wrapping, with a remainder hint | Pending diff preview while running; expanded diff capped at 4000 terminal rows |
| `write` | Overwrite diff against pre-execution content; new files render as additions; same diff limits as `edit` | Pending diff preview while running; expanded diff capped at 4000 terminal rows |
| Thinking | Themed `Thinking:` prefix | Streaming updates remain labeled |

Call rows use `bash <label>`, `read path[:range]`, `edit path (N lines)`, and `write path (N lines • size)`, so the leading word always names the tool. Expanding a row (click or `ctrl+o`) restores the shell form: `$ <command>`.

### Collapsed bash row

The collapsed row is always exactly one line, whatever the label length and the terminal width. It
sheds content in this order: the command excerpt, then label columns down to eight, then `timeout Ns`
and `shell <path>`, then `ctrl+o`, then the whole meta.

The label is the call's own `description` argument, which `mpi-bash` asks for while this row is on,
or the elided command when the call carries none:

| Label source | Row |
| --- | --- |
| The call's `description` argument | `bash Find callers of the parser` |
| A call without one falls back to its elided command | `bash rg -n parser src \| head -30` |

The row carries a dim one-line excerpt of the command beside the label, with runs of whitespace
collapsed:

```text
bash Find callers of the parser  rg -n parser src | head -30        ok · 40 lines · 0s · ctrl+o
```

The excerpt takes only what the label leaves, so a long command cannot squeeze the label below the
excerpt's floor of twelve columns; the excerpt gives up its columns before the label elides and
disappears first on a narrow terminal. A
command the label already carries shows no excerpt, so a row never prints the same text twice, which
covers a call whose label falls back to its command.

A running call shows `~ <elapsed>`. A finished call shows `ok`, or `!! exit N`, `!! timed out`,
`!! aborted`, or `!! failed`, followed by the output line count (`1 line`, `32 lines`), and by its duration when the row
measured one. Status comes from the last line of the result, where Pi appends it. A failed call keeps
at most `bashFailureTailLines` (3) non-empty output lines below the row, taken from the end of the
output; a failure without a status line (a validation or spawn error) keeps the first three instead,
because its message sits at the head. Expanding shows the full command and the full output preview.

Diff presentation uses bars, split layout at widths of 120 columns or more, unified layout below 120 columns, word wrapping, and Pi syntax highlighting. The collapsed budget counts each content line once, including all its wrapped rows; a left/right pair counts once in split view. Headers and hunk/file metadata do not consume that budget. The remainder hint counts hidden content lines when collapsed and hidden terminal rows when expanded. Diff knobs and the bash failure tail (`bashFailureTailLines`) live in `DEFAULT_TOOL_DISPLAY_CONFIG`. Raw argument display is configured separately.

## Configuration

Run `/mpi-tool-display config` to open the global settings overlay. `j`/`k` or the arrow keys select a setting, Enter toggles it, and Esc closes. Changes persist immediately to `<agentDir>/mpi-tool-display.json`, where `<agentDir>` follows `PI_CODING_AGENT_DIR` and otherwise defaults to `~/.pi/agent`.

```json
{
  "showRawToolArguments": false,
  "compactBashCallRow": true
}
```

`compactBashCallRow` defaults to `true` and selects the collapsed row described above. Turning it off restores the two-row presentation: the call row shows the full command and the result row shows `↳ N lines returned • Ctrl+O to expand` (a failure keeps its `↳ command failed` header and a head preview). The settings panel writes the file; the toggle applies to calls rendered after it changes, and `/reload` rebuilds existing rows. The flag also decides whether `mpi-bash` requires the `description` argument that supplies the label; see `pi-packages/mpi-bash/README.md`.

`compactBashCommandHint` is accepted and ignored, so a configuration file that still carries it loads unchanged; the excerpt itself has no setting.

`showRawToolArguments` defaults to `false`. When enabled, every tool call keeps its specialized, native, or title fallback presentation and appends `JSON.stringify(args, null, 2)`. Tool results are unchanged. Later calls in the current tab use the new value; `/reload` rebuilds existing rows. Other tabs reread the file before their next agent turn.

Arguments can include credentials, prompts, file contents, or large payloads. Invalid JSON, unknown keys, and non-boolean values are rejected; the ignored key above is the only exception.

## Thinking contract

Thinking blocks are labeled through Pi's `message_update` and `message_end` extension events. Formatting is API-aware and idempotent.

Before each model call, the `context` handler removes the label and ANSI presentation sequences from assistant Thinking blocks. Display formatting never enters model context.

## Execution contract

The package does not call `registerTool`, create tool definitions, wrap `execute`, read shell settings, or claim tool ownership. A guarded, reload-safe adapter selects call/result renderers through Pi's `ToolExecutionComponent` for `bash`, `read`, `edit`, and `write`. When `read` targets `SKILL.md`, the adapter uses the tool definition's native renderer, which draws `[skill] <parent directory>` when collapsed. Other defined tools use their own renderers. The call wrapper preserves each renderer's `lastComponent` state while optionally appending raw arguments. Tools without a definition keep Pi's generic formatter, including its native result text. With `showRawToolArguments` off, that formatter receives no argument object.

Native definitions preserve cwd, shell path/prefix, permission wrappers, and the bash child environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`). The public `tool_call` event captures write's previous file content for display only; it does not block or mutate tool input.

## License notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
