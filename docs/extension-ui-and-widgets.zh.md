# 扩展 UI 体系、挂件系统与侧边栏 (Extension UI & Widgets)

[English Documentation](extension-ui-and-widgets.md)

MixCode Pi 为 Pi 扩展提供完整的 UI 宿主原语支持（`src/agent/runtime-extension-ui.ts`），包括多区域挂件停靠槽（`src/agent/runtime-extension-widgets.ts`）、折叠式扩展侧边栏以及内联挂件模式。

## 1. 扩展 UI 布局区域与停靠槽

扩展可将 UI 组件挂载到 5 个专属布局区域：

```text
┌────────────────────────────────────────────────────────────────┐
│ Header（随 Chat 对话流滚动）    ctx.ui.setHeader()             │
├────────────────────────────────────────────────────────────────┤
│ Chat 消息流视口                 可选右侧扩展侧边栏             │
│                                 ctx.ui.setSidePanel()          │
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
| Side Panel | `ctx.ui.setSidePanel(factory)` | 水平分割 Chat 视口宽度；在空输入框中按 `Right` 可展开/折叠。 |
| 上方停靠区 | `ctx.ui.setWidget(key, comp)` | 固定渲染在编辑器输入框上方边框处。 |
| 下方停靠区 | `ctx.ui.setWidget(key, comp)` | 固定渲染在编辑器下方与状态栏之间。 |
| Footer | `ctx.ui.setFooter(factory)` | 覆盖默认的输入元数据行，展示自定义扩展状态文本。 |

## 2. 内联挂件模式 (`/toggle-inline-widgets`)

挂件迁移、`[INL]` 角标与设置见 [内联挂件模式](inline-widgets.zh.md)。
