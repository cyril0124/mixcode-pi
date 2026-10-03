# mpi-working-timer

[English](README.md)

用一条 footer 条目显示当前 Agent 一轮运行的已耗时。同一个包在裸上游 Pi 和 MixCode 下都能运行，只使用公开的 `ExtensionAPI` 与 `ctx.ui.setStatus`。

## 显示

| 状态 | footer 条目 |
| --- | --- |
| 运行中 | `⏱ <已耗时>` |
| 本轮结束 | `✔ done <耗时> at <本地 YYYY-MM-DD HH:MM:SS>` |
| 空闲，或本会话还没有运行过 | 移除该条目 |

耗时向下取整到秒，渲染为 `7s`、`2m 05s` 或 `1h 02m 03s`。结束时刻是本地时间，格式与转录里的 `Worked for 7s · at <stamp>` 一致。

在 MixCode 下 working 行本身已带 `(12s • esc to interrupt)`；footer 条目是独立的第二处显示，两者同时可见。

## 状态 key

条目写在状态 key `mpi-working-timer` 下。Pi 与 MixCode 都按 key 排序扩展状态，因此它相对其他扩展条目的位置是稳定的。`setStatus` 是叠加式的：兄弟扩展保留各自的 key，`ctx.ui.setWorkingMessage`、working 指示器以及 Pi 的 retry / compaction 状态行都不会被触碰。

两种宿主都会把拼接后的状态行渲染进终端宽度，因此在窄终端上、或旁边有其他长状态时，本条目的尾部会被裁掉而不是换行。条目本身在 10 小时以内占 40 列，10 小时及以上占 41 列（`✔ done 10h 00m 00s at 2026-10-03 15:39:00`）。

## 生命周期

- `session_start`：清空状态并移除条目。
- `agent_start`：用 `??=` 打时间戳，因此属于同一次运行的 agent 循环（自动重试、恢复、压缩、队列中的后续任务）保留已耗时。
- 运行期间由 `turn_start`、`message_update`、`tool_execution_start`、`tool_execution_end` 刷新文本，并由 1s 定时器让长时间静默的工具调用期间秒数继续增长。
- `agent_settled`：停止定时器并切换为 `✔ done <耗时> at <时刻>`。
- `session_shutdown`：停止定时器并移除条目。

一次运行在 `agent_settled` 结束，而不是 `agent_end`：Pi 在 `agent_end` 之后仍可能自动继续（重试、恢复、压缩、队列中的后续任务），结束耗时应包含这些时间。本包有意不处理 `agent_end`。

定时器只在运行期间存在，已 `unref()`；若运行中途再次收到 `agent_start` 会替换而不是叠加。空闲会话不创建定时器，也不请求渲染。

## 范围

- 没有命令、没有配置文件、没有工具、没有 Skill、没有 JSON Schema。
- 非交互模式（print / RPC）下 `setStatus` 是空实现，因此处理函数保持无副作用。
- 不包含：每轮或每个工具的耗时、成本与 token 遥测、替换 working 指示器本身。
