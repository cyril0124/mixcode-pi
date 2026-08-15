# MixCode TUI 组件目录

当前 mixcode-pi 的 TUI 表面清单。改 UI 前先看这里：能复用就复用；能用
`@earendil-works/pi-tui` 就不要本地重写（见 AGENTS.md Pi Integration）。

覆盖：

- 全屏 chrome / agent surface
- 状态级 overlay / selector
- 短生命周期反馈（Toast / Floating Panel / Notice）
- 与 pi-tui 的所有权边界

不是快捷键手册（见 `docs/architecture.md` 与 `/hotkeys`）。

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
│|   / @ $ autocomplete  |  vim  |  bash-mode !                                                   |│
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
│            |        + MixCodeCompletion     + renderFooter                                       │
│            v                                                                                     │
│   +---------------- chrome (chrome.ts) ----------------+                                         │
│   | header | tab bar | separator | status | input meta |                                         │
│   +-------------------+--------------------------------+                                         │
│                       |                                                                          │
│          +------------+-------------+                                                            │
│          | config tab               | agent tab                                                  │
│          v                          v                                                            │
│    renderConfig()            Agent Surface                                                       │
│    home actions                |                                                                 │
│                                +-- chat blocks (user/asst/tool/bash)                             │
│                                +-- extension header (scrolls w/ chat)                            │
│                                +-- optional extension side panel                                 │
│                                +-- queue preview                                                 │
│                                +-- toast paint (top-right)                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 所有权边界

```text
┌─ Ownership split ────────────────────────────────────────────────────────────────────────────────┐
│  FROM pi-tui (reuse, do not reimplement)     MIXCODE-LOCAL (owned here)                          │
│  ---------------------------------------     ---------------------------                         │
│  TUI / Container / OverlayHandle             MixCodeLayoutRoot stack                             │
│  Editor / Input / SelectList                 CompactPromptEditor + Vim Search row                    │
│  Markdown / Image / Loader                   Agent Surface + chat blocks                            │
│                                              Transcript matcher + viewport highlight                │
│  Box / Spacer / Text / TruncateText          chrome (header/tab/status)                          │
│  SettingsList (when fits)                    Settings Panel                                      │
│  keybindings / autocomplete APIs             Command Palette / Tab Jump                          │
│  showOverlay anchors                         Toast / Floating Panel                              │
│                                              Picker / Tree / Session / Fork                      │
│                                              Workspace Overlay                                   │
│                                              Notice/Error + console bridge                       │
│                                              Question dialogs                                    │
│                                              Extension panel / widgets host                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Overlay / Selector / Editor Mode 目录

状态级 overlay 同一时刻只开一个（`src/core/overlays.ts` 的 `OverlayKind` 优先级）。
通用 Text/Lines 与 Notice/Error 走 `src/ui/app-overlays.ts` -> pi-tui `showOverlay()`。

```text
┌─ Overlay / selector catalog ─────────────────────────────────────────────────────────────────────┐
│ state-level overlays; single active via OverlayKind priority                                     │
│                                                                                                  │
│  ┌─ Command Palette ────────┐   ┌─ Tab Jump ───────────────┐   ┌─ Picker ─────────────────┐      │
│  │ Ctrl+P                   │   │ Ctrl+T                   │   │ /models /workdir         │      │
│  │ filter + enter           │   │ fuzzy tab switch         │   │ /thinking /ctx           │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
│                                                                                                  │
│  ┌─ Settings Panel ─────────┐   ┌─ Extension Manager ──────┐   ┌─ Session Selector ───────┐      │
│  │ /settings                │   │ manage packages          │   │ /resume                  │      │
│  │ theme / UI opts          │   │ enable / disable         │   │ pick session             │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
│                                                                                                  │
│  ┌─ Tree Selector ──────────┐   ┌─ Fork Selector ──────────┐   ┌─ Workspace Overlay ──────┐      │
│  │ /tree                    │   │ /fork                    │   │ save/restore/del         │      │
│  │ session DAG              │   │ branch point             │   │ progress/confirm         │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
│                                                                                                  │
│  ┌─ Confirm dialogs ────────┐   ┌─ Notice / Error ─────────┐   ┌─ Text / Lines ───────────┐      │
│  │ quit / close-all         │   │ bottom-center            │   │ generic overlay          │      │
│  │ delete / action          │   │ c/y copy  Esc            │   │ help / hotkeys           │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
│                                                                                                  │
│  ┌─ Preview overlay ────────┐   ┌─ Question dialog ────────┐   ┌─ Transcript Search ──────┐      │
│  │ markdown / tool          │   │ pendingDialogs           │   │ Vim editor input row     │      │
│  │ h/l j/k g/G              │   │ multi-question           │   │ literal + N/M + n/N      │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 速查表

