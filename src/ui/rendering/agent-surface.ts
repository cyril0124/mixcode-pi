import { compositeTuiLine, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chatSelectionHighlight } from "./highlight.js";
import { pointerHoverFor } from "../pointer-hover.js";
import { chatScrollbarFor } from "../chat-scrollbar.js";
import type { ChatLine, RuntimeTab } from "../../agent/runtime.js";
import {
  captureScrollableChatSelection,
  highlightChatSelectionLine,
  scrollableChatSelectionForViewport,
} from "../../core/chat-selection.js";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import { activeToast } from "../../core/toast.js";
import type { ChatExpandTarget, MixCodeTabInfo } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import {
  type AgentSurfaceRenderOptions,
  chatBlockRenderOptions,
  oversizedPolicyKey,
} from "./agent-surface-options.js";
import {
  applyChatBlockScrollAnchor,
  applyPendingScrollUserDelta,
  applyScrollFreezeAnchor,
  BLOCK_HEIGHT_FALLBACK,
  type ChatBlockLayout,
  decorateWindow,
  estimateTotalHeight,
  keepScrolledViewStable,
  rememberChatBlockScrollAnchor,
  rememberScrollFreezeAnchor,
  scrollFreezeChatLine,
} from "./agent-surface-scroll.js";
import {
  chatBlockSeparator,
  chatLinesForDisplay,
  originalChatIndicesForDisplay,
  renderChatBlock,
  renderConversation,
  renderConversationEmptyState,
  renderStartupBlock,
} from "./chat.js";
import { renderExtensionHeader, renderInlineExtensionWidgets } from "./chrome.js";
import { chatExpandTarget } from "./chat-expansion.js";
import { paintRowBackground } from "../pointer-hover.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { renderHeaderKeyHints } from "../components/header-hints.js";
import { clipChatImages, fitScrolledLinesWithInfo, type ScrolledLinesResult } from "./layout.js";
import { isOversizedAssistantMessageText } from "./oversized-assistant-message.js";
import { box } from "./primitives.js";
import { applyToastOverlay } from "../components/toast-overlay.js";

// Above this many chat blocks we switch from "render everything, then slice"
// to the windowed renderer. The windowed path has more bookkeeping overhead
// per call, so for short chats it's faster to just render the whole thing.
// Picked via the perf-tab-switch benchmark — at ~100 blocks both paths cross.
const WINDOW_RENDER_BLOCK_THRESHOLD = 60;
// During streaming, the threshold is lower because the streaming block's
// markdown re-parse dominates frame cost and windowed rendering avoids
// iterating all blocks in the legacy path.
const WINDOW_RENDER_STREAMING_THRESHOLD = 20;
// Extra rendered lines above and below the visible viewport. Larger overscan
// makes scroll-up smoother (fewer cache misses while paging) at the cost of
// extra block renders per frame.
const WINDOW_OVERSCAN_LINES = 20;

// Cache the expensive renderConversation result per tab.
// Queue preview and inline widgets are appended after the cache so live
// widget ticks cannot bust the conversation cache.
// Invalidated when chat content, width, theme, or relevant UI state changes.
// The full-render cache is bypassed while active tool renderers may have
// lifecycle side effects that need to run on every frame.
interface ConversationCache {
  lines: string[];
  /** Pointer block rows in `lines` coordinates, translated to the visible window on use. */
  pointerRanges: Array<{ start: number; height: number; expand?: ChatExpandTarget }>;
  /** Sorted blocks expanded on their own, so a click invalidates this cache. */
  expandedBlocks: string;
  // Invalidation keys
  chatLength: number;
  lastChatText: string;
  lastChatStatus: string | undefined;
  width: number;
  themeName: string;
  toolsExpanded: boolean;
  oversizedPolicyKey: string;
  hideThinking: boolean;
  boxedHiddenThinking: boolean;
  showResponseModelNotices: boolean;
  hiddenThinkingLabel: string;
  mermaidRenderingMode: string;
  showImages: boolean;
  imageWidthCells: number;
  chatRef: ChatLine[];
}

const conversationCacheMap = new Map<string, ConversationCache>();

/** Remove cached conversation lines for a closed tab to prevent memory leaks. */
export function clearConversationCache(sessionId: string): void {
  conversationCacheMap.delete(sessionId);
}

/**
 * Header lines to prepend at the top of the scrollable conversation: the
 * extension header (when set), the keyboard-hint block, then the tab-level
 * startup resource summary. Rendered live every frame (never cached) so
 * dynamic headers keep updating, matching Pi where header +
 * loadedResourcesContainer are the first children of the scrollback and
 * scroll away with the conversation. Living outside the chat array, all of
 * these survive chat rebuilds from session entries.
 */
