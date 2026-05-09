import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import { renderConversation } from "./chat.js";
import { renderSidebarInner } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { fitScrolledLinesWithInfo, joinColumns, type ScrolledLinesResult } from "./layout.js";
import { box, padLine } from "./primitives.js";

const MIN_MAIN_WIDTH_WITH_SIDEBAR = 40;
const MIN_SIDEBAR_WIDTH = 28;

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
  const main = getCachedConversationLines(tab, runtimeTab, mainWidth);
  const lines = sidebarVisible
    ? joinColumns(main, renderSidebarInner(tab, sidebarWidth, runtimeTab), mainWidth, sidebarWidth)
    : main;
  if (maxHeight === undefined) return lines;
  const fitted = fitScrolledLinesWithInfo(lines, maxHeight, surfaceWidth, tab.chatScrollOffset);
  const hasNewContent =
    tab.chatScrollOffset > 0 && (tab.status === "running" || tab.status === "thinking");
  return appendChatScrollbar(fitted, width, hasNewContent);
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
  if (
    tab.status === "running" ||
    tab.status === "thinking" ||
    hasRunningTool(chat)
  ) {
    conversationCacheMap.delete(tab.sessionId);
    return [
      ...renderConversation(chat, reasoning, width, tab),
      ...renderQueuePreview(tab, width),
    ];
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

function appendChatScrollbar(result: ScrolledLinesResult, width: number, hasNewContent = false): string[] {
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
