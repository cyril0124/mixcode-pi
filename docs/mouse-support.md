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
| Jump to latest | Returns the active chat to its end and resumes automatic following. |

### Jump to Latest

When the chat is scrolled away from its end or pinned to a message, a centered jump label floats over the original bottom chat row. A primary-button press on the label returns to the end; the label disappears while new output follows automatically. Vim mode also shows the `G` shortcut. Outside Vim mode, `End` retains its editor line-end behavior.

Only the label's character cells are overlaid: the original text remains visible on both sides, and no row is reserved, cleared, or added. The scrollbar column is excluded and the label is clipped to the chat width. Image rows are left intact. The label is not included in copied transcript text. Modal overlays keep input priority; mouse motion, release, secondary clicks, and an active text-selection drag do not activate the label. The right-hand widget panel keeps its independent scrolling.

## Chat Scrollbar

The main chat keeps its Pi-style scrollbar visible whenever content overflows, in normal, Zen, and split-panel layouts. The track is `│`; hovering or dragging expands the thumb from `┃` to `█`. Leaving the track restores the thin thumb without hiding it. Content that fits has no scrollbar.

Clicking the track centers the thumb at the pointer, clamped at either end. Pressing the thumb retains the grab position; dragging continues outside the track until release. Tab changes, modal takeovers, resizing, and terminal teardown cancel capture. The existing new-content arrow remains visible while reading above a running response.

The chat reserves a one-column gutter, keeping the scrollbar out of text and selection coordinates. Long transcripts retain windowed rendering and estimated total heights. Third-party Pi themes use `scrollbarTrack` and `scrollbarThumb`; built-in MixCode themes use their muted and text foregrounds. Scrollbar interaction state lives in `src/ui/chat-scrollbar.ts`; geometry and cell painting use exported Pi helpers from the `pi-tui` patch.

`src/ui/terminal.ts` enables all-motion tracking (`1003`) with SGR coordinates (`1006`) and disables it on stop or input drain. Passive pointer movement outside the chat track does not trigger a MixCode repaint or alter keyboard chords. Side-panel scrolling remains independent.

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
- **Automatic Clipboard Copy**: Releasing the mouse button copies the selected text to the system clipboard.
- **ANSI-Clean Extraction**: Strips syntax highlighting and background colors, copying plain text.
- **Wide-Character (CJK) Boundary Safe**: `src/core/chat-selection.ts` snaps the start column to `getGraphemeCellRange(line, col).start` and the end column to `.end`, so a full-width grapheme under the pointer is never split.
- **Block Background Overlay**: The same helper reapplies `theme.selectedBg` after every SGR in the selected slice so tool/thinking card backgrounds cannot hide the highlight.
- **Edge Auto-Scroll**: Dragging past the top or bottom border of the chat viewport automatically scrolls the conversation while maintaining the drag selection.