function scrollableHeaderLines(tab: MixCodeTabInfo, width: number): string[] {
  const blocks = [
    renderExtensionHeader(tab, width),
    renderHeaderKeyHints(tab, width),
    tab.startupSummary
      ? renderStartupBlock(
          tab.extensionUi.toolsExpanded
            ? tab.startupSummary
            : (tab.startupSummaryCompact ?? tab.startupSummary),
          width,
        )
      : [],
  ].filter((block) => block.length > 0);
  if (!blocks.length) return [];
  const lines = blocks.flatMap((block, index) =>
    index === 0 ? block : [chatBlockSeparator(width), ...block],
  );
  return [...lines, chatBlockSeparator(width)];
}

function shouldRenderInlineWidgets(tab: MixCodeTabInfo): boolean {
  // Vim still hides the editor dock; inline widgets stay in the chat tail.
  return tab.inlineWidgets === true && tab.panelOpen !== true;
}

function renderInlineWidgetLines(
  tab: MixCodeTabInfo,
  width: number,
  viewportRows: number | undefined,
): string[] {
  if (!shouldRenderInlineWidgets(tab)) return [];
  const lines = renderInlineExtensionWidgets(tab, width, { viewportRows });
  // Lift the chat-tail band off the transcript. Dock/panel keep dim-only chrome.
  return lines.map((line) => activeRenderTheme.surface(line));
}

/** Messages → widgets → Steer/Follow-up. Widgets are omitted unless inline mode is on. */
function renderChatTailLines(
  tab: MixCodeTabInfo,
  width: number,
  viewportRows: number | undefined,
): string[] {
  return joinBlocksWithSeparator(
    [renderInlineWidgetLines(tab, width, viewportRows), renderQueuePreview(tab, width)],
    chatBlockSeparator(width),
  );
}

export function renderAgentSurface(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
  maxHeight?: number,
  theme: MixCodeTheme = activeRenderTheme,
  options: AgentSurfaceRenderOptions = {},
): string[] {
  return renderWithTheme(theme, () =>
    renderAgentSurfaceInner(tab, runtimeTab, width, maxHeight, options),
  );
}

function renderAgentSurfaceInner(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
  maxHeight: number | undefined,
  options: AgentSurfaceRenderOptions,
): string[] {
  tab.chatJumpToLatestHitRegion = undefined;
  const surfaceWidth = maxHeight === undefined || width < 2 ? width : width - 1;

  if (maxHeight !== undefined && runtimeTab && tab.chatAtHome) {
    return renderAgentSurfaceWindowed(
      tab,
      runtimeTab,
      runtimeTab.chat,
      width,
      maxHeight,
      surfaceWidth,
      options,
    );
  }

  if (maxHeight !== undefined && runtimeTab && tab.chatScrollAnchorEntryId) {
    return renderAgentSurfaceAnchored(tab, runtimeTab, width, maxHeight, surfaceWidth, options);
  }

  // Windowed path: only viable when the caller is going to clip to maxHeight
  // anyway and chat is long enough that rendering every block hurts. Falls
  // through to the legacy full-render path otherwise (legacy callers pass
  // maxHeight=undefined, e.g. tests measuring full layout).
  if (maxHeight !== undefined) {
    const chat = runtimeTab?.chat ?? [];
    if (canUseWindowedRender(tab, chat, options.oversizedAssistantMessage)) {
      return renderAgentSurfaceWindowed(
        tab,
        runtimeTab,
        chat,
        width,
        maxHeight,
        surfaceWidth,
        options,
      );
    }
  }

  const conversation = getCachedConversationLines(tab, runtimeTab, surfaceWidth, options);
  const body = conversation.lines;
  // Extension header rides at the very top of the scrollable conversation
  // (like Pi): visible when scrolled to the top, scrolls away otherwise.
  const headerLines = scrollableHeaderLines(tab, surfaceWidth);
  const tailLines = renderChatTailLines(tab, surfaceWidth, maxHeight);
  const withHeader = headerLines.length ? [...headerLines, ...body] : body;
  const lines =
    tailLines.length === 0
      ? withHeader
      : withHeader.length
        ? [...withHeader, chatBlockSeparator(surfaceWidth), ...tailLines]
        : tailLines;
  if (maxHeight === undefined) return lines;
  // Clamp chatScrollOffset to the actual scrollable range so that sentinel
  // values (e.g. 1_000_000 from chatHome) don't leave the offset far above
  // the content, which would make subsequent small scroll deltas (j / ctrl+d)
  // appear to do nothing.
  const viewport = Math.max(0, Math.floor(maxHeight));
  keepScrolledViewStable(tab, lines.length, surfaceWidth, viewport);
  const maxOffset = Math.max(0, lines.length - viewport);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  applyScrollFreezeAnchor(tab, lines, viewport, surfaceWidth, true);
  applyPendingScrollUserDelta(tab);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  tab.lastRenderedChatAtTop = tab.chatScrollOffset >= maxOffset;
  const fitted = fitScrolledLinesWithInfo(lines, maxHeight, surfaceWidth, tab.chatScrollOffset);
  // The shared pager substitutes boundary rows. Chat keeps the original bottom
  // row so the floating jump label can cover only its own cells, not the whole row.
  if (fitted.lines.length > 0 && fitted.end < fitted.total) {
    fitted.lines[fitted.lines.length - 1] = lines[fitted.end - 1]!;
  }
  fitted.lines = clipChatImages(lines, fitted.start, fitted.lines);
  // Pointer blocks move with the header offset and then with the visible window.
  publishChatPointerRanges(
    tab,
    conversation.pointerRanges
      .map((range) => ({
        start: range.start + headerLines.length - fitted.start,
        height: range.height,
        expand: range.expand,
      }))
      .filter((range) => range.start < fitted.height && range.start + range.height > 0),
  );
  rememberScrollFreezeAnchor(tab, fitted.lines, surfaceWidth, fitted.height);
  const highlighted = highlightVisibleChatLines(fitted.lines, tab, surfaceWidth, fitted.height);
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar({ ...fitted, lines: highlighted }, width, hasNewContent, tab);
}

