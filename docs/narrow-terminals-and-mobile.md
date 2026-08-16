# Narrow & Mobile Terminal Optimizations

[中文文档](narrow-terminals-and-mobile.zh.md)

MixCode Pi provides dedicated layout degradation and touch/mouse optimizations for narrow terminal windows, mobile terminal emulators (e.g. Termux, iOS Blink/SSH), and split-pane environments.

## 1. Narrow Terminal Layout Adaptation

When running under constrained widths (<80 columns) or short vertical heights, MixCode dynamically degrades chrome elements to avoid visual clipping:

```text
┌─ Ultra-Narrow / Mobile Layout (<70 columns) ─────────────────────────────┐
│ H [Agent-01*] [Agent-02]  … +2                                           │
├──────────────────────────────────────────────────────────────────────────┤
│ ── [ZEN] ───────────────────────────────────────────── Agent-01 ── 12k ──│
│ > prompt editor                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ opus-4-5 | /repo/pkg | git                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

### Progressive Degradation Strategy

1. **Tab Bar Compaction (`src/ui/rendering/chrome.ts`)**:
   - `MixCode Home` collapses to compact `" H "` when width is constrained.
   - Long tab lists show left/right overflow indicators (`+N …` / ` … +N`).
   - Active tab title preserves full visibility while inactive titles truncate with `…`.
2. **Metadata Row Compression (`compactWorkdir`)**:
   - Compresses long working directory paths progressively (e.g. `~/w/p/m/packages/cli`).
   - Model names degrade smoothly: `provider/modelId` → `modelId` → truncated string.
3. **Editor Badge Drop Order**:
   - When editor width is tight, top border badges are dropped in strict non-essential order: `[INL]` → `[ZEN]` → `[VIM]` → `[sys]`.
4. **Widget Row Caps & Truncation**:
   - Above/below editor docks enforce strict row caps (`… (widgets truncated)`) to guarantee the chat surface and prompt editor always retain visible typing space.

## 2. Touch & Mobile-Friendly Mouse Interactions

Mobile SSH clients and tablets emulate mouse clicks via SGR 1006 touch events:

- **Touch-to-Switch Tabs**: Tap a tab chip or the compact ` H ` Home chip to switch contexts.
- **Zen status dots**: Visual only. Not tappable.
- **Clickable Metadata**: Tap model, thinking, or workdir chips in the bottom meta bar to open interactive pickers.
- **Drag-to-Copy with Edge Auto-Scroll**: Touch-drag across chat lines highlights text and copies clean ANSI-stripped text to the system clipboard upon release.
