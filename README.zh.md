# MixCode Pi (`mpi`)

[English](README.md)

基于 [Pi](https://pi.dev) 的**多 Tab** 终端原生 AI 编程助手，全面兼容 Pi 扩展生态。Pi 是一款开放、可扩展的终端 AI 编程助手——MixCode 原生运行其完整包生态。

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/cyril0124/mixcode-pi" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/github/package-json/v/cyril0124/mixcode-pi" alt="Version"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-black" alt="Bun"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/Pi-compatible-blue" alt="Pi compatible"></a>
</p>

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="MixCode Pi 多 Tab 工作台" width="900">
</p>

> **为什么选择 MixCode Pi？**
> 传统终端 AI 编程助手通常受限于单会话模型——在模型生成代码、执行长任务或跑测试期间，终端会被完全占用，开发者无法同时开展探索、审查或多模块并行工作。MixCode 为终端带来原生多 Tab 并发、Agent Tab 协作与完整的 Pi 扩展生态兼容：并行多个独立 Agent 会话，Tab 之间互相派活，跨重启持久化工作区，并直接使用完整的 Pi 包生态（`npm:…`、自定义工具、挂件与 Slash 指令）。

## 核心亮点

- **原生多 Tab 并发。** 多个 Agent 会话并行运行，实时显示状态指示。
- **Agent Tab 协作。** Tab 之间互发 Prompt、等待完成并收集回复（`mpi ctl`）。
- **Pi 扩展生态兼容。** 运行完整 Pi 包生态与第一方 `mpi-*` 扩展。
- **Zen 专注与内联挂件。** 隐藏界面元素获得专注视图，或将挂件移入对话流。
- **窄屏与移动触控优化。** 适配窄终端、分屏与移动 SSH 客户端（Termux、iOS Blink）。
- **终端优先交互流。** Vim 式对话导航、命令面板、`$skill` / `@file` / `@tab` 自动补全。
- **声明式 Batch 自动化。** 用 Lua 或 TypeScript 脚本批量派发多 Agent 任务，支持 Dry-run 预览。

---

## 快速开始

需要 [Bun](https://bun.sh)。通过克隆仓库并执行安装脚本进行安装：

```bash
git clone https://github.com/cyril0124/mixcode-pi.git
cd mixcode-pi
./install.sh
mpi
```

如果偏好直接软链本地开发源码，也可在克隆目录下运行 `bun run install:global`。请确保 `~/.local/bin`（或开发软链对应的 `~/.bun/bin`）在 `PATH` 中。后续升级在仓库目录下执行 `git pull && ./install.sh` 即可。

模型与凭证直接复用 Pi 的标准配置：`~/.pi/agent/models.json`（模型与自定义端点）加 `auth.json`（API 密钥）。内置 provider 直接在 `mpi`（或 `pi`）里执行 `/login`，支持订阅 OAuth 登录或录入 API 密钥，无需手写配置；凭证与 Pi 共享，已有 Pi 配置开箱即用——详见 [模型管理](docs/model-management.zh.md)。

---

## 核心特性

### 1. 多 Tab 工作区与跨实例协同
用 `Tab` / `Shift+Tab` 切换，或按 `Ctrl+T` 全屏模糊跳转；后台 Tab 实时展示状态指示符（`●` 运行中、`!` 完成未读、`x` 错误）。各 Tab 维护独立的会话分支树、工具运行时与工作目录。工作区自动持久化 Tab 布局与焦点状态，跨进程原子文件锁（`open_tabs.json.lock`）支持在多个终端窗口或 tmux 窗格间安全协同。

### 2. Agent Tab 协作
Tab 之间可以直接对话——同一 TUI，或其他 `mpi` 进程——无需抢键盘。一个 Tab 把审查或验证委派给同伴，等待完成后读取回复。内置 `mpi-ctl` 技能把 `mpi status` / `mpi ctl` 交给 agent 的 bash 工具。命令循环见 [Agent Tab 协作](#agent-tab-协作)。

### 3. 完整 Pi 生态与内置第一方扩展
直接通过 Pi 包配置（`settings.json` `packages`，如 `npm:pi-web-access`）安装社区扩展——含自定义工具、挂件与主题——或直接使用 MixCode 内置工具：
- **`mpi-goal`**：自主目标追踪引擎，支持渐进式动态工具暴露与执行预算。
- **`mpi-diff-viewer`**：终端视觉 Diff 查看器，支持行级评审批注与结构化 Prompt 生成（`/diff`）。
- **`mpi-loop`**：定时循环任务调度器，支持冲突策略（`/loop 5m /review`）。
- **`mpi-optimize-prompt`**：基于 Meta-prompt 的提示词结构化扩写与优化。
- **`mpi-auto-rename`**：基于上下文自动生成会话标题（`/auto-rename`）。
- **`mpi-ctl`**：Agent Tab 跨 Tab / 多实例协作命令行工具与技能（`mpi status` / `mpi ctl`）。
- **`mpi-permission`**：细粒度工具调用权限管控（`/permission`）。
- **`mpi-transcript`**：在 nvim、vim 或内置查看器中查看 LLM 实际上下文、完整对话、Thinking 与最新回复；使用 `/transcript config` 选择编辑器。
- **`mpi-prompt-history`**：Prompt 历史召回与交互式浏览面板（`/prompt-history`）。
- **`mpi-tool-block`**：动态对模型屏蔽指定工具（`/tool-block`）。
- **`mpi-tool-display`**：终端紧凑型工具调用与 Thinking 消息渲染优化。
- **`mpi-model-skills` / `mpi-model-extensions`**：按模型动态切换 Skill 与扩展。
- **`mpi-skill-refs`**：`$` 触发 Skill 自动补全与内嵌展开。
- **`mpi-stuck-guard`**：防卡死双护栏：拦截对高基数目录的递归搜索，外加 Provider 流 watchdog（`/stuck-guard config`、`/stuck-guard stats`、retry cooldown、Provider 过滤）。
- **`mpi-length-resume`**：回答因输出长度截断时自动续跑（原生压缩后与 run 结束时两类恢复）。
- **`mpi-herdr-report`**：向 Herdr 窗格上报 Agent 运行与就绪状态（`HERDR_ENV=1`）。
- **`mpi-image-hoist`**：自动提升输入中的图片路径为原生多模态消息。
- **`mpi-bash`**：为 Bash 工具调用注入默认超时，并在前台窗口到期后把长命令转入后台，结束时自动回报退出码；`/bash-logs` 可查看任意后台命令的完整日志。

<p align="center">
  <img src="assets/readme-right-widget.gif" alt="扩展侧栏" width="900">
</p>

### 4. 内联与停靠扩展挂件 (Inline & Docked Widgets)
使用 `/toggle-inline-widgets` 可动态在编辑器顶部停靠挂件与消息流内联挂件之间切换。内联模式下，挂件随对话内容自然滚动，不占用固定的编辑器高度。

<p align="center">
  <img src="assets/readme-inline-widget.gif" alt="内联挂件模式" width="900">
</p>

### 5. Vim 模式对话导航
将对话流作为 Vim 文本 Buffer 浏览：逐行滚动（`j`/`k`）、`Ctrl+U` / `Ctrl+D` 翻页、在关键用户提问间跳跃（`Right` / `Shift+Right`）。通过 `/vim` 或空队列 `Ctrl+U` 再按 `u` 进入，`q` 退出。

<p align="center">
  <img src="assets/readme-vim.gif" alt="Vim 模式" width="900">
</p>

### 6. Zen 专注模式与后台感知
隐藏顶部 Tab 栏（`/toggle-zen-mode`），获得专注视图。有状态变更的后台 Agent（运行中、等待输入、报错、完成）会在顶部边框紧凑显示为状态圆点（`●`）。圆点仅展示状态，不可点击。

<p align="center">
  <img src="assets/readme-zen.gif" alt="Zen 模式" width="900">
</p>

### 7. Prompt 内联技能引用与补全
在输入框中输入 `$` 触发项目、全局与已安装 package Skill 模糊自动补全，自动将技能规范内嵌至 Prompt 载荷中。

<p align="center">
  <img src="assets/readme-skill.gif" alt="Skill 引用" width="900">
</p>

### 8. 命令面板 (Command Palette)
按 `Ctrl+P` 模糊检索并执行当前 Tab 语境下的 Slash 命令、模型切换与扩展指令。

<p align="center">
  <img src="assets/readme-command-palette.gif" alt="Command Palette" width="900">
</p>

---

## 常用快捷键

高频快捷键速查（完整列表见应用内 **Help** 或 Command Palette）：

| 快捷键 | 作用域 | 动作 | 说明 |
|---|---|---|---|
| `Tab` / `Shift+Tab` | 全局 | 下一个 / 上一个 Tab | 切换 Tab 标签。补全打开或 Zen 模式下不切换（用 `Ctrl+T`）。 |
| `Ctrl+P` | 全局 | Command Palette | 模糊检索并执行 Slash 命令。 |
| `Ctrl+T` | 全局 | Tab 跳转面板 | 打开全屏 Tab 快速跳转检索面板。 |
| `Ctrl+G` | 全局 | 外部编辑器 | 在 `$VISUAL` / `$EDITOR` 中编辑当前草稿。 |
| `Ctrl+Q` | 全局 | 退出 | 安全保存工作区状态并退出程序。 |
| `Ctrl+U` | 输入框/队列 | 出队 / 选择 / Vim | 只有一个非空队列时直接弹出；两个队列都有消息时使用 `Ctrl+U,S/F`；队列为空时预备进入 Vim。详见[队列管理](docs/queue-and-follow-up.zh.md)。 |
| `Right` | 空输入框 | 扩展侧边栏 | 展开 / 折叠右侧扩展组件侧边栏。 |
| `Escape` | 全局 | 智能 Escape | 关闭浮层 → 中断/撤回 Prompt。 |
| `!` | 编辑器 | Bash 命令 | 进入单行 Shell 命令快速执行模式。 |
| `$` | 编辑器 | Skill 补全 | 触发项目、全局与已安装 package Skill 自动补全。 |
| `@` | 编辑器 | 文件 / Tab 补全 | 补全工作区文件路径和其它 Tab 标题。 |

---

## 安装说明

### 推荐方式：编译为独立二进制（通过 git clone）

```bash
git clone https://github.com/cyril0124/mixcode-pi.git
cd mixcode-pi
./install.sh                 # 独立二进制 → ~/.local/bin/mpi
./install.sh --prefix /opt/mixcode
```

升级方式：在仓库内执行 `git pull && ./install.sh`。

### 本地开发软链

```bash
bun run install:global       # 从当前源码全局软链 `mpi`
```

- `./install.sh` 编译为单个独立二进制文件（`bun build --compile`），运行时无需 `node_modules`。
- `bun run install:global` 从当前本地仓库软链，基于 Bun 运行时执行 TypeScript 入口。

---

## 启动参数

```bash
mpi                             # 在当前目录启动
mpi --workdir ~/project         # 在指定工作区目录启动
mpi --builtin-extensions-only   # 仅加载 mpi-* 第一方扩展，禁用第三方包
mpi --batch script.ts           # 启动后执行批量自动化脚本（.lua 或 .ts）
mpi status                      # 检视运行中的实例与 Tab 状态
```

## Agent Tab 协作

Agent Tab 用 `mpi status` / `mpi ctl` 驱动自己所在的 TUI——或任何其他 `mpi`。向同伴 Tab 发送 Prompt 与 Slash 命令、等待完成、读取结果；用 `--pid` / `--workdir` 操作其他目录的实例。

典型用法：

- 把审查、提问或长任务交给另一个 Tab，再读它的回复。
- 把互不依赖的工作拆到多个 Tab，再汇总结果。
- 跟另一个 `mpi` 实例里的 Tab 说话（`--pid` / `--workdir`）。

```bash
mpi status --json                        # 列出存活实例、Tab 与状态
mpi ctl --tab Agent-01 send-prompt '/compact'
mpi ctl --workdir ~/other-proj --tab Reviewer send-prompt 'review the diff'
mpi ctl --tab Agent-01 wait && mpi ctl --tab Agent-01 last-message
```

`mpi` 开发 `mpi` 正是如此：一个 Tab 把审查或验证任务委派给其他实例的 Tab，再收集它们的回复。完整命令参考：[pi-packages/mpi-ctl/skills/mpi-ctl/SKILL.md](pi-packages/mpi-ctl/skills/mpi-ctl/SKILL.md)。运行时该技能安装于 `<agentDir>/extensions/mpi-ctl/skills/mpi-ctl/SKILL.md`，默认 `~/.pi/agent/…`。

灵感来自 [Herdr](https://herdr.dev)——一个面向编程 Agent 的终端复用器，它把会话控制能力暴露给运行其中的 Agent。

---

## 官方技术文档

完整技术规范、架构设计与命令手册请查阅 [`docs/`](docs/README.zh.md) 目录：

- [系统架构 (System Architecture)](docs/architecture.zh.md)
- [TUI 组件目录与布局](docs/tui-components.zh.md)
- [多标签与工作区管理](docs/workspace-and-tabs.zh.md)
- [模型管理 (models.json)](docs/model-management.zh.md)
- [转向与后续双队列管理](docs/queue-and-follow-up.zh.md)
- [Zen 专注模式](docs/zen-mode.zh.md)
- [内联挂件模式 (`[INL]`)](docs/inline-widgets.zh.md)
- [Vim 模式与导航](docs/vim-and-navigation.zh.md)
- [Batch 批量自动化](docs/batch-scripts.zh.md)
- [Pi 扩展兼容性规范](docs/extension-compatibility.zh.md)
- [Slash 命令完整手册](docs/commands.zh.md)
- [配置管理 (`mixcode_settings.json`)](docs/mixcode-settings.zh.md)
- [环境变量清单](docs/environment.zh.md)
- [实例监控与状态注册表](docs/instance-registry.zh.md)

---

## 关于本项目

这是一个 AI 开发的项目。我现在的日常开发已完全使用 `mpi`，包括开发 `mpi` 本身。代码质量可能很差，但请亲自感受 `mpi`。

如果你对当前项目不感兴趣，也可以看看 [`pi-packages/`](pi-packages/)，里面都是高质量的 Pi 扩展插件，在原生 [Pi](https://pi.dev) 上也能正常使用。

本项目基于 [MIT License](LICENSE) 开源。

## 致谢

- [Pi](https://pi.dev)（Mario Zechner，[earendil-works/pi](https://github.com/earendil-works/pi)）。MixCode 构建在 Pi 的 Agent 内核、扩展系统与 TUI 工具链之上（`pi-coding-agent`、`pi-tui`、`pi-ai`、`pi-agent-core`）。正是它干净的 SDK 与开放的扩展生态让这个项目成为可能。
