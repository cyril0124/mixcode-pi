# MixCode Pi

[English](README.md)

基于 [Pi](https://pi.dev) 的**多 Tab** 终端原生 AI 编程助手。

**兼容 Pi 扩展** — 可用 Pi 扩展生态（`settings.json` 的 `packages`、agent `extensions/`、widget、tools、slash 命令）。MixCode 另带第一方 `mpi-*` 内置扩展。`--builtin-extensions-only` 时只加载这些内置项。

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="MixCode Pi 多 Tab 工作台" width="900">
</p>

## 快速开始

需要 [Bun](https://bun.sh)。从 GitHub 全局安装（无需手动 clone；**仓库须公开**）：

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

请把 `~/.bun/bin` 加入 `PATH`。升级用同一条命令；卸载：`bun remove -g mixcode-pi`。

## 特性

### 多 Tab 会话

并行多个 agent 对话。新建 Tab，用 `Tab` / `Shift+Tab` 切换，或 `Ctrl+T` 跳转。

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="多 Tab 会话" width="900">
</p>

### Vim 模式

像编辑缓冲区一样浏览对话：进入 Vim 模式后在用户消息间跳转。

<p align="center">
  <img src="assets/readme-vim.gif" alt="Vim 模式" width="900">
</p>

### Zen 模式

隐藏 Tab 栏，专注当前 agent。需要切会话时仍可用 `Ctrl+T`。

<p align="center">
  <img src="assets/readme-zen.gif" alt="Zen 模式" width="900">
</p>

### Command Palette

`Ctrl+P` 按当前 Tab 语境过滤命令与 slash 操作。

<p align="center">
  <img src="assets/readme-command-palette.gif" alt="Command Palette" width="900">
</p>

### 扩展侧栏

编辑器为空时按 `Right` 打开扩展 widget 侧栏（演示：pi-tasks 任务列表）。

<p align="center">
  <img src="assets/readme-right-widget.gif" alt="扩展侧栏" width="900">
</p>

### Skill 引用

输入 `$` 引用项目 skill。

<p align="center">
  <img src="assets/readme-skill.gif" alt="Skill 引用" width="900">
</p>

### Pi 扩展兼容

兼容 [Pi](https://pi.dev) 扩展：通过 Pi 的 package 设置安装（`npm:…` / git 包），从 agent 的 extensions 目录加载，tools / widgets / commands 与 Pi 一致。

## 快捷键

高频键速查（完整列表见应用内 **Help** / Command Palette）：

| 按键 | 作用 |
|------|------|
| `Tab` / `Shift+Tab` | 下一个 / 上一个 Tab |
| `Ctrl+P` | Command Palette |
| `Ctrl+T` | Tab Jump |
| `Right`（输入为空） | 切换扩展侧栏 / Home 下 attach |
| `Ctrl+Q` | 退出 |
| `Escape` | 关闭浮层 |
| `!` | Bash 命令 |
| `$` | Skill 补全 |
| `/toggle-zen-mode` | Zen 模式 |
| `/vim` 或空队列 `Ctrl+U` 再 `u` | Vim 模式 |
| `/new-session` / `/new-session 标题` | 新建会话（可选标题） |

## 安装

### 从 GitHub（推荐）

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

仓库必须是 **public**（private 会 API 404）。升级用同一条命令。卸载：`bun remove -g mixcode-pi`。

### 本地仓库

```bash
./install.sh                 # 独立二进制 → ~/.local/bin/mpi
./install.sh --prefix /opt/mixcode
bun run install:global       # 从当前目录全局安装 `mpi`
```

- `bun install -g github:…` — Bun 直接跑 TypeScript 入口（`mpi`）；需要 Bun 在 `PATH` 中。
- `./install.sh` — `bun build --compile` 单文件；运行时不需要 `node_modules`。

**开发：** `bun install`（锁文件：`bun.lock`）。脚本统一 `bun run …`（例如 `bun run check`）。

## 使用

```bash
mpi                             # 在当前目录启动
mpi --workdir ~/project         # 指定工作目录
mpi --builtin-extensions-only   # 仅加载 MixCode 内置扩展
```

`--builtin-extensions-only` 只关闭第三方 Pi extensions；skills、prompts、themes 和上下文文件仍按现有配置加载。

## 配置

MixCode 设置位于根状态目录（默认是 `~/.pi/agent/mixcode-pi/mixcode_settings.json`）。Pi 兼容的 packages、themes、skills、auth 仍走 Pi 的 agent 目录（`settings.json`、`packages` 等）。