/**
 * Pick between the windowed and full-render path. Windowed rendering is used
 * whenever the caller clips output and the chat is long enough to make full
 * rendering expensive.
 *
 * For a typical "long quiet chat" tab switch the dynamic-renderer check is
 * cheap because such tabs have few/none of those blocks.
 */
function canUseWindowedRender(
  tab: MixCodeTabInfo,
  chat: ChatLine[],
  oversizedPolicy: OversizedAssistantMessageSettings | undefined,
): boolean {
  // During streaming, active tool renderers are always at the tail of the
  // chat (current turn). The windowed renderer walks backward from the tail,
  // so it naturally includes them in the viewport. Allow windowed rendering
  // with a lower threshold during streaming to avoid the expensive legacy
  // full-render path that blocks the event loop.
  const isActiveRun = tab.status === "running" || tab.status === "thinking";
  if (isActiveRun && chat.length >= WINDOW_RENDER_STREAMING_THRESHOLD) return true;
  return (
    chat.length >= WINDOW_RENDER_BLOCK_THRESHOLD ||
    chat.some(
      (line) =>
        (line.role === "assistant" || line.role === "thinking") &&
        isOversizedAssistantMessageText(line.text, oversizedPolicy),
    )
  );
}

/**
 * Windowed renderer.
 *
 * Algorithm (backward walk):
 *   1. Materialize the queue preview (always emitted at the bottom).
 *   2. Walk chat blocks from the newest to the oldest, prepending each
 *      rendered block (and its leading separator) to a line buffer. Stop
 *      once we've collected enough rows to cover viewport + scrollOffset
 *      + overscan (so adjacent boundary markers can be placed).
 *   3. Slice the visible viewport out of the assembled lines.
 *
 * Trade-off: the scrollbar thumb position uses estimated heights for the
 * blocks we did NOT render, since we don't know their actual size. This
 * gives a slightly imprecise but stable thumb. The visible content is
 * always exact because actual heights drive the slicing.
 */
