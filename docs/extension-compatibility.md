# Pi Extension 兼容性说明

本文记录 MixCode 对 Pi packages / extensions 的兼容边界、安装方式、已验证能力和已知限制。Pi 官方 package catalog 当前把 packages 定义为发布到 npm 的 extensions、skills、prompt templates 和 themes，安装形式是 `pi install npm:<package>`；MixCode 当前走同一套 Pi resource loader / package discovery 语义。

参考：

- https://pi.dev/packages
- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/tui

## 当前结论

```text
pi.dev/packages
  │
  ├─ extension / skill / prompt / theme npm package
  │
  v
.pi/settings.json packages
  │
  v
Pi resource loader
  │
  ├─ extensions -> ExtensionRunner
  ├─ skills     -> system prompt / completion / prompt build
  ├─ prompts    -> slash command / prompt template
  └─ themes     -> theme discovery / MixCode theme switching
        │
        v
MixCode adapters
  ├─ tools / commands
  ├─ lifecycle events
  ├─ UI primitives
  ├─ message renderer
  └─ tool renderer
```

MixCode 现在可以安装并加载 Pi package，但不能宣称对 package catalog 中所有 package 100% 兼容。判断标准不是“能安装”，而是 package 的核心 command/tool 是否能真实执行。

当前 `ctx.ui.custom()` 覆盖两种 Pi TUI 语义：

```text
ctx.ui.custom(factory)
  └─ 临时替换 MixCode editor，done() 后恢复原 editor

ctx.ui.custom(factory, { overlay: true })
  └─ 通过 pi-tui overlay 显示浮层，hide/done 后 dispose
```

## 安装方式

目前推荐直接写项目级 Pi settings：

```json
{
  "packages": [
    "npm:<package-name>",
    "npm:pi-web-access"
  ]
}
```

文件位置：

```text
<project>/.pi/settings.json
```

MixCode 启动时会让 Pi resource loader 读取 project package sources。不要依赖 `refs/` 里的 package；`refs/` 只用于 UI/交互参考。

## 兼容等级

```text
Level 0: 可安装
  package 被 npm 安装并被 resource loader 发现。

Level 1: 可加载
  extension factory 成功执行，tools / commands / renderers 注册成功。

Level 2: 可交互
  command、tool、UI primitive、renderer 在 MixCode TUI 中能正常显示和响应。

Level 3: 核心功能真实可用
  package 的主要功能跑过真实 smoke，不是 mock，不是只看注册表。
```

MixCode 只维护通用 Pi extension 兼容层，不内置特定 package 的专用命令、侧栏或 smoke。用户安装的 package 应按下方“验收新 package 的流程”自行验证。

## 已接入能力

### Runtime

```text
MixCodeRuntime
  -> createAgentSessionServices()
  -> createAgentSessionFromServices()
  -> AgentSession
  -> bindExtensions()
  -> ExtensionRunner
```

已支持：

- extension factory loading
- package resource discovery
- `session_start`
- `session_shutdown`
- `session_before_switch`
- `session_before_fork`
- `session_tree`
- `ctx.newSession()`
- `ctx.fork()`
- `ctx.switchSession()`
- `ctx.navigateTree()`
- `ctx.reload()`
- `/import <jsonl-path> [cwdOverride]` 的 MixCode 等价实现

AGENTS / project context / system prompt 走 Pi resource loader 链路，不再靠 prompt injection 拼 workdir instructions。

### Tools

MixCode 启用 Pi built-in tool，并在需要时恢复未被 extension 接管的内置实现：

```text
read
bash
edit
write
ls
```

extension tools 会进入 `AgentSession.getAllTools()` 并参与 active tools。如果 extension 按 Pi SDK 语义注册了与 built-in 同名的 tool，该 extension 拥有该 tool 名称，MixCode 不再用内置实现抢回；启动摘要里的 `[Diagnostics]` 会显示 `Extension tool override: <name>`，`[Tool Owners]` 会显示当前 owner。owner 判断以 `AgentSession.getAllTools()` 暴露的 public `sourceInfo` 为准，避免 Pi 内部私有 tool definition 尚未同步时误恢复 built-in。

### Commands

```text
用户输入 /xxx
  │
  ├─ 本地 MixCode command 命中 -> MixCode handler
  │
  └─ 本地未命中 -> AgentSession.prompt()
                    -> Pi extension command
```

已支持：

- extension slash command 注册
- extension command completion
- 本地 command 优先
- command/shortcut conflict 显式显示在启动摘要 header 的 `[Diagnostics]` 段，不静默覆盖
- extension tool 可覆盖同名 built-in tool，并通过 `[Tool Owners]` 暴露 owner

### UI Primitives

已桥接到 MixCode TUI：

```text
select
confirm
input
notify
onTerminalInput
setStatus
setWorkingMessage
setWorkingVisible
setWorkingIndicator
setWidget
setFooter
setHeader
setTitle
custom(factory) / custom(factory, { overlay: true })
setHiddenThinkingLabel
pasteToEditor
setEditorText / getEditorText
editor(title, prefill?)
addAutocompleteProvider
setEditorComponent / getEditorComponent
getToolsExpanded / setToolsExpanded
theme / getAllThemes / getTheme / setTheme
```

