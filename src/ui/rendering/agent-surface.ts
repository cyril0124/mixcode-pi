import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../../agent/runtime.js";
import {
  captureScrollableChatSelection,
  highlightChatSelectionLine,
  scrollableChatSelectionForViewport,
} from "../../core/chat-selection.js";
import { activeToast } from "../../core/toast.js";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import {
  chatBlockSeparator,
  chatLinesForDisplay,
  renderChatBlock,
  renderConversation,
  renderConversationEmptyState,
  renderStartupBlock,
} from "./chat.js";
import {
  chatBlockRenderOptions,
  oversizedPolicyKey,
  type AgentSurfaceRenderOptions,
} from "./agent-surface-options.js";
import { renderExtensionHeader } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import {
  BLOCK_HEIGHT_FALLBACK,
  applyChatBlockScrollAnchor,
  applyScrollFreezeAnchor,
  decorateWindow,
  estimateTotalHeight,
  keepScrolledViewStable,
  rememberChatBlockScrollAnchor,
  rememberScrollFreezeAnchor,
  type ChatBlockLayout,
} from "./agent-surface-scroll.js";
import { fitScrolledLinesWithInfo, type ScrolledLinesResult } from "./layout.js";
import { renderHeaderKeyHints } from "./header-hints.js";
import { box, padLine } from "./primitives.js";
import { applyToastOverlay } from "./toast-overlay.js";

/**
 * Convert persisted previewMessages to lightweight ChatLine[] for rendering
 * before the full runtimeTab is ready (deferred extension loading).
 * Memoized on tab to avoid breaking the render cache's reference-equality check.
 */
const previewChatCache = new WeakMap<MixCodeTabInfo, ChatLine[]>();
function previewMessagesToChat(tab: MixCodeTabInfo): ChatLine[] {
  const cached = previewChatCache.get(tab);
  if (cached) return cached;
  if (!tab.previewMessages.length) return [];
  const chat: ChatLine[] = tab.previewMessages
    .filter((msg) => msg.role !== "empty")
    .map((msg) => ({
      role: (msg.role === "shell" ? "user" : msg.role) as ChatLine["role"],
      text: msg.text,
      ...(msg.role === "shell" ? { variant: "user-bash" as const } : {}),
    }));
  previewChatCache.set(tab, chat);
  return chat;
}

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

// Cache the expensive renderConversation + renderQueuePreview result per tab.
// Invalidated when chat content, width, theme, or relevant UI state changes.
// The full-render cache is bypassed while active tool renderers may have
// lifecycle side effects that need to run on every frame.
interface ConversationCache {
  lines: string[];
  // Invalidation keys
  chatLength: number;
  lastChatText: string;
  lastChatStatus: string | undefined;
  width: number;
  themeName: string;
  toolsExpanded: boolean;
  pendingMessagesLength: number;
  lastPendingMessage: string;
  pendingFollowUpsLength: number;
  lastPendingFollowUp: string;
  oversizedPolicyKey: string;
  hideThinking: boolean;
  hiddenThinkingLabel: string;
  renderMermaid: boolean;
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
  const surfaceWidth = maxHeight === undefined || width < 2 ? width : width - 1;
  const mainWidth = surfaceWidth;

  if (maxHeight !== undefined && runtimeTab && tab.chatScrollAnchorEntryId) {
    return renderAgentSurfaceAnchored(
      tab,
      runtimeTab,
      width,
      maxHeight,
      surfaceWidth,
      mainWidth,
      options,
    );
  }

  // Windowed path: only viable when the caller is going to clip to maxHeight
  // anyway and chat is long enough that rendering every block hurts. Falls
  // through to the legacy full-render path otherwise (legacy callers pass
  // maxHeight=undefined, e.g. tests measuring full layout).
  if (maxHeight !== undefined) {
    const chat = runtimeTab?.chat ?? previewMessagesToChat(tab);
    if (canUseWindowedRender(tab, chat, options.oversizedAssistantMessage)) {
      return renderAgentSurfaceWindowed(
        tab,
        runtimeTab,
        chat,
        width,
        maxHeight,
        surfaceWidth,
        mainWidth,
        options,
      );
    }
  }