function renderAgentSurfaceAnchored(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab,
  width: number,
  maxHeight: number,
  surfaceWidth: number,
  options: AgentSurfaceRenderOptions,
): string[] {
  const chat = runtimeTab.chat;
  const viewport = Math.max(0, Math.floor(maxHeight));
  if (viewport <= 0) {
    publishChatPointerRanges(tab, []);
    return [];
  }

  let anchorIndex = tab.chatScrollAnchorIndex ?? -1;
  if (
    anchorIndex < 0 ||
    anchorIndex >= chat.length ||
    !matchesChatAnchor(chat[anchorIndex]!, tab)
  ) {
    anchorIndex = chat.findIndex((line) => matchesChatAnchor(line, tab));
  }
  if (anchorIndex < 0) {
    tab.chatScrollAnchorEntryId = undefined;
    tab.chatScrollAnchorIndex = undefined;
    tab.chatScrollAnchorText = undefined;
    return renderAgentSurfaceWindowed(
      tab,
      runtimeTab,
      chat,
      width,
      maxHeight,
      surfaceWidth,
      options,
    );
  }

  const frameBlockHeights = new Map<ChatLine, number>();
  const localOffset = tab.chatScrollOffset;
  // Walk older blocks (anchor-1 → 0), collect newest-first, then reverse-join.
  // Avoids O(n²) Array.unshift while building the prefix above the anchor.
  const prefixBlocksNewestFirst: string[][] = [];
  const prefixSpansNewestFirst: Array<{ line: ChatLine; height: number }> = [];
  const neededPrefixRows = Math.max(0, localOffset);
  let prefixRows = 0;
  for (let i = anchorIndex - 1; i >= 0 && prefixRows < neededPrefixRows; i--) {
    const block = renderChatBlock(
      chat[i]!,
      surfaceWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, i, options),
    );
    frameBlockHeights.set(chat[i]!, block.length);
    if (block.length === 0) continue;
    if (prefixRows > 0) prefixRows += 1; // separator
    prefixRows += block.length;
    prefixBlocksNewestFirst.push(block);
    prefixSpansNewestFirst.push({ line: chat[i]!, height: block.length });
  }
  const prefix = joinBlocksWithSeparator(
    prefixBlocksNewestFirst.reverse(),
    chatBlockSeparator(surfaceWidth),
  );
  const anchoredPointerRanges: Array<{ start: number; height: number; expand?: ChatExpandTarget }> =
    [];
  {
    let cursor = 0;
    for (const span of prefixSpansNewestFirst.reverse()) {
      if (cursor > 0) cursor += 1; // separator
      const expand = chatExpandTarget(span.line);
      if (expand) {
        anchoredPointerRanges.push({ start: cursor, height: span.height, expand });
      }
      cursor += span.height;
    }
  }

  const suffix: string[] = [];
  let suffixHasContent = prefix.length > 0;
  const suffixLimit = viewport + Math.max(0, -localOffset);
  let i = anchorIndex;
  for (; i < chat.length && suffix.length < suffixLimit; i++) {
    const line = chat[i]!;
    const block = renderChatBlock(
      line,
      surfaceWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, i, options),
    );
    frameBlockHeights.set(line, block.length);
    if (block.length === 0) continue;
    if (suffixHasContent) suffix.push(chatBlockSeparator(surfaceWidth));
    const spanStart = prefix.length + suffix.length;
    for (const renderedLine of block) suffix.push(renderedLine);
    suffixHasContent = true;
    const expand = chatExpandTarget(line);
    if (expand) {
      anchoredPointerRanges.push({ start: spanStart, height: block.length, expand });
    }
  }
  const tailLines = renderChatTailLines(tab, surfaceWidth, viewport);
  if (i >= chat.length && tailLines.length > 0) {
    if (suffixHasContent) suffix.push(chatBlockSeparator(surfaceWidth));
    suffix.push(...tailLines);
  }
  const lines = [...prefix, ...suffix];
  const anchorStart = prefix.length;
  const requestedStart = anchorStart - localOffset;
  const windowStart = Math.max(0, Math.min(requestedStart, Math.max(0, lines.length - viewport)));
  publishChatPointerRanges(
    tab,
    anchoredPointerRanges
      .map((range) => ({ ...range, start: range.start - windowStart }))
      .filter((range) => range.start < viewport && range.start + range.height > 0),
  );
  const visible = lines.slice(windowStart, windowStart + viewport);
  while (visible.length < viewport) visible.push(chatBlockSeparator(surfaceWidth));

  const total = estimateTotalHeight(chat, tailLines.length, frameBlockHeights);
  const start = Math.min(
    Math.max(0, total - visible.length),
    anchorIndex * BLOCK_HEIGHT_FALLBACK + windowStart,
  );
  const decorated = clipChatImages(
    lines,
    windowStart,
    decorateWindow(visible, start, viewport, surfaceWidth),
  );
  const fitted: ScrolledLinesResult = {
    lines: highlightVisibleChatLines(decorated, tab, surfaceWidth, viewport),
    total,
    height: viewport,
    start,
    end: Math.min(total, start + viewport),
    scrollable: total > viewport,
  };
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar(fitted, width, hasNewContent, tab);
}

function matchesChatAnchor(line: ChatLine, tab: MixCodeTabInfo): boolean {
  if (line.entryId && line.entryId === tab.chatScrollAnchorEntryId) return true;
  return Boolean(
    tab.chatScrollAnchorText && line.role === "user" && line.text === tab.chatScrollAnchorText,
  );
}

/** Join blocks already ordered top-to-bottom; insert separator between non-empty ones. */
function joinBlocksWithSeparator(blocks: string[][], separator: string): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.length === 0) continue;
    if (out.length > 0) out.push(separator);
    for (const line of block) out.push(line);
  }
  return out;
}

