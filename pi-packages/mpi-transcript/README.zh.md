# `mpi-transcript`

[English Documentation](README.md)

`mpi-transcript` 提供 `/transcript`，用于查看 LLM 实际上下文、完整对话、Thinking 区块，以及最近一条用户或 assistant 消息。

## 命令

```text
/transcript [context|chatlog|thinking|latest-agent|latest-user] [N] [full]
/transcript config
```

`/transcript config` 打开由本包管理的编辑器配置面板。面板始终提供 `auto` 与 `builtin`；只有对应命令的 `--version` 检查成功时才显示 `nvim` 或 `vim`。

`N` 适用于 `context`、`chatlog` 和 `thinking`。`full` 适用于 `context` 和 `chatlog`。

## 编辑器选择

配置文件位于 `<agentDir>/mpi-transcript.json`：

```json
{
  "$schema": "./extensions/mpi-transcript/mpi-transcript.schema.json",
  "editor": "auto"
}
```

支持的值：

| 值 | 行为 |
| --- | --- |
| `auto` | 优先使用可用的 `nvim`，然后是 `vim`，最后使用内置查看器。 |
| `nvim` | 使用 nvim 以只读方式打开 transcript，并启用 transcript 导航与样式。 |
| `vim` | 使用 vim 以只读方式打开 transcript。 |
| `builtin` | 使用内置多行查看器。 |

每次执行 `/transcript` 时都会读取该文件。配置文件缺失时使用 `auto`；配置无效时报告错误并停止打开 transcript。指定的外部编辑器无法启动时，先报告错误，再使用内置查看器。

本包随扩展提供 `mpi-transcript.schema.json`。可选的 `$schema` 字段会在配置写回时保留。
