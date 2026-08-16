# mpi-optimize-prompt

[English Documentation](README.md)

MixCode 内置的基于 Meta-prompt 技术的提示词优化扩展，将简短或模糊的用户指令转化为清晰、结构化可执行的高质量 Prompt。

## 命令与使用

```bash
/optimize-prompt [instructions]
/optimize-prompt-config
```

- 若未指定参数，直接执行 `/optimize-prompt` 将自动使用当前编辑器中的文本进行润色。
- 生成的优化结果将直接替换当前输入框内容。
- 支持按 `Ctrl+U` 撤销并恢复优化前的原始文本草稿。

## 配置文件 (`~/.pi/agent/optimize-prompt.json`)

```jsonc
{
  "model": "anthropic/claude-3-7-sonnet", // 或 "inherit" 跟随当前 Tab
  "systemPrompt": "自定义优化指令..."
}
```
