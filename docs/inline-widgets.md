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
│ │ Goal (active) | 3 tasks remaining | tokens: 12.4k                    │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ ── Agent-01 ──────────────────────────────────────────────────────────── │
│ > prompt editor                                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Inline Widgets View (`/toggle-inline-widgets`) ─────────────────────────┐
│ [Chat Message Stream]                                                    │
│                                                                          │
│ ▸ Inline · Goal (active) ─────────────────────────────────────────────── │
│ 3 tasks remaining | tokens: 12.4k                                         │
│                                                                          │
│ ▸ Inline · Goal (active) ───────────────────────────────── Agent-01 ──── │
│ > prompt editor (Expanded vertical room)                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key Invariants & Behaviors

1. **Natural Scroll Integration**:
   - Widgets render directly after the last conversation message and before pending steer/follow-up queues.
   - When scrolling historical chat messages (PageUp/Vim mode), inline widgets scroll naturally out of the viewport.
2. **Inline Widget Header (`▸ Inline`)**:
   - Each inline widget starts with a `▸ Inline · <key>` header at the widget's top-left.
   - The editor top border no longer carries an inline-mode badge; `[VIM]`, `[ZEN]`, and `[sys]` keep their existing roles.
3. **Session-Level & Global Configuration**:
   - **Per-Session Toggle**: Run `/toggle-inline-widgets` to switch for the current tab.
   - **Global Default**: Set `"ui.inlineWidgets": true` in `mixcode_settings.json` or toggle via `/settings` ("Inline widgets").
4. **Side Panel Coexistence**:
   - When the extension side panel is open (`Right` on empty editor), inline widgets in the chat column yield to side-panel rendering rules.

## Widget display and slash commands

Inline widgets expand by default. Each one starts with a `▸ Inline · <key>` header row; its body follows on the rows below.

### Automatic row budget

The inline block is capped by a budget derived from the chat viewport, so stacked widgets cannot squeeze the transcript off screen:

| Widgets | Budget |
|---|---|
| Any | `clamp(floor(viewport * 0.7), 6, 24)` rows |

A 24-row viewport therefore allows 16 rows of widget block. Below 12 viewport rows the 6-row floor shrinks to half the viewport, so the transcript keeps the other half, and above 34 viewport rows the 24-row ceiling binds before the share does. When the natural block is taller than the budget, collapse works on whole widgets:

1. Every body renders complete or not at all; a body is never cut to fit.
2. Complete bodies are handed out in priority order: manually expanded widgets first, then the most recently updated widget, then registration order. The first widget whose whole body no longer fits is the cut: it and every lower-priority widget collapse to their `▸ Inline` header.
3. If even a header-only stack exceeds the budget, the whole block renders as one row: `▸ Inline · N widgets · /widgets expand`, shortened on a narrow column to `/widgets expand` and then `/widgets`.

Auto-collapsed headers are marked `(auto)` and keep their `/widgets expand <key>` hint. On a column too narrow for the full hint the header gives up pieces in this order: the `(auto)` marker, then the widget key, then the `expand` argument, leaving `/widgets` as the shortest form. A column too narrow even for that shows no hint at all. The header is clipped rather than wrapped.

A `mpi ctl dump-screen --tab`/`--session` dump renders the transcript without a viewport, so the row budget does not auto-collapse a widget; a widget you collapsed with `/widgets` still prints as its header alone. Dumping the focused tab re-renders the live screen and applies the same row budget; because that pass renders at `--width`, dumping at a width other than the terminal's recomputes the tail and can change which widgets are collapsed.

Three details matter when widget heights change:

- **Decisions are held against jitter, not against change.** Automatic decisions are carried over while the same widgets (same keys and `updatedAt` stamps) share the same budget and the block's fully expanded height moves by no more than a deadband (2 rows, or 20% of the budget when that is larger), so an overflowing tail cannot collapse and re-expand on alternating frames. A resize, a width change, a widget update, a widget added or removed, or a bigger content change recomputes the allocation, so the most recently updated widget takes over the body rows. Held decisions are also dropped once the fully expanded block fits the budget for two frames in a row, so content that keeps shrinking expands again while a one-row dip cannot re-expand a tail that immediately overflows.
- **A manual expand wins.** A widget expanded with `/widgets expand <key>` is never auto-collapsed and keeps its complete body even when the pinned widgets alone exceed the budget: the block overflows rather than contradicting the command or cutting a body. Only when the bare headers themselves exceed the budget does the block fall back to the single summary row.
- **Automatic decisions are disposable.** They live in session-only state. A `/widgets` command takes over its key immediately. The next recomputation discards the rest and decides afresh which widgets collapse; a recomputation follows a resize, a widget update, a widget added or removed, or a content change larger than the deadband.

Use slash commands to control the current tab:

| Command | Action |
|---|---|
| `/widgets` | Toggle all widgets between collapsed and expanded. Automatic collapses count as collapsed while the inline tail renders, so this expands an auto-collapsed tail and lets the bodies take the rows the budget reserved; repeating the command releases the pins back to the row budget, which re-folds what does not fit. Docked widgets and the side panel ignore the automatic set and collapse manually. |
| `/widgets expand [key]` | Expand all widgets or the widget with the given key |
| `/widgets collapse [key]` | Collapse all widgets or the widget with the given key |
| `/widgets toggle [key]` | Toggle all widgets or the widget with the given key |

Manual collapse state and automatic decisions are session-only. Docked widgets and the side panel keep their existing full-content behavior.


| Command | Action |
|---|---|
| `/toggle-inline-widgets` | Toggles inline widget mode on the active tab. |
| `/settings` → `Inline widgets` | Sets the global default for all newly created tabs. |
