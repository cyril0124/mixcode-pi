# mpi-auto-rename

[English Documentation](README.md)

根据当前对话生成短横线风格（kebab-case）的会话标题。

## 命令

```bash
/auto-rename                 # 根据最近对话生成标题
/auto-rename config          # 选择模型和 thinking
/auto-rename-cancel          # 中止进行中的生成
```

## 配置（`<agentDir>/auto-rename.json`）

```json
{
  "model": "provider/modelId",
  "thinking": "low"
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | 继承当前会话模型 | `provider/modelId` |
| `thinking` | 继承当前会话 thinking | 所选模型支持的级别，如 `off`、`low`、`high` |

`/auto-rename config` 会写入这两个字段。省略字段（或设为 `"inherit"`）则跟随当前会话。
