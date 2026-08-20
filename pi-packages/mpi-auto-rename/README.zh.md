# mpi-auto-rename

[English Documentation](README.md)

根据当前对话生成短横线风格（kebab-case）的会话标题。

## 命令

```bash
/auto-rename                 # 根据最近对话生成标题
/auto-rename config          # 设置列表：模型、thinking、首条消息自动触发、上下文字符上限
/auto-rename-cancel          # 中止进行中的生成
```

会话已有标题时，选 **Yes** 覆盖、**No** 保留，或 **Regenerate** 重新生成。

## 配置（`<agentDir>/auto-rename.json`）

包内随带 `auto-rename.schema.json`（安装于 `<agentDir>/extensions/mpi-auto-rename/`），可在配置中用 `$schema` 键引用以获得编辑器补全；该键被接受并在写回时保留。

```json
{
  "model": "provider/modelId",
  "thinking": "low",
  "onFirstMessage": true,
  "maxContextChars": 4000
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | 继承当前会话模型 | `provider/modelId` |
| `thinking` | 继承当前会话 thinking | 所选模型支持的级别，如 `off`、`low`、`high` |
| `onFirstMessage` | `false`（省略） | 为 `true` 时，在该 session 发出第一条用户消息时生成标题。已有标题或后续轮次不自动触发。 |
| `maxContextChars` | `4000`（省略） | 正整数。先取最近 20 段 user/assistant，再截到该字符数（留尾巴）。 |

`/auto-rename config` 打开设置列表。Enter 编辑该项（`onFirstMessage` 为开关；`maxContextChars` 选 `1000` / `4000` / `8000` / `16000`）；Esc 关闭。改动立即写入。省略 `model` / `thinking`（或设为 `"inherit"`）则跟随当前会话。省略 `maxContextChars`（或设为 `4000`）即用默认值。JSON 可写任意正整数。