重要边界：

- `setHeader` / `setFooter` 只占用 MixCode 固定布局中的 extension slot，不允许覆盖 Agent Tabs 或核心输入区。
- `setHiddenThinkingLabel(label?)` 写入 per-tab `hiddenThinkingLabel`；`hideThinkingBlock` 折叠 thinking 时用该文案作斜体占位（默认 `Thinking...`）；`undefined`/空串恢复默认。
- `ctx.ui.custom(factory)`（非 overlay）临时替换当前 tab 的 editor slot（与 select/confirm/input/editor 同槽），`done()` 后恢复原文与 factory；`custom(factory, { overlay: true })` 走 pi-tui 浮层。无 live TUI host 或 editor 替换不可用时显式报错。
- `setEditorComponent` 接入当前 live editor slot；没有 live TUI host 时显式报错。
- `setTheme(name | Theme)` 对齐 Pi：任意已注册 theme 名（内置 `mixcode-dark`/`claude-warm`/`tokyo-night`/`terminal`/`catppuccin`/`kanagawa`/`rose-pine`、Pi `dark`/`light`、`~/.pi/agent/themes`、package themes、`ResourceLoader` 发现结果）会映射到 MixCode 全局 TUI + extension theme，并请求 redraw。Id 必须精确匹配，没有 `dark`→`mixcode-dark` 这类 MixCode 别名。`Theme` 实例须带 `name`（会 `registerAdditionalTheme`）。未知 theme 或没有 live TUI host 时显式失败，不静默降级。TUI chrome 字段名与 Pi token 对齐（如 `error`/`muted`/`borderMuted`/`selectedBg`/`bashMode`/`toolTitle`/`thinkingText`）。

### Rendering

已支持：

- custom message renderer
- tool `renderCall`
- tool `renderResult`
- renderer component 复用
- session close / clear / compact 时 dispose
- renderer 抛错时显式显示错误
- renderer `context.invalidate()` 触发 MixCode redraw
- 主聊天 `user` / `assistant` / `assistant-thinking` Markdown 串联 `extensionRunner.getMarkdownTransformers()`（mermaid 在前，与 Pi 顺序一致）；skill 展开正文、branch/compaction summary 不跑 extension transformers（与 Pi 一致）

```text
extension renderer invalidate()
  -> RuntimeTab.requestRender()
  -> extension_ui_update
  -> pi-tui redraw
```

## TUI theme 验证

2026-06-30 用 180x48 tmux 真实会话验证了 theme 切换与 tokyo-night theme 渲染；内置 `/theme` 已移除，主题改由 `/settings` 编辑：

```bash
./run.sh
# in tmux:
Tab
/settings → Theme → tokyo-night
/settings → Theme → terminal
```

验证产物：

```text
tmp/tui-verify-112457/
  ├─ 01-config-or-agent.ansi
  ├─ 02-agent-tab.ansi
  ├─ 03-theme-picker.ansi
  └─ 04-tokyo-night-theme.ansi
```

`04-tokyo-night-theme.ansi` 中确认出现 MixCode tokyo-night palette，例如：

```text
selection bg: 48;2;51;70;124
home tab bg : 48;2;122;162;247
accent      : 38;2;125;207;255
```

另一次逐步 tmux 验证通过 `/settings` 选中 Theme 并选择 tokyo-night，捕获到 `48;2;51;70;124` selection bg。

## 验收新 package 的流程

每安装一个新 package，至少按下面三步验收：

```text
1. Resource discovery
   - package 是否安装成功
   - extension / skill / prompt / theme 是否被发现

2. Registration
   - commands 是否出现在 completion / command palette
   - tools 是否出现在 AgentSession.getAllTools()
   - renderer 是否注册且没有 load error

3. Real execution
   - 跑 package 的核心 command/tool
   - 检查 TUI 是否刷新
   - 检查 message/tool renderer 是否正确显示
   - 检查失败是否显式暴露，而不是 silent fallback
```

建议记录格式：

```text
package: npm:<name>@<version>
level: 0 / 1 / 2 / 3
commands:
tools:
ui primitives used:
verified command/tool:
known limits:
```

## 当前不能承诺的内容

```text
不能承诺:
  ├─ package catalog 里所有 package 都 100% 可用
  ├─ 所有 Pi 官方 TUI surface 都能被 MixCode 完整无差异复刻
  ├─ 所有 package 的后台任务 / 子进程 / 外部 CLI 依赖都已验证
  └─ extension 可以任意改 MixCode 全局主题或覆盖核心布局

可以承诺:
  ├─ package 能通过 Pi resource loader 加载
  ├─ 常见 extension tools / commands / lifecycle 能桥接
  ├─ 常见 UI primitives 已有 MixCode adapter
  ├─ renderer invalidate 会触发 redraw
  └─ 失败路径应显式暴露，不做 mock success
```

## 与主架构文档的关系

`docs/architecture.md` 记录 MixCode TUI、runtime、快捷键和 session 迁移方案；本文只记录 Pi package / extension 兼容面。

更细的实现状态和测试清单见仓库根目录的 `PI_EXTENSION_COMPAT_PLAN.md`。
