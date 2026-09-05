# MixCode TUI Component Catalog

[中文文档](tui-components.zh.md)

Current surface inventory of MixCode TUI. Check here before altering UI: reuse when possible, prefer `@earendil-works/pi-tui` over local rewrites (see AGENTS.md Pi Integration).

Covers:

- Full-screen chrome / agent surface
- State-level overlays / selectors
- Transient UI feedback (Toast / Floating Panel / Notice)
- Ownership boundary with `pi-tui`

## Full-Screen Layout

```text
┌─ Full-screen layout ─────────────────────────────────────────────────────────────────────────────┐
│                                   approximate agent-tab frame                                    │
│                                                                                                  │
│+------------------------------------------------------------------------------------------------+│
│| Header: MixCode                                                                                |│
│|================================================================================================|│
│| [Home] [Agent-01*] [Agent-02] [Agent-03]                                                       |│
│|------------------------------------------------------------------------------------------------|│
│| Status: idle | ctx 12k/200k | claude-sonnet | thinking: medium                                 |│
│|------------------------------------------------------------------------------------------------|│
│| user> implement toast overlay                                                                  |│
│| assistant> adding toast component...                                                           |│
│| tool: bash  ok  (12ms)                                                                         |│
│| assistant> Done. auto-hides in 3s.                                                             |│
│|                                                                                                |│
│| [scrollable chat surface]                                                                      |│
│| (extension header scrolls here)                                                                |│
│| optional: /toggle-inline-widgets moves setWidget chrome here,                                  |│
│| after messages and before Steer/Follow-up; editor top border shows [INL]                       |│
│| optional: extension side panel may split this row                                              |│
│|------------------------------------------------------------------------------------------------|│
│| [extension widgets above editor]  (hidden in inline / vim / side-panel)                        |│
│|------------------------------------------------------------------------------------------------|│
│| > prompt editor   CompactPromptEditor / EditorSlot                                             |│
│|   / @ $ autocomplete (@ files + peer tabs)  |  vim  |  bash-mode !                             |│
│|------------------------------------------------------------------------------------------------|│
│| meta: model | thinking | workdir | git   (omitted when extension footer is set)                |│
│| extension footer widgets  (when set, replaces meta row fields)                                 |│
│| footer                                                                                         |│
│+------------------------------------------------------------------------------------------------+│
│                                                                                                  │
│ overlays: pi-tui showOverlay() floats above this frame                                           │
│ toast / floating-panel: painted into the frame (no focus steal)                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Tree

```text
┌─ Component tree ─────────────────────────────────────────────────────────────────────────────────┐
│                         @earendil-works/pi-tui                                                   │
│  +--------------------------------------------------------------------+                          │
│  | TUI  Container  OverlayHandle  Editor  SelectList  Markdown  Loader|                          │
│  +----------------------------------+---------------------------------+                          │
│                                     |                                                            │
│                                     v                                                            │
│                          MixCodeLayoutRoot                                                       │
│            +----------------+----------------+----------------+                                  │
│            |                |                |                |                                  │
│            v                v                v                v                                  │
│      MixCodeRoot       EditorSlot     MixCodeFooterRoot   Loader                                 │
│            |                |                |            (working)                              │
│            |                v                v                                                   │
│            |        CompactPromptEditor   extension footer                                       │
│            |        + MixCodeCompletion     renderExtensionFooter                                │
│            v                                                                                     │
│   +---------------- chrome (chrome.ts) ----------------+                                         │
│   | header | tab bar | separator | status | input meta |                                         │
│   +-------------------+--------------------------------+                                         │
│                       |                                                                          │
│          +------------+-------------+                                                            │
│          | home tab                 | agent tab                                                  │
│          v                          v                                                            │
│    renderHome()              Agent Surface                                                       │
│    home actions                |                                                                 │
│                                +-- chat blocks (user/asst/tool/bash)                             │
│                                +-- extension header (scrolls w/ chat)                            │
│                                +-- optional extension side panel                                 │
│                                +-- queue preview                                                 │
│                                +-- toast paint (top-right)                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Home

`renderHome()` in `src/ui/rendering/overlays.ts` owns Home layout. The masthead shows the app version, working directory, and live working/input counts. The agent roster uses four rows per item: title/status, model/context/recency, latest output, and a separator row. Only the selected item's content receives the selection background.

At 120 terminal columns or more, with at least 18 rows available below the masthead, the roster and selected conversation appear side by side. Shorter or narrower viewports stack them; the message preview appears only when its 15% row allocation is at least four rows. The roster windows around the selection, and the navigation row stays at the bottom. With fewer than four Home rows, the selected agent replaces section headings; a single remaining row shows the agent rather than navigation hints. Narrow status labels yield space to an eight-column agent identifier. Wide previews use Bun's native `wrapAnsi` on plain text, group consecutive tool calls by count, and mark earlier content when the newest output exceeds the available rows. Message collection scans backward only as far as the visible groups require. Roster summaries are clipped before adding ANSI styling or the tree glyph, so full outputs do not enter Pi's decorated-line width cache. Plain summaries and viewport-sized wrapped tails are weakly cached by tab/message ownership; text edits, width changes, and tail row-budget changes invalidate the relevant entry. Theme colors are applied outside these caches.

Home uses the active theme's semantic colors. Layout does not change agent selection, message submission, or draft ownership. Interaction contracts: [Home keys](keybindings-and-escape.md) and [mouse support](mouse-support.md).

## Ownership Boundaries

```text
┌─ Ownership split ────────────────────────────────────────────────────────────────────────────────┐
│  FROM pi-tui (reuse, do not reimplement)     MIXCODE-LOCAL (owned here)                          │
│  ---------------------------------------     ---------------------------                         │
│  TUI / Container / OverlayHandle             MixCodeLayoutRoot stack                             │
│  Editor / Input / SelectList                 CompactPromptEditor                                 │
│  Markdown / Image / Loader                   Agent Surface + chat blocks                         │
│  Box / Spacer / Text / TruncateText          chrome (header/tab/status)                          │
│  SettingsList (when fits)                    Settings Panel                                      │
│  keybindings / autocomplete APIs             Command Palette / Tab Jump                          │
│  showOverlay anchors / getBounds             Toast / Floating Panel                              │
│                                              Picker / Tree / Session / Fork                      │
│                                              Workspace Overlay                                   │
│                                              Read-only text viewer                              │
│                                              Notice/Error + console bridge                       │
│                                              Extension panel / widgets host                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```
