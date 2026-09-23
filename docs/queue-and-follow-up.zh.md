# 转向与后续队列

[English Documentation](queue-and-follow-up.md)

MixCode 将轮次中的转向消息与用户后续消息分开。两个队列都属于当前 Tab 的运行时会话；待发消息、轮次边界和暂停状态均不跨重启持久化。

## 队列语义

| 输入 | 忙碌时 | 空闲时 |
|---|---|---|
| 普通 Prompt | 在下一个投递点转向当前轮次 | 开始普通轮次，不恢复暂停的后续队列 |
| `/follow-up <text>` | 追加独占一个轮次的后续消息 | 未暂停时立即执行；暂停时只追加，不恢复 |
| `/follow-up --batch <text>` | 追加批量后续消息 | 未暂停时立即执行；暂停时只追加，不恢复 |
| `Alt+Enter` | 追加批量后续消息 | 未暂停时正常提交；暂停时追加批量后续消息，不恢复 |
| `/follow-up` | 恢复用户后续队列，等待当前轮次结束 | 恢复并执行排队的用户后续消息 |

不带文本的 `/follow-up --batch` 报错 `Error: Usage: /follow-up [--batch] <message>`。不带文本的 `/follow-up` 在用户后续队列为空时报错 `Error: No follow-up messages to resume`。文本提示词与显式恢复要求模型已启用；排队的本地命令使用各自的命令校验。只剥离开头的 `--batch` token，因此 `--batchfile` 和出现在消息中间的 `--batch` 都原样保留在内容中。

### 后续轮次

用户后续消息按 FIFO 入队顺序执行。来自 `/follow-up --batch` 或 `Alt+Enter` 的相邻批量条目合并到同一轮次。每个不带 `--batch` 的 `/follow-up <text>` 条目独占一轮，并隔开前后的批量消息，不会插到先前消息之前。

```text
入队：batch A, batch B, next C, batch D
执行：[A + B] -> [C] -> [D]
轮次：   1       2      3
```

当前 Agent 运行结束并空闲后，MixCode 投递一个用户轮次。成功结束后才继续下一轮。一个轮次包含完整的 Agent 运行及其工具循环，不是单次模型回复或工具调用。

### 排队执行 slash 命令

`/follow-up /color red` 和 `/follow-up --batch /color red` 都会在轮到该条目时执行 MixCode 本地命令。命令作用于入队时的 Tab，不受之后焦点切换影响。本地命令独占一个队列步骤，不与相邻文本合并，也不发送给模型；原有确认与校验仍然适用。命令抛出错误时暂停剩余队列，不自动重试失败命令。Ctrl+U 取回命令时保留原有 follow-up 前缀。

`/close-session`、`/delete-session`、`/close-all-sessions`、`/delete-all-sessions` 会等待确认及确认后的操作与持久化结束。取消时消费该命令并暂停剩余任务。其他浮层替换对话框时，包括打开退出确认，也会取消正在等待共用对话框位置的排队确认。不同 Tab 排队的确认共用一个对话框位置；单会话确认显示时切换到所属 Tab。其他本地命令保留其处理器的完成语义，包括打开后即返回的选择器。

已注册的扩展命令、`/skill:<name>` 和具名提示词模板独占队列步骤，避免相邻普通文本被当成命令参数。它们仍使用 Pi SDK 分发与展开。`/follow-up` 保留内容中的内部空白与换行。

重载扩展或更换工作目录时保留运行中的队列，并将调度交接到重建的 SDK 会话。关闭或清空所属会话时丢弃剩余任务。

### 暂停与恢复

按 `Esc` 或 Agent 最终失败会暂停整个剩余用户后续队列。消息仍然可见，顺序与轮次边界保持不变。工具错误和可恢复的重试不会暂停队列。

只有不带文本的 `/follow-up` 会显式恢复暂停的后续消息。普通 Prompt、`/follow-up <text>`、`/follow-up --batch <text>` 和 `Alt+Enter` 都不会取消暂停。当前仍在运行时，恢复操作会等待其空闲。

转向队列独立处理：`Esc` 将待发转向消息立即刷新为新轮次。压缩期间，转向消息等待压缩结束，`Esc` 改为中断压缩。这两种操作都不会恢复暂停的用户后续消息。

### 编辑排队消息

`Ctrl+U` 根据可见队列状态工作：

- 只有一个非空队列：将该队列最新消息弹回编辑器。
- 两个队列都非空：进入一秒选择状态，不修改队列。按 `S` 选择 Steer，按 `F` 选择 Follow-up，按 `Esc` 取消。
- 两个队列都为空：预备进入 Vim；在一秒内按 `u` 或 `Ctrl+U` 确认。

如果确认前所选队列变空，不会回退到另一队列。弹出独占条目时，编辑器恢复 `/follow-up <text>`；弹出批量本地命令时恢复 `/follow-up --batch <text>`；重新提交这两类条目都保持原有轮次类型；批量文本条目则恢复为纯文本。弹出消息不会恢复队列。

## 运行时归属与并发

`MixCodeTabInfo.followUpQueue` 以 `{ text: string, kind: "batch" | "next", command?: boolean }` 保存用户条目，`followUpsPaused` 控制其投递。`pendingFollowUps` 是展示用聚合列表，先放本地用户文本，再放 SDK 后续文本。

SDK 的 follow-up 模式保持 `all`。扩展伴随消息和内部续跑留在 SDK 队列，保持 SDK 投递行为；用户轮次边界和暂停状态不会改变它们的类别。TUI 用 `SDK` 标记这些条目，不分配用户轮次编号。

`dispatchTurn` 通过 Tab 的 `promptDispatchGate` 串行执行 Prompt 预检，在预检完成或失败时释放。这可以防止快速提交穿透忙碌状态检查。用户后续消息的投递等待当前 Agent 运行结束并空闲。

## TUI 队列显示

Steer 和 Follow-up 显示在编辑器上方的对话尾部，各有独立边框。每个框显示消息总数及最新至多五条消息。

- 用户后续条目显示 `Round N`；相邻批量条目共用编号，独占条目还显示 `next`。编号相对于完整的待发用户队列，即使更早条目不在五条预览范围内，也不会重新编号。
- 暂停时，Follow-up 框单独一行显示 `Paused · /follow-up to resume`。
- 只有一个非空队列时显示 `Ctrl+U->edit`。两个队列都非空时，Steer 显示 `Ctrl+U,S->edit`，Follow-up 显示 `Ctrl+U,F->edit`。
- 除压缩期间外，Steer 显示 `Esc->send now`；Follow-up 始终不显示此提示。
