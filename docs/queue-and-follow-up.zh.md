# 转向与后续队列管理 (Steer & Follow-up Queue)

[English Documentation](queue-and-follow-up.md)

MixCode Pi 在 Agent 执行过程中提供双队列机制：**转向队列 (Steer)** 与 **后续队列 (Follow-up)**。

## 设计意图与动机

当 Agent 正在输出或执行长链条工具循环时，用户输入的意图具有截然不同的诉求，单队列模型无法兼顾：
1. **紧急中途干预 (Steer)**：用户发现 Agent 正在执行错误的命令或修改了非预期的文件，需要立即在下一个工具执行完毕时注入上下文纠偏，同时不丢弃当前轮次已生成的有效成果。
2. **有序排队执行 (Follow-up)**：用户希望预先布置下一阶段任务（如“修改完后执行全部测试”），要求严格等待当前 Agent 任务完全收敛、空闲后再作为全新独立轮次执行。

MixCode 通过双队列将二者的处理时机、中断表现与生命周期完全解耦。

## 队列行为与语义

```text
当 Agent 正在执行时用户提交消息
   │
   ├─ 普通 Prompt ─────────────> 转向队列 (Steer Queue - 轮次中动态注入)
   │                                 │
   │                                 ├─ 在下一个工具调用完成时注入当前模型上下文
   │                                 └─ 按 `Esc` → 立即刷新为新 Prompt 发送
   │
   └─ `/follow-up <text>` ─────> 后续队列 (Follow-up Queue - 轮次后排队)
                                     │
                                     └─ 在 `Esc` / 中断中存活；待 Agent 空闲后自动作为新轮次发送
```

### 队列差异对比

| 特性 | 转向队列 (Steer) | 后续队列 (Follow-up) |
|---|---|---|
| 触发方式 | Agent 运行中提交普通 Prompt | 执行 `/follow-up <text>` |
| 消费时机 | 当前轮次中作为 Steering Message 注入 | 当前轮次结束且 Agent 空闲后触发新轮次 |
| 中断表现 (`Esc`) | 刷新为新轮次立即发送 | 在中断与轮次交替中完整保留 |
| 弹出编辑 | 按 `Ctrl+U`（弹出最新消息回编辑器） | 按 `Ctrl+U`（弹出最新消息回编辑器） |

## 并发门控保障 (`dispatchTurn`)

在状态快速切换时，通过 `dispatchTurn` 防止并发 `prompt()` 竞争穿透 `isStreaming` 检查：

```text
dispatchTurn(tab, send)
   │
   ├─ 获取 tab.promptDispatchGate（Promise.withResolvers）
   ├─ 附带 preflightResult 信号执行 send()
   └─ 在 Prompt 预检完成或发生异常时释放门控
```

## TUI 队列可视化渲染

排队消息以专属边框浮动在编辑器上方：
- `┌ Steer ─┐`：展示排队中的转向消息，并提示 `Esc->send now` 与 `Ctrl+U->edit`。
- `┌ Follow-up ─┐`：展示排队中的后续消息。
