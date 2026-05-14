import { isKeyRelease, matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

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
import type { MixCodeKeyRuntime, OverlayTui, TreeSelectorDisplayHost } from "./app-types.js";
import { showErrorOverlay } from "./app-overlays.js";
import { renderTreeSelector } from "./tree-selector-render.js";

function refreshTreeSelectorDisplay(tui: OverlayTui): void {
  getTreeSelectorDisplayHost(tui)?.refresh();
}

function closeTreeSelectorDisplay(tui: OverlayTui, sessionId?: string): void {
  getTreeSelectorDisplayHost(tui)?.close(sessionId);
}

function getTreeSelectorDisplayHost(tui: OverlayTui): TreeSelectorDisplayHost | undefined {
  return tui.treeSelectorDisplay;
}

function getMaxVisible(): number {
  return Math.max(5, Math.floor((process.stdout.rows || 24) / 2));
}

export class TreeSelectorEditorComponent implements EditorComponent {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  constructor(
    private readonly state: MixCodeState,
    private readonly tui: OverlayTui,
    private readonly runtime?: unknown,
    private readonly onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  ) {}

  render(width: number): string[] {
    return renderTreeSelector(this.state, width);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    handleTreeSelectorKey(
      this.state,
      data,
      this.tui,
      this.runtime as MixCodeKeyRuntime | undefined,
      this.onStateChanged,
    );
  }

  getText(): string {
    return "";
  }

  setText(_text: string): void {}

  getExpandedText(): string {
    return "";
  }

  addToHistory(_text: string): void {}

  insertTextAtCursor(_text: string): void {}
}

export function attachTreeSelectorDisplayHost(
  tui: OverlayTui,
  state: MixCodeState,
  setEditorComponent: (factory: (() => EditorComponent) | undefined, sessionId?: string) => void,
): void {
  const displayTui = tui as OverlayTui & {
    treeSelectorDisplay?: TreeSelectorDisplayHost;
  };
  displayTui.treeSelectorDisplay = {
    open: (sessionId, runtime, onStateChanged) => {
      setEditorComponent(
        () => new TreeSelectorEditorComponent(state, tui, runtime, onStateChanged),
        sessionId,
      );
    },
    refresh: () => tui.requestRender(),
    close: (sessionId) => {
      setEditorComponent(undefined, sessionId);
      state.treeSelector.open = false;
    },
  };
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
  const display = getTreeSelectorDisplayHost(tui);
  if (!display) throw new Error("Tree selector requires editor display host support");
  display.open(sessionId, runtime, undefined);
  tui.requestRender();
}

export function closeTreeSelector(state: MixCodeState, tui: OverlayTui): void {
  state.treeSelector.open = false;
  closeTreeSelectorDisplay(tui);
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
      refreshTreeSelectorDisplay(tui);
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
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
      return true;
    }
    if (data === "\u007f") {
      selector.labelEditInput = selector.labelEditInput.slice(0, -1);
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "ctrl+u")) {
      selector.labelEditInput = "";
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
      return true;
    }
    // Accept printable input
    if (data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data)) {
      selector.labelEditInput += data;
      refreshTreeSelectorDisplay(tui);
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
        refreshTreeSelectorDisplay(tui);
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
        refreshTreeSelectorDisplay(tui);
        tui.requestRender();
        return true;
      }
      if (matchesKey(data, "ctrl+u")) {
        prompt.customInput = "";
        refreshTreeSelectorDisplay(tui);
        tui.requestRender();
        return true;
      }
      if (data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data)) {
        prompt.customInput += data;
        refreshTreeSelectorDisplay(tui);
        tui.requestRender();
        return true;
      }
      return true;
    }

    // Summarize option selection
    if (matchesKey(data, "escape")) {
      cancelSummarizePrompt(selector);
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "up")) {
      moveSummarizeSelection(selector, -1);
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "down")) {
      moveSummarizeSelection(selector, 1);
      refreshTreeSelectorDisplay(tui);
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
        refreshTreeSelectorDisplay(tui);
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
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
    } else {
      closeTreeSelector(state, tui);
    }
    return true;
  }
  if (matchesKey(data, "up")) {
    moveTreeSelection(selector, -1);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveTreeSelection(selector, 1);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "left") || matchesKey(data, "pageUp")) {
    pageTreeSelection(selector, -1, getMaxVisible());
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "right") || matchesKey(data, "pageDown")) {
    pageTreeSelection(selector, 1, getMaxVisible());
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left")) {
    foldOrUp(selector);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right")) {
    unfoldOrDown(selector);
    refreshTreeSelectorDisplay(tui);
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
          refreshTreeSelectorDisplay(tui);
          tui.requestRender();
        }
      }
    }
    return true;
  }
  // Filter shortcuts
  if (matchesKey(data, "ctrl+a")) {
    setTreeFilter(selector, selector.filterMode === "all" ? "default" : "all");
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+t")) {
    setTreeFilter(selector, selector.filterMode === "no-tools" ? "default" : "no-tools");
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+u")) {
    setTreeFilter(selector, selector.filterMode === "user-only" ? "default" : "user-only");
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+l")) {
    setTreeFilter(selector, selector.filterMode === "labeled-only" ? "default" : "labeled-only");
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+o")) {
    cycleTreeFilter(selector, 1);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "shift+ctrl+o")) {
    cycleTreeFilter(selector, -1);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "shift+l")) {
    startLabelEdit(selector);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "shift+t")) {
    selector.showLabelTimestamps = !selector.showLabelTimestamps;
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return true;
  }
  // Backspace
  if (data === "\u007f") {
    if (selector.searchQuery.length > 0) {
      updateTreeSearchQuery(selector, selector.searchQuery.slice(0, -1));
      refreshTreeSelectorDisplay(tui);
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
    refreshTreeSelectorDisplay(tui);
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
