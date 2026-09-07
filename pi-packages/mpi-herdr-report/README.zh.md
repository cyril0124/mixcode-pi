# mpi-herdr-report

向 Herdr 上报 MixCode 窗格活动状态。[English](README.md)

## 启用条件

扩展要求 `MIXCODE` 为真值、`HERDR_ENV=1`，且 `HERDR_SOCKET_PATH` 与
`HERDR_PANE_ID` 非空。`MIXCODE` 去除首尾空白并转为小写后，未设置、空值、
`0`、`false`、`off` 均表示关闭。纯 Pi 环境不进行上报。

## 生命周期

只有以 `ctx.mode === "tui"` 启动的会话才加入窗格账本。没有对应 TUI 启动的
shutdown 不修改账本。每个 TUI 会话贡献自己的忙碌状态；`agent_settled` 仅在
`ctx.isIdle()` 返回 true 时清除该状态。宿主通过 `mpi:waiting-for-input` 广播的
进程级等待数量大于零时，窗格上报 `blocked`；否则，只要存在忙碌会话就上报
`working`，全部空闲则上报 `idle`。

账本、上报序号、最新状态队列、去重状态、通知防抖和退出钩子注册共享一个进程级
对象。扩展模块重载时复用该对象，不丢失仍存活 Tab 的状态。最后一个已登记会话
关闭时，清空忙碌与等待状态，并等待空闲上报完成。

上报使用换行分隔的 socket JSON-RPC：`pane.report_agent` 与
`pane.report_agent_session`，source 和 agent 均为 `mpi`。只有完整、以换行
结束、请求 ID 匹配、包含带类型的 `result` 且不含 `error` 的应答才确认发送成功。
socket 分片会缓冲到完整应答到达。首次发送超时为 500 ms，失败后以 1500 ms
超时重试一次。两次都失败时，清除最新失败状态的去重记录，让后续生命周期事件
可以重新上报相同状态；旧请求失败不会清除更新的记录。此后没有后台自动重试，
这是尽力上报，不保证持久交付。`mpi:mark-done` 发送声音为 `done` 的
`notification.show` 请求，100 ms 内的重复事件被抑制。

首次 TUI 会话启动时注册进程退出清理。只加载扩展或仅运行非 TUI 会话的进程，
退出时不会释放窗格。曾拥有 TUI 会话的进程退出时启动独立的
`herdr pane release-agent` 子进程，其序号高于该进程分配过的所有上报序号。
`HERDR_BIN_PATH` 指定 CLI 可执行文件，默认使用 `PATH` 中的 `herdr`。
释放操作要求 CLI 可用且 Herdr 服务可达。

## 验证

```sh
bun test --isolate --timeout=60000 pi-packages/mpi-herdr-report/
```

生命周期回归测试使用 Pi 扩展加载器与本地 Unix socket 服务，并覆盖禁用原生
导入缓存后的模块重新求值。不验证 Herdr 界面或服务端实现。
