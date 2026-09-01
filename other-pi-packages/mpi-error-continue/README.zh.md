# mpi-error-continue

自动恢复未完成工作便停止的代理。
每次继续前都会显示倒计时确认对话框，因此用户始终可以在发送前取消。

## 触发条件

| 稳定条件 | 流程 |
|---|---|
| `stopReason: "error"`（Pi 内置自动重试未恢复） | 错误退避 |
| 空响应：没有文本、思考或工具调用 | 错误退避 |
| 非错误停止，且最后一个助手块是 `thinking` 或 `toolCall` | 工作中断 |

用户主动中止（`stopReason: "aborted"` 或 `agent_end` 时 `ctx.signal.aborted`）
不会触发继续，即使最后一条助手消息仍像是工作未完成。

## 错误退避

最多发送 **3 次不可见继续**（隐藏自定义标记，不进入 LLM 上下文），
然后最多发送 **5 次可见的** `continue` 用户提示。状态栏显示当前阶段和本会话累计发送次数：

```text
error-continue: on · total 7
error-continue: on · invisible 1/3 · total 7
error-continue: on · visible 2/5 · total 8
error-continue: on · mid-work · total 9
```

`invisible N/3` 和 `visible N/5` 表示当前错误重试阶段。
`mid-work` 表示正在等待发送 `continue $simple-plan`。
`total N` 只统计实际发送的继续；等待、超时、Esc/No 取消和外部中止均不增加计数。

## 工作中断

发送一次可见的 `continue $simple-plan`，以便恢复时加载 simple-plan skill。
每次停止最多发送一次，不涉及阶段计数器。

## 确认对话框

每次继续都会在发送前显示确认对话框：

| 操作 | 结果 |
|---|---|
| 超时（未按键） | 发送继续，保持无人值守恢复行为 |
| `Yes` | 立即发送，跳过剩余倒计时 |
| `Esc` 或 `No` | 取消。错误退避会重置阶段计数并停止当前重试循环；工作中断会跳过本次发送 |

取消不会禁用扩展：状态栏保留 `error-continue: on · total N`，
清除当前阶段，且 `N` 不增加。下一次符合条件的稳定事件会从 invisible 1/3 重新开始。
使用 `/error-continue off` 可在本会话中禁用扩展。

该对话框是等待期间唯一可由 Esc 触达的界面。
`agent_settled` 触发时，主程序已将标签页标记为空闲，并会在扩展快捷键分发前消费 Esc。

### 等待时长

`max(指数退避, 5s)`：对话框超时同时作为重试退避。
1 秒的对话框无法可靠点击。

| 尝试 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| invisible | 5s | 5s | 5s | — | — |
| visible | 5s | 5s | 5s | 8s | 16s |

工作中断固定等待 5 秒。

当 `ctx.hasUI` 为 false（打印模式 `-p`、JSON 模式）时不显示对话框：
等待改为普通计时器，并在到期后发送继续。
此时无人可以按 Esc；无操作 UI 的 `confirm()` 会返回 `false`，不能将其误判为用户取消。

## 命令

| 命令 | 效果 |
|---|---|
| `/error-continue on` | 为本会话启用；无状态记录时默认启用 |
| `/error-continue off` | 禁用；状态持久化到会话分支 |
| `/error-continue reset` | 重置重试阶段和本会话累计计数；保持启用状态 |

## 本地加载

```bash
pi -e ./other-pi-packages/mpi-error-continue/index.ts
# 或
mpi -e ./other-pi-packages/mpi-error-continue/index.ts
```

## 测试

```bash
bun test --isolate --timeout=60000 other-pi-packages/mpi-error-continue/error-continue.test.ts
```
