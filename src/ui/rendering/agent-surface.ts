import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import {
  cachedChatBlockHeight,
  chatBlockSeparator,
  renderChatBlock,
  renderConversation,
  renderConversationEmptyState,
  renderReasoningSummaryLines,
} from "./chat.js";
import { renderSidebarInner } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { fitScrolledLinesWithInfo, joinColumns, type ScrolledLinesResult } from "./layout.js";
import { box, padLine } from "./primitives.js";

const MIN_MAIN_WIDTH_WITH_SIDEBAR = 40;
const MIN_SIDEBAR_WIDTH = 28;

// Above this many chat blocks we switch from "render everything, then slice"
// to the windowed renderer. The windowed path has more bookkeeping overhead
// per call, so for short chats it's faster to just render the whole thing.
// Picked via the perf-tab-switch benchmark — at ~100 blocks both paths cross.
const WINDOW_RENDER_BLOCK_THRESHOLD = 60;
// Extra rendered lines above and below the visible viewport. Larger overscan
// makes scroll-up smoother (fewer cache misses while paging) at the cost of
// extra block renders per frame.
const WINDOW_OVERSCAN_LINES = 20;
// Default per-block height assumption used before any block has been rendered
// once. Roughly matches a typical assistant paragraph at 120 cols.
const BLOCK_HEIGHT_FALLBACK = 4;

// Cache the expensive renderConversation + renderQueuePreview result per tab.
// Invalidated when chat content, reasoning, width, theme, or relevant UI state changes.
// Disabled when chat contains lines with dynamic render functions (tool/extension renderers)
// that have component lifecycle side effects.
interface ConversationCache {
  lines: string[];
  // Invalidation keys
  chatLength: number;
  lastChatText: string;
  lastChatStatus: string | undefined;
  reasoningLength: number;
  lastReasoningText: string;
  width: number;
  themeName: string;
  toolsExpanded: boolean;
  hiddenThinkingLabel: string;
  pendingMessagesLength: number;
  lastPendingMessage: string;
  chatRef: ChatLine[];
}

const conversationCacheMap = new Map<string, ConversationCache>();

/** Remove cached conversation lines for a closed tab to prevent memory leaks. */
export function clearConversationCache(sessionId: string): void {
  conversationCacheMap.delete(sessionId);
}

export function renderAgentSurface(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
  maxHeight?: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderAgentSurfaceInner(tab, runtimeTab, width, maxHeight));
}

function renderAgentSurfaceInner(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
  maxHeight?: number,
): string[] {
  const surfaceWidth = maxHeight === undefined || width < 2 ? width : width - 1;
  const sidebarVisible =
    tab.todoVisible && surfaceWidth >= MIN_MAIN_WIDTH_WITH_SIDEBAR + 1 + MIN_SIDEBAR_WIDTH;
  const sidebarWidth = sidebarVisible
    ? Math.min(42, Math.max(MIN_SIDEBAR_WIDTH, Math.floor(surfaceWidth * 0.34)))
    : 0;
  const mainWidth = sidebarVisible ? surfaceWidth - sidebarWidth - 1 : surfaceWidth;

  // Windowed path: only viable when the caller is going to clip to maxHeight
  // anyway and chat is long enough that rendering every block hurts. Falls
  // through to the legacy full-render path otherwise (legacy callers pass
  // maxHeight=undefined, e.g. tests measuring full layout).
  if (
    maxHeight !== undefined &&
    runtimeTab &&
    canUseWindowedRender(tab, runtimeTab)
  ) {
    return renderAgentSurfaceWindowed(
      tab,
      runtimeTab,
      width,
      maxHeight,
      surfaceWidth,
      mainWidth,
      sidebarVisible,
      sidebarWidth,
    );
  }

  const main = getCachedConversationLines(tab, runtimeTab, mainWidth);
  const lines = sidebarVisible
    ? joinColumns(main, renderSidebarInner(tab, sidebarWidth, runtimeTab), mainWidth, sidebarWidth)
    : main;
  if (maxHeight === undefined) return lines;
  // Clamp chatScrollOffset to the actual scrollable range so that sentinel
  // values (e.g. 1_000_000 from chatHome) don't leave the offset far above
  // the content, which would make subsequent small scroll deltas (j / ctrl+d)
  // appear to do nothing.
  const maxOffset = Math.max(0, lines.length - Math.max(0, Math.floor(maxHeight)));
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  const fitted = fitScrolledLinesWithInfo(lines, maxHeight, surfaceWidth, tab.chatScrollOffset);
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar(fitted, width, hasNewContent);
}

