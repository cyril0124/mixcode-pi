# mpi-working-timer

[English](README.md)

用一条 footer 条目显示运行耗时，以及恢复会话后最后一条可见消息的时间。通过 Pi 公开的扩展与会话 API，在裸 Pi 和 MixCode 下均可运行。

## 显示

| 状态 | footer 条目 |
| --- | --- |
| 运行中 | `⏱ <已耗时>` 或 `⏱ <已耗时> · <idle> idle` |
| 本轮结束 | `✔ done <耗时> at <本地 YYYY-MM-DD HH:MM:SS>` |
| 恢复会话，存在可见消息 | `✔ done at <本地 YYYY-MM-DD HH:MM:SS>` |
| 没有可见消息，也没有已完成的运行 | 移除该条目 |

idle 后缀在运行开始后出现，显示距上一次 streaming 活动（`turn_start`、`message_update`、`tool_execution_start`、`tool_execution_end`）已过的时间，每次事件重置为零，在长时间静默的工具调用期间持续增长。

耗时向下取整到秒，渲染为 `7s`、`2m 05s` 或 `1h 02m 03s`。结束时刻是本地时间，格式与转录里的 `Worked for 7s · at <stamp>` 一致。

启动、reload、恢复、fork 和树导航时，条目使用当前分支显示的历史中最后一条可见消息的时间。MixCode 显示完整分支；裸 Pi 使用考虑 compaction 的 `buildContextEntries()` 顺序。Context edit 只改变模型输入，转录中的原消息仍然可见。

普通消息读取自身以毫秒为单位的 `timestamp`；外层 session entry 的时间和当前时钟不参与恢复。Pi 将可见 custom-message entry 和摘要 entry 转成消息，转换后的消息时间来自 entry 的时间。历史未记录运行耗时，因此恢复条目省略耗时。

隐藏 custom 消息（`display: false`）、system 消息、仅保存状态的 entry，以及没有可见内容或显示容器的消息均不参与筛选。

可见性判断遵循各宿主的转录规则：

| 消息 | MixCode | 裸 Pi |
| --- | --- | --- |
| 空 redacted thinking | 显示占位符 | 隐藏 |
| 没有文字的 user 图片 | 显示图片 | 隐藏 |
| 没有内容的 assistant 错误、中止或截断 | 恢复历史时隐藏 | 显示提示 |
| tool result | 更新前置调用所在行，允许重复结果 | 只更新尚未收到结果的调用一次；已中止或错误的 assistant 调用，以及显示历史之外的调用均不匹配 |

在 MixCode 下 working 行本身已带 `(12s • esc to interrupt)`；footer 条目是独立的第二处显示，两者同时可见。

## 状态 key

条目写在状态 key `mpi-working-timer` 下。Pi 与 MixCode 都按 key 排序扩展状态，因此它相对其他扩展条目的位置是稳定的。`setStatus` 是叠加式的：兄弟扩展保留各自的 key，`ctx.ui.setWorkingMessage`、working 指示器以及 Pi 的 retry / compaction 状态行都不会被触碰。

两种宿主都会把拼接后的状态行渲染进终端宽度，因此在窄终端上、或旁边有其他长状态时，本条目的尾部会被裁掉而不是换行。条目本身在 10 小时以内占 40 列，10 小时及以上占 41 列（`✔ done 10h 00m 00s at 2026-10-03 15:39:00`）。

## 生命周期

- `session_start` 与 `session_tree`：停止定时器、重置运行状态，并从当前分支恢复最后一条可见消息的 timestamp；没有带有限数值时间戳的可见消息时移除条目。
- `agent_start`：用 `??=` 打时间戳，因此属于同一次运行的 agent 循环（自动重试、恢复、压缩、队列中的后续任务）保留已耗时。
- 运行期间由 `turn_start`、`message_update`、`tool_execution_start`、`tool_execution_end` 刷新文本并重置 idle 计数，1s 定时器让已耗时和 idle 时长在长时间静默的工具调用期间继续增长。
- `agent_settled`：停止定时器并切换为 `✔ done <耗时> at <时刻>`。
- `session_shutdown`：停止定时器并移除条目。

一次运行在 `agent_settled` 结束，而不是 `agent_end`：Pi 在 `agent_end` 之后仍可能自动继续（重试、恢复、压缩、队列中的后续任务），结束耗时应包含这些时间。本包有意不处理 `agent_end`。

定时器只在运行期间存在，已 `unref()`；若运行中途再次收到 `agent_start` 会替换而不是叠加。恢复状态时渲染一次，此后空闲会话不创建定时器，也不请求额外渲染。

## 范围

- 没有命令、没有配置文件、没有工具、没有 Skill、没有 JSON Schema。
- 非交互模式（print / RPC）下 `setStatus` 是空实现，因此处理函数保持无副作用。
- 不包含：每轮或每个工具的耗时、成本与 token 遥测、替换 working 指示器本身。
