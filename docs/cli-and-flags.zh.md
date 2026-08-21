# CLI 入口、参数选项与上游委托 (CLI & Flags)

[English Documentation](cli-and-flags.md)

本文档记录 `src/cli/main.ts` 中实现的 CLI 命令行接口、参数选项及上游 Pi 委托规则。

## 命令用法概要

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
mpi ctl [--pid <n> | --workdir <path>] [--tab <title> | --session <id> | --focus-tab <title> | --focus-session <id>] <command>
mpi commands [--json] [--workdir <path>]
mpi install-extensions [--yes]
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

- `--json`：输出与表格字段一致的机器可读 JSON（`pid`、`workdir`、`createdAt`、`focus`、`activeTabTitle`、tabs）。`focus` 在 Home 页聚焦时为 `"home"`，tab 聚焦时为 `"tab"`，未知时省略；`activeTabTitle` 仅在 `focus` 为 `"tab"` 时出现。
- `--workdir <path>`：仅保留实例根 workdir 与解析后路径完全相等的进程。相对路径相对当前工作目录解析。`~` 与 `~/...` 展开为家目录。也接受 `--workdir=<path>`。
- `status` 命令运行在独立的轻量路径上，直接读取实例注册表，不启动 TUI、不导入 Pi 运行时组件，编译版亦不释放二进制资产。

## `ctl` 子命令

通过每个进程的 Unix socket（`<agentDir>/mixcode-pi/instances/<hostname>/<pid>.sock`）控制一台已打开的 MixCode TUI。

TUI 会在首帧渲染后立即启动该 ctl 服务。若启动失败（状态目录上的瞬时文件系统错误、bind 失败），TUI 会显示 `mpi ctl server unavailable: …` 通知并在无 socket 的状态下继续运行，直到重启；此时对该 pid 执行 `mpi ctl` 会连接失败。TUI 进入备用屏后抛出的致命启动错误还会追加写入 `<agentDir>/mixcode-pi/startup-crash.log`（此时仅有 stderr 是不可见的）。

```bash
mpi ctl last-message
mpi ctl last-assistant-message
mpi ctl last-user-message
mpi ctl last-tool
mpi ctl wait --timeout 60
mpi ctl --pid 4104920 dump-screen
mpi ctl --workdir ~/proj send-keys /compact Enter
mpi ctl send-keys --literal Enter
mpi ctl --tab Agent-01 send-prompt <<'EOF'
line1
line2
EOF
```

