# mpi-loop

[English Documentation](README.md)

MixCode 内置的定时循环 Prompt 执行引擎，支持时间间隔调度、冲突处理策略、编辑器底部状态挂件与全屏交互式管理浮层。

## 命令与使用

```bash
/loop                          # 打开全屏管理浮层
/loop [interval] <prompt>      # 启动新的定时循环（例如 /loop 5m /review）
/loop stop <id|name>           # 停止指定定时任务
/loop interval <id> <interval> # 调整已有任务的时间间隔
/loop prompt <id> <prompt>     # 修改已有任务的 Prompt 文本
```

- **时间间隔**：支持秒 `s`、分 `m`、时 `h`、天 `d`（例如 `10s`, `5m`, `1h`）。最小 `10s`，默认 `10m`。
- **冲突处理模式**：`skip`（繁忙时跳过）或 `defer`（繁忙时合并并在空闲后立即执行）。

## 管理浮层快捷键

| 快捷键 | 行为 |
|---|---|
| `j` / `k` 或 `Down` / `Up` | 在列表中选择定时任务 |
| `Space` | 切换冲突处理模式 (`skip` / `defer`) |
| `f` | 立即手动触发一次执行（忽略定时器） |
| `i` | 修改选定任务的时间间隔 |
| `p` | 修改选定任务的 Prompt 文本 |
| `d` / `Backspace` | 删除选定的定时任务 |
| `Escape` / `q` | 关闭管理面板 |
