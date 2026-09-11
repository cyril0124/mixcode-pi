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

`CompactPromptEditor` in `src/ui/app-editor.ts` renders the default editor as a rounded card. Agent identity and exact context usage are grouped at the right of the top edge; usage takes the warning color at 85% of the configured limit. `[VIM]`, `[SHELL]`, `[ZEN]`, `[sys]`, and hidden-line indicators appear on the left when active. The empty draft displays `@ files  / commands` alongside its dim placeholder. Empty agent input also shows `← Home · → widgets`; these navigation hints are omitted on Home and once the draft contains text. Placeholder text is truncated to the available width. The bottom edge is plain during ordinary input and in Vim mode. Completion, shell/queue actions, and hidden-line indicators appear only when relevant; ordinary send and newline hints are omitted. Vim navigation hints appear only in the empty input body. Narrow cards omit mode labels and context before truncating the right-aligned identity; the bottom edge prioritizes its primary action.

The entire frame, including corners and side borders, follows the active theme's `thinkingBorder` color for the tab's thinking level. Vim mode takes precedence with `vimBorder`; leaving Vim restores the current thinking-level color. Body and labels use `text` and `accent`, leaving the terminal background unchanged. Horizontal body padding inside the side borders follows [`editorPaddingX`](mixcode-settings.md). No blank rows are added around the draft: empty and single-line cards occupy three rows; additional text lines grow the body up to Pi's scroll limit. Widths below eight columns retain the draft and cursor but omit the card and text until there is room to render wide graphemes safely.

Pi's existing `Editor.renderTopBorder()` and `renderBottomBorder()` hooks supply scroll counts. MixCode locates its widened bottom edge in the rendered rows to separate the draft from autocomplete; Pi owns text wrapping and editing. Completion rows stay outside the card; hardware cursor markers survive framing, and mouse coordinates are translated back to Pi's inner geometry. `EditorSlot` leaves custom editor components and temporary input takeovers responsible for their own rendering. Custom-editor agent labels remain on the tab-bar separator.

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
