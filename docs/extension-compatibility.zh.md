# Pi Extension 兼容性说明

[English Documentation](extension-compatibility.md)

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
  └─ ctx.ui.getEditorText / setEditorText / pasteToEditor 仍读写底层 editor

ctx.ui.custom(factory, { overlay: true })
  └─ 通过 pi-tui overlay 显示浮层，hide/done 后 dispose

ctx.ui.select / confirm / input
  └─ 打开期间顶替 editor 区域；关闭时保留关闭时刻的 editor 文本
     （dialog 期间的 setEditorText 写入会存活，与 Pi 一致）
```

`ctx.ui.onTerminalInput` handler 先于焦点编辑器执行，可 consume 或改写输入；但与 Pi 不同，MixCode 在 tui overlay 或待处理扩展交互（`select`/`confirm`/`input` dialog、pending `custom()`）激活期间不分发。Pi 下扩展可通过真实 TUI 的焦点组件自行避让；MixCode 传给 widget 工厂的是无焦点状态的 `NullTerminal` 沙箱 TUI，扩展无法感知 dialog 打开，故由宿主抑制分发以保住 dialog 按键。

例外：当 custom overlay 被扩展自身隐藏（调用过 `handle.hide()`）时，即使还有其他待处理交互，分发也保持开启，overlay 仍能收到恢复快捷键（例如 ask_user_question 的折叠切换）。无隐藏 overlay 时，editor-slot 接管期间仍完全抑制。

扩展的 `renderCall` 或 `renderResult` 返回 `undefined` 时，`ToolExecutionComponent` 使用 Pi 原生 fallback。Renderer 抛出的异常会显示为错误文本；result renderer 抛错时同时保留原始结果 fallback。

`ctx.ui.setTitle(title)` 在调用方 session 所在 tab 处于激活状态时立即写终端标题（OSC 0）；非激活 tab 只存储标题，切回该 tab 时重新应用。切到没有存储标题的 tab 不改变当前终端标题（与 Pi 一致：标题保持到被覆盖）。

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
- `ctx.scopedModels`（由 MixCode 模型禁用列表解析而来，见[模型管理](model-management.zh.md)）
- `/import <jsonl-path> [cwdOverride]` 的 MixCode 等价实现

AGENTS / project context / system prompt 走 Pi resource loader 链路，不再靠 prompt injection 拼 workdir instructions。

当 `ctx.switchSession()`、会话选择器恢复或 `/import` 的目标工作目录不同时，替换会话会重建绑定 cwd 的 services。在 `session_start` 和 `withSession` 执行前，扩展 `ctx.cwd`、工具相对路径、项目配置和项目资源均使用目标会话的 cwd。导入时显式指定的 cwd override 为有效目标目录。同目录替换复用 services 并重新加载扩展，不与其他存活标签共享 services。取消切换不会加载目标项目的扩展。
