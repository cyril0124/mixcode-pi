# mpi-tool-display

[English](README.md)

为 `bash`、`read`、`edit`、`write` 与 Thinking 块提供 render-only 转写展示。原生工具定义、ownership、执行逻辑、settings 和会话环境保持不变。

## 行为

| 界面 | 折叠态 / 空闲态 | 展开态 / 运行态 |
| --- | --- | --- |
| `bash` | `↳ N lines returned • Ctrl+O to expand` | 10 帧 spinner + 运行耗时；实时输出不折叠；展开预览上限 4000 行 |
| `read` | `↳ loaded N lines • Ctrl+O to expand` | 展开预览上限 4000 行 |
| `edit` | diff 折叠上限 24 行，超出部分给出提示 | 运行中显示 pending diff；展开后显示完整 diff |
| `write` | 基于执行前内容显示覆写 diff；新文件显示为纯新增 | 运行中显示 pending diff；展开后显示完整 diff |
| Thinking | 带主题色的 `Thinking:` 前缀 | 流式更新持续保留标签 |

调用行格式为 `$ command [timeout]`、`read path[:range]`、`edit path (N lines)` 和 `write path (N lines • size)`。

diff 使用 bars 指示；宽度不小于 120 列时左右分栏，低于 120 列时使用 unified；支持 word wrap 和 Pi 语法高亮。固定显示参数由 `DEFAULT_TOOL_DISPLAY_CONFIG` 定义，不提供运行时配置。

## Thinking 契约

Thinking 块通过 Pi 的 `message_update` 与 `message_end` extension events 添加标签。格式化按 API 判断并保持幂等。

每次模型调用前，`context` handler 会从 assistant Thinking 块中剥离标签和 ANSI 展示序列。展示格式不会进入模型上下文。

## 执行契约

包不调用 `registerTool`，不创建工具定义、不包装 `execute`、不读取 shell settings、不抢工具 ownership。带形状守卫且 reload 可恢复的 adapter 通过 Pi `ToolExecutionComponent` 为 `bash`、`read`、`edit`、`write` 选择 call/result renderer；其他工具保留原生 renderer。

原生定义继续负责 cwd、shell path/prefix、permission wrapper 和 bash 子进程环境（`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`）。公开 `tool_call` 事件只为显示而捕获 write 执行前的文件内容，不 block、不修改工具输入。

## 许可证声明

参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
