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

MixCode 自有工具以 Pi `ToolDefinition[]` 注册：

```text
read_text_file
shell
ask_questions
```

extension tools 会进入 `AgentSession.getAllTools()` 并参与 active tools。当前仍设置 `noTools: "builtin"`，所以 Pi built-in tools 会存在于 tool registry，但不是默认 active policy 的唯一依据。

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
- command/tool/shortcut conflict 显式显示为 system chat，不静默覆盖

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
setHiddenThinkingLabel
setWidget
setFooter
setHeader
setTitle
custom(..., { overlay: true })
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
- `setEditorComponent` 接入当前 live editor slot；没有 live TUI host 时显式报错。
- `setTheme("dark" | "light" | "mixcode-dark" | "mixcode-light" | "terminal")` 会映射到 MixCode 全局 TUI theme，并主动请求 TUI redraw；未知 theme 或没有 live TUI host 时返回显式失败，不静默降级。
- 非 overlay 的 `ctx.ui.custom()` 还不是完整 Pi TUI 等价能力。

### Rendering

已支持：

- custom message renderer
- tool `renderCall`
- tool `renderResult`
- renderer component 复用
- session close / clear / compact 时 dispose
- renderer 抛错时显式显示错误
- renderer `context.invalidate()` 触发 MixCode redraw

```text
extension renderer invalidate()
  -> RuntimeTab.requestRender()
  -> extension_ui_update
  -> pi-tui redraw
```

## TUI theme 验证

2026-05-10 用 180x48 tmux 真实会话验证了 theme picker、theme alias / prefix 和 light theme 渲染：

```bash
./run.sh
# in tmux:
Tab
/theme
li<Enter>
/theme li<Enter>
/theme terminal<Enter>
```

验证产物：

```text
tmp/tui-verify-112457/
  ├─ 01-config-or-agent.ansi
  ├─ 02-agent-tab.ansi
  ├─ 03-theme-picker.ansi
  └─ 04-light-theme.ansi
```

`04-light-theme.ansi` 中确认出现 MixCode light palette，例如：

```text
header bg: 48;2;227;222;210
input bg : 48;2;236;231;220
accent   : 38;2;196;93;61
```

另一次逐步 tmux 验证使用 `send-keys -l '/theme li'` 后单独发送 `Enter`，捕获到第一次 Enter 后输入框清空且出现 `48;2;227;222;210` light header。合并成一个 `tmux send-keys '/theme li' Enter` 会产生 tmux 批量输入时序差异，不能作为人工交互失败的证据。

可重复 smoke：

```bash
MIXCODE_RUN_TMUX_TUI_SMOKE=1 timeout 60s node --test --import tsx test/tui-smoke.test.ts
```

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
