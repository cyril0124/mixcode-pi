# MixCode TUI 组件目录

[English Documentation](tui-components.md)

当前 mixcode-pi 的 TUI 表面清单。改 UI 前先看这里：能复用就复用；能用 `@earendil-works/pi-tui` 就不要本地重写（见 AGENTS.md Pi Integration）。

覆盖：

- 全屏 chrome / agent surface
- 状态级 overlay / selector
- 短生命周期反馈（Toast / Floating Panel / Notice）
- 与 pi-tui 的所有权边界

不是快捷键手册（见 `docs/architecture.zh.md` 与 `/hotkeys`）。

## 全屏布局

```text
┌─ Full-screen layout ─────────────────────────────────────────────────────────────────────────────┐
│                                   approximate agent-tab frame                                    │
│                                                                                                  │
│+------------------------------------------------------------------------------------------------+│
│| Header: MixCode                                                                                |│
│|================================================================================================|│
│| [Home] [Agent-01*] [Agent-02] [Agent-03]                                                       |│
│|------------------------------------------------------------------------------------------------|│
│| Status: idle | ctx 12k/200k | claude-sonnet | thinking: medium                                 |│
│|------------------------------------------------------------------------------------------------|│
│| user> implement toast overlay                                                                  |│
│| assistant> adding toast component...                                                           |│
│| tool: bash  ok  (12ms)                                                                         |│
│| assistant> Done. auto-hides in 3s.                                                             |│
│|                                                                                                |│
│| [scrollable chat surface]                                                                      |│
│| (extension header scrolls here)                                                                |│
│| optional: /toggle-inline-widgets moves setWidget chrome here,                                  |│
│| after messages and before Steer/Follow-up; each inline widget starts with a `▸ Inline · <key>` header                 |│
│| optional: extension side panel may split this row                                              |│
│|------------------------------------------------------------------------------------------------|│
│| [extension widgets above editor]  (hidden in inline / vim / side-panel)                        |│
│|------------------------------------------------------------------------------------------------|│
│| > prompt editor   CompactPromptEditor / EditorSlot                                             |│
│|   / @ $ autocomplete (@ files + peer tabs)  |  vim  |  bash-mode !                             |│
│|------------------------------------------------------------------------------------------------|│
│| meta: model | thinking | workdir | git   (omitted when extension footer is set)                |│
│| extension footer widgets  (when set, replaces meta row fields)                                 |│
│| footer                                                                                         |│
│+------------------------------------------------------------------------------------------------+│
│                                                                                                  │
│ overlays: pi-tui showOverlay() floats above this frame                                           │
│ toast / floating-panel: painted into the frame (no focus steal)                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 组件树

```text
┌─ Component tree ─────────────────────────────────────────────────────────────────────────────────┐
│                         @earendil-works/pi-tui                                                   │
│  +--------------------------------------------------------------------+                          │
│  | TUI  Container  OverlayHandle  Editor  SelectList  Markdown  Loader|                          │
│  +----------------------------------+---------------------------------+                          │
│                                     |                                                            │
│                                     v                                                            │
│                          MixCodeLayoutRoot                                                       │
│            +----------------+----------------+----------------+                                  │
│            |                |                |                |                                  │
│            v                v                v                v                                  │
│      MixCodeRoot       EditorSlot     MixCodeFooterRoot   Loader                                 │
│            |                |                |            (working)                              │
│            |                v                v                                                   │
│            |        CompactPromptEditor   extension footer                                       │
│            |        + MixCodeCompletion     renderExtensionFooter                                │
│            v                                                                                     │
│   +---------------- chrome (chrome.ts) ----------------+                                         │
│   | header | tab bar | separator | status | input meta |                                         │
│   +-------------------+--------------------------------+                                         │
│                       |                                                                          │
│          +------------+-------------+                                                            │
│          | home tab                 | agent tab                                                  │
│          v                          v                                                            │
│    renderHome()              Agent Surface                                                       │
│    home actions                |                                                                 │
│                                +-- chat blocks (user/asst/tool/bash)                             │
│                                +-- extension header (scrolls w/ chat)                            │
│                                +-- optional extension side panel                                 │
│                                +-- queue preview                                                 │
│                                +-- toast paint (top-right)                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Home

`src/ui/rendering/overlays.ts` 中的 `renderHome()` 负责 Home 布局。页头显示版本、工作目录以及工作中和等待输入的数量。会话列表每项固定四行：标题与状态、模型与上下文用量及时间、最近输出、分隔空行。只有选中项的内容使用选中底色。

