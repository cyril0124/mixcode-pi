# mpi-bash

[English](README.md)

Bash 执行策略：默认超时、前台窗口、到期自动转后台、结束自动回报，以及用 `/bash-logs` 读后台命令的完整日志。

扩展通过 Pi 的 `createBashToolDefinition` 和自定义 `BashOperations` 注册 `bash` 工具。参数、渲染和输出截断使用 Pi 的实现，执行时采用 `commandPrefix`、`shellPath` 以及 MixCode 每次启动进程时注入的 tab 环境变量。

## 行为

| 阶段 | 发生什么 |
| --- | --- |
| `0` → 前台窗口 | 命令产生输出即实时流入对话。 |
| 命令先结束 | 工具结果携带输出与退出码，与 Pi 内置 bash 完全一致。 |
| 窗口到期 | 命令转入后台继续运行；工具结果追加句柄（pid + 日志路径）并以成功返回，本轮继续。 |
| 后台命令没有输出 | 日志静默满 60s 后，一条 `bash-detached-stall` 消息提醒模型去确认该任务，见[停滞提醒](#停滞提醒)。 |
| 后台命令结束 | 日志流写入完成或失败后，投递带退出码与末尾输出的 `bash-detached-exit`。模型忙碌时使用 `steer`，空闲时开启一轮。 |
| 到达 `timeout` | 命令所在进程组被杀死：前台阶段表现为 Pi 的 `Command timed out after N seconds` 错误，后台阶段则写入完成回报。 |

`timeout` 约束命令的总生命周期，含前台与后台两段。当模型传入的 `timeout` 小于前台窗口时，命令在有机会转后台之前就被杀死。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MPI_BASH_FOREGROUND_SECONDS` | `30` | 前台阻塞窗口秒数。`0` 表示完全关闭转后台：bash 一直阻塞到命令结束或被超时杀死。非数字或负数会在会话启动时直接报错。 |
| `MPI_BASH_STALL_SECONDS` | `60` | 首次[停滞提醒](#停滞提醒)所需的日志静默秒数，之后每次翻倍。`0` 完全关闭停滞提醒。非数字或负数会在扩展加载时直接报错。 |

注入的默认 `timeout` 为 `300` 秒，仅在模型省略 `timeout` 时生效。

## 可见性

只要还有命令在后台运行，编辑器上方就会出现一棵树，按开始先后列出全部后台命令：

```text
 ○ Jobs · 2 running · /bash-logs to inspect
 ├ ⠋ 1m12s bun run check · #111
 └ ⠹ 5s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done' · #222
```

标题行给出正在运行的条数，并标明 `/bash-logs` 可打开日志。每一条是 `warning` 色 spinner、`accent` 加粗的时长、`dim` 的命令，以及 pid。超出终端宽度的命令会省略，每条恰好一行。最后一条结束后组件消失。

每条转后台、完成和停滞通知都附带 `Still running: N jobs · PIDs: ... · at notification time`。这是本会话已转后台任务的快照，按开始时间排序；不包含前台命令和其他会话。刚转后台的任务计入；进程退出且标准输出、标准错误收完后从运行列表移除，即使日志还在写入也不计入。没有剩余任务时显示 `Still running: 0 jobs · at notification time`，省略 PID 列表。

模型正文和聊天界面使用同一份发送时快照。聊天中的长 PID 列表自动换行，不省略条目；任务结束后，旧通知不会跟着变化。批量停滞提醒只附带一份快照，其中也包含仍在持续输出的任务。底部组件继续显示实时状态。

后台命令结束后，聊天里先是一行 `Background job finished · PID <pid>` 标题，再是运行时长和命令本身；有输出时中间一条分隔线，下面是带行号的最后 10 行。上面还有输出时写 `… N lines omitted (full log at <路径>)`。

模型收到 XML 风格的完成消息。格式化器会转义命令、路径、错误和输出中的 `&`、`<`、`>`，这些值无法闭合或插入 XML 元素。

命令成功时使用 `outcome="success"`。

```xml
<bash_completion job_id="109" outcome="success">
  <summary>Background job #109 succeeded after 22s.</summary>
  <command>bun run build</command>
  <exit_code>0</exit_code>
  <log_path>/tmp/mpi-bash-109-1.log</log_path>
  <output truncated="false">Build complete.</output>
  <logs_hint>Read /tmp/mpi-bash-109-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 2 jobs · PIDs: 111, 222 · at notification time</running_jobs>
</bash_completion>
```

非零退出码使用 `outcome="failure"`。

```xml
<bash_completion job_id="108" outcome="failure">
  <summary>Background job #108 failed with exit code 2 after 3s.</summary>
  <command>cargo test</command>
  <exit_code>2</exit_code>
  <log_path>/tmp/mpi-bash-108-1.log</log_path>
  <output truncated="false">FAILED tests/retry.rs</output>
  <logs_hint>Read /tmp/mpi-bash-108-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 1 job · PIDs: 111 · at notification time</running_jobs>
</bash_completion>
```

已转入后台的命令被超时终止时使用 `outcome="timeout"`。

```xml
<bash_completion job_id="107" outcome="timeout">
  <summary>Background job #107 timed out after 5m00s.</summary>
  <command>pytest -k slow</command>
  <log_path>/tmp/mpi-bash-107-1.log</log_path>
  <output truncated="false"></output>
  <logs_hint>Read /tmp/mpi-bash-107-1.log for the complete output.</logs_hint>
  <running_jobs>Still running: 0 jobs · at notification time</running_jobs>
</bash_completion>
```

未知退出状态也使用 `outcome="failure"`。进程没有提供退出码时，格式化器省略 `<exit_code>`；完整日志写入失败时增加 `<log_error>`；只保留最后 2000 字节时设置 `<output truncated="true">`。聊天渲染器读取 `details`，不显示 XML 正文：

```text
 Background job finished · PID 1258366
 ✓ 12s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done'
 ────────────────────────────────
 … 16 lines omitted (full log at /tmp/mpi-bash-1258366-1.log)
 24 │ tick 23/24 at 21:16:43
 25 │ tick 24/24 at 21:16:44
 26 │ done
 Still running: 2 jobs · PIDs: 111, 222 · at notification time

 Background job finished · PID 108
 ✗ 3s cargo test                                            1
 ────────────────────────────────
 18 │ FAILED tests/retry.rs
 Still running: 1 job · PIDs: 111 · at notification time

 Background job finished · PID 107
 ⏱ 5m00s pytest -k slow                               timeout
 Still running: 0 jobs · at notification time
```

完成消息的 `details` 用 `id` 保存子进程 PID，用 `runningPids: number[]` 保存快照；任务数量直接取数组长度。停滞消息的 `details` 为 `{ jobs: StallDetails[], runningPids: number[] }`。缺少 `id`/`runningPids` 的已存储完成消息，以及仅含 `StallDetails[]` 的已存储停滞消息仍能渲染，不补造运行数量。

## 停滞提醒

停滞提醒针对日志持续没有变化的后台命令，不以总运行时长作为触发条件。

检查间隔为静默窗口的四分之一，最短 500ms，最长 15s。仅在会话空闲时检查日志。忙碌期间，定时器只标记一次待检查；排队消息、重试和压缩结束后，由 Pi 的 `agent_settled` 事件触发检查。每个会话同时最多执行一次检查。

静默时长从日志的 mtime 起算。提醒间隔按以下规则调整：

| 条件 | 结果 |
| --- | --- |
| 静默未满 `MPI_BASH_STALL_SECONDS`，默认 60s | 不提醒。 |
| 静默达到阈值 | 在下一次空闲检查时具备提醒条件。 |
| 提醒已投递 | 下一次等待翻倍；默认阈值下依次为 2m、4m、8m、16m…… |
| 出现新输出 | 等待间隔重置为 `MPI_BASH_STALL_SECONDS`。 |

聊天面板沿用完成回报的布局，完成回报放退出码的位置，这里放静默时长：

```text
 Background job stalled · PID 1258366
 ⏳ 8s printf 'connecting to build-box...'; sleep 45; …           silent 6s
 ────────────────────────────────
 connecting to build-box...
 Still running: 2 jobs · PIDs: 1258366, 1258367 · at notification time
```

模型收到 `<bash_stall>`。其中包含任务编号、命令、静默时长、总运行时长、日志最后 2000 字节中的至多三行非空输出，以及查看日志和终止进程的命令。如果截取起点落在一行中间，第一行可能不完整：

```xml
<bash_stall job_id="1258366">
  <summary>Background job #1258366 may be stuck after 5m02s of silence.</summary>
  <command>ssh build-box make release</command>
  <silence>5m02s</silence>
  <elapsed>8m14s</elapsed>
  <log_path>/tmp/mpi-bash-1258366-1.log</log_path>
  <output>Compiling serde v1.0.219</output>
  <logs_hint>Use tail -n 50 /tmp/mpi-bash-1258366-1.log to inspect recent output.</logs_hint>
  <stop_hint>Use kill -- -1258366 to stop the whole process group.</stop_hint>
  <action_hint>Ignore this event if long periods without output are expected for this command.</action_hint>
</bash_stall>

  <running_jobs>Still running: 2 jobs · PIDs: 1258366, 1258367 · at notification time</running_jobs>
```

共用的 `<running_jobs>` 元素放在本消息全部 `<bash_stall>` 元素之后。

发送 `followUp` 提醒前，扩展再次确认会话空闲、任务仍在运行。检查使用当前日志状态，不在忙碌期间排入提醒文本。读取日志期间会话变忙时，延后投递，提醒间隔不变。仍满足条件的任务共用一条消息、一轮模型调用。会话关闭时取消待检查工作。

日志读不到的任务（tmpdir 不可写，或用户删了日志）不走这条上报路径，它的完成回报照常送达。

## 后台输出

在前台跑完的命令完全不碰磁盘：输出已经全在工具结果里。命令转入后台时，此前打印的内容一次性落盘到 `<tmpdir>/mpi-bash-<pid>-<n>.log`，之后的输出继续追加，因此那个文件就是唯一的完整记录：

| 位置 | 内容 |
| --- | --- |
| 工具结果 | 转后台之前的输出。在那一刻定稿，之后不再增长。 |
| `<tmpdir>/mpi-bash-<pid>-<n>.log` | **全部输出**，包含前台那一段。要读全就读它。 |
| 完成回报 | 最后 2000 字节，附日志路径。 |

进程退出且标准输出、标准错误收完后，从运行列表移除。等待日志写完期间，`/bash-logs` 禁用终止操作。日志流写入完成或失败后才发送完成通知；通知到达时，日志已写入完毕，或通知中包含 `logError`。命令耗时不包含这段写入等待。

转后台命令的日志在命令结束后仍然保留，`/bash-logs` 才能继续打开它；超过七天的日志会在会话启动时清理。若日志写不进去，完成回报会写明失败原因，命令本身继续运行。

前台那一段由内存回放写入，缓冲上限 4 MB。命令在转后台前打印超过这个量时，最早的输出会丢失，日志首行为 `[mpi-bash] earlier output dropped`。

## `/bash-logs`

`/bash-logs` 列出本会话转入后台的命令。运行中的在前，然后是最近 50 条已结束的。overlay 上段是列表，下段是选中任务的实时日志，大约占终端高度的 60%。行按 pid 区分，同一条命令跑两次就是两行。

```text
╭ 2/4 running ── Bash logs ─────────────────────────────────────────╮
│> ● running     10s  #111  printf "FOREGROUND-OUTPUT"; sleep 12    │
│  ✓ exit 0      22s  #109  bun run build                           │
│  ✗ exit 1       3s  #108  cargo test                              │
│  ⏱ timeout   5m00s  #107  pytest -k slow                          │
│───────────────────────────────────────────────────────────────────│
│  24  tick 23/24 at 21:16:43                                       │
│  25  tick 24/24 at 21:16:44                                       │
│  26  Compiling serde v1.0.219                                     │
│  following  24-31/40  (J/K scroll)                                │
├───────────────────────────────────────────────────────────────────┤
│  j/k move  J/K scroll  g/G top/bot  ^e editor  x kill  q close    │
╰───────────────────────────────────────────────────────────────────╯
```

overlay 只读，例外是 `x`：杀掉还在跑的任务。行号来自日志。一行太长就折到下一行，行号位留空。

| 按键 | 作用 |
| --- | --- |
| `j` / `k` | 下一条 / 上一条任务 |
| `J` / `K` | 预览下 / 上一行 |
| `↓` / `↑` | 预览下 / 上一行 |
| `Ctrl+D` / `Ctrl+U` | 预览半页 |
| `Ctrl+F` `PgDn` `Space` / `Ctrl+B` `PgUp` | 预览整页 |
| `g` `Home` / `G` `End` | 预览首部 / 尾部 |
| `Ctrl+E` `v` | 关闭 overlay，用 `$VISUAL`/`$EDITOR` 打开当前日志 |
| `x` | 确认后杀掉选中的运行中任务 |
| `q` `Esc` | 关闭 |

预览从最新输出开始。任务仍在运行或日志尚在收尾时，每秒重读日志，钉在尾部，标 `following`。往上滚就停住。`G` 回到尾部再跟。日志收尾完成后，预览做最后一次读取，然后停止刷新。

预览下方是可见范围，例如 `1-21/3574`。overlay 太窄时从中间丢掉快捷键提示。

按 `x`，提示变成 `kill job #<pid> and its children? y confirms, any other key cancels`。只有 `y` 会向进程组发 `SIGKILL`，和超时同一信号。结果走平常的完成回报。`q`、`Esc`、`j`、`k` 和其他键都取消，overlay 还在。已结束的任务没有 `x`，pid 可能已经给了别人。

预览最多读最后 200000 字节。跳过了前面的输出时，首行会写明。`Ctrl+E` 或 `v` 关掉 overlay，用 `$VISUAL`/`$EDITOR` 打开日志文件。编辑器占用终端时 TUI 停下，退出后再起来。编辑器起不来就发通知，把失败原因写出来。

`/bash-logs` 不把日志发给模型。记录按 Tab 隔离，跟会话一起走。

## 边界

- 转后台的命令是进程组组长，既活过本轮，也活过 `mpi` 本身。停止它请用 `kill -- -<pid>`（句柄里给出的 pid）；只杀这个 pid 会把命令自己的子进程留下。
- `mpi` 退出后，未结束的命令继续运行，但不会再送出完成回报，`timeout` 也不再生效；日志文件保留它写出的内容。
- 中止本轮会杀死仍在前台的命令；已经转入后台的命令继续运行。
- 若命令运行期间会话被替换或关闭，完成回报会被丢弃。