function renderAgentSurfaceWindowed(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  chat: ChatLine[],
  width: number,
  maxHeight: number,
  surfaceWidth: number,
  options: AgentSurfaceRenderOptions,
  freezeAdjusted = false,
): string[] {
  const viewport = Math.max(0, Math.floor(maxHeight));

  // Extension header rides at the very top of the scrollable conversation.
  const headerLines = scrollableHeaderLines(tab, surfaceWidth);

  // Bottom-anchored content: inline widgets, then Steer/Follow-up.
  const tailLines = renderChatTailLines(tab, surfaceWidth, viewport);
  // Pending user-bash renders after the main stream (Pi pending-area parity).
  const displayChat = chatLinesForDisplay(chat);
  const originalIndices = originalChatIndicesForDisplay(chat, displayChat);

  // Walk chat blocks newest-to-oldest, collecting rendered blocks, then
  // reverse-join into top-to-bottom order. Push+reverse is O(n); unshift was O(n²).
  const targetRows = tab.chatAtHome
    ? viewport + (tab.chatHomeOffset ?? 0) + WINDOW_OVERSCAN_LINES
    : viewport + Math.max(0, tab.chatScrollOffset) + WINDOW_OVERSCAN_LINES;
  const newerFirstBlocks: string[][] = [];
  const newerFirstChatLines: ChatLine[] = [];
  const frameBlockHeights = new Map<ChatLine, number>();
  const previousAnchor = scrollFreezeChatLine(tab);
  // Runtime projections can replace a block without changing its text. Resolve
  // the current object first, preserving identity before using the layout fallback.
  const anchor =
    previousAnchor &&
    (displayChat.find((line) => line === previousAnchor) ??
      displayChat.find(
        (line) =>
          (previousAnchor.entryId && line.entryId === previousAnchor.entryId) ||
          (previousAnchor.text &&
            line.role === previousAnchor.role &&
            line.text === previousAnchor.text),
      ));
  let reachedAnchor = anchor === undefined;
  let oldestEmittedIndex = displayChat.length;
  // Tail rows cannot satisfy a viewport collected from the beginning.
  let assembledRows = tab.chatAtHome ? 0 : tailLines.length;
  const firstIndex = tab.chatAtHome ? 0 : displayChat.length - 1;
  const step = tab.chatAtHome ? 1 : -1;
  for (let i = firstIndex; i >= 0 && i < displayChat.length; i += step) {
    // New messages can fill the budget before the visible anchor is reached.
    // Retain that block so estimated heights cannot displace the pinned text.
    if (assembledRows >= targetRows && reachedAnchor) break;
    const line = displayChat[i]!;
    if (line === anchor) reachedAnchor = true;
    const originalIndex = originalIndices?.get(line) ?? i;
    const block = renderChatBlock(
      line,
      surfaceWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, originalIndex, options),
    );
    // Some rendered blocks intentionally bypass the cross-frame cache (for
    // example the active streaming assistant tail). Keep their just-rendered
    // height for this frame so scroll bounds use what is actually on screen.
    frameBlockHeights.set(line, block.length);
    if (block.length === 0) {
      // Empty block contributes nothing visually; just record visit.
      oldestEmittedIndex = i;
      continue;
    }
    if (assembledRows > 0) assembledRows += 1; // separator between this block and content below
    assembledRows += block.length;
    newerFirstBlocks.push(block);
    newerFirstChatLines.push(line);
    oldestEmittedIndex = i;
  }

  // newerFirstBlocks is [newest, ..., oldest]; reverse to oldest-first top-to-bottom.
  const orderedBlocks = tab.chatAtHome ? newerFirstBlocks : newerFirstBlocks.reverse();
  const orderedChatLines = tab.chatAtHome ? newerFirstChatLines : newerFirstChatLines.reverse();
  const olderLines = joinBlocksWithSeparator(orderedBlocks, chatBlockSeparator(surfaceWidth));

  // When the backward walk reached the very first block, the header sits
  // directly above it (Pi-style). Otherwise it stays part of the virtual
  // prefix counted via estimateTotalHeight's extraRows below.
  const reachedTop = tab.chatAtHome || oldestEmittedIndex === 0;
  let lines: string[];
  if (reachedTop && headerLines.length) {
    lines = olderLines.length ? [...headerLines, ...olderLines] : [...headerLines];
  } else {
    lines = olderLines;
  }
  if (tailLines.length > 0) {
    // Separate on whatever is already above the tail, not just chat blocks: a
    // header with only empty-rendering blocks below it still needs the gap, and
    // the full-render path uses the same rule (see renderConversation above).
    if (lines.length > 0) lines.push(chatBlockSeparator(surfaceWidth));
    lines.push(...tailLines);
  }

  // Empty-state placeholder mirrors what renderConversation would produce.
  if (lines.length === 0) {
    const placeholder = renderConversationEmptyState(surfaceWidth);
    const withHeader = headerLines.length ? [...headerLines, ...placeholder] : placeholder;
    const fitted = fitScrolledLinesWithInfo(withHeader, maxHeight, surfaceWidth, 0);
    // The highlight reads the published ranges, so they must be current before it runs.
    publishChatPointerRanges(tab, []);
    const highlighted = highlightVisibleChatLines(fitted.lines, tab, surfaceWidth, fitted.height);
    return appendChatScrollbar({ ...fitted, lines: highlighted }, width, false, tab);
  }

  // Estimated total: sum of cached heights (for blocks we already rendered)
  // and BLOCK_HEIGHT_FALLBACK for blocks we skipped. The thumb position is
  // approximate for the un-rendered prefix, exact for what's on screen.
  const total = estimateTotalHeight(
    displayChat,
    tailLines.length,
    frameBlockHeights,
    headerLines.length,
  );
  // Clamp the estimated range before applying the viewport anchor.
  if (!freezeAdjusted && keepScrolledViewStable(tab, total, surfaceWidth, viewport)) {
    return renderAgentSurfaceWindowed(
      tab,
      runtimeTab,
      chat,
      width,
      maxHeight,
      surfaceWidth,
      options,
      true,
    );
  }
  const maxOffset = Math.max(0, total - viewport);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;

  // Map each rendered chat block to its start index in `lines` for resize anchors.
  const blockLayouts: ChatBlockLayout[] = [];
  {
    let cursor = reachedTop && headerLines.length ? headerLines.length : 0;
    // Header is not a chat block; chat blocks start after it when present at top.
    for (let i = 0; i < orderedBlocks.length; i++) {
      const block = orderedBlocks[i]!;
      if (block.length === 0) continue;
      if (blockLayouts.length > 0) cursor += 1; // separator
      blockLayouts.push({ line: orderedChatLines[i]!, start: cursor, height: block.length });
      cursor += block.length;
    }
  }
  const blockAnchorApplied = applyChatBlockScrollAnchor(
    tab,
    blockLayouts,
    lines.length,
    viewport,
    surfaceWidth,
  );
  applyScrollFreezeAnchor(tab, lines, viewport, surfaceWidth, !blockAnchorApplied);
  applyPendingScrollUserDelta(tab);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  const clampedOffset = Math.max(0, Math.min(tab.chatScrollOffset, maxOffset));
  tab.lastRenderedChatAtTop = tab.chatScrollOffset >= maxOffset;

  // Pick the visible window from the bottom. `lines` is ordered top-to-bottom
  // and ends with the queue preview / latest content. Bottom of window sits
  // at lines.length - clampedOffset.
  const windowEnd = tab.chatAtHome
    ? Math.min(lines.length, (tab.chatHomeOffset ?? 0) + viewport)
    : Math.max(0, lines.length - clampedOffset);
  const windowStart = tab.chatAtHome
    ? Math.min(tab.chatHomeOffset ?? 0, Math.max(0, lines.length - viewport))
    : Math.max(0, windowEnd - viewport);
  if (tab.chatAtHome) tab.chatHomeOffset = windowStart;
  publishChatPointerRanges(
    tab,
    blockLayouts
      .flatMap((layout) => {
        const expand = chatExpandTarget(layout.line);
        return expand && layout.height > 0
          ? [{ start: layout.start - windowStart, height: layout.height, expand }]
          : [];
      })
      .filter((range) => range.start < viewport && range.start + range.height > 0),
  );
  let visible = lines.slice(windowStart, windowEnd);
  // If the window extends below the materialized lines (clampedOffset is
  // larger than what we collected because of imprecise estimates), pad with
  // blanks at the bottom rather than show stale content.
  while (visible.length < viewport) visible.push(chatBlockSeparator(surfaceWidth));

  // Determine virtual start row for boundary markers / scrollbar.
  // Rows above `lines` (un-rendered prefix) contribute total - lines.length.
  const linesAboveBuffer = Math.max(0, total - lines.length);
  const start = tab.chatAtHome ? (tab.chatHomeOffset ?? 0) : linesAboveBuffer + windowStart;

  rememberChatBlockScrollAnchor(tab, blockLayouts, windowStart, visible, surfaceWidth, viewport);
  const decorated = clipChatImages(
    lines,
    windowStart,
    decorateWindow(visible, start, viewport, surfaceWidth),
  );

  const fitted: ScrolledLinesResult = {
    lines: highlightVisibleChatLines(decorated, tab, surfaceWidth, viewport),
    total,
    height: viewport,
    start,
    end: Math.min(total, start + viewport),
    scrollable: total > viewport,
  };
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar(fitted, width, hasNewContent, tab);
}