  const body = getCachedConversationLines(tab, runtimeTab, mainWidth, options);
  // Extension header rides at the very top of the scrollable conversation
  // (like Pi): visible when scrolled to the top, scrolls away otherwise.
  const headerLines = scrollableHeaderLines(tab, mainWidth);
  const lines = headerLines.length ? [...headerLines, ...body] : body;
  if (maxHeight === undefined) return lines;
  // Clamp chatScrollOffset to the actual scrollable range so that sentinel
  // values (e.g. 1_000_000 from chatHome) don't leave the offset far above
  // the content, which would make subsequent small scroll deltas (j / ctrl+d)
  // appear to do nothing.
  const viewport = Math.max(0, Math.floor(maxHeight));
  keepScrolledViewStable(tab, lines.length, surfaceWidth, viewport);
  const maxOffset = Math.max(0, lines.length - viewport);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  applyScrollFreezeAnchor(tab, lines, viewport, surfaceWidth);
  const fitted = fitScrolledLinesWithInfo(lines, maxHeight, surfaceWidth, tab.chatScrollOffset);
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
  return chat.length >= WINDOW_RENDER_BLOCK_THRESHOLD || chat.some((line) => isOversizedAssistantBlock(line, oversizedPolicy));
}

function isOversizedAssistantBlock(
  line: ChatLine,
  policy: OversizedAssistantMessageSettings | undefined,
): boolean {
  if (!policy?.enabled) return false;
  if (line.role !== "assistant" && line.role !== "thinking") return false;
  if (Buffer.byteLength(line.text, "utf8") > policy.maxBytes) return true;
  let lineCount = 1;
  for (let index = line.text.indexOf("\n"); index >= 0; index = line.text.indexOf("\n", index + 1)) {
    lineCount++;
    if (lineCount > policy.maxLines) return true;
  }
  return false;
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
  mainWidth: number,
  options: AgentSurfaceRenderOptions,
): string[] {
  const chat = runtimeTab.chat;
  const viewport = Math.max(0, Math.floor(maxHeight));
  if (viewport <= 0) return [];

  let anchorIndex = tab.chatScrollAnchorIndex ?? -1;
  if (anchorIndex < 0 || anchorIndex >= chat.length || !matchesChatAnchor(chat[anchorIndex]!, tab)) {
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
      mainWidth,
      options,
    );
  }

  const frameBlockHeights = new Map<ChatLine, number>();
  const localOffset = tab.chatScrollOffset;
  // Walk older blocks (anchor-1 → 0), collect newest-first, then reverse-join.
  // Avoids O(n²) Array.unshift while building the prefix above the anchor.
  const prefixBlocksNewestFirst: string[][] = [];
  const neededPrefixRows = Math.max(0, localOffset);
  let prefixRows = 0;
  for (let i = anchorIndex - 1; i >= 0 && prefixRows < neededPrefixRows; i--) {
    const block = renderChatBlock(
      chat[i]!,
      mainWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, i, options),
    );
    frameBlockHeights.set(chat[i]!, block.length);
    if (block.length === 0) continue;
    if (prefixRows > 0) prefixRows += 1; // separator
    prefixRows += block.length;
    prefixBlocksNewestFirst.push(block);
  }
  const prefix = joinRenderedBlocksTopToBottom(
    prefixBlocksNewestFirst.reverse(),
    chatBlockSeparator(mainWidth),
  );

  const suffix: string[] = [];
  let suffixHasContent = prefix.length > 0;
  for (let i = anchorIndex; i < chat.length && suffix.length < viewport + Math.max(0, -localOffset); i++) {
    const line = chat[i]!;
    const block = renderChatBlock(
      line,
      mainWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, i, options),
    );
    frameBlockHeights.set(line, block.length);
    if (block.length === 0) continue;
    if (suffixHasContent) suffix.push(chatBlockSeparator(mainWidth));
    for (const renderedLine of block) suffix.push(renderedLine);
    suffixHasContent = true;
  }
  const lines = [...prefix, ...suffix];
  const anchorStart = prefix.length;
  const requestedStart = anchorStart - localOffset;
  const windowStart = Math.max(0, Math.min(requestedStart, Math.max(0, lines.length - viewport)));
  const visible = lines.slice(windowStart, windowStart + viewport);
  while (visible.length < viewport) visible.push(chatBlockSeparator(mainWidth));

  const total = estimateTotalHeight(
    chat,
    renderQueuePreview(tab, mainWidth).length,
    mainWidth,
    frameBlockHeights,
  );
  const start = Math.min(Math.max(0, total - visible.length), anchorIndex * BLOCK_HEIGHT_FALLBACK + windowStart);
  const decorated = decorateWindow(visible, start, total, viewport, mainWidth);
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
  return Boolean(tab.chatScrollAnchorText && line.role === "user" && line.text === tab.chatScrollAnchorText);
}

