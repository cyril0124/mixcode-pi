import { matchesKey } from "@earendil-works/pi-tui";

import type { SessionTreeNode } from "../core/tree-selector.js";

import {
  cancelCustomInstructions,
  cancelLabelEdit,
  cancelSummarizePrompt,
  confirmCustomInstructions,
  confirmLabelEdit,
  confirmSummarizeSelection,
  cycleTreeFilter,
  foldOrUp,
  getSelectedTreeEntry,
  initTreeSelector,
  moveTreeSelection,
  moveSummarizeSelection,
  pageTreeSelection,
  setTreeFilter,
  showSummarizePrompt,
  startLabelEdit,
  type TreeSelectorState,
  unfoldOrDown,
  updateTreeSearchQuery,
} from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import { renderTreeSelector } from "./tree-selector-render.js";

function getMaxVisible(): number {
  return Math.max(8, Math.floor((process.stdout.rows || 24) / 2));
}

// --- Runtime interface ---

export interface TreeSelectorRuntime {
  getTab: (sessionId: string) => {
    session: {
      getTree: () => SessionTreeNode[];
      getLeafId: () => string | null;
      appendLabelChange: (entryId: string, label: string | undefined) => string;
    };
    agentSession: {
      abortBranchSummary: () => void;
    };
  } | undefined;
  extensionNavigateTree: (
    sessionId: string,
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ) => Promise<{ cancelled: boolean; aborted?: boolean }>;
  appendSystemMessage: (sessionId: string, text: string) => void;
}

// --- Open / Close ---

export function openTreeSelector(
  state: MixCodeState,
  runtime: TreeSelectorRuntime,
  tui: OverlayTui,
  sessionId: string,
  initialSelectedId?: string,
): void {
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) {
    showErrorOverlay(tui, new Error("No active session"));
    tui.requestRender();
    return;
  }

  const tree = runtimeTab.session.getTree();
  const leafId = runtimeTab.session.getLeafId();

  if (tree.length === 0) {
    runtime.appendSystemMessage(sessionId, "No entries in session");
    tui.requestRender();
    return;
  }

  initTreeSelector(state.treeSelector, tree, leafId, initialSelectedId);
  showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
  tui.requestRender();
}