/**
 * Pick between the windowed and full-render path. Windowed path is only safe
 * when chat is long enough to dominate render cost AND it doesn't contain any
 * dynamic-renderer blocks in regions we wouldn't otherwise visit (those
 * renderers have lifecycle hooks that must run every frame).
 *
 * For a typical "long quiet chat" tab switch the dynamic-renderer check is
 * cheap because such tabs have few/none of those blocks.
 */
function canUseWindowedRender(tab: MixCodeTabInfo, runtimeTab: RuntimeTab): boolean {
  const chat = runtimeTab.chat;
  if (chat.length < WINDOW_RENDER_BLOCK_THRESHOLD) return false;
  // Tools that are still running drive their own renderer lifecycle every frame.
  // The legacy full path already handles this case via cache invalidation, so
  // bail out and let it run.
  if (tab.status === "running" || tab.status === "thinking") return false;
  for (let i = chat.length - 1; i >= 0; i--) {
    const line = chat[i]!;
    if (line.role === "tool" && (line.status === "running" || line.status === "pending")) {
      return false;
    }
    if (line.role !== "tool") break;
  }
  return true;
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
 *   3. Materialize the reasoning prefix only if the visible window may
 *      reach the top of the chat (i.e. we walked all the way back).
 *   4. Slice the visible viewport out of the assembled lines.
 *
 * Trade-off: the scrollbar thumb position uses estimated heights for the
 * blocks we did NOT render, since we don't know their actual size. This
 * gives a slightly imprecise but stable thumb. The visible content is
 * always exact because actual heights drive the slicing.
 */
function renderAgentSurfaceWindowed(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab,
  width: number,
  maxHeight: number,
  surfaceWidth: number,
  mainWidth: number,
  sidebarVisible: boolean,
  sidebarWidth: number,
): string[] {
  const chat = runtimeTab.chat;
  const reasoning = runtimeTab.reasoning ?? [];
  const viewport = Math.max(0, Math.floor(maxHeight));
  const scrollOffset = Math.max(0, tab.chatScrollOffset);

  // Bottom-anchored content.
  const queueLines = renderQueuePreview(tab, mainWidth);

  // Walk chat blocks newest-to-oldest, prepending rendered output to `lines`
  // until we've covered the visible window plus overscan.
  const targetRows = viewport + scrollOffset + WINDOW_OVERSCAN_LINES;
  const lines: string[] = [...queueLines];
  let oldestEmittedIndex = chat.length;
  let nextIsNonEmpty = queueLines.length > 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (lines.length >= targetRows) break;
    const block = renderChatBlock(chat[i]!, mainWidth, tab);
    if (block.length === 0) {
      // Empty block contributes nothing visually; just record visit.
      oldestEmittedIndex = i;
      continue;
    }
    if (nextIsNonEmpty) {
      // Prepend a separator between this block and whatever is below it.
      lines.unshift(chatBlockSeparator(mainWidth));
    }
    for (let j = block.length - 1; j >= 0; j--) lines.unshift(block[j]!);
    nextIsNonEmpty = true;
    oldestEmittedIndex = i;
  }

  // If we walked to the start, prepend reasoning summary so the very top of
  // the chat is reachable. Reasoning suppresses itself when chat already
  // contains a thinking block.
  const reachedTop = oldestEmittedIndex === 0;
  if (reachedTop) {
    const reasoningLines = renderReasoningSummaryLines(chat, reasoning, mainWidth, tab);
    if (reasoningLines.length > 0) {
      // Walk newest-to-oldest because reasoning sits above the very first
      // block; preserve order on prepend.
      for (let i = reasoningLines.length - 1; i >= 0; i--) lines.unshift(reasoningLines[i]!);
    }
  }

  // Empty-state placeholder mirrors what renderConversation would produce.
  if (lines.length === 0 && reasoning.length === 0) {
    const placeholder = renderConversationEmptyState(mainWidth);
    const composed = sidebarVisible
      ? joinColumns(
          placeholder,
          renderSidebarInner(tab, sidebarWidth, runtimeTab),
          mainWidth,
          sidebarWidth,
        )
      : placeholder;
    const fitted = fitScrolledLinesWithInfo(composed, maxHeight, surfaceWidth, 0);
    return appendChatScrollbar(fitted, width, false);
  }

  // Estimated total: sum of cached heights (for blocks we already rendered)
  // and BLOCK_HEIGHT_FALLBACK for blocks we skipped. The thumb position is
  // approximate for the un-rendered prefix, exact for what's on screen.
  const total = estimateTotalHeight(
    chat,
    reasoning,
    queueLines.length,
    mainWidth,
    tab,
    reachedTop,
  );

  // Clamp scrollOffset against the estimate so chatHome's 1_000_000 sentinel
  // settles into a sensible value (treated as "all the way up").
  const maxOffset = Math.max(0, total - viewport);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

  // Pick the visible window from the bottom. `lines` is ordered top-to-bottom
  // and ends with the queue preview / latest content. Bottom of window sits
  // at lines.length - clampedOffset.
  const windowEnd = Math.max(0, lines.length - clampedOffset);
  const windowStart = Math.max(0, windowEnd - viewport);
  let visible = lines.slice(windowStart, windowEnd);
  // If the window extends below the materialized lines (clampedOffset is
  // larger than what we collected because of imprecise estimates), pad with
  // blanks at the bottom rather than show stale content.
  while (visible.length < viewport) visible.push(chatBlockSeparator(mainWidth));

  // Determine virtual start row for boundary markers / scrollbar.
  // Rows above `lines` (un-rendered prefix) contribute total - lines.length.
  const linesAboveBuffer = Math.max(0, total - lines.length);
  const start = linesAboveBuffer + windowStart;

  const decorated = decorateWindow(visible, start, total, viewport, mainWidth);

  const composed = sidebarVisible
    ? joinColumns(
        decorated,
        renderSidebarInner(tab, sidebarWidth, runtimeTab),
        mainWidth,
        sidebarWidth,
      )
    : decorated;

  const fitted: ScrolledLinesResult = {
    lines: composed,
    total,
    height: viewport,
    start,
    end: Math.min(total, start + viewport),
    scrollable: total > viewport,
  };
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar(fitted, width, hasNewContent);
}