终端宽度至少 120 列，且页头下方至少有 18 行时，会话列表与选中会话预览并排显示。更窄或更矮的视口采用纵向布局；消息预览的 15% 行数配额达到四行时才显示。列表窗口跟随选中项，导航行固定在底部。Home 可用行数少于四行时，选中会话优先于分区标题；只剩一行时显示会话而不是导航提示。窄屏状态标签会缩短，为会话标识保留八列。宽屏预览使用 Bun 原生 `wrapAnsi` 对纯文本折行，将连续工具调用合并为数量，并在最新输出超出可用行数时标记更早内容。消息收集仅从末尾回溯到可见分组所需的位置。列表摘要先裁剪，再添加 ANSI 样式或树形符号，避免完整输出进入 Pi 的装饰行宽度缓存。纯文本摘要与视口大小的折行末尾分别按标签页和消息使用弱引用缓存；文本修改、宽度变化及末尾行预算变化会使对应条目失效。主题颜色在缓存之外应用。

Home 使用当前主题的语义颜色。`src/ui/home-actions.ts` 在列表标题旁绘制强调色实底的 `+ New session` 按钮和较弱的 `Resume` 按钮。标题旁放不下时，若高度允许则另占一行。宽度不足时先隐藏 Resume，再将 New session 缩短为 New，不显示被截断的按钮。较矮且有会话的视口优先保留选中会话；空视口优先保留新建入口。悬停、按压或等待状态不改变按钮尺寸。指针状态与命中区域仅在内存中保存，不持久化。

布局不改变会话选择、消息发送或草稿归属。不新增快捷键或按钮焦点循环；`Tab` 仍切换标签页，没有打开会话时也能通过 `Ctrl+P` 或斜杠命令执行这两个操作。交互契约见 [Home 按键](keybindings-and-escape.zh.md) 和 [鼠标支持](mouse-support.zh.md)。

## 所有权边界

`src/ui/app.ts` 中的 `createMixCodeTui()` 使用 Pi 的 `TuiAltScreen`。它在终端备用屏幕中绘制固定应用画面，在同步输出块内用绝对坐标定位每个变化的行。行差分、浮层合成、图片与光标定位，以及 `stop({ preserveScreen: true })` 时的原屏幕恢复，均由 Pi 负责。图片支持遵循上游渲染器：支持 Kitty 图片协议；禁用 `iterm2` 协议，其图片组件显示文字占位。

MixCode 管理聊天窗口化渲染和输入路由。Pi 补丁的 `viewportInput: false` 选项将滚动与选区操作交给宿主；`mouse: false` 则让 `MouseReportingTerminal` 管理鼠标报告。全屏绘制器在写入每帧前恢复屏幕原点与完整滚动范围。绝对跳转到聊天开头会清除冻结视口的锚点，避免高度重算覆盖目标位置。

Pi 依赖补丁对没有代码围栏的消息跳过 Mermaid 解析，并在调用 Marked 标题正则前检查是否存在可能的 Setext 下划线。符合条件的标题仍交给上游解析器处理。

渲染器接管可恢复：`start()` 会重新安装 `stop()` 移除的绘制/标题监听与 stdout 保护。`pause()/resume()` 临时释放终端时保留这些资源。

```text
┌─ Ownership split ────────────────────────────────────────────────────────────────────────────────┐
│  FROM pi-tui (reuse, do not reimplement)     MIXCODE-LOCAL (owned here)                          │
│  ---------------------------------------     ---------------------------                         │
│  TUI / Container / OverlayHandle             MixCodeLayoutRoot stack                             │
│  Editor / Input / SelectList                 CompactPromptEditor                                 │
│  Markdown / Image / Loader                   Agent Surface + chat blocks                         │
│  Box / Spacer / Text / TruncateText          chrome (header/tab/status)                          │
│  SettingsList (when fits)                    Settings Panel                                      │
│  keybindings / autocomplete APIs             Command Palette / Tab Jump                          │
│  showOverlay anchors / getBounds             Toast / Floating Panel                              │
│                                              Picker / Tree / Session / Fork                      │
│                                              Workspace Overlay                                   │
│                                              只读文本查看器                                      │
│                                              Notice/Error + console bridge                       │
│                                              Extension panel / widgets host                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```
