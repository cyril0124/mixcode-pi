# Extension UI System, Widgets & Side Panel

[中文文档](extension-ui-and-widgets.zh.md)

MixCode Pi provides complete hosting for Pi extension UI primitives (`src/agent/runtime-extension-ui.ts`), including multi-zone widget docks (`src/agent/runtime-extension-widgets.ts`), the widget side panel, and inline widget modes.

## 1. Extension UI Zones & Docks

Extensions mount UI components into four dedicated layout zones:

```text
┌────────────────────────────────────────────────────────────────┐
│ Header (scrolls with chat)      ctx.ui.setHeader()             │
├────────────────────────────────────────────────────────────────┤
│ Chat Surface                    Optional widget side panel     │
│                                 (view of setWidget docks)      │
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
| Above-Editor Dock | `ctx.ui.setWidget(key, comp)` | Rendered directly above the prompt editor border. |
| Below-Editor Dock | `ctx.ui.setWidget(key, comp)` | Rendered between editor bottom border and status footer. |
| Footer | `ctx.ui.setFooter(factory)` | Overrides default input metadata row with custom extension status text. |

## 2. Widget Side Panel

The side panel is a display mode, not a mount zone — there is no dedicated extension API for it. Pressing `Right` on an empty editor splits the chat viewport and relocates every `aboveEditor`/`belowEditor` widget into a scrollable right-hand column; pressing `Right` again (or following the `→ to close` hint) restores the docks.

- Rendering: `renderExtensionPanel` (`src/ui/rendering/chrome.ts`) — pinned `Widgets` title, one dim `─ {key} ─` section rule per widget, scroll window with `↑ more`/`↓ more` markers.
- The toggle refuses to open below 80 terminal columns or when the tab has no dock widgets (a toast explains why).
- Extensions cannot open the panel or mount components into it directly; it always mirrors the current `setWidget` content.

## 3. Inline Widgets Mode (`/toggle-inline-widgets`)

Widget relocation, `[INL]` badge, and settings live in [Inline Widgets](inline-widgets.md).
