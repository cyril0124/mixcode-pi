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

## 输入编辑器

`src/ui/app-editor.ts` 中的 `CompactPromptEditor` 将默认输入区绘制为圆角卡片。Agent 标识与精确上下文用量一起显示在上边框右侧；用量达到配置上限的 85% 时使用警告色。`[VIM]`、`[SHELL]`、`[ZEN]`、`[sys]` 和隐藏行数指示在生效时显示于左侧。空草稿的 dim 占位文字旁显示 `@ files  / commands`。Agent 的空输入区还显示 `← Home · → widgets`；Home 页面或草稿非空时不显示这两个导航提示。占位文字按可用宽度截断。普通输入和 Vim 模式下，下边框保持纯线条。补全、Shell/队列操作及隐藏行数指示仅在相关状态下显示，不显示普通发送和换行提示。Vim 导航提示仅在空输入区内显示。窄卡片先省略模式标签和上下文，再截断右侧名称；下边框优先保留主要操作。

整圈边框（包括圆角和两侧竖线）使用当前主题中对应 thinking 等级的 `thinkingBorder` 颜色。Vim 模式优先使用 `vimBorder`；退出 Vim 后恢复当前 thinking 等级的颜色。正文和标签使用 `text` 与 `accent`，保留终端原有底色。侧边框内的正文水平内边距由 [`editorPaddingX`](mixcode-settings.zh.md) 控制。草稿上下不添加空白行：空输入和单行输入的卡片均占三行；更多正文行使输入区增高，直到 Pi 的滚动上限。宽度不足八列时保留草稿和光标，暂时省略卡片与正文，等待宽度足以安全显示宽字符。

Pi 现有的 `Editor.renderTopBorder()` 和 `renderBottomBorder()` 接口提供隐藏行数。MixCode 在渲染结果中定位加宽的下边框，区分正文与补全菜单；Pi 负责正文折行和编辑。补全行位于卡片外部；硬件光标标记在包裹边框后保留，鼠标坐标转换回 Pi 内部布局。`EditorSlot` 继续由自定义编辑器和临时输入接管组件负责自身渲染。自定义编辑器的 Agent 标签仍位于标签栏下方的分隔线。

## 会话卡片

`src/ui/rendering/message-cards.ts` 使用 Pi 的 `SkillInvocationMessageComponent`、`BranchSummaryMessageComponent` 和 `CompactionSummaryMessageComponent`。卡片使用 Pi 的配色、间距和快捷键提示。`chat.ts` 使用 Pi 的 `parseSkillBlock`；MixCode 保留 skill 时间戳、用户参数和图片附件。没有参数的 skill 在卡片标签行显示时间戳；有参数时，时间戳显示在单独的用户消息区域。

`ChatLine.summaryMessage` 携带 Pi 所需的摘要数据。`runtime-chat.ts` 从会话条目构造它，并保留摘要文本、时间戳、分支来源和压缩 token 数。零是有效的 token 数。`ChatLine.text` 继续供宿主搜索和预览使用。会话文件沿用 Pi 的现有格式。

MixCode 管理展开状态和每行渲染缓存。卡片渲染时临时应用当前主题和共享快捷键管理器，结束后恢复两者。缓存键包含展开快捷键，因此重新加载快捷键后，下一次渲染会更新提示。展开卡片保留配置的代码块缩进和 Mermaid 处理；用户参数区域保留既有 Markdown 与图片设置。

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