function getCachedConversationLines(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
  options: AgentSurfaceRenderOptions,
): {
  lines: string[];
  pointerRanges: Array<{ start: number; height: number; expand?: ChatExpandTarget }>;
} {
  const chat = runtimeTab?.chat ?? [];

  // Skip cache when the tab is actively running or any tool is mid-execution.
  // Tool renderers may have component lifecycle side effects (dispose/create)
  // that require re-invocation on each render frame.
  const blockOptions = (_line: ChatLine, index: number) =>
    chatBlockRenderOptions(runtimeTab, index, options);
  const collectPointerRanges = () => {
    const ranges: Array<{ start: number; height: number; expand?: ChatExpandTarget }> = [];
    return {
      ranges,
      sink: (line: ChatLine, start: number, height: number) => {
        const expand = height > 0 ? chatExpandTarget(line) : undefined;
        if (expand) ranges.push({ start, height, expand });
      },
    };
  };
  if (tab.status === "running" || tab.status === "thinking" || hasRunningTool(chat)) {
    conversationCacheMap.delete(tab.sessionId);
    const collected = collectPointerRanges();
    const lines = renderConversation(chat, width, tab, {
      blockOptions,
      blockRanges: collected.sink,
    });
    return { lines, pointerRanges: collected.ranges };
  }

  const lastChat = chat[chat.length - 1];
  const toolsExpanded = tab.extensionUi.toolsExpanded ?? false;
  const policyKey = oversizedPolicyKey(options.oversizedAssistantMessage);
  const hideThinking = options.hideThinking ?? false;
  const boxedHiddenThinking = options.boxedHiddenThinking === true;
  const showResponseModelNotices = options.showResponseModelNotices !== false;
  const hiddenThinkingLabel = tab.extensionUi.hiddenThinkingLabel ?? "";
  const mermaidRenderingMode = options.mermaidRenderingMode ?? "streaming";
  const showImages = options.showImages !== false;
  const imageWidthCells = options.imageWidthCells ?? 60;
  const expandedBlocks = [
    ...[...(tab.expandedToolCalls ?? [])].map((id) => `t:${id}`),
    ...[...(tab.expandedSummaryCards ?? [])].map((id) => `s:${id}`),
  ]
    .sort()
    .join(",");

  const cached = conversationCacheMap.get(tab.sessionId);
  if (
    cached &&
    cached.chatRef === chat &&
    cached.chatLength === chat.length &&
    cached.lastChatText === (lastChat?.text ?? "") &&
    cached.lastChatStatus === lastChat?.status &&
    cached.width === width &&
    cached.themeName === activeRenderTheme.name &&
    cached.toolsExpanded === toolsExpanded &&
    cached.oversizedPolicyKey === policyKey &&
    cached.hideThinking === hideThinking &&
    cached.boxedHiddenThinking === boxedHiddenThinking &&
    cached.showResponseModelNotices === showResponseModelNotices &&
    cached.hiddenThinkingLabel === hiddenThinkingLabel &&
    cached.mermaidRenderingMode === mermaidRenderingMode &&
    cached.showImages === showImages &&
    cached.imageWidthCells === imageWidthCells &&
    cached.expandedBlocks === expandedBlocks
  ) {
    return { lines: cached.lines, pointerRanges: cached.pointerRanges };
  }

  const collected = collectPointerRanges();
  const lines = renderConversation(chat, width, tab, {
    blockOptions,
    blockRanges: collected.sink,
  });

  conversationCacheMap.set(tab.sessionId, {
    lines,
    pointerRanges: collected.ranges,
    expandedBlocks,
    chatRef: chat,
    chatLength: chat.length,
    lastChatText: lastChat?.text ?? "",
    lastChatStatus: lastChat?.status,
    width,
    themeName: activeRenderTheme.name,
    toolsExpanded,
    oversizedPolicyKey: policyKey,
    hideThinking,
    boxedHiddenThinking,
    showResponseModelNotices,
    hiddenThinkingLabel,
    mermaidRenderingMode,
    showImages,
    imageWidthCells,
  });

  return { lines, pointerRanges: collected.ranges };
}

