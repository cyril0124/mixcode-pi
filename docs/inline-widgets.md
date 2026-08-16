# Inline Widgets Mode (`[INL]`)

[中文文档](inline-widgets.zh.md)

MixCode Pi provides **Inline Widgets Mode** (`/toggle-inline-widgets`), allowing users to relocate extension widgets from fixed editor docks into the natural, scrollable chat transcript stream.

## Concept & Layout Comparison

By default, extension widgets (such as goal trackers or recurring loop meters) occupy fixed docks directly above or below the prompt editor. For complex multi-line widgets, this reduces the vertical height available for writing code.

Inline widgets mode moves widget rendering to the tail of the conversation log:

```text
┌─ Default Docked View ────────────────────────────────────────────────────┐
│ [Chat Message Stream]                                                    │
│                                                                          │
│ ┌ Widget Dock Above Editor ────────────────────────────────────────────┐ │
│ │ Goal (active) | 3 tasks remaining | tokens: 12.4k                     │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ ── Agent-01 ──────────────────────────────────────────────────────────── │
│ > prompt editor                                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Inline Widgets View (`/toggle-inline-widgets`) ─────────────────────────┐
│ [Chat Message Stream]                                                    │
│                                                                          │
│ [Inline Widget Chrome]                                                   │
│ Goal (active) | 3 tasks remaining | tokens: 12.4k                        │
│                                                                          │
│ ── [INL] ───────────────────────────────────────────────── Agent-01 ──── │
│ > prompt editor (Expanded vertical room)                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key Invariants & Behaviors

1. **Natural Scroll Integration**:
   - Widgets render directly after the last conversation message and before pending steer/follow-up queues.
   - When scrolling historical chat messages (PageUp/Vim mode), inline widgets scroll naturally out of the viewport.
2. **Editor Top Border Badge (`[INL]`)**:
   - The editor top border clearly displays the `[INL]` badge when active.
   - Editor left badges render as `[VIM] [ZEN] [INL]`; `[sys]` follows the title.
3. **Session-Level & Global Configuration**:
   - **Per-Session Toggle**: Run `/toggle-inline-widgets` to switch for the current tab.
   - **Global Default**: Set `"ui.inlineWidgets": true` in `mixcode_settings.json` or toggle via `/settings` ("Inline widgets").
4. **Side Panel Coexistence**:
   - When the extension side panel is open (`Right` on empty editor), inline widgets in the chat column yield to side-panel rendering rules.

## Commands Reference

| Command | Action |
|---|---|
| `/toggle-inline-widgets` | Toggles inline widget mode on the active tab. |
| `/settings` → `Inline widgets` | Sets the global default for all newly created tabs. |
