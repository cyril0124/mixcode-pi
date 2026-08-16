# mpi-optimize-prompt

[中文文档](README.zh.md)

Metaprompt-based prompt optimizer extension for MixCode that refines brief user instructions into clear, structured, actionable prompts.

## Usage

```bash
/optimize-prompt [instructions]
/optimize-prompt-config
```

- If invoked without arguments, `/optimize-prompt` uses the text currently in the prompt editor.
- Generated prompts directly replace the editor draft.
- Press `Ctrl+U` to undo and restore the original text before optimization.

## Configuration (`~/.pi/agent/optimize-prompt.json`)

```jsonc
{
  "model": "anthropic/claude-3-7-sonnet", // Or "inherit" to follow current tab
  "systemPrompt": "Custom optimizer guidelines..."
}
```
