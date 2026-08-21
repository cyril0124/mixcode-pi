# Mouse Support & Clickable Interactions

[中文文档](mouse-support.zh.md)

MixCode Pi enables full terminal mouse tracking via SGR 1006 protocol (`src/ui/app-mouse.ts` and `src/core/mouse.ts`), supporting clickable tabs, interactive overlay selection, scrollbar dragging, and ANSI-clean text selection.

## 1. Clickable Surfaces & Hit Regions

MixCode computes exact hit regions (`MouseHitRegion`) during frame rendering to route mouse clicks directly to actions:

```text
┌─ Clickable TUI Zones ────────────────────────────────────────────────────┐
│ MixCode Home  [Agent-01*] [Agent-02] [Agent-03]                          │
│  │             │                                                         │
│  ▼             ▼                                                         │
│ Home           Switch tab. Re-click the active chip to open Tab Jump.    │
├──────────────────────────────────────────────────────────────────────────┤
│ ── ● (running) ● (waiting) [+1] ──────────────────────────────────────── │
│    │                                                                     │
│    └─ Zen mode: status dots are visual only (not clickable)              │
├──────────────────────────────────────────────────────────────────────────┤
│ [Chat Transcript Surface]                         │ [Chat Scrollbar]     │
│  │                                                │  │                   │
│  ├─ Left Click + Drag: Highlight & Copy Text      │  └─ Click / Drag to  │
│  └─ Wheel Up / Down: Scroll conversation view     │     scroll viewport  │
├──────────────────────────────────────────────────────────────────────────┤
│ > prompt editor                                                          │
│  │                                                                       │
│  └─ Left Click + Drag: Select and copy draft text                        │
├──────────────────────────────────────────────────────────────────────────┤
│ [Model: claude-sonnet] [Thinking: medium] [Workdir: /repo]               │
│  │                      │                  │                             │
│  ▼                      ▼                  ▼                             │
│ Open Model Picker   Open Thinking Picker Open Workdir Picker             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Clickable Target Summary

| UI Element | Action on Click |
|---|---|
| Tab chip | Focus that tab. Re-click the already-active chip to open Tab Jump. |
| MixCode Home chip | Opens the Home tab. Compact form is ` H `. |
| Zen background dots (`●`) | Visual status only. Not clickable. |
| Model Badge in Meta Bar | Opens the `/models` model selection picker. |
| Thinking Badge in Meta Bar | Opens the `/thinking` effort level picker. |
| Workdir Badge in Meta Bar | Opens the `/workdir` directory navigation picker. |
| Chat Scrollbar Rail & Thumb | Jumps or drags the conversation viewport directly. |

## 2. Interactive Overlay Clicking & Scrolling

Modal overlays support direct mouse navigation:

- **Command Palette (`Ctrl+P`)**: Click a command row to run it.
- **Tab Jump (`Ctrl+T`)**: Click any tab row to switch directly.
- **Model / Workdir Pickers**: Click any entry to select; scroll wheel scrolls through candidate lists.

## 3. Mouse Wheel Scrolling

- **Chat Transcript**: Wheel up/down scrolls the conversation history.
- **Side Panels**: Hovering and scrolling over the extension side panel scrolls that pane independently.

## 4. Mouse Drag Text Selection & Auto-Copy

Dragging with the left mouse button across the Chat surface, Input Editor, or Notice dialog highlights visible text:
- **Automatic Clipboard Copy**: Releasing the mouse button copies the selected text cleanly to the system clipboard.
- **ANSI-Clean Extraction**: Strips syntax highlighting and background colors, copying plain text.
- **Wide-Character (CJK) Boundary Safe**: `src/core/chat-selection.ts` snaps the start column to `getGraphemeCellRange(line, col).start` and the end column to `.end`, so a full-width grapheme under the pointer is never split.
- **Block Background Overlay**: The same helper reapplies `theme.selectedBg` after every SGR in the selected slice so tool/thinking card backgrounds cannot hide the highlight.
- **Edge Auto-Scroll**: Dragging past the top or bottom border of the chat viewport automatically scrolls the conversation while maintaining the drag selection.