/**
 * Estimate total virtual height. Uses cached heights for blocks already
 * rendered, BLOCK_HEIGHT_FALLBACK for blocks not yet rendered. Ignores
 * separator rows for the un-rendered prefix to keep the estimate simple
 * (±few rows error is acceptable for scrollbar thumb only).
 */
function estimateTotalHeight(
  chat: ChatLine[],
  reasoning: string[],
  queueRows: number,
  width: number,
  tab: MixCodeTabInfo,
  reasoningCounted: boolean,
): number {
  let total = queueRows;
  let nonEmpty = 0;
  for (let i = 0; i < chat.length; i++) {
    const cached = cachedChatBlockHeight(chat[i]!, width, tab);
    const h = cached ?? BLOCK_HEIGHT_FALLBACK;
    total += h;
    if (h > 0) nonEmpty++;
  }
  total += Math.max(0, nonEmpty - 1);
  if (reasoningCounted) {
    // Include reasoning summary rows once we know we actually emitted them.
    const reasoningLines = renderReasoningSummaryLines(chat, reasoning, width, tab);
    total += reasoningLines.length;
  } else if (!chat.some((line) => line.role === "thinking")) {
    // We didn't emit reasoning yet, but it does occupy rows in virtual space.
    // Estimate by re-using its actual length (cheap, just a few markdown wraps).
    const reasoningLines = renderReasoningSummaryLines(chat, reasoning, width, tab);
    total += reasoningLines.length;
  }
  return total;
}

/**
 * Apply the same boundary markers fitScrolledLinesWithInfo applies (... older
 * above / ... newer below) so the windowed output is visually identical.
 */
function decorateWindow(
  visible: string[],
  start: number,
  total: number,
  viewport: number,
  width: number,
): string[] {
  if (visible.length === 0) return visible;
  const out = visible.slice();
  if (viewport <= 1) return out;
  if (start > 0) {
    out[0] = padLine(activeRenderTheme.dim("... older above"), width);
  }
  if (start + visible.length < total) {
    out[out.length - 1] = padLine(activeRenderTheme.dim("... newer below"), width);
  }
  return out;
}

