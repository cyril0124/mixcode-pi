# MixCode-pi Transient TUI Components

本文记录 MixCode-pi 自己维护的三类 transient TUI 组件。目标读者是未来开发者：改 UI 时先看这里，确认应该复用哪个组件、入口文件在哪、生命周期和边界是什么。

本文只覆盖三类短生命周期提示/浮层：

1. Toast：右上角短消息卡片。
2. Floating Panel：输入编辑器上方靠右的短暂浮窗，例如 vim user-message navigation preview。
3. Notice/Error Overlay：中间偏下的非捕获式通知面板，console bridge 和 error notice 使用。

不覆盖完整 overlay 系统、picker/palette、workspace overlay、extension side panel、chat renderer、InputEditor 全部实现。

## 快速选择

| 需求 | 用哪个组件 | 原因 |
| --- | --- | --- |
| 只需要告诉用户一个短结果，例如复制成功、终端太窄、没有可显示内容 | Toast | 自动消失、右上角、不阻塞输入，适合一行到三行的即时反馈。 |
| 用户按键后需要一个短暂的局部上下文预览，例如“当前跳到了哪条 user message” | Floating Panel | 锚定在输入区附近，能高亮当前行，适合导航/局部状态预览。 |
| 需要展示 console 输出、错误文本、较长诊断，并且不能污染 TTY 帧 | Notice/Error Overlay | non-capturing、底部居中、可换行、`c/y` 复制、Esc 关闭，适合需要读完再关的信息。 |
| 需要筛选、选择、确认、编辑输入 | 不用这三类 | 使用 picker/palette/workspace overlay/editor component 等交互式组件。 |

```text
short result       navigation context        readable diagnostic
     │                    │                         │
     v                    v                         v
  Toast            Floating Panel           Notice/Error Overlay
 top-right          above editor             bottom-center panel
 auto-hide          auto-hide                c/y copy · Esc close
```

## 1. Toast

### Purpose

Toast 是最轻量的短反馈：告诉用户“发生了什么”，但不要求用户处理。典型场景：复制成功、操作不可用、边界提示、短错误。

### Code Entry Points

| 责任 | 文件 / API |
| --- | --- |
| 状态类型与写入 | `src/core/toast.ts`：`ToastType`、`ToastNotification`、`pushToast()`、`activeToast()` |
| 渲染 | `src/ui/rendering/toast-overlay.ts`：`applyToastOverlay()` |
| 挂到 chat surface | `src/ui/rendering/agent-surface.ts` 调用 `applyToastOverlay(lines, activeToast(tab), ...)` |
| 常见调用点 | `src/ui/app-input.ts`、`src/ui/app-mouse.ts`、`src/ui/tree-selector.ts`、`src/ui/workspace-overlay.ts` |
| 测试 | `test/toast-rendering.test.ts` |

### State / API

```ts
pushToast(tab, {
  type: "info" | "success" | "warning" | "error",
  message: "short user-facing message",
});
```

`pushToast()` 把 toast 放到当前 tab 的 `tab.toast` 上，并记录 `createdAt`。`activeToast()` 在渲染时读取；超过 `TOAST_DURATION_MS` 后返回 `undefined` 并清掉状态。

当前 duration：`3_000ms`。

### Rendering Behavior

- 位置：chat surface 右上角，`TOAST_TOP_MARGIN = 1`，`TOAST_RIGHT_MARGIN = 1`。
- 样式：圆角卡片，使用 `╭ ╮ ╰ ╯`。
- 宽度：最小 24，最大 48，同时不超过终端宽度的 45%。
- 内容：自动加类型图标：`•` / `✓` / `⚠` / `✖`。
- 长文本：最多三行，最后一行用 `…` 截断。
- 过小视口：如果放不下完整 toast，直接不渲染。

### Use When

- 操作完成或失败，但用户不需要选择。
- 边界提示，例如“没有更旧消息”、“没有 extension widgets”。
- 反馈内容可以在几秒后消失。

### Do Not Use When

- 文本较长，需要用户读完。
- 需要用户确认、选择、输入。
- 信息必须保留到用户显式关闭。

### Validation

最小验证：

```bash
timeout 60s node --test --import tsx test/toast-rendering.test.ts
```

重点断言：圆角边框存在、右边距存在、长消息最多三行、视口过小时不渲染。

## 2. Floating Panel

### Purpose

Floating Panel 是输入区附近的短暂上下文预览。它不是通用 modal，也不接管焦点。当前主要使用者是 vim user-message navigation preview：按 `Right` / `Shift+Right` 后显示附近 user messages，并高亮当前行。

