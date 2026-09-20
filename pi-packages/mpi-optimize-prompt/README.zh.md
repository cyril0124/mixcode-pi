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

Pi 模型注册表通过所选模型的已配置 provider 发送请求。每次请求都会重新解析认证，处理 OAuth 刷新，并应用认证返回的 base URL、请求头和环境设置。本地 provider 可以不使用 API Key。

Provider 或认证失败时显示 `Optimize failed: ...`，编辑器草稿和撤销记录保持不变。取消会立即清除进度提示。迟到的响应不会替换草稿，也不会清除其他请求的进度提示。

## 配置（`<agentDir>/mpi-optimize-prompt.json`）

包会将 `mpi-optimize-prompt.schema.json` 安装到 `<agentDir>/extensions/mpi-optimize-prompt/`。配置中用 `$schema` 引用该文件即可获得编辑器补全，写回配置时会保留此字段。

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
