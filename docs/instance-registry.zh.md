# 实例注册表与状态监控 (Instance Registry)

[English Documentation](instance-registry.md)

MixCode 在状态目录下维护活跃终端进程与其 Tab 状态的实例注册表：

```text
~/.pi/agent/mixcode-pi/instances/<hostname>/<pid>.json    # 心跳快照
~/.pi/agent/mixcode-pi/instances/<hostname>/<pid>.sock    # mpi ctl socket
```

注册表按主机（`os.hostname()`）隔离：状态目录可能位于多台机器共享的 NFS 家目录上，而以 pid 命名的文件、`kill(pid, 0)` 存活探测和 Unix socket 都只在创建它们的主机上有意义。每台主机只读取并清理自己的子目录。

## CLI 状态查询命令

使用 `mpi status` 命令检视所有运行中的 MixCode 进程与活跃 Tab：

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- 表格输出中，`A` 列的 `*` 标识当前获得焦点（focused）的活跃 Tab。
- `TAB_TITLE` 列显示各 Tab 的标题。
- `LAST` 列以紧凑时长（`12s` / `4m` / `3h` / `2d`）显示每个 Tab 的最近活动时间，无法判定时显示 `-`；头行的 `last:` 是该实例所有 Tab 中最新的一次活动。
- `started` 显示实例（进程）的启动时间，本地时区 `YYYY-MM-DD HH:MM` 格式。
- Home 页聚焦时头行显示 `focus: home`；tab 聚焦仍由行内 `*` 标识，因此名为 `home` 的 tab 聚焦不会触发头行标记。
- `--json` 中 `focus` 为 `"home"` / `"tab"`（未知时省略），`activeTabTitle` 仅在 `focus` 为 `"tab"` 时出现，每个 Tab 还可带 `lastActivity`（ISO，未知时省略）。
- `--workdir <path>` 按实例根 workdir 精确过滤（支持 `~`、相对路径、绝对路径）。

### 最近活动时间

`LAST` 列、头行 `last:` 与 `--json` 的 `lastActivity` 都是**读取时推导**的，不存入快照：

```text
tabs[].sessionId + tabs[].workdir
        │
        ▼
<agentDir>/sessions/<encoded-workdir>/<createdAt>_<sessionId>.jsonl  ── stat mtime ──> lastActivity
```

会话转录文件是追加写的，其 mtime 恰好在该会话写入一轮对话、工具调用或会话信息变更时推进。快照自身的 `updatedAt` 不能承担这个职责：它是 5 秒心跳，空闲实例也会永远显示“刚刚”。若本机上不存在该 Tab 的转录文件（从未落盘、已删除，或属于另一台机器），显示 `-` 而不是猜测值。

由于是读取时推导，快照 Schema 与 `INSTANCE_REGISTRY_VERSION` 均未改动。只关心存活性的调用方（`mpi ctl`、peer tab sync）不传入活动时间读取器，因此不产生额外文件系统开销。

## 快照字段 Schema

每个运行中的实例定期写入心跳快照：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number (`1`) | 实例快照 Schema 版本。 |
| `pid` | number | 宿主系统进程 PID。 |
| `workdir` | string | 进程启动时的根工作目录。 |
| `activeTabId` | string | 当前 UI 获得焦点的 Tab ID。 |
| `createdAt` | string (ISO) | 实例（进程）启动时间；进程生命周期内固定不变。 |
| `updatedAt` | string (ISO) | 心跳时间戳（每 5,000 ms 更新一次）。 |
| `tabs` | array | Tab 快照列表（索引、Session ID、标题、状态、工作目录、waitingForInputCount）。 |

输出中的所有最近活动时间均在读取时由会话转录文件推导，快照中没有任何字段承载它。

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

因异常终止残留的无主文件由清理机制自动回收：
- 心跳时间 `updatedAt` 超过 `15,000 ms` 被视为过期。
- 通过 `kill(pid, 0)` 确认进程是否仍存活（注册表按主机隔离后该判断是可信的）。
- 启动新实例或执行 `mpi status` 时会自动清理无效快照文件。
- 清理同时回收属主 pid 已死亡的 `<pid>.sock` 与 `<pid>.json.<pid>.<uuid>.tmp` 残留（被 SIGKILL 的实例不会执行退出清理）。

## Ctl Socket 自愈

ctl socket 在启动时绑定，并在每次心跳时复查：若 socket 文件缺失（NFS 瞬时 bind 失败、被外部删除），实例会销毁旧 server 并在一个心跳周期内重新绑定。`mpi ctl server unavailable` 通知每次故障期间只显示一次。
