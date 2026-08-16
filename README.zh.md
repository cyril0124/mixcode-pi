# MixCode Pi

[English](README.md)

基于 [Pi](https://pi.dev) 的**多 Tab** 终端原生 AI 编程助手，全面兼容 Pi 扩展生态。

> **为什么选择 MixCode Pi？**
> 传统终端 AI 编程助手通常受限于单会话模型——在模型生成代码、执行长任务或跑测试期间，终端会被完全占用，开发者无法同时开展探索、审查或多模块并行工作。MixCode 为终端带来了**原生多 Tab 并发**与**完整的 Pi 扩展生态兼容**：在单个终端中并行多个独立 Agent 会话，跨重启持久化工作区，零成本复用 Pi 官方及社区的海量扩展（`npm:…`、自定义工具、挂件与 Slash 指令）。

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="MixCode Pi 多 Tab 工作台" width="900">
</p>

## 核心亮点

- 🗂️ **原生多 Tab 并发会话**：在单个终端中同时运行多个独立的 Agent 会话。用 `Tab` / `Shift+Tab` 快速切换，或按 `Ctrl+T` 全屏模糊跳转。后台任务实时展示状态指示符（`●` 运行中、`!` 完成未读、`x` 错误）。
- 🧩 **100% 兼容 Pi 扩展生态**：开箱即用支持 Pi 包生态（`settings.json` `packages`、npm 扩展、自定义工具、挂件与主题）。内置第一方强大的 `mpi-*` 扩展集（目标追踪、Diff 评审、提示词优化、自动重命名）。
- 🧘 **Zen 专注与内联挂件模式**：开启 Zen 模式（`/toggle-zen-mode`）隐藏 Tab 栏以最大化纵向阅读空间，并通过顶部状态圆点感知后台任务；开启内联挂件（`/toggle-inline-widgets`）将工具挂件移入对话流尾部，释放代码编辑高度。
- 📱 **窄屏与移动终端触控优化**：深度适配手机/平板终端模拟器（Termux、iOS Blink/SSH）及分屏小窗口，支持手指轻触切 Tab、点击状态栏唤起选择器，并具备自适应布局平滑降级。
- ⌨️ **终端优先交互流**：Buffer 级 Vim 导航（`j`/`k` 逐行滚动、`Right`/`Shift+Right` 提问跳转、`/` 正则检索）、命令面板（`Ctrl+P`）、`$` 技能自动补全与外部编辑器一键调用（`Ctrl+E`）。
- 📜 **声明式 Batch Lua 自动化**：通过嵌入式 Lua 脚本（`mpi --batch script.lua`）在 Monorepo 中批量派发 Tab 与任务，支持 Dry-run 静态计划预览。

---

## 快速开始

需要 [Bun](https://bun.sh)。从 GitHub 全局安装：

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

请确保 `~/.bun/bin` 在 `PATH` 中。升级用同一条命令；卸载：`bun remove -g mixcode-pi`。

---

## 核心特性

### 1. 多 Tab 工作区与跨实例协同
各 Tab 维护独立的会话分支树、工具运行时与工作目录。工作区自动持久化 Tab 布局与焦点状态，跨进程原子文件锁（`open_tabs.json.lock`）支持在多个终端窗口或 tmux 窗格间安全协同。

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="多 Tab 会话" width="900">
</p>

### 2. 完整 Pi 生态与内置第一方扩展
直接通过 Pi 包配置安装社区扩展（如 `npm:pi-web-access`），或直接使用 MixCode 内置工具：
- **`mpi-goal`**：自主目标追踪引擎，支持渐进式动态工具暴露与执行预算。
- **`mpi-diff-viewer`**：终端视觉 Diff 查看器，支持行级评审批注与结构化 Prompt 生成（`/diff`）。
- **`mpi-loop`**：定时循环任务调度器，支持冲突策略（`/loop 5m /review`）。
- **`mpi-optimize-prompt`**：基于 Meta-prompt 的提示词结构化扩写与优化。

<p align="center">
  <img src="assets/readme-right-widget.gif" alt="扩展侧栏" width="900">
</p>

### 3. 内联与停靠扩展挂件 (Inline & Docked Widgets)
使用 `/toggle-inline-widgets` 可动态在编辑器顶部停靠挂件与消息流内联挂件之间切换。内联模式下，挂件随对话内容自然滚动，不占用固定的编辑器高度。

<p align="center">
  <img src="assets/readme-inline-widget.gif" alt="内联挂件模式" width="900">
</p>

### 4. Vim 模式与对话全文检索
将对话流作为 Vim 文本 Buffer 浏览：逐行滚动、在关键用户提问间跳跃（`Right` / `Shift+Right`），并支持基于 WeakMap 缓存的高性能 `/` 正则搜索。通过 `/vim` 或空队列 `Ctrl+U` 再按 `u` 进入。

<p align="center">
  <img src="assets/readme-vim.gif" alt="Vim 模式" width="900">
</p>

### 5. Zen 专注模式与后台感知
隐藏顶部 Tab 栏，获得极致沉浸的编码画布。有状态变更的后台 Agent（运行中、等待输入、报错、完成）会在顶部边框紧凑显示为状态圆点（`●`）。圆点仅展示状态，不可点击。

<p align="center">
  <img src="assets/readme-zen.gif" alt="Zen 模式" width="900">
</p>

### 6. Prompt 内联技能引用与补全
在输入框中输入 `$` 触发项目、全局与已安装 package Skill 模糊自动补全，自动将技能规范内嵌至 Prompt 载荷中。

<p align="center">
  <img src="assets/readme-skill.gif" alt="Skill 引用" width="900">
</p>

### 7. 命令面板 (Command Palette)
按 `Ctrl+P` 快速模糊检索并执行当前 Tab 语境下的 Slash 命令、模型切换与扩展指令。

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
| `Ctrl+E` | 全局 | 外部编辑器 | 在 `$VISUAL` / `$EDITOR` 中编辑当前草稿。 |
| `Ctrl+Q` | 全局 | 退出 | 安全保存工作区状态并退出程序。 |
| `Ctrl+U` | 输入框/队列 | 取出排队消息 / 进入 Vim | 将排队中的消息弹回输入框；队列为空时预备进入 Vim 模式。 |
| `Right` | 空输入框 | 扩展侧边栏 | 展开 / 折叠右侧扩展组件侧边栏。 |
| `Escape` | 全局 | 智能 Escape | 关闭浮层 → 退出 Vim → 中断/撤回 Prompt。 |
| `!` | 编辑器 | Bash 命令 | 进入单行 Shell 命令快速执行模式。 |
| `$` | 编辑器 | Skill 补全 | 触发项目、全局与已安装 package Skill 自动补全。 |
| `@` | 编辑器 | 文件补全 | 触发工作区文件路径自动补全。 |

---

## 安装说明

### 从 GitHub 安装（推荐）

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

升级使用相同命令。卸载：`bun remove -g mixcode-pi`。

### 从源码构建（独立二进制）

```bash
./install.sh                 # 独立二进制 → ~/.local/bin/mpi
./install.sh --prefix /opt/mixcode
bun run install:global       # 从当前源码全局软链 `mpi`
```

- `bun install -g github:…` — 基于 Bun 运行时执行 TypeScript 入口。
- `./install.sh` — 编译为单个独立二进制文件（`bun build --compile`），运行时无需 `node_modules`。

---

## 启动参数

```bash
mpi                             # 在当前目录启动
mpi --workdir ~/project         # 在指定工作区目录启动
mpi --builtin-extensions-only   # 仅加载 mpi-* 第一方扩展，禁用第三方包
mpi --batch script.lua          # 启动后执行 Lua 批量自动化脚本
mpi status                      # 检视运行中的实例与 Tab 状态
```

---

## 官方技术文档

完整技术规范、架构设计与命令手册请查阅 [`docs/`](docs/README.zh.md) 目录：

- [系统架构 (System Architecture)](docs/architecture.zh.md)
- [TUI 组件目录与布局](docs/tui-components.zh.md)
- [多标签与工作区管理](docs/workspace-and-tabs.zh.md)
- [转向与后续双队列管理](docs/queue-and-follow-up.zh.md)
- [Zen 专注模式](docs/zen-mode.zh.md)
- [内联挂件模式 (`[INL]`)](docs/inline-widgets.zh.md)
- [Vim 模式与检索](docs/vim-and-navigation.zh.md)
- [Batch Lua 批量自动化](docs/batch-lua.zh.md)
- [Pi 扩展兼容性规范](docs/extension-compatibility.zh.md)
- [Slash 命令完整手册](docs/commands.zh.md)
- [配置管理 (`mixcode_settings.json`)](docs/mixcode-settings.zh.md)
- [环境变量清单](docs/environment.zh.md)
- [实例监控与状态注册表](docs/instance-registry.zh.md)
