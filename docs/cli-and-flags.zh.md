# CLI 入口、参数选项与上游委托 (CLI & Flags)

[English Documentation](cli-and-flags.md)

本文档记录 `src/cli/main.ts` 中实现的 CLI 命令行接口、参数选项及上游 Pi 委托规则。

## 命令用法概要

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
mpi ctl [--pid <n> | --workdir <path>] [--focus-tab <title> | --focus-session <id>] <command>
```

## 选项参数清单

| 参数 | 类型 | 默认值 | 作用说明 |
|---|---|---|---|
| `--workdir <path>` | string | 当前工作目录 (`process.cwd()`) | 指定工作目录。也接受 `--workdir=<path>`。没有 `-w` 短选项。 |
| `--builtin-extensions-only` | boolean | `false` | 禁用 `settings.json` `packages` 中配置的第三方扩展，仅加载 `pi-packages/mpi-*` 下的第一方内置扩展。 |
| `--batch <script.lua>` | string | 未设置 | 启动运行时后执行指定的 Lua 批量自动化脚本。 |
| `--batch-dry-run` | boolean | `false` | 仅校验模型与思考配置并打印批量执行计划，不启动 TUI，不写入任何状态文件。 |
| `--help`, `-h` | boolean | `false` | 打印命令行帮助文本并立即退出。 |

## `status` 子命令

检视机器上所有正在运行的 MixCode 实例与 Tab 运行状态：

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- `--json`：输出与表格字段一致的机器可读 JSON（`pid`、`workdir`、`activeTabTitle`、tabs）。
- `--workdir <path>`：仅保留实例根 workdir 与解析后路径完全相等的进程。相对路径相对当前工作目录解析。`~` 与 `~/...` 展开为家目录。也接受 `--workdir=<path>`。
- `status` 命令运行在独立的轻量路径上，直接读取实例注册表，不启动 TUI、不导入 Pi 运行时组件，编译版亦不释放二进制资产。

## `ctl` 子命令

通过每个进程的 Unix socket（`<agentDir>/mixcode-pi/instances/<pid>.sock`）控制一台已打开的 MixCode TUI。

```bash
mpi ctl last-message
mpi ctl last-assistant-message
mpi ctl last-user-message
mpi ctl last-tool
mpi ctl wait --timeout 60
mpi ctl --pid 4104920 dump-screen
mpi ctl --workdir ~/proj send-keys /compact Enter
mpi ctl send-keys --literal Enter
```

- 选实例：`--pid` 与 `--workdir` 互斥（`--workdir` 解析规则与 `status` 相同）；都未给则用当前工作目录。0 个匹配、或多个匹配且未给 `--pid` 时非 0 退出。
- 每个命令先打头再空一行：`tab:`、`session:`；未给 `--focus-tab`/`--focus-session` 时才有 `reason:`。`last-message` / `last-assistant-message` / `last-user-message` 每条消息先是 `----------`，再是 `time:`（本地时间 `YYYY-MM-DD HH:MM:SS ±HH:MM`，没有则为 `unknown`），然后是正文。`last-message` 另打 `role:`，user 和 assistant 都算。`last-tool` 打 `tool:` / `status:` / 可选 `command:` / `time:`，然后是 tool 或 `!bash` 输出。可选 `--from <n> --to <m>`（必须成对）从末尾 1-based 取闭区间（`1` 是最新；按角色的命令只数该角色），按时间正序打印。条数不够时有多少打多少，头里加 `messages: N (requested A-B)`。Home 上 last-message / last-tool 先把头发到 stdout，再在 stderr 失败。
- `wait`：挡住直到聚焦的 agent tab 不是 `running`/`thinking`，或在等输入（`pendingDialogs` / extension UI）。一定有超时：`--timeout <sec>` 默认 60；`0` 只查一次。打 `status:`（`finished` / `wait-for-input` / `error`；超时则是 `running`/`thinking`）和 `timeout:`。超时先打这两行再失败。Home 没有 agent run。
- `dump-screen`：用 `renderAgentSurface` / `renderConfig` 拼出的文本，不是 PNG / 终端像素缓冲。客户端默认去掉 ANSI 和行尾空格；`--ansi` 保留颜色。两种模式都会去掉行尾空格。
- `--focus-tab <title>` 与 `--focus-session <id>` 互斥。标题精确匹配；重名必须用 `--focus-session`。`--focus-session home` 切到 Home。
- `send-keys`：把 tmux 风格按键注入与键盘同一条输入通路（`Enter`、`Escape`、`Tab`、`BSpace`、方向键、`C-a`…`C-z`、`M-x`、以及普通字符串）。可选先切 tab，再打到该 tab。`--literal` / `-l` 关闭键名映射。
- 任一 agent tab 为 `Not Ready` 时，所有 `ctl` 命令失败（`Tab is still loading extensions. Please wait a moment.`），包括打 Home。
- `ctl` 与 `status` 一样走轻量启动路径（不 boot TUI；编译包跳过 materialize）。
- `last-message`、`last-assistant-message`、`last-user-message`、`last-tool`、`dump-screen` 超过 8192 字节时 stdout 只留前 4096 字节，全文写到 `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt`（权限 `0600`）。`send-keys` 和 `wait` 不截断。

## 上游 Pi 自动委托机制

仅当参数包含 `--print` 或 `-p` 时，MixCode 会把调用转给 `$PATH` 上的上游 `pi`：
- 委托进程中不会设置 `MIXCODE` 环境变量。
- 完整透传参数与退出码（Exit Code）。
