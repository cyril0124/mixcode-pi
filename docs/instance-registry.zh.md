# 实例注册表与状态监控 (Instance Registry)

[English Documentation](instance-registry.md)

MixCode 在状态目录下维护活跃终端进程与其 Tab 状态的实例注册表：

```text
~/.pi/agent/mixcode-pi/instances/<pid>.json
```

## CLI 状态查询命令

使用 `mpi status` 命令检视所有运行中的 MixCode 进程与活跃 Tab：

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- 表格输出中，`A` 列的 `*` 标识当前获得焦点（focused）的活跃 Tab。
- `TAB_TITLE` 列显示各 Tab 的标题。
- `--workdir <path>` 按实例根 workdir 精确过滤（支持 `~`、相对路径、绝对路径）。

## 快照字段 Schema

每个运行中的实例定期写入心跳快照：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number (`1`) | 实例快照 Schema 版本。 |
| `pid` | number | 宿主系统进程 PID。 |
| `workdir` | string | 进程启动时的根工作目录。 |
| `activeTabId` | string | 当前 UI 获得焦点的 Tab ID。 |
| `updatedAt` | string (ISO) | 心跳时间戳（每 5,000 ms 更新一次）。 |
| `tabs` | array | Tab 快照列表（索引、Session ID、标题、状态、工作目录、waitingForInputCount）。 |

## Tab 运行状态推导

快照中的每个 Tab 会自动推导为以下五种运行状态之一：

```text
               ┌──> working（正在运行 / 正在思考）
               │
               ├──> waiting-for-input（extension UI 等待输入）
Tab Snapshot ──┼──> error（轮次执行失败）
               │
               ├──> finished（已完成且包含未读结果）
               │
               └──> idle（空闲就绪）
```

## 僵尸进程与过期快照清理

因异常终止残留的无主快照由清理机制自动回收：
- 心跳时间 `updatedAt` 超过 `15,000 ms` 被视为过期。
- 通过 `kill(pid, 0)` 确认进程是否仍存活。
- 启动新实例或执行 `mpi status` 时会自动清理无效快照文件。