/** Check if any tool chat line is currently executing (status "running" or "pending"). */
function hasRunningTool(chat: ChatLine[]): boolean {
  for (let i = chat.length - 1; i >= 0; i--) {
    const line = chat[i]!;
    if (line.role === "tool" && (line.status === "running" || line.status === "pending")) {
      return true;
    }
    // Once we hit a non-tool line going backwards, no need to check further
    // since running tools are always at the end of the chat.
    if (line.role !== "tool") break;
  }
  return false;
}

/** The pointer block covering a chat-surface row, when there is one. */
export function chatPointerBlockAtRow(
  tab: MixCodeTabInfo,
  row: number,
): { start: number; height: number; expand?: ChatExpandTarget } | undefined {
  return tab.chatPointerBlockRanges?.find(
    (range) => row >= range.start && row < range.start + range.height,
  );
}

/** Records the visible pointer blocks so a click can resolve which block it hit. */
export function publishChatPointerRanges(
  tab: MixCodeTabInfo,
  ranges: Array<{ start: number; height: number; expand?: ChatExpandTarget }> | undefined,
): void {
  const next = ranges && ranges.length > 0 ? ranges : undefined;
  const current = tab.chatPointerBlockRanges;
  const same =
    current === next ||
    (current !== undefined &&
      next !== undefined &&
      current.length === next.length &&
      current.every(
        (range, index) =>
          range.start === next[index]!.start &&
          range.height === next[index]!.height &&
          sameExpandTarget(range.expand, next[index]!.expand),
      ));
  if (!same) tab.chatPointerBlockRanges = next;
}

function sameExpandTarget(
  a: ChatExpandTarget | undefined,
  b: ChatExpandTarget | undefined,
): boolean {
  return a === b || (a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id);
}

function highlightVisibleChatLines(
  lines: string[],
  tab: MixCodeTabInfo,
  width: number,
  height: number,
): string[] {
  tab.lastRenderedChatLines = lines;
  tab.lastRenderedChatScrollOffset = tab.chatScrollOffset;
  let result = applyToastOverlay(lines, activeToast(tab), width, height, activeRenderTheme);
  const hovered =
    tab.chatHoverRow === undefined ? undefined : chatPointerBlockAtRow(tab, tab.chatHoverRow);
  if (hovered) {
    const painted = result.slice();
    for (let row = hovered.start; row < hovered.start + hovered.height; row++) {
      const line = painted[row];
      if (line !== undefined) painted[row] = paintRowBackground(line, activeRenderTheme);
    }
    result = painted;
  }
  const selection = tab.chatSelection;
  if (!selection) return result;
  captureScrollableChatSelection(selection, lines, tab.chatScrollOffset);
  const viewportSelection = scrollableChatSelectionForViewport(selection, tab.chatScrollOffset);
  const blockHighlight = chatSelectionHighlight(activeRenderTheme);
  return result.map((line, row) =>
    highlightChatSelectionLine(
      line,
      row,
      viewportSelection,
      // The cue shares the selection background only inside a pointer block, so only those cells
      // add the underline.
      chatPointerBlockAtRow(tab, row) ? blockHighlight : activeRenderTheme.selectedBg,
    ),
  );
}

