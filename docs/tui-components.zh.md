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
│| after messages and before Steer/Follow-up; editor top border shows [INL]                       |│
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

Home 使用当前主题的语义颜色。布局不改变会话选择、消息发送或草稿归属。交互契约见 [Home 按键](keybindings-and-escape.zh.md) 和 [鼠标支持](mouse-support.zh.md)。

## 所有权边界

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