function getCachedConversationLines(
  tab: MixCodeTabInfo,
  runtimeTab: RuntimeTab | undefined,
  width: number,
): string[] {
  const chat = runtimeTab?.chat ?? [];
  const reasoning = runtimeTab?.reasoning ?? [];

  // Skip cache when the tab is actively running or any tool is mid-execution.
  // Tool renderers may have component lifecycle side effects (dispose/create)
  // that require re-invocation on each render frame.
  if (tab.status === "running" || tab.status === "thinking" || hasRunningTool(chat)) {
    conversationCacheMap.delete(tab.sessionId);
    return [...renderConversation(chat, reasoning, width, tab), ...renderQueuePreview(tab, width)];
  }

  const lastChat = chat[chat.length - 1];
  const lastReasoning = reasoning[reasoning.length - 1] ?? "";
  const toolsExpanded = tab.extensionUi.toolsExpanded ?? false;
  const hiddenThinkingLabel = tab.extensionUi.hiddenThinkingLabel?.trim() ?? "";
  const lastPending = tab.pendingMessages[tab.pendingMessages.length - 1] ?? "";

  const cached = conversationCacheMap.get(tab.sessionId);
  if (
    cached &&
    cached.chatRef === chat &&
    cached.chatLength === chat.length &&
    cached.lastChatText === (lastChat?.text ?? "") &&
    cached.lastChatStatus === lastChat?.status &&
    cached.reasoningLength === reasoning.length &&
    cached.lastReasoningText === lastReasoning &&
    cached.width === width &&
    cached.themeName === activeRenderTheme.name &&
    cached.toolsExpanded === toolsExpanded &&
    cached.hiddenThinkingLabel === hiddenThinkingLabel &&
    cached.pendingMessagesLength === tab.pendingMessages.length &&
    cached.lastPendingMessage === lastPending
  ) {
    return cached.lines;
  }

  const lines = [
    ...renderConversation(chat, reasoning, width, tab),
    ...renderQueuePreview(tab, width),
  ];

  conversationCacheMap.set(tab.sessionId, {
    lines,
    chatRef: chat,
    chatLength: chat.length,
    lastChatText: lastChat?.text ?? "",
    lastChatStatus: lastChat?.status,
    reasoningLength: reasoning.length,
    lastReasoningText: lastReasoning,
    width,
    themeName: activeRenderTheme.name,
    toolsExpanded,
    hiddenThinkingLabel,
    pendingMessagesLength: tab.pendingMessages.length,
    lastPendingMessage: lastPending,
  });

  return lines;
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

function appendChatScrollbar(
  result: ScrolledLinesResult,
  width: number,
  hasNewContent = false,
): string[] {
  if (!result.scrollable || width < 2 || result.lines.length === 0)
    return result.lines.map((line) => padLine(line, width));
  const contentWidth = Math.max(1, width - 1);
  const bar = chatScrollbar(result);
  const lastIndex = result.lines.length - 1;
  return result.lines.map((line, index) => {
    let barChar = bar[index] ?? "│";
    if (hasNewContent && index === lastIndex) {
      barChar = activeRenderTheme.accent("↓");
      return `${padLine(line, contentWidth)}${barChar}`;
    }
    return `${padLine(line, contentWidth)}${activeRenderTheme.borderDim(barChar)}`;
  });
}

function chatScrollbar(result: ScrolledLinesResult): string[] {
  const height = result.lines.length;
  if (height <= 0) return [];
  const thumbSize = Math.max(1, Math.min(height, Math.ceil((height / result.total) * height)));
  const maxThumbTop = Math.max(0, height - thumbSize);
  const maxStart = Math.max(1, result.total - result.height);
  const thumbTop = Math.round((result.start / maxStart) * maxThumbTop);
  return Array.from({ length: height }, (_, index) =>
    index >= thumbTop && index < thumbTop + thumbSize ? "█" : "│",
  );
}

export function renderQueuePreview(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderQueuePreviewInner(tab, width));
}

function renderQueuePreviewInner(tab: MixCodeTabInfo, width: number): string[] {
  if (!tab.pendingMessages.length) return [];
  const maxQueue = 5;
  const innerWidth = Math.max(12, width - 2);
  const itemWidth = Math.max(8, innerWidth - 2);
  const messages = tab.pendingMessages.slice(-maxQueue);
  const queueTitle =
    tab.pendingMessages.length > maxQueue
      ? `Queue (${tab.pendingMessages.length}, latest ${maxQueue})`
      : `Queue (${tab.pendingMessages.length})`;
  const lines = [
    `${queueTitle}  Esc->send now  Ctrl+U->edit`,
    ...messages.map(
      (message) => `↳ ${truncateToWidth(message.replace(/\s+/g, " ").trim(), itemWidth)}`,
    ),
  ];
  return box("Queue", lines, width);
}
