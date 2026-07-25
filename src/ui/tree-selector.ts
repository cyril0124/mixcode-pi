import { isKeyRelease, matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatLine } from "../agent/runtime.js";
import type { SessionTreeNode, TreeFilterMode, TreeSelectorMode } from "../core/tree-selector.js";

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
  isNewestNavRowSelected,
  moveTreeSelection,
  moveTreeSelectionBounded,
  moveSummarizeSelection,
  pageTreeSelection,
  setTreeFilter,
  showSummarizePrompt,
  startLabelEdit,
  unfoldOrDown,
  updateTreeSearchQuery,
} from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import { chatEnd } from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeKeyRuntime, OverlayTui, TreeSelectorDisplayHost } from "./app-types.js";
import { showErrorOverlay } from "./app-overlays.js";
import { scrollChatToUserEntry } from "./chat-scroll-target.js";
import { halfScreenRows } from "./rendering/scroll-window.js";
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
  return halfScreenRows();
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
    return renderTreeSelector(
      this.state,
      width,
      getTreeSelectorDisplayHost(this.tui)?.getEditorRows?.(this.state.activeTabId),
    );
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
  getEditorRows?: (sessionId?: string) => number | undefined,
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
    getEditorRows,
  };
}

// --- Runtime interface ---

export interface TreeSelectorRuntime {
  getTab: (sessionId: string) => {
    session: {
      getTree: () => SessionTreeNode[];
      getLeafId: () => string | null;
      appendLabelChange: (entryId: string, label: string | undefined) => string;
      getBranch?: () => SessionEntry[];
    };
    chat?: ChatLine[];
    agentSession: {
      abortBranchSummary: () => void;
    };
  } | undefined;
  extensionNavigateTree?: (
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
  initialFilterMode?: TreeFilterMode,
  mode: TreeSelectorMode = "tree",
  allowedEntryIds?: Set<string>,
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
    const tab = state.tabs.find((t) => t.sessionId === sessionId);
    if (tab) pushToast(tab, { type: "warning", message: "No entries in session" });
    tui.requestRender();
    return;
  }

  initTreeSelector(state.treeSelector, tree, leafId, initialSelectedId, initialFilterMode, mode, allowedEntryIds);
  // Remember owner so tab switches can unload the correct editor replacement.
  state.treeSelector.ownerSessionId = sessionId;
  const display = getTreeSelectorDisplayHost(tui);
  if (!display) throw new Error("Tree selector requires editor display host support");
  display.open(sessionId, runtime, undefined);
  tui.requestRender();
}

export function closeTreeSelector(state: MixCodeState, tui: OverlayTui): void {
  const ownerSessionId = state.treeSelector.ownerSessionId;
  state.treeSelector.open = false;
  state.treeSelector.ownerSessionId = undefined;
  // Pass owner id: default close() would target the newly active tab after a switch.
  closeTreeSelectorDisplay(tui, ownerSessionId);
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
  if (matchesKey(data, "escape") || (selector.mode === "navigate" && matchesKey(data, "enter"))) {
    if (selector.searchQuery) {
      updateTreeSearchQuery(selector, "");
      refreshTreeSelectorDisplay(tui);
      tui.requestRender();
    } else {
      closeTreeSelector(state, tui);
    }
    return true;
  }
  if (matchesKey(data, "up") || (selector.mode === "navigate" && data === "k")) {
    moveTreeSelectorSelection(state, tui, runtime, onStateChanged, -1);
    return true;
  }
  if (matchesKey(data, "down") || (selector.mode === "navigate" && data === "j")) {
    moveTreeSelectorSelection(state, tui, runtime, onStateChanged, 1);
    return true;
  }
  // Navigate swaps the editor for an empty tree surface; without consuming Left,
  // app-input treats empty-editor Left as "return to Home" and leaves the tree open.
  if (selector.mode === "navigate") return matchesKey(data, "left");
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
          pushToast(active, { type: "info", message: "Already at this point" });
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
  // Pi default: ctrl+d resets tree filters to default (hint lists ctrl+d).
  if (matchesKey(data, "ctrl+d")) {
    setTreeFilter(selector, "default");
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

function moveTreeSelectorSelection(
  state: MixCodeState,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  direction: -1 | 1,
): void {
  const selector = state.treeSelector;
  let moved = true;
  if (selector.mode === "navigate") {
    moved = moveTreeSelectionBounded(selector, direction);
  } else {
    moveTreeSelection(selector, direction);
  }
  if (!moved) {
    const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
    if (active)
      pushToast(active, {
        type: "info",
        message: direction < 0 ? "No older user message" : "No newer user message",
      });
  } else if (selector.mode === "navigate") {
    void navigateOnSelectionChange(state, tui, runtime, onStateChanged);
  }
  refreshTreeSelectorDisplay(tui);
  tui.requestRender();
}

async function navigateOnSelectionChange(
  state: MixCodeState,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
  if (!active) return;
  // Virtual <NEWEST> row: clear the scroll anchor and jump to the latest position.
  if (isNewestNavRowSelected(state.treeSelector)) {
    chatEnd(active);
    await onStateChanged?.(state);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return;
  }
  const entry = getSelectedTreeEntry(state.treeSelector);
  const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
  const runtimeTab = runtimeRef?.getTab(active.sessionId);
  const branch = runtimeTab?.session.getBranch?.() ?? [];
  if (!entry || !runtimeTab) return;
  const bounds = active.chatSurfaceBounds;
  const result = scrollChatToUserEntry(
    active,
    runtimeTab.chat ?? [],
    branch,
    entry.id,
    bounds?.height ?? getMaxVisible(),
    bounds?.width ?? (process.stdout.columns || 80),
  );
  if (!result.found)
    pushToast(active, { type: "warning", message: "Message is not in the current chat" });
  await onStateChanged?.(state);
  refreshTreeSelectorDisplay(tui);
  tui.requestRender();
}

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
    active.lastWorkedAt = undefined;
    active.extensionUi.workingMessage = "Summarizing branch... (escape to cancel)";
    active.extensionUi.workingVisible = true;
    tui.requestRender();
  }

  if (!runtime.extensionNavigateTree) throw new Error("Tree navigation requires pi runtime tree support");

  try {
    const result = await runtime.extensionNavigateTree(sessionId, entryId, {
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
    });
    if (result.aborted) {
      // Re-show tree selector with same selection on abort
      if (active) pushToast(active, { type: "warning", message: "Branch summarization cancelled" });
      openTreeSelector(state, runtime, tui, sessionId, entryId);
      return;
    }
    if (result.cancelled) {
      if (active) pushToast(active, { type: "warning", message: "Navigation cancelled" });
    } else {
      if (active) pushToast(active, { type: "success", message: "Navigated to selected point" });
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