### Code Entry Points

| 责任 | 文件 / API |
| --- | --- |
| 状态类型 | `src/core/types.ts`：`FloatingPanelState`、`FloatingPanelStyle`、`FloatingPanelThemeRole` |
| 默认 tab 状态 | `src/core/defaults.ts`：`floatingPanel: undefined` |
| 渲染 | `src/ui/rendering/floating-panel.ts`：`renderFloatingPanelOverlay()` |
| 接入布局 | `src/ui/app-layout.ts`：assembled layout 最后调用 `renderFloatingPanelOverlay(...)` |
| 当前使用者 | `src/ui/vim-user-message-navigation.ts` |
| 到期重绘 | `src/ui/app-input.ts`：`scheduleFloatingPanelExpiryRender()` |
| 测试 | `test/floating-panel.test.ts` |

### State / API

```ts
tab.floatingPanel = {
  title: "User Messages",
  lines: ["↑ 3 older above", "some message", "↓ 2 newer below"],
  highlightedIndex: 1,
  width: 34,
  expiresAt: Date.now() + 1_800,
  style: {
    border: "borderDim",
    title: "borderDim",
    body: "surface",
    highlighted: "selection",
  },
};
```

`style` 是可选的；不指定时使用安全默认值：

- `border`: `borderDim`
- `title`: `borderDim`，或跟随 `border`
- `body`: `surface`
- `highlighted`: `selection`

`FloatingPanelThemeRole` 只允许使用 `MixCodeTheme` 中的命名 role。不要把函数直接塞进 state；这保持 state 可序列化/可测试，也避免跨 theme 生命周期泄漏。

### Rendering Behavior

- 位置：输入编辑器 top row 上方一行，靠右。
- 右侧保护：`SCROLLBAR_SAFE_RIGHT_MARGIN = 2`，并且 splice 时保留 overlay 右侧原始 suffix，避免擦掉 chat scrollbar。
- 样式：圆角 titled border，使用 `╭ title ─╮` / `╰──╯`。
- 高亮：只通过 `highlightedIndex` 样式高亮，不在文本里加 `*`、`o` 等 marker。
- 到期：`expiresAt` 后不渲染；按键触发时会安排一次到期后的 `requestRender()`，避免画面停留到下一次输入。
- 过小空间：如果放不下面板，直接不渲染。

### Current User-message Preview Behavior

`src/ui/vim-user-message-navigation.ts` 负责生成当前 preview 内容：

- `PREVIEW_TTL_MS = 1_800`
- `PREVIEW_WIDTH = 34`
- 默认 5 行；有 chat surface bounds 时自适应 3–7 行。
- 行内容来自当前 branch 的 user message 第一行，最后追加虚拟 `<NEWEST>`。
- 如果窗口无法显示全部消息，在框内显示：
  - `↑ N older above`
  - `↓ N newer below`
- 当前行只高亮，不加 marker。

### Use When

- 用户已经触发了一个局部导航动作，需要短暂展示“附近上下文”。
- 信息和输入区/当前 tab 强关联。
- 不需要焦点、不需要 Esc、不需要用户选择。
- 需要高亮当前行或展示少量列表。

### Do Not Use When

- 信息应覆盖全屏或需要用户关闭：用 Notice/Error Overlay。
- 只是短成功/失败反馈：用 Toast。
- 需要滚动、选择、过滤或提交：用 picker/palette/editor component。

### Validation

最小验证：

```bash
timeout 60s node --test --import tsx test/floating-panel.test.ts
```

重点断言：圆角标题、样式 role 可配置、当前行高亮、overflow rows、到期隐藏、右侧 scrollbar 列未被擦掉。

真实 TUI 改动还需要 tmux 校验。可以用临时 harness 或实际功能路径启动 TUI，按触发键后 capture pane，确认：

- `╭ User Messages` 出现。
- 当前 user message 出现。
- 右侧 scrollbar/gutter 没被覆盖。
- 到期后消失。

## 3. Notice / Error Overlay

### Purpose

Notice/Error Overlay 用来把较长、需要用户读完的信息放进 TUI 管理的 overlay，而不是让文本直接写到 stdout 破坏 TUI 帧。console bridge 的输出和部分 error/notice 都走这条路径。

### Code Entry Points

