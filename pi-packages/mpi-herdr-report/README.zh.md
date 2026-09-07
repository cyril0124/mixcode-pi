# mpi-herdr-report

向 Herdr 上报 MixCode 窗格活动状态。[English](README.md)

## 启用条件

要求 `MIXCODE` 为真值、`HERDR_ENV=1`，且 `HERDR_SOCKET_PATH` 与
`HERDR_PANE_ID` 非空。`MIXCODE` 去除首尾空白并转为小写后，未设置、空值、
`0`、`false`、`off` 均表示关闭。纯 Pi 环境不进行上报。

## 窗格状态

只跟踪以 `ctx.mode === "tui"` 启动的会话。每个运行实例独立记录忙碌状态，
即使多个实例共用会话文件或 ID。没有对应 TUI 启动的 shutdown 不影响状态。

状态优先级为 `blocked` > `working` > `idle`。`mpi:waiting-for-input` 广播的
进程级等待数量大于零时，状态为 `blocked`；否则，只要有实例忙碌就为
`working`，全部空闲则为 `idle`。`agent_settled` 仅在 `ctx.isIdle()` 返回
true 时清除该实例的忙碌状态。

扩展每 2 秒读取各存活上下文的 `ctx.isIdle()` 并重新上报窗格状态。这覆盖
手动压缩等没有 Agent 生命周期事件的活动，也用于恢复 Herdr 重启时丢失的
上报。过期上下文保留最后记录的活动状态，直到关闭或替换。状态跟踪与发送
记录由整个进程共享，模块重载时继续使用。最后一个已登记会话关闭时，停止
计时器、清空活动与等待数量，并等待最后一次空闲上报的发送尝试结束。

## 发送规则

请求使用换行分隔的 socket JSON-RPC，source 和 agent 均为 `mpi`：
`pane.report_agent` 上报状态，`pane.report_agent_session` 上报会话字段。
有效应答必须是完整的一行，请求 ID 匹配，不含 `error`，且 `result` 为包含
字符串 `type` 的对象。

序号按 `max(previousSeq + 1, Date.now() * 1000)` 递增。Herdr 会确认收到
旧序号请求，但不应用其状态。序号随当前时间推进，让后续刷新可以超过较新
进程按时间生成的序号。仅凭成功应答，不能确认 Herdr 已应用状态。

首次发送超时为 500 ms，失败后重试一次，超时为 1500 ms。两次都失败时，
清除最新失败状态的去重记录，允许再次发送；旧请求失败不会清除更新的记录。
只要仍有存活 TUI 会话，周期刷新就会继续。发送采用尽力交付，不持久化队列。

`mpi:mark-done` 发送声音为 `done` 的 `notification.show` 请求，100 ms 内的
重复事件被抑制。

## 退出清理

首次 TUI 会话启动时注册退出钩子。只加载扩展或仅运行非 TUI 会话的进程，
退出时不会释放窗格。

进程退出时，钩子启动独立的 `herdr pane release-agent` 子进程，其序号高于
该进程尚未完成的上报。`HERDR_BIN_PATH` 指定可执行文件，默认使用 `PATH`
中的 `herdr`。清理要求 CLI 可用且 Herdr 服务可达。

## 测试

```sh
bun test --isolate --timeout=60000 pi-packages/mpi-herdr-report/
```

测试覆盖 Pi 扩展加载、模块重新求值、本地 Unix socket 应答和进程退出，
不运行 Herdr 服务端或界面。
