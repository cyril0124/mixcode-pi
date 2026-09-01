# mpi-bash

[English](README.md)

Bash 执行策略：默认超时、前台窗口、到期自动转后台、结束自动回报，以及用 `/bash-logs` 读后台命令的完整日志。

扩展用 Pi 的 `createBashToolDefinition` 配合自定义 `BashOperations` 注册自己的 `bash` 工具定义。工具参数、渲染、输出截断、`commandPrefix`、`shellPath` 以及 MixCode 每次 spawn 注入的 tab 环境变量跟 Pi 原来的一样。只改执行方式。

## 行为

| 阶段 | 发生什么 |
| --- | --- |
| `0` → 前台窗口 | 命令产生输出即实时流入对话。 |
| 命令先结束 | 工具结果携带输出与退出码，与 Pi 内置 bash 完全一致。 |
| 窗口到期 | 命令转入后台继续运行；工具结果追加句柄（pid + 日志路径）并以成功返回，本轮继续。 |
| 后台命令没有输出 | 日志静默满 60s 后，一条 `bash-detached-stall` 消息提醒模型去确认该任务，见[停滞提醒](#停滞提醒)。 |
| 后台命令结束 | 一条带退出码与末尾输出的 `bash-detached-exit` 消息追加进会话，并**开启新一轮**。 |
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

后台命令结束后，聊天里先是一行 `Background job finished` 标题，再是运行时长和命令本身；有输出时中间一条分隔线，下面是带行号的最后 10 行。上面还有输出时写 `… N lines omitted (full log at <路径>)`。

模型收到 XML 风格的完成消息。格式化器会转义命令、路径、错误和输出中的 `&`、`<`、`>`，这些值无法闭合或插入 XML 元素。

命令成功时使用 `outcome="success"`。

```xml
<bash_completion job_id="109" outcome="success">
  <summary>Background job #109 succeeded after 22s.</summary>
  <command>bun run build</command>
  <exit_code>0</exit_code>
  <log_path>/tmp/mpi-bash-109-1.log</log_path>
  <output truncated="false">Build complete.</output>
  <logs_hint>Use /bash-logs or read /tmp/mpi-bash-109-1.log for the complete output.</logs_hint>
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
  <logs_hint>Use /bash-logs or read /tmp/mpi-bash-108-1.log for the complete output.</logs_hint>
</bash_completion>
```

已转入后台的命令被超时终止时使用 `outcome="timeout"`。

```xml
<bash_completion job_id="107" outcome="timeout">
  <summary>Background job #107 timed out after 5m00s.</summary>
  <command>pytest -k slow</command>
  <log_path>/tmp/mpi-bash-107-1.log</log_path>
  <output truncated="false"></output>
  <logs_hint>Use /bash-logs or read /tmp/mpi-bash-107-1.log for the complete output.</logs_hint>
</bash_completion>
```

未知退出状态也使用 `outcome="failure"`。进程没有提供退出码时，格式化器省略 `<exit_code>`；完整日志写入失败时增加 `<log_error>`；只保留最后 2000 字节时设置 `<output truncated="true">`。聊天渲染器读取 `details`，不显示 XML 正文：

```text
 Background job finished
 ✓ 12s printf "FOREGROUND-OUTPUT"; sleep 12; printf 'done'
 ────────────────────────────────
 … 16 lines omitted (full log at /tmp/mpi-bash-1258366-1.log)
 24 │ tick 23/24 at 21:16:43
 25 │ tick 24/24 at 21:16:44
 26 │ done

 Background job finished
 ✗ 3s cargo test                                            1
 ────────────────────────────────
 18 │ FAILED tests/retry.rs

 Background job finished
 ⏱ 5m00s pytest -k slow                               timeout
```

## 停滞提醒

从转后台到结束之间模型什么都收不到，命令卡死只能等超时杀掉才暴露。提醒看的是静默，不是运行时长：持续刷输出十分钟的构建是健康的，一轮也不该花；被上报的是日志停止增长的那条。

运行中任务的日志每隔四分之一静默窗口 stat 一次，最长 15s。静默时长以日志 mtime 为准，每提醒一次，下一次的等待翻倍，因此卡死数小时的任务只会提醒几次，而不是每分钟一次：

| 静默时长 | 发生什么 |
| --- | --- |
| < `MPI_BASH_STALL_SECONDS`（默认 60s） | 不提醒。 |
| 60s | 第一次提醒。 |
| 之后 | 静默 2m、4m、8m、16m…… 每提醒一次翻倍。 |
| 出现新输出 | 阶梯重置：下一次提醒需要重新静默满 60s。 |

聊天面板沿用完成回报的布局，完成回报放退出码的位置，这里放静默时长：

```text
 Background job stalled
 ⏳ 8s printf 'connecting to build-box...'; sleep 45; …           silent 6s
 ────────────────────────────────
 connecting to build-box...
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
  <logs_hint>Use /bash-logs or tail -n 50 /tmp/mpi-bash-1258366-1.log to inspect recent output.</logs_hint>
  <stop_hint>Use kill -- -1258366 to stop the whole process group.</stop_hint>
  <action_hint>Ignore this event if long periods without output are expected for this command.</action_hint>
</bash_stall>
```

投递用 `followUp`，所以静默任务不会打断正在进行的一轮。会话空闲时它会开新一轮，由模型决定继续等还是杀掉，而不是一直阻塞到超时。同一次检查中一起到期的任务共用一条消息、一轮开销。

日志读不到的任务（tmpdir 不可写，或用户删了日志）不走这条上报路径，它的完成回报照常送达。

## 后台输出

在前台跑完的命令完全不碰磁盘：输出已经全在工具结果里。命令转入后台时，此前打印的内容一次性落盘到 `<tmpdir>/mpi-bash-<pid>-<n>.log`，之后的输出继续追加，因此那个文件就是唯一的完整记录：

| 位置 | 内容 |
| --- | --- |
| 工具结果 | 转后台之前的输出。在那一刻定稿，之后不再增长。 |
| `<tmpdir>/mpi-bash-<pid>-<n>.log` | **全部输出**，包含前台那一段。要读全就读它。 |
| 完成回报 | 最后 2000 字节，附日志路径。 |

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

预览从最新输出开始。任务还在跑时每秒重读日志，钉在尾部，标 `following`。往上滚就停住。`G` 回到尾部再跟。已结束的任务只读一次。

预览下方是可见范围，例如 `1-21/3574`。overlay 太窄时从中间丢掉快捷键提示。

按 `x`，提示变成 `kill job #<pid> and its children? y confirms, any other key cancels`。只有 `y` 会向进程组发 `SIGKILL`，和超时同一信号。结果走平常的完成回报。`q`、`Esc`、`j`、`k` 和其他键都取消，overlay 还在。已结束的任务没有 `x`，pid 可能已经给了别人。

预览最多读最后 200000 字节。跳过了前面的输出时，首行会写明。`Ctrl+E` 或 `v` 关掉 overlay，用 `$VISUAL`/`$EDITOR` 打开日志文件。编辑器占用终端时 TUI 停下，退出后再起来。编辑器起不来就发通知，把失败原因写出来。

`/bash-logs` 不把日志发给模型。记录按 Tab 隔离，跟会话一起走。

## 边界

- 转后台的命令是进程组组长，既活过本轮，也活过 `mpi` 本身。停止它请用 `kill -- -<pid>`（句柄里给出的 pid）；只杀这个 pid 会把命令自己的子进程留下。
- `mpi` 退出后，未结束的命令继续运行，但不会再送出完成回报，`timeout` 也不再生效；日志文件保留它写出的内容。
- 中止本轮会杀死仍在前台的命令；已经转入后台的命令继续运行。
- 若命令运行期间会话被替换或关闭，完成回报会被丢弃。
