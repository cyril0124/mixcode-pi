# `mpi-transcript`

[English Documentation](README.md)

`mpi-transcript` 提供 `/transcript`，用于查看 LLM 实际上下文、完整对话、Thinking 区块，以及最近一条用户或 assistant 消息。

## 命令

```text
/transcript [context|chatlog|thinking|latest-agent|latest-user] [N] [full]
/transcript config
```

`/transcript config` 打开 transcript 设置面板。编辑器选项包括 `auto` 与 `builtin`；对应命令的 `--version` 检查成功时才显示 `nvim` 或 `vim`。

选中 `Fold threshold` 并按 Enter 编辑折叠阈值。Ctrl+U 清空输入，Enter 保存，Esc 取消编辑。

`N` 适用于 `context`、`chatlog` 和 `thinking`。`full` 适用于 `context` 和 `chatlog`。每个视图顶部都会显示 transcript 统计信息，其中包含当前 session 文件路径；未持久化的 session 显示 `In-memory`。

## 配置

使用同一 `<agentDir>` 的工作目录共享设置，配置文件位于 `<agentDir>/mpi-transcript.json`：

```json
{
  "$schema": "./extensions/mpi-transcript/mpi-transcript.schema.json",
  "editor": "auto",
  "foldThreshold": 20
}
```

`editor` 的可选值：

| 值 | 行为 |
| --- | --- |
| `auto` | 优先使用可用的 `nvim`，然后是 `vim`，最后使用内置查看器。 |
| `nvim` | 使用 nvim 以只读方式打开 transcript，并启用 transcript 导航与样式。 |
| `vim` | 使用 vim 以只读方式打开 transcript，并启用 transcript 导航与样式。 |
| `builtin` | 使用内置多行查看器。 |

`nvim` 与 `vim` 以 `--clean` 启动，不加载 init 配置、插件与配色。transcript 视图自带样式、快捷键和剪贴板（`unnamedplus`；`$TMUX` 未设置时 nvim 用 OSC 52 把 yank 交给外层终端）。即使 transcript 有数 MB 也能快速打开。

每次执行 `/transcript` 时都会读取该文件。`editor` 缺失时使用 `auto`，`foldThreshold` 缺失时使用下文的默认值；配置无效时报告错误并停止打开 transcript。指定的外部编辑器无法启动时，先报告错误，再使用内置查看器。

本包随扩展提供 `mpi-transcript.schema.json`。可选的 `$schema` 字段会在配置写回时保留。

## 工具折叠

`foldThreshold` 默认 20，接受 0 到 9007199254740991 的整数。在 nvim/vim 中，工具输入和输出正文分别计数，行数超过该值时才折叠。默认情况下，20 行展开，21 行折叠。设为 0 时，每个非空且闭合的工具正文块都会折叠。

正文空行计入行数，标题和代码围栏不计入，屏幕自动换行也不增加行数。工具标题和状态保持可见。用户和助手正文、Thinking、Skill 卡片以及未闭合的工具代码块保持展开。内置查看器不支持折叠。

工具输出先截断，再判断是否折叠。默认成功输出保留前 20 行，失败输出保留后 20 行，因此两者在默认阈值下都保持展开。使用 `/transcript chatlog full` 或 `/transcript context full` 保留完整输出，并按完整行数判断。

在 nvim/vim 中，`za` 切换光标下的折叠，`zR` 全部展开，`zM` 全部折叠。正文行数不超过阈值的块没有可切换的自动折叠。
