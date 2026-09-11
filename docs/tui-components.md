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
│| after messages and before Steer/Follow-up; each inline widget starts with a `▸ Inline · <key>` header                 |│
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

Home uses the active theme's semantic colors. `src/ui/home-actions.ts` paints a filled, accent-colored `+ New session` button and a lower-emphasis `Resume` button beside the roster heading. When they do not fit beside the heading, they occupy a separate row if height permits. Width pressure hides Resume first and then shortens New session to New; buttons are never partially clipped. Short populated viewports retain the selected agent before action chrome; empty viewports prioritize the new-session action. Button dimensions do not change with hover, press, or pending state. Pointer state and hit regions are ephemeral and are not persisted.

Layout does not change agent selection, message submission, or draft ownership. No new keybindings or button focus cycle are added; `Tab` still switches tabs, and both actions are available through `Ctrl+P` or slash commands even without an open session. Interaction contracts: [Home keys](keybindings-and-escape.md) and [mouse support](mouse-support.md).

## Input editor

`CompactPromptEditor` in `src/ui/app-editor.ts` renders a rounded input frame. Its top edge groups the agent name and exact context usage on the right, with active `[VIM]`, `[SHELL]`, `[ZEN]`, `[sys]`, and hidden-line indicators on the left. Narrow layouts drop mode labels and context before truncating the name. Context usage takes the warning color at 85% of the configured limit.

An empty or single-line draft occupies three rows. Additional lines grow the body up to Pi's scroll limit. [`editorPaddingX`](mixcode-settings.md) controls horizontal padding inside the side borders. Below eight columns, the editor retains the draft and cursor while hiding the frame and text. The frame uses the tab's `thinkingBorder` color, overridden by `vimBorder` in Vim mode. Text and labels use theme foreground colors over the terminal background.

Empty input shows dim hints for `@ files` and `/ commands`. Agent tabs also show `← Home · → widgets`; Vim mode shows navigation instructions instead. These hints disappear while the draft contains text and truncate to the available width. The bottom edge is reserved for the count of editable draft lines below the viewport. Completion choices appear beneath the frame.

Pi owns editing and wrapping. Its `Editor.renderTopBorder()` and `renderBottomBorder()` hooks supply hidden-line counts; the widened bottom edge separates body rows from completion rows. MixCode preserves hardware cursor markers and translates mouse columns to the inner editor coordinates. `EditorSlot` delegates rendering to custom editors and temporary input components; custom-editor agent labels appear on the tab-bar separator.

## Conversation cards

`src/ui/rendering/message-cards.ts` uses Pi's `SkillInvocationMessageComponent`, `BranchSummaryMessageComponent`, and `CompactionSummaryMessageComponent`. The cards use Pi's colors, spacing, and keybinding hints. `chat.ts` uses Pi's `parseSkillBlock`; MixCode keeps skill timestamps, user arguments, and image attachments. A skill without arguments places its timestamp on the card label. A skill with arguments places the timestamp on the separate user message.

`ChatLine.summaryMessage` carries the summary data needed by Pi. `runtime-chat.ts` builds it from the session entry and preserves the summary text, timestamp, branch source, and compaction token count. Zero is a valid token count. `ChatLine.text` remains available to host search and previews. Session files keep Pi's existing format.

MixCode owns expansion state and the per-line render cache. Card rendering temporarily applies the active theme and the shared keybinding manager, then restores both. Cache keys include the expansion binding, so a reloaded shortcut changes the hint on the next render. Expanded cards keep the configured code-block indentation and Mermaid handling. User argument blocks keep their existing Markdown and image settings.

## Ownership boundaries

`createMixCodeTui()` in `src/ui/app.ts` uses Pi's `TuiAltScreen`. It renders the fixed application frame in the terminal's alternate screen, positioning each changed row with absolute coordinates inside synchronized output. Pi owns line diffing, overlays, image placement, cursor placement, and screen restoration on `stop({ preserveScreen: true })`. Image support follows the upstream renderer: Kitty graphics are supported; the `iterm2` protocol is disabled, and image components display text placeholders.

MixCode owns chat virtualization and input routing. The Pi patch option `viewportInput: false` leaves scrolling and selection with the host, and `mouse: false` leaves mouse reporting with `MouseReportingTerminal`. The fullscreen painter restores a full-screen origin and scrolling region before writing a frame. Absolute navigation to the beginning of chat clears the frozen viewport anchor so height recalculation cannot override the requested position.

The Pi dependency patches skip Mermaid parsing for unfenced messages and check for a possible Setext underline before invoking Marked's heading regex. Matching heading candidates still use the upstream parser.

Renderer handoffs are reversible: `start()` restores the redraw/title bindings and stdout protection removed by `stop()`. `pause()/resume()` preserve these resources while temporarily releasing the terminal.

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