- 选实例：显式 `--pid` 或 `--workdir` 优先（二者互斥；`--workdir` 解析规则与 `status` 相同），其次使用已设置的 `MIXCODE_PID`，最后使用当前工作目录。非法或失效的 `MIXCODE_PID` 会失败；0 个匹配或 cwd/workdir 匹配到多个实例时非 0 退出。
- 每个命令先打头再空一行：`tab:`、`session:`；未给 `--tab` / `--session` / `--focus-tab` / `--focus-session` 时才有 `reason:`。`last-message` / `last-assistant-message` / `last-user-message` 每条消息先是 `----------`，再是 `time:`（本地时间 `YYYY-MM-DD HH:MM:SS ±HH:MM`，没有则为 `unknown`），然后是正文。`last-message` 另打 `role:`，user 和 assistant 都算。`last-tool` 打 `tool:` / `status:` / 可选 `command:` / `time:`，然后是 tool 或 `!bash` 输出。可选 `--from <n> --to <m>`（必须成对）从末尾 1-based 取闭区间（`1` 是最新；按角色的命令只数该角色），按时间正序打印。条数不够时有多少打多少，头里加 `messages: N (requested A-B)`。Home 上 last-message / last-tool 先把头发到 stdout，再在 stderr 失败。
- `wait`：挡住直到聚焦的 agent tab 不是 `running`/`thinking`，或在等输入（extension UI 或会抢焦点的 MixCode app overlay，例如 Y/N 确认框、picker；不包括 Notice/Error）。一定有超时：`--timeout <sec>` 默认 60；`0` 只查一次。客户端套接字会等到 `--timeout` 再加 5 秒。打 `status:`（`finished` / `wait-for-input` / `error`；超时则是 `running`/`thinking`）和 `timeout:`。超时先打这两行再失败。Home 没有 agent run。
- `dump-screen`：未点名或 `--focus-*` 时 dump 活 TUI 帧。`--tab` / `--session` 只 dump 该 tab 的 chat 表面（不要 workspace 的 tab bar / footer）。然后附上该 tab 的 extension custom overlay（`ctx.ui.custom`）和当前 MixCode app overlay（`showLinesOverlay` / `showComponentOverlay`，包括 Y/N 确认框和 Notice）。不是 PNG。主界面按活 TUI 宽度画；overlay 用 `max(活宽度, 100)`，窄 pane 也能看清对话框。`--width <n>` 两者一起改。客户端默认去掉 ANSI 和行尾空格；`--ansi` 保留颜色。
- `--tab <title>` / `--session <id>` 只点名、不改 UI 焦点。`--focus-tab` / `--focus-session` 点名并留下焦点。四个旗标互斥。标题精确匹配；重名（resume 后仍可能出现）用 `--session` 或 `--focus-session`。见 [Tab 标题](workspace-and-tabs.zh.md#tab-标题)。`home` 是 Home。
- `send-keys`：当前焦点或 `--focus-*` 时，按键注入键盘通路（`Enter`、`Escape`、`Tab`、`BSpace`、方向键、`C-a`…`C-z`、`M-x`、普通字符串）。`--tab` / `--session` 只允许文本和 `Enter`：`Enter` 按 Home 发送路径提交（不改 `activeTabId`）；没回车的文本追加 `draftInput`。接受后立刻 ACK。UI 键要用 `--focus-tab`。`--literal` / `-l` 关闭键名映射。
- `send-prompt [text...]`：把参数拼成一段正文（单个参数里的换行会保留）。没有正文或只有 `-` 时读 stdin（heredoc/管道）。stdin 是 TTY 且没给正文则报错。Home 失败。接受后立刻 ACK；不截断。有 `MIXCODE_TAB_TITLE` 时，普通提问会加一段英文说明：这是另一个 MixCode tab 经 ctl 发来的，不是用户手打；若同时有 `MIXCODE_PID`，来源行还会附发送方实例 pid（`(title, pid <n>)`）。`--expect-response` 再附上 mpi-ctl skill 绝对路径（`<agentDir>/extensions/mpi-ctl/skills/mpi-ctl/SKILL.md`）和 `` `mpi ctl` --pid <发送方 pid> --tab <title> send-prompt `` 回信命令（无 `MIXCODE_PID` 时省略 `--pid`）；需要 `MIXCODE_TAB_TITLE`，`/` 或 `!` 行会失败。普通终端（没 title）原文提交。`--tab` 的 send-keys 提交只加短说明。编辑器手打的字不加。
- 目标 agent tab 为 `Not Ready` 时，该条 `ctl` 命令失败（`Tab is still loading extensions. Please wait a moment.`）。其它 tab 和 Home 仍可用。
- `ctl` 与 `status` 一样走轻量启动路径（不 boot TUI；编译包跳过 materialize）。
- `last-message`、`last-assistant-message`、`last-user-message`、`last-tool`、`dump-screen` 超过 8192 字节时 stdout 只留前 4096 字节，全文写到 `/tmp/mpi-ctl-<pid>-<command>-<ms>.txt`（权限 `0600`）。提示：`[Full output: <path>. Truncated: N lines shown (4.0KB limit)]`。`send-keys`、`send-prompt` 和 `wait` 不截断。

## Commands 子命令

列出这个 workdir 会注册的 slash 命令（不启动 TUI）。

```bash
mpi commands
mpi commands --json --workdir ~/proj
```

- 打印 `/name` 和可选 `argumentHint`，再打印 description。包含 MixCode 本地命令、扩展 `registerCommand`、prompt 模板。不列出 `/skill:*`。
- `--json` 为 `{ name, usage, description, source, path? }` 数组，`source` 为 `local` | `extension` | `prompt`。扩展和 prompt 的 `path` 是 Pi `sourceInfo.path`（扩展文件或包目录）。同名时本地命令优先。
- 按 TUI 同一套 `agentDir` 加载扩展和 skill。不走 status/ctl 快路径。

## Install-Extensions 子命令

安装推荐的第三方 Pi 扩展（推荐列表唯一归属：`src/cli/install-extensions.ts`）：

```bash
mpi install-extensions          # 交互多选缺失的扩展
mpi install-extensions --yes    # 无提示安装全部缺失项
```

- 安装走 pi-coding-agent 公开的 `DefaultPackageManager` 进程内执行（与 `pi install` 同一代码路径），不依赖外部 `pi` CLI。安装成功后写入全局 `settings.json` `packages`。
- 已在 `settings.json` `packages` 中的扩展会被跳过。
- 未知参数以退出码 1 失败。
- 任一选中项安装失败时退出码为 1。
- 仓库内同一流程由 `bun install` postinstall / `bun run install:extensions`（`scripts/install-pi-extensions.ts`）触发。

### 首次运行提示（编译 binary）

编译 binary 交互启动时一次性询问是否安装全部缺失的推荐扩展：

- 仅当同时满足：运行编译 binary、stdin 与 stdout 均为 TTY、未设置 `PI_OFFLINE`、标记文件不存在、且至少有一个推荐扩展缺失。
- 只问一次：标记文件 `<agentDir>/mixcode-pi/extensions-prompt-asked` 在弹出询问前写入，拒绝或中断都不会再次询问；之后仍可随时运行 `mpi install-extensions`。
- 源码（仓库）安装不会看到此提示；该场景由 postinstall 负责。

## 上游 Pi 自动委托机制

仅当参数包含 `--print` 或 `-p` 时，MixCode 会把调用转给 `$PATH` 上的上游 `pi`：
- 委托进程中不会设置 `MIXCODE` 环境变量。
- 完整透传参数与退出码（Exit Code）。
