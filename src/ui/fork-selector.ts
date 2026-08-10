/**
 * Fork selector: lists user messages as fork points, newest last. Selecting one
 * calls extensionFork(entryId) which branches the session to that message and
 * refills the editor with that message text (SDK fork semantics).
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { closeAppOverlay, showLinesOverlay } from "./app-overlays.js";
import { overlayPanel } from "./rendering/primitives.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { themeForId } from "./themes.js";

export { createForkSelectorState } from "../core/fork-selector.js";
export type { ForkSelectorState } from "../core/fork-selector.js";

export function openForkSelector(
  state: MixCodeState,
  sessionId: string,
  runtime: MixCodeKeyRuntime,
  tui: OverlayTui,
): void {
  const items = runtime.getForkableUserMessages(sessionId);
  if (items.length === 0) {
    const tab = state.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.toast = { type: "warning", message: "No forkable user messages", createdAt: Date.now() };
    }
    tui.requestRender();
    return;
  }

  state.forkSelector.open = true;
  state.forkSelector.sessionId = sessionId;
  state.forkSelector.items = items;
  // Default select the newest (last) user message
  state.forkSelector.selectedIndex = items.length - 1;

  showLinesOverlay(tui, (width) => renderForkSelectorOverlay(state, width));
  tui.requestRender();
}

export function closeForkSelector(state: MixCodeState, tui: OverlayTui): void {
  state.forkSelector.open = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

export function handleForkSelectorKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
): boolean {
  const selector = state.forkSelector;
  if (!selector.open) return false;

  if (matchesKey(data, "escape")) {
    closeForkSelector(state, tui);
    return true;
  }

  if (matchesKey(data, "up") || data === "k") {
    selector.selectedIndex = Math.max(0, selector.selectedIndex - 1);
    showLinesOverlay(tui, (width) => renderForkSelectorOverlay(state, width));
    return true;
  }

  if (matchesKey(data, "down") || data === "j") {
    selector.selectedIndex = Math.min(selector.items.length - 1, selector.selectedIndex + 1);
    showLinesOverlay(tui, (width) => renderForkSelectorOverlay(state, width));
    return true;
  }

  if (matchesKey(data, "enter")) {
    const selected = selector.items[selector.selectedIndex];
    if (selected && runtime?.extensionFork) {
      closeForkSelector(state, tui);
      // Fork is async; don't await here, the fork logic handles the tab switch and editor refill
      void runtime.extensionFork(selector.sessionId, selected.entryId);
    }
    return true;
  }

  // Modal: swallow unbound keys so they cannot hit the editor / global handlers.
  return true;
}

function renderForkSelectorOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderForkSelectorOverlayInner(state, width));
}

function renderForkSelectorOverlayInner(state: MixCodeState, width: number): string[] {
  const selector = state.forkSelector;
  if (!selector.open || selector.items.length === 0) return [];

  const maxVisible = 15;
  const innerWidth = Math.max(1, width - 4);

  const lines: string[] = [];
  lines.push(activeRenderTheme.dim("Select a user message to fork from (newest last):"));
  lines.push("");

  // Simple scrolling: if selected is out of the visible window, scroll to show it
  const totalItems = selector.items.length;
  let startIndex = 0;
  if (totalItems > maxVisible) {
    startIndex = Math.max(0, Math.min(selector.selectedIndex - Math.floor(maxVisible / 2), totalItems - maxVisible));
  }
  const endIndex = Math.min(startIndex + maxVisible, totalItems);

  if (startIndex > 0) {
    lines.push(activeRenderTheme.dim(`  ... (${startIndex} more above)`));
  }

  for (let i = startIndex; i < endIndex; i++) {
    const item = selector.items[i];
    const isSelected = i === selector.selectedIndex;
    const prefix = isSelected ? ">" : " ";
    // Truncate message preview to fit the inner width minus prefix and spacing
    const previewBudget = innerWidth - 2;
    const preview = truncateMessagePreview(item.text, previewBudget);
    const line = `${prefix} ${preview}`;
    lines.push(isSelected ? activeRenderTheme.selectedBg(line) : line);
  }

  if (endIndex < totalItems) {
    lines.push(activeRenderTheme.dim(`  ... (${totalItems - endIndex} more below)`));
  }

  return overlayPanel("Fork from User Message", lines, width);
}

function truncateMessagePreview(text: string, maxWidth: number): string {
  // Collapse newlines and multiple spaces into single spaces, then truncate.
  // Delegate to pi-tui truncateToWidth: identical "..." behavior for ASCII,
  // column-correct for wide chars (the old char-slice overflowed CJK text).
  return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth);
}