| 责任 | 文件 / API |
| --- | --- |
| console 重载 | `src/cli/console-tui-bridge.ts`：`installConsoleTuiBridge()`、`wireConsoleSink()` |
| main 接线 | `src/cli/main.ts`：启动早期安装 bridge，TUI 创建后 wire sink 到 `showNoticeTextOverlay()` |
| notice/error API | `src/ui/app-overlays.ts`：`showNoticeTextOverlay()`、`showErrorOverlay()`、`copyActiveNoticeText()` |
| 渲染 | `src/ui/app-overlays.ts`：`renderNoticePanel()` |
| 输入 | `src/ui/app-input.ts`：Notice 打开时 `c/y` 复制全文；`src/ui/app-mouse.ts`：面板内拖选复制 |
| 测试 | `test/console-tui-bridge.test.ts`、`test/notice-overlay.test.ts`、`test/app-mouse-selection.test.ts` |

### Console Bridge Flow

```text
extension / code calls console.log(...)
  │
  v
installConsoleTuiBridge() overrides console.log/info/debug/warn/error
  │
  ├─ before TUI sink exists: queue formatted lines
  │
  v
wireConsoleSink(fn) flushes backlog in order
  │
  v
showNoticeTextOverlay(tui, "[console.log]: ...")
  │
  v
bottom-center non-capturing Notice panel
```

Only these methods are bridged:

- `console.log`
- `console.info`
- `console.debug`
- `console.warn`
- `console.error`

`console.trace`、`console.dir` 等没有接管。

### Rendering Behavior

- 位置：`anchor: "bottom-center"`，`offsetY: -4`。
- 捕获：`nonCapturing: true`，不会主动吃掉输入焦点。
- 提示：显示 `c/y copy · Esc close`。
- 复制：`c/C/y/Y` 复制完整 notice body；鼠标可在面板 bounds 内拖选复制。
- 关闭：通用 Esc overlay 处理会关闭它。
- 宽度：按内容自适应，最大约终端宽度 60%，最小 24。
- 高度：最大约终端高度 60%，至少 6。
- 内容：按 panel 宽度 wrap，不按行截断；适合诊断信息。
- 样式：普通 notice 用默认 border，error variant 用 danger border/title。

### Use When

- 文本来自 console，需要从 raw tty 搬到 TUI 内。
- 信息比 toast 长，用户可能要读几秒。
- 错误消息需要保留到用户关闭。
- 需要避免 TUI frame 被 stdout/stderr 破坏。

### Do Not Use When

- 只是短反馈：用 Toast。
- 只是局部导航 preview：用 Floating Panel。
- 需要用户选择/确认：用专门的 confirm overlay 或 picker。
- 需要持续显示的 extension UI：用 extension header/footer/widgets/editor component。

### Validation

最小验证：

```bash
timeout 60s node --test --import tsx test/console-tui-bridge.test.ts test/notice-overlay.test.ts
```

重点断言：console 输出先 queue 后 flush、带 `[console.<method>]:` 前缀、notice/error title 正确、长消息 wrap 后不丢词、每行宽度正确。

## Shared Rules

### Keep transient state per tab

Toast 和 Floating Panel 都挂在 `MixCodeTabInfo` 上，避免跨 tab 泄漏。Notice/Error Overlay 是 TUI-level overlay，因为它服务于全局 console/error 输出。

### Prefer explicit expiry over silent persistence

- Toast：`activeToast()` 根据 `createdAt` 过期。
- Floating Panel：`expiresAt` 决定是否渲染，并安排到期重绘。
- Notice/Error Overlay：没有自动过期；可 `c/y` 复制，用户用 Esc 关闭。

### Do not use fallback success paths

如果组件无法渲染（空间不足、没有 active tab、没有 TUI sink），让行为明确：不渲染、queue、toast warning 或 error overlay。不要伪造成功或吞掉真实错误。

### Keep renderers pure where possible

渲染函数应主要做 string composition：输入 state/theme/width，输出 lines。状态变更放在 action/input handler 层，例如 `pushToast()` 或设置 `tab.floatingPanel`。

## Component Checklist

新增 transient TUI 组件或复用现有组件时，至少确认：

- [ ] 位置不会覆盖 tab bar、input editor、footer 或 chat scrollbar。
- [ ] 生命周期明确：auto-hide、Esc close，或由状态清理。
- [ ] 样式来自 `MixCodeTheme` role，而不是硬编码 ANSI。
- [ ] 太窄/太矮时行为明确。
- [ ] 有 focused rendering test。
- [ ] TUI 相关改动通过 tmux capture 验证核心键流。
