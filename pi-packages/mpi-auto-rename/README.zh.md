# mpi-auto-rename

[English Documentation](README.md)

根据当前对话生成短横线风格（kebab-case）的会话标题。

## 命令

```bash
/auto-rename                 # 根据最近对话生成标题
/auto-rename config          # 设置列表：模型、thinking、首条消息自动触发
/auto-rename-cancel          # 中止进行中的生成
```

## 配置（`<agentDir>/auto-rename.json`）

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "onFirstMessage": true
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | 继承当前会话模型 | `provider/modelId` |
| `thinking` | 继承当前会话 thinking | 所选模型支持的级别，如 `off`、`low`、`high` |
| `onFirstMessage` | `false`（省略） | 为 `true` 时，在该 session 发出第一条用户消息时生成标题。已有标题或后续轮次不自动触发。 |

`/auto-rename config` 打开设置列表。Enter 编辑该项（`onFirstMessage` 为开关）；Esc 关闭。改动立即写入。省略 `model` / `thinking`（或设为 `"inherit"`）则跟随当前会话。
