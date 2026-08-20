# mpi-optimize-prompt

[English Documentation](README.md)

把输入框草稿（或斜杠命令参数）改写成更清晰的 coding-agent 提示词。

## 命令

```bash
/opt-prompt                  # 优化当前编辑器草稿
/opt-prompt <text>           # 优化给定文本并写入编辑器
/opt-prompt config           # 覆盖层：模型、thinking、系统提示词
/opt-prompt help             # 用法与配置说明
/opt-prompt cancel           # 中止进行中的优化（保留草稿）
/opt-prompt undo             # 恢复优化前的草稿
```

`Ctrl+Shift+C` 也可中止进行中的优化。

## 配置（`<agentDir>/optimize-prompt.json`）

包内随带 `optimize-prompt.schema.json`（安装于 `<agentDir>/extensions/mpi-optimize-prompt/`），可在配置中用 `$schema` 键引用以获得编辑器补全；该键被接受并在写回时保留。

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "systemPrompt": "自定义改写指令..."
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | 继承当前会话模型 | `provider/modelId` |
| `thinking` | 继承当前会话 thinking | 所选模型支持的级别，如 `off`、`low`、`high` |
| `systemPrompt` | 内置改写指令 | 完整覆盖；必须要求只输出改写后的提示词 |

`/opt-prompt config` 会立即写入 model/thinking。省略字段（或设为 `"inherit"`）则跟随当前会话。