/** Join blocks already ordered top-to-bottom; insert separator between non-empty ones. */
function joinRenderedBlocksTopToBottom(blocks: string[][], separator: string): string[] {
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
  mainWidth: number,
  options: AgentSurfaceRenderOptions,
  freezeAdjusted = false,
): string[] {
  const viewport = Math.max(0, Math.floor(maxHeight));

  // Extension header rides at the very top of the scrollable conversation.
  const headerLines = scrollableHeaderLines(tab, mainWidth);

  // Bottom-anchored content.
  const queueLines = renderQueuePreview(tab, mainWidth);
  // Pending user-bash renders after the main stream (Pi pending-area parity).
  const displayChat = chatLinesForDisplay(chat);

  // Walk chat blocks newest-to-oldest, collecting rendered blocks, then
  // reverse-join into top-to-bottom order. Push+reverse is O(n); unshift was O(n²).
  const targetRows = viewport + Math.max(0, tab.chatScrollOffset) + WINDOW_OVERSCAN_LINES;
  const newerFirstBlocks: string[][] = [];
  const newerFirstChatLines: ChatLine[] = [];
  const frameBlockHeights = new Map<ChatLine, number>();
  let oldestEmittedIndex = displayChat.length;
  // Count rows the same way unshift path did: queue first, then each older block
  // plus a separator when content already exists below.
  let assembledRows = queueLines.length;
  for (let i = displayChat.length - 1; i >= 0; i--) {
    if (assembledRows >= targetRows) break;
    const line = displayChat[i]!;
    const originalIndex = chat.indexOf(line);
    const block = renderChatBlock(
      line,
      mainWidth,
      tab,
      activeRenderTheme,
      chatBlockRenderOptions(runtimeTab, originalIndex >= 0 ? originalIndex : i, options),
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
  const orderedBlocks = newerFirstBlocks.reverse();
  const orderedChatLines = newerFirstChatLines.reverse();
  const olderLines = joinRenderedBlocksTopToBottom(
    orderedBlocks,
    chatBlockSeparator(mainWidth),
  );

  // When the backward walk reached the very first block, the header sits
  // directly above it (Pi-style). Otherwise it stays part of the virtual
  // prefix counted via estimateTotalHeight's extraRows below.
  const reachedTop = oldestEmittedIndex === 0;
  let lines: string[];
  if (reachedTop && headerLines.length) {
    lines = olderLines.length
      ? [...headerLines, ...olderLines]
      : [...headerLines];
  } else {
    lines = olderLines;
  }
  if (queueLines.length > 0) {
    if (olderLines.length > 0) lines.push(chatBlockSeparator(mainWidth));
    lines.push(...queueLines);
  }

  // Empty-state placeholder mirrors what renderConversation would produce.
  if (lines.length === 0) {
    const placeholder = renderConversationEmptyState(mainWidth);
    const withHeader = headerLines.length ? [...headerLines, ...placeholder] : placeholder;
    const fitted = fitScrolledLinesWithInfo(withHeader, maxHeight, surfaceWidth, 0);
    const highlighted = highlightVisibleChatLines(fitted.lines, tab, surfaceWidth, fitted.height);
    return appendChatScrollbar({ ...fitted, lines: highlighted }, width, false, tab);
  }

  // Estimated total: sum of cached heights (for blocks we already rendered)
  // and BLOCK_HEIGHT_FALLBACK for blocks we skipped. The thumb position is
  // approximate for the un-rendered prefix, exact for what's on screen.
  const total = estimateTotalHeight(
    displayChat,
    queueLines.length,
    mainWidth,
    frameBlockHeights,
    headerLines.length,
  );

  // Clamp scrollOffset against the estimate so chatHome's 1_000_000 sentinel
  // settles into a sensible value (treated as "all the way up").
  if (!freezeAdjusted && keepScrolledViewStable(tab, total, surfaceWidth, viewport)) {
    return renderAgentSurfaceWindowed(
      tab,
      runtimeTab,
      chat,
      width,
      maxHeight,
      surfaceWidth,
      mainWidth,
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
  applyChatBlockScrollAnchor(tab, blockLayouts, lines.length, viewport, surfaceWidth);
  applyScrollFreezeAnchor(tab, lines, viewport, surfaceWidth);
  if (tab.chatScrollOffset > maxOffset) tab.chatScrollOffset = maxOffset;
  const clampedOffset = Math.max(0, Math.min(tab.chatScrollOffset, maxOffset));

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

  rememberChatBlockScrollAnchor(tab, blockLayouts, windowStart, visible, surfaceWidth, viewport);
  const decorated = decorateWindow(visible, start, total, viewport, mainWidth);

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
): string[] {
  const chat = runtimeTab?.chat ?? previewMessagesToChat(tab);

  // Skip cache when the tab is actively running or any tool is mid-execution.
  // Tool renderers may have component lifecycle side effects (dispose/create)
  // that require re-invocation on each render frame.
  const blockOptions = (_line: ChatLine, index: number) =>
    chatBlockRenderOptions(runtimeTab, index, options);
  if (tab.status === "running" || tab.status === "thinking" || hasRunningTool(chat)) {
    conversationCacheMap.delete(tab.sessionId);
    return [
      ...renderConversation(chat, width, tab, { blockOptions }),
      ...renderQueuePreview(tab, width),
    ];
  }

  const lastChat = chat[chat.length - 1];
  const toolsExpanded = tab.extensionUi.toolsExpanded ?? false;
  const lastPending = tab.pendingMessages[tab.pendingMessages.length - 1] ?? "";
  const lastFollowUp = tab.pendingFollowUps[tab.pendingFollowUps.length - 1] ?? "";
  const policyKey = oversizedPolicyKey(options.oversizedAssistantMessage);
  const hideThinking = options.hideThinking ?? false;
  const hiddenThinkingLabel = tab.extensionUi.hiddenThinkingLabel ?? "";
  const renderMermaid = options.renderMermaid !== false;

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
    cached.pendingMessagesLength === tab.pendingMessages.length &&
    cached.lastPendingMessage === lastPending &&
    cached.pendingFollowUpsLength === tab.pendingFollowUps.length &&
    cached.lastPendingFollowUp === lastFollowUp &&
    cached.oversizedPolicyKey === policyKey &&
    cached.hideThinking === hideThinking &&
    cached.hiddenThinkingLabel === hiddenThinkingLabel &&
    cached.renderMermaid === renderMermaid
  ) {
    return cached.lines;
  }

  const lines = [
    ...renderConversation(chat, width, tab, { blockOptions }),
    ...renderQueuePreview(tab, width),
  ];

  conversationCacheMap.set(tab.sessionId, {
    lines,
    chatRef: chat,
    chatLength: chat.length,
    lastChatText: lastChat?.text ?? "",
    lastChatStatus: lastChat?.status,
    width,
    themeName: activeRenderTheme.name,
    toolsExpanded,
    pendingMessagesLength: tab.pendingMessages.length,
    lastPendingMessage: lastPending,
    pendingFollowUpsLength: tab.pendingFollowUps.length,
    lastPendingFollowUp: lastFollowUp,
    oversizedPolicyKey: policyKey,
    hideThinking,
    hiddenThinkingLabel,
    renderMermaid,
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

function highlightVisibleChatLines(
  lines: string[],
  tab: MixCodeTabInfo,
  width: number,
  height: number,
): string[] {
  tab.lastRenderedChatLines = lines;
  const result = applyToastOverlay(lines, activeToast(tab), width, height, activeRenderTheme);
  const selection = tab.chatSelection;
  if (!selection) return result;
  captureScrollableChatSelection(selection, lines, tab.chatScrollOffset);
  const viewportSelection = scrollableChatSelectionForViewport(
    selection,
    tab.chatScrollOffset,
  );
  return result.map((line, row) =>
    highlightChatSelectionLine(line, row, viewportSelection, activeRenderTheme.selection),
  );
}

function appendChatScrollbar(
  result: ScrolledLinesResult,
  width: number,
  hasNewContent = false,
  tab?: MixCodeTabInfo,
): string[] {
  if (tab) {
    tab.lastChatScrollMetrics = {
      total: result.total,
      viewport: result.height,
      start: result.start,
      end: result.end,
      scrollable: result.scrollable,
    };
  }
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
  const maxQueue = 5;
  const lines: string[] = [];
  if (tab.pendingMessages.length > 0) {
    lines.push(...renderOneQueueBox("Steer", tab.pendingMessages, width, maxQueue, true));
  }
  if (tab.pendingFollowUps.length > 0) {
    lines.push(...renderOneQueueBox("Follow-up", tab.pendingFollowUps, width, maxQueue, false));
  }
  return lines;
}

function renderOneQueueBox(
  label: string,
  messages: readonly string[],
  width: number,
  maxQueue: number,
  escSendNow: boolean,
): string[] {
  const innerWidth = Math.max(12, width - 2);
  const itemWidth = Math.max(8, innerWidth - 2);
  const shown = messages.slice(-maxQueue);
  const title =
    messages.length > maxQueue
      ? `${label} (${messages.length}, latest ${maxQueue})`
      : `${label} (${messages.length})`;
  const shortcuts = escSendNow ? "Esc->send now  Ctrl+U->edit" : "Ctrl+U->edit";
  const body = [
    `${title}  ${shortcuts}`,
    ...shown.map((message) => `↳ ${normalizePendingMessage(message, itemWidth)}`),
  ];
  return box(label, body, width);
}

function normalizePendingMessage(message: string, width: number): string {
  return truncateToWidth(message.replace(/\s+/g, " ").trim(), width);
}
