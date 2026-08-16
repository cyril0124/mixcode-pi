# Extension UI System, Widgets & Side Panel

[中文文档](extension-ui-and-widgets.zh.md)

MixCode Pi provides complete hosting for Pi extension UI primitives (`src/agent/runtime-extension-ui.ts`), including multi-zone widget docks (`src/agent/runtime-extension-widgets.ts`), collapsible side panels, and inline widget modes.

## 1. Extension UI Zones & Docks

Extensions mount UI components into five dedicated layout zones:

```text
┌────────────────────────────────────────────────────────────────┐
│ Header (scrolls with chat)      ctx.ui.setHeader()             │
├────────────────────────────────────────────────────────────────┤
│ Chat Surface                    Optional Side Panel            │
│                                 ctx.ui.setSidePanel()          │
├────────────────────────────────────────────────────────────────┤
│ Above-Editor Dock               ctx.ui.setWidget(aboveEditor)  │
├────────────────────────────────────────────────────────────────┤
│ Editor / Prompt Input                                          │
├────────────────────────────────────────────────────────────────┤
│ Below-Editor Dock               ctx.ui.setWidget(belowEditor)  │
├────────────────────────────────────────────────────────────────┤
│ Footer / Status Bar             ctx.ui.setFooter()             │
└────────────────────────────────────────────────────────────────┘
```

| UI Zone | API Method | Behavior & Lifetime |
|---|---|---|
| Header | `ctx.ui.setHeader(factory)` | Rendered above conversation history; scrolls naturally with chat. |
| Side Panel | `ctx.ui.setSidePanel(factory)` | Splits chat width horizontally; toggled via `Right` on empty editor. |
| Above-Editor Dock | `ctx.ui.setWidget(key, comp)` | Rendered directly above the prompt editor border. |
| Below-Editor Dock | `ctx.ui.setWidget(key, comp)` | Rendered between editor bottom border and status footer. |
| Footer | `ctx.ui.setFooter(factory)` | Overrides default input metadata row with custom extension status text. |

## 2. Inline Widgets Mode (`/toggle-inline-widgets`)

Widget relocation, `[INL]` badge, and settings live in [Inline Widgets](inline-widgets.md).