| 表面 | 打开方式 | 主要文件 | 说明 |
| --- | --- | --- | --- |
| Command Palette | `Ctrl+P` | `rendering/overlays.ts`, `core/overlays.ts` | 按当前 tab 语境过滤，不是全量 slash 列表 |
| Tab Jump | `Ctrl+T`；再点当前 tab | `rendering/overlays.ts`, `core/overlays.ts`, `list-overlay-mouse.ts` | 模糊跳转 tab；`Ctrl+F` 切换 non-idle 过滤；列表支持滚轮与点击 |
| Picker | `/models` `/workdir` `/thinking` `/context-limit` | `core/pickers.ts`, `rendering/overlays.ts` | 过滤后单选 |
| Settings Panel | `/settings` | `settings-panel.ts` | 主题 / UI 选项；主列表可按显示标签或设置键名输入过滤 |
| Extension Manager | palette / command | `extension-manager.ts` | 启停 package extension |
| Session Selector | `/resume` | `session-selector.ts` | 恢复已有 session |
| Tree Selector | `/tree`；空输入 Double-Esc | `tree-selector.ts` | session DAG |
| Fork Selector | `/fork` | `fork-selector.ts` | 选择 fork 点 |
| Workspace Overlay | save / restore / delete | `workspace-overlay.ts`, `workspace-rendering.ts` | 多模式 + 进度 |
| Confirm | quit / close-all / delete / action | `app-overlays.ts`, `app-key-handlers.ts` | y/n + Esc |
| Notice / Error | console bridge / errors | `app-overlays.ts` | 底中、`c/y` 复制、Esc 关 |
| Text / Lines | help、hotkeys、通用 | `app-overlays.ts` | `showTextOverlay` / `showLinesOverlay` |
| Preview | preview toggle | `rendering/overlays.ts`, `core/overlays.ts` | markdown / tool 预览 |
| Transcript Search | Vim `/` | `vim-transcript-search.ts`, `app-editor.ts`, `rendering/agent-surface.ts` | 复用 Vim editor 行并持续显示 `/query N/M`，无 overlay；Enter 后 `n/N` 循环匹配并同步更新序号 |
| Question dialog | extension / agent questions | `core/dialogs.ts`, `pendingDialogs` | 多题 / 多选 |
| File picker `@` | `@` | editor + file picker 路径 | fuzzy + tree 两种模式 |

## 短生命周期 UI（Transient）

只做反馈，不要用它们承载选择 / 确认。

