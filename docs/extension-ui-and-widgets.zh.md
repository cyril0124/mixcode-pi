# 扩展 UI 体系、组件系统与侧边栏 (Extension UI & Widgets)

[English Documentation](extension-ui-and-widgets.md)

MixCode Pi 为 Pi 扩展提供完整的 UI 宿主原语支持（`src/agent/runtime-extension-ui.ts`），包括多区域组件停靠区（`src/agent/runtime-extension-widgets.ts`）、widget 侧边面板以及内联组件模式。

## 1. 扩展 UI 布局区域与停靠区

扩展可将 UI 组件挂载到 4 个专属布局区域：

```text
┌────────────────────────────────────────────────────────────────┐
│ Header（随 Chat 对话流滚动）    ctx.ui.setHeader()             │
├────────────────────────────────────────────────────────────────┤
│ Chat 消息流视口                 可选 widget 侧边面板          │
│                                 （setWidget 停靠区的视图）    │
├────────────────────────────────────────────────────────────────┤
│ 编辑器上方停靠区 (Above Editor) ctx.ui.setWidget(aboveEditor)  │
├────────────────────────────────────────────────────────────────┤
│ 输入框 Prompt Editor                                           │
├────────────────────────────────────────────────────────────────┤
│ 编辑器下方停靠区 (Below Editor) ctx.ui.setWidget(belowEditor)  │
├────────────────────────────────────────────────────────────────┤
│ 底部状态栏 Footer               ctx.ui.setFooter()             │
└────────────────────────────────────────────────────────────────┘
```

| UI 区域 | API 方法 | 渲染行为与生命周期 |
|---|---|---|
| Header | `ctx.ui.setHeader(factory)` | 渲染在对话流最上方，随聊天内容自然上下滚动。 |
| 上方停靠区 | `ctx.ui.setWidget(key, comp)` | 固定渲染在编辑器输入框上方边框处。 |
| 下方停靠区 | `ctx.ui.setWidget(key, comp)` | 固定渲染在编辑器下方与状态栏之间。 |
| Footer | `ctx.ui.setFooter(factory)` | 覆盖默认的输入元数据行，展示自定义扩展状态文本。 |

## 2. Widget 侧边面板

侧边面板是一种展示模式，不是挂载区域——没有专属的扩展 API。在空输入框中按 `Right` 会分割 Chat 视口，把所有 `aboveEditor`/`belowEditor` widget 迁移到右侧可滚动的纵向面板中；再按 `Right`（或按照 `→ to close` 提示）恢复停靠区布局。

- 渲染：`renderExtensionPanel`（`src/ui/rendering/chrome.ts`）——置顶 `Widgets` 标题、每个 widget 一行 dim 的 `─ {key} ─` 分节线、带 `↑ more`/`↓ more` 标记的滚动窗口。
- 终端宽度不足 80 列或当前 tab 没有停靠区 widget 时，切换拒绝打开（以 toast 说明原因）。
- 扩展无法主动打开面板，也无法直接向面板挂载组件；面板始终镜像当前 `setWidget` 的内容。

## 3. 内联组件模式 (`/toggle-inline-widgets`)

组件迁移、`[INL]` 角标与设置见 [内联组件模式](inline-widgets.zh.md)。