function appendChatScrollbar(
  result: ScrolledLinesResult,
  width: number,
  hasNewContent = false,
  tab: MixCodeTabInfo,
): string[] {
  tab.lastChatScrollMetrics = {
    total: result.total,
    viewport: result.height,
    start: result.start,
    end: result.end,
    scrollable: result.scrollable,
  };
  const lines = chatScrollbarFor(tab).render(result, width, activeRenderTheme, hasNewContent);
  const showJump =
    width > 1 && (result.end < result.total || tab.chatScrollAnchorEntryId !== undefined);
  const hover = pointerHoverFor(tab, "jump");
  if (!showJump || lines.length === 0) {
    hover.reset();
    return lines;
  }

  // The label overlays only its own cells, after selection capture and scrollbar paint.
  const contentWidth = width - 1;
  const row = lines.length - 1;
  const label = truncateToWidth(` ↓ Jump to latest${tab.vimMode ? " · G" : ""} `, contentWidth, "");
  const labelWidth = visibleWidth(label);
  const column = Math.floor((contentWidth - labelWidth) / 2);
  const line = lines[row]!;
  const composed = compositeTuiLine(
    line,
    activeRenderTheme.selectedBg(activeRenderTheme.text(label)),
    column,
    labelWidth,
    width,
  );
  // Pi leaves image rows intact; no invisible mouse target belongs over an image.
  if (composed !== line && labelWidth > 0) {
    tab.chatJumpToLatestHitRegion = { row, column, width: labelWidth };
    lines[row] = composed;
    hover.layout([{ id: "jump", x: column + 1, y: row + 1, width: labelWidth }]);
    return hover.paint(lines, width, activeRenderTheme);
  }
  hover.reset();
  return lines;
}

export function renderQueuePreview(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderQueuePreviewInner(tab, width));
}

function renderQueuePreviewInner(tab: MixCodeTabInfo, width: number): string[] {
  const maxQueue = 5;
  const lines: string[] = [];
  const dualQueues = tab.pendingMessages.length > 0 && tab.pendingFollowUps.length > 0;
  if (tab.pendingMessages.length > 0) {
    lines.push(
      ...renderOneQueueBox(
        "Steer",
        tab.pendingMessages,
        width,
        maxQueue,
        // Compaction swallows the queue until compaction_end; Esc cannot flush then.
        tab.activeCompactionReason === undefined,
        dualQueues ? "Ctrl+U,S->edit" : "Ctrl+U->edit",
      ),
    );
  }
  if (tab.pendingFollowUps.length > 0) {
    lines.push(
      ...renderOneQueueBox(
        "Follow-up",
        followUpPreviewMessages(tab),
        width,
        maxQueue,
        false,
        dualQueues ? "Ctrl+U,F->edit" : "Ctrl+U->edit",
        tab.followUpsPaused ? "Paused · /follow-up to resume" : undefined,
      ),
    );
  }
  return lines;
}

function followUpPreviewMessages(tab: MixCodeTabInfo): string[] {
  let round = 0;
  let previousKind: "batch" | "next" | undefined;
  // Number the whole queue before the display limit is applied. Each next item
  // ends both adjacent batches, so its neighbors cannot share its round.
  const messages = tab.followUpQueue.map((item) => {
    if (item.command || item.kind === "next" || previousKind !== "batch") round += 1;
    previousKind = item.command ? "next" : item.kind;
    const kindLabel = item.command ? "command · " : item.kind === "next" ? "next · " : "";
    return `Round ${round} · ${kindLabel}${item.text}`;
  });
  // SDK companions are not user rounds. The aggregate appends them after the
  // local queue; keep them visible without inventing local dispatch boundaries.
  for (const text of tab.pendingFollowUps.slice(tab.followUpQueue.length)) {
    messages.push(`SDK · ${text}`);
  }
  return messages;
}

function renderOneQueueBox(
  label: string,
  messages: readonly string[],
  width: number,
  maxQueue: number,
  escSendNow: boolean,
  editShortcut: string,
  statusHint?: string,
): string[] {
  const innerWidth = Math.max(12, width - 2);
  const itemWidth = Math.max(8, innerWidth - 2);
  const shown = messages.slice(-maxQueue);
  const title =
    messages.length > maxQueue
      ? `${label} (${messages.length}, latest ${maxQueue})`
      : `${label} (${messages.length})`;
  const shortcuts = escSendNow ? `${editShortcut}  Esc->send now` : editShortcut;
  const body = [
    `${title}  ${shortcuts}`,
    ...(statusHint ? [statusHint] : []),
    ...shown.map((message) => `↳ ${normalizePendingMessage(message, itemWidth)}`),
  ];
  return box(label, body, width, activeRenderTheme, true);
}

function normalizePendingMessage(message: string, width: number): string {
  return truncateToWidth(message.replace(/\s+/g, " ").trim(), width);
}