```text
┌─ Transient UI ───────────────────────────────────────────────────────────────────────────────────┐
│          short result                 local nav context               long diagnostic            │
│                |                              |                              |                   │
│                v                              v                              v                   │
│  ┌─ Toast ──────────────────┐   ┌─ Floating Panel ─────────┐   ┌─ Notice / Error ─────────┐      │
│  │ top-right                │   │ above editor             │   │ bottom-center            │      │
│  │ auto-hide 3s             │   │ auto-hide ~1.8s          │   │ Esc close                │      │
│  │ no focus                 │   │ no focus                 │   │ nonCapturing             │      │
│  └──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘      │
│                |                              |                              |                   │
│                v                              v                              v                   │
│            tab.toast                  tab.floatingPanel                 TUI overlay              │
│        applyToastOverlay         renderFloatingPanelOverlay             showNotice*              │
│       agent-surface paint               layout paint                pi-tui showOverlay           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| 需求 | 用 | 原因 |
| --- | --- | --- |
| 短结果（复制成功、太窄、无可显示） | **Toast** | 自动消失、右上、不抢焦点 |
| 局部导航上下文（当前在哪条 user message） | **Floating Panel** | 锚定输入区上方、可高亮当前行 |
| 需要读完的诊断 / console / error | **Notice / Error** | 底中、可复制、Esc 关 |
| 选择 / 确认 / 编辑 | **不要用这三类** | 用 picker / palette / confirm / editor |

### Toast

- 状态：`src/core/toast.ts` — `pushToast()` / `activeToast()`
- 绘制：`src/ui/rendering/toast-overlay.ts` — `applyToastOverlay()`
- 挂载：agent surface / config 绘制路径
- 时长：`3000ms`
- 类型：`info` / `success` / `warning` / `error`
- 形态：圆角卡片，最多 3 行，右上边距

```ts
pushToast(tab, { type: "success", message: "Copied." });
```

### Floating Panel

- 状态：`tab.floatingPanel`（`FloatingPanelState`，`src/core/types.ts`）
- 绘制：`src/ui/rendering/floating-panel.ts` — `renderFloatingPanelOverlay()`
- 挂载：`app-layout.ts` assembled layout 末尾
- 当前生产者：`src/ui/vim-user-message-navigation.ts`（TTL ~1800ms）
- 样式只允许 `MixCodeTheme` role（state 可序列化）

### Notice / Error

- API：`showNoticeTextOverlay()` / `showErrorOverlay()`（`app-overlays.ts`）
- Console：`src/cli/console-tui-bridge.ts` 先 queue，sink 就绪后 flush 进 Notice
- 锚点：`bottom-center`，`nonCapturing: true`
- 键：`c/y` 复制全文；Esc 关闭；面板内可鼠标拖选

```text
┌─ console -> Notice ──────────────────────────────────────────────────┐
│  console.log / info / debug / warn / error                           │
│                    |                                                 │
│                    v                                                 │
│       installConsoleTuiBridge()                                      │
│                    |                                                 │
│       +------------+------------+                                    │
│       | before sink              | sink ready                        │
│       v                          v                                   │
│     queue lines              wireConsoleSink()                       │
│       |                          |                                   │
│       +------------> flush <-----+                                   │
│                      |                                               │
│                      v                                               │
│         showNoticeTextOverlay(...)                                   │
│                      |                                               │
│                      v                                               │
│           bottom-center Notice panel                                 │
└──────────────────────────────────────────────────────────────────────┘
```

## 该用哪个？

```text
┌─ Which surface? ─────────────────────────────────────────────────────────────────────────────────┐
│ need user action?                                                                                │
│        |                                                                                         │
│        +-- no -- short text? -- yes --> Toast                                                    │
│        |              |                                                                          │
│        |              +-- no -- local nav? -- yes --> Floating Panel                             │
│        |                              |                                                          │
│        |                              +-- no --> Notice / Error                                  │
│        |                                                                                         │
│        +-- yes                                                                                   │
│             |                                                                                    │
│             +-- select one item?  --> Picker / Session / Fork / Tree / TabJump                   │
│             +-- filter commands?  --> Command Palette                                            │
│             +-- edit settings?    --> Settings Panel                                             │
│             +-- yes/no confirm?   --> Confirm overlay                                            │
│             +-- multi-question?   --> Question dialog (pendingDialogs)                           │
│             +-- free text / help? --> Text / Lines overlay                                       │
│             +-- extension custom? --> Pi Component / widgets / editor slot                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 常驻 chrome 件