export function closeTreeSelector(state: MixCodeState, tui: OverlayTui): void {
  state.treeSelector.open = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

// --- Key handling ---

export function handleTreeSelectorKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const selector = state.treeSelector;
  if (!selector.open) return false;

  // Label edit mode
  if (selector.labelEditEntryId !== null) {
    if (matchesKey(data, "escape")) {
      cancelLabelEdit(selector);
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "enter")) {
      const result = confirmLabelEdit(selector);
      if (result) {
        // Persist label via runtime (if available)
        const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
        const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
        if (active && runtimeRef?.getTab) {
          runtimeRef.getTab(active.sessionId)?.session.appendLabelChange(result.entryId, result.label);
        }
      }
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (data === "\u007f") {
      selector.labelEditInput = selector.labelEditInput.slice(0, -1);
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "ctrl+u")) {
      selector.labelEditInput = "";
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    // Accept printable input
    if (data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data)) {
      selector.labelEditInput += data;
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    return true;
  }

  // Summarize prompt mode
  if (selector.summarizePrompt !== null) {
    const prompt = selector.summarizePrompt;
    if (prompt.customMode) {
      // Custom instructions input
      if (matchesKey(data, "escape")) {
        cancelCustomInstructions(selector);
        showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
        tui.requestRender();
        return true;
      }
      if (matchesKey(data, "enter")) {
        const result = confirmCustomInstructions(selector);
        if (result) {
          const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
          const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
          if (active && runtimeRef?.extensionNavigateTree) {
            closeTreeSelector(state, tui);
            void navigateToEntry(
              state, tui, active.sessionId, result.targetEntryId, runtimeRef, onStateChanged,
              { summarize: true, customInstructions: result.customInstructions },
            );
          }
        }
        return true;
      }
      if (data === "\u007f") {
        prompt.customInput = prompt.customInput.slice(0, -1);
        showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
        tui.requestRender();
        return true;
      }
      if (matchesKey(data, "ctrl+u")) {
        prompt.customInput = "";
        showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
        tui.requestRender();
        return true;
      }
      if (data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data)) {
        prompt.customInput += data;
        showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
        tui.requestRender();
        return true;
      }
      return true;
    }

    // Summarize option selection
    if (matchesKey(data, "escape")) {
      cancelSummarizePrompt(selector);
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "up")) {
      moveSummarizeSelection(selector, -1);
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "down")) {
      moveSummarizeSelection(selector, 1);
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "enter")) {
      const result = confirmSummarizeSelection(selector);
      if (result) {
        const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
        const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
        if (active && runtimeRef?.extensionNavigateTree) {
          closeTreeSelector(state, tui);
          void navigateToEntry(
            state, tui, active.sessionId, result.targetEntryId, runtimeRef, onStateChanged,
            { summarize: result.summarize },
          );
        }
      } else {
        // Entered custom mode, re-render
        showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
        tui.requestRender();
      }
      return true;
    }
    return true;
  }

  // Normal mode
  if (matchesKey(data, "escape")) {
    if (selector.searchQuery) {
      updateTreeSearchQuery(selector, "");
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
    } else {
      closeTreeSelector(state, tui);
    }
    return true;
  }
  if (matchesKey(data, "up")) {
    moveTreeSelection(selector, -1);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveTreeSelection(selector, 1);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "left") || matchesKey(data, "pageUp")) {
    pageTreeSelection(selector, -1, getMaxVisible());
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "right") || matchesKey(data, "pageDown")) {
    pageTreeSelection(selector, 1, getMaxVisible());
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+h")) {
    // Fold or navigate up
    foldOrUp(selector);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+l")) {
    // Unfold or navigate down
    unfoldOrDown(selector);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "enter")) {
    const entry = getSelectedTreeEntry(selector);
    if (entry) {
      const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
      if (active) {
        // If selecting the current leaf, show status and close
        if (entry.id === selector.currentLeafId) {
          closeTreeSelector(state, tui);
          const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
          runtimeRef?.appendSystemMessage(active.sessionId, "Already at this point");
          return true;
        }
        const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
        if (runtimeRef?.extensionNavigateTree) {
          // Show summarize prompt
          showSummarizePrompt(selector, entry.id);
          showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
          tui.requestRender();
        }
      }
    }
    return true;
  }
  // Filter shortcuts
  if (matchesKey(data, "ctrl+a")) {
    setTreeFilter(selector, selector.filterMode === "all" ? "default" : "all");
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+t")) {
    setTreeFilter(selector, selector.filterMode === "no-tools" ? "default" : "no-tools");
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+u")) {
    setTreeFilter(selector, selector.filterMode === "user-only" ? "default" : "user-only");
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+b")) {
    setTreeFilter(selector, selector.filterMode === "labeled-only" ? "default" : "labeled-only");
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+n")) {
    cycleTreeFilter(selector, 1);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+p")) {
    cycleTreeFilter(selector, -1);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+e")) {
    // Edit label
    startLabelEdit(selector);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+d")) {
    // Toggle label timestamps
    selector.showLabelTimestamps = !selector.showLabelTimestamps;
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  // Backspace
  if (data === "\u007f") {
    if (selector.searchQuery.length > 0) {
      updateTreeSearchQuery(selector, selector.searchQuery.slice(0, -1));
      showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
      tui.requestRender();
    }
    return true;
  }
  // Printable characters for search
  if (
    data.length > 0 &&
    !data.startsWith("\x1b") &&
    !matchesKey(data, "escape") &&
    !/^[\x00-\x1f\x7f]$/.test(data)
  ) {
    updateTreeSearchQuery(selector, selector.searchQuery + data);
    showLinesOverlay(tui, (width) => renderTreeSelector(state, width));
    tui.requestRender();
    return true;
  }
  return true; // Consume all input while selector is open
}

// --- Navigation ---

async function navigateToEntry(
  state: MixCodeState,
  tui: OverlayTui,
  sessionId: string,
  entryId: string,
  runtime: TreeSelectorRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  options?: { summarize?: boolean; customInstructions?: string },
): Promise<void> {
  const active = state.tabs.find((tab) => tab.sessionId === sessionId);

  // Show working state if summarizing
  if (options?.summarize && active) {
    active.status = "running";
    active.workingStartedAt = new Date().toISOString();
    active.lastWorkedDurationSeconds = undefined;
    active.extensionUi.workingMessage = "Summarizing branch... (escape to cancel)";
    active.extensionUi.workingVisible = true;
    tui.requestRender();
  }

  try {
    const result = await runtime.extensionNavigateTree(sessionId, entryId, {
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
    });
    if (result.aborted) {
      // Re-show tree selector with same selection on abort
      runtime.appendSystemMessage(sessionId, "Branch summarization cancelled");
      openTreeSelector(state, runtime, tui, sessionId, entryId);
      return;
    }
    if (result.cancelled) {
      runtime.appendSystemMessage(sessionId, "Navigation cancelled");
    } else {
      runtime.appendSystemMessage(sessionId, "Navigated to selected point");
    }
  } catch (error) {
    showErrorOverlay(tui, error);
  } finally {
    // Restore tab state
    if (options?.summarize && active) {
      active.status = "idle";
      active.workingStartedAt = undefined;
      active.extensionUi.workingMessage = undefined;
      active.extensionUi.workingVisible = false;
    }
  }
  await onStateChanged?.(state);
  tui.requestRender();
}