| 部件 | 渲染入口 | 说明 |
| --- | --- | --- |
| Header | `renderHeader` | 顶栏 |
| Tab bar | `renderTabBar` / `renderVisibleTabBar` | Zen 下隐藏 |
| Tab separator | `renderTabBarSeparator` | Zen 后台状态：彩色 `●`（working / 等待输入 / done / error） |
| Status | `renderStatus` | context / state / model |
| Agent surface | `renderAgentSurface` | chat + 可选 sidebar |
| Chat blocks | `renderChat` / `renderChatBlock` | user / asst / tool / bash |
| Extension header | `renderExtensionHeader` | 随 chat 滚动 |
| Extension side panel | `renderExtensionPanel` | 非 vim 时 `Right` 切换 |
| Extension widgets | `renderExtensionWidgets` | 默认编辑器上下；`/toggle-inline-widgets` 时进 chat 尾部（Steer/Follow-up 仍在最后） |
| Input meta | `renderInputMeta` | model / thinking / workdir 可点 |
| Working indicator | pi-tui `Loader` | streaming / working |
| Footer | `renderFooter` / `renderExtensionFooter` | 底栏 |
| Editor | `CompactPromptEditor` + `EditorSlot` | 输入宿主 |

## 代码地图

```text
┌─ Code map ───────────────────────────────────────────────────────────────────────────────────────┐
│src/ui/                                                                                           │
│├── app-layout.ts                 MixCodeRoot / FooterRoot / LayoutRoot                           │
│├── app-editor.ts                 CompactPromptEditor, EditorSlot                                 │
│├── app-overlays.ts               Lines / Text / Notice / Error / Confirm                         │
│├── list-overlay-mouse.ts         center list overlay hit-test / wheel / click                    │
│├── app-input.ts                  global key routing into components                              │
│├── completion.ts                 / @ $ autocomplete provider                                     │
│├── settings-panel.ts             Settings Panel                                                  │
│├── session-selector.ts           Session resume selector                                         │
│├── tree-selector.ts              Session tree selector                                           │
│├── fork-selector.ts              Fork point selector                                             │
│├── workspace-overlay.ts          Workspace save/restore/delete UI                                │
│├── workspace-rendering.ts        Workspace overlay renderers                                     │
│├── extension-manager.ts          Extension Manager overlay                                       │
│├── vim-user-message-navigation.ts  Floating Panel producer                                       │
│└── rendering/                                                                                    │
│    ├── chrome.ts                 header, tab bar, status, meta, extension panel                   │
│    ├── agent-surface.ts          chat surface + toast paint + queue                              │
│    ├── chat.ts                   chat block rendering                                            │
│    ├── overlays.ts               palette, tab-jump, picker, config, preview                      │
│    ├── floating-panel.ts         Floating Panel renderer                                         │
│    ├── toast-overlay.ts          Toast painter                                                   │
│    └── primitives.ts             box / titledBox / overlayPanel                                  │
│                                                                                                  │
│src/core/                                                                                         │
│├── toast.ts                      pushToast / activeToast                                         │
│├── pickers.ts                    models / workdir / thinking / context                           │
│├── overlays.ts                   OverlayKind + palette / tab-jump / preview                      │
│├── dialogs.ts                    Question dialog state machine                                   │
│└── types.ts                      FloatingPanelState, dialog, picker types                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 共享规则

1. **先复用再发明。** 先查 pi-tui 与本目录。
2. **状态级 overlay 同时只开一个。** `activeOverlay()` / `closeActiveOverlay()`。
3. **Toast / Floating Panel 按 tab 挂状态；Notice 是 TUI 级。**
4. **生命周期要明确。** auto-hide、Esc、或显式清状态；禁止无声常驻。
5. **样式走 `MixCodeTheme` role，不硬编码 ANSI。**
6. **视口太小：不渲染或 queue，不伪造成功。**
7. **渲染尽量纯。** 状态变更在 handler；renderer 只拼字符串。
8. **TUI 改动要 tmux 验证**（见 AGENTS.md TUI Validation）。

## 新表面检查清单

- [ ] 现有表面是否已覆盖？复用。
- [ ] pi-tui 是否已有？复用。
- [ ] 位置：不盖住 tab bar / editor / footer / scrollbar。
- [ ] 生命周期：auto-hide / Esc / 显式清理。
- [ ] 主题：`MixCodeTheme` role。
- [ ] 过窄 / 过矮行为已定义。
- [ ] 有 focused contract test（禁止 source-grep）。
- [ ] TUI 路径有 tmux capture。
