import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import type { ChatLine } from "../agent/runtime.js";
import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { chatEnd } from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import {
  cancelCustomInstructions,
  cancelSummarizePrompt,
  confirmCustomInstructions,
  confirmSummarizeSelection,
  initTreeSelector,
  isNewestTreeSelection,
  moveSummarizeSelection,
  resetTreeSelectorComponent,
  type SessionTreeNode,
  showSummarizePrompt,
  syncTreeSelectorSelection,
  type TreeFilterMode,
  type TreeSelectorMode,
} from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import { showErrorOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui, TreeSelectorDisplayHost } from "./app-types.js";
import { scrollChatToUserEntry } from "./chat-scroll-target.js";
import { renderTreeSelector } from "./tree-selector-render.js";

function getTreeSelectorDisplayHost(tui: OverlayTui): TreeSelectorDisplayHost | undefined {
  return tui.treeSelectorDisplay;
}

function refreshTreeSelectorDisplay(tui: OverlayTui): void {
  getTreeSelectorDisplayHost(tui)?.refresh();
}

function closeTreeSelectorDisplay(tui: OverlayTui, sessionId?: string): void {
  getTreeSelectorDisplayHost(tui)?.close(sessionId);
}

export class TreeSelectorEditorComponent implements EditorComponent {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  constructor(
    private readonly state: MixCodeState,
    private readonly tui: OverlayTui,
    private readonly runtime?: unknown,
    private readonly onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  ) {
    const rows = getTreeSelectorDisplayHost(tui)?.getEditorRows?.(state.activeTabId);
    if (rows !== undefined)
      resetTreeSelectorComponent(state.treeSelector, Math.max(10, (rows - 9) * 2));
  }

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
  tui.treeSelectorDisplay = {
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

export interface TreeSelectorRuntime {
  getTab: (sessionId: string) =>
    | {
        session: {
          getTree: () => SessionTreeNode[];
          getLeafId: () => string | null;
          appendLabelChange: (entryId: string, label: string | undefined) => string;
          getBranch?: () => SessionEntry[];
        };
        chat?: ChatLine[];
        agentSession: { abortBranchSummary: () => void };
      }
    | undefined;
  extensionNavigateTree: (
    sessionId: string,
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ) => Promise<{ cancelled: boolean; aborted?: boolean }>;
  appendSystemMessage: (sessionId: string, text: string) => void;
}

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
  if (tree.length === 0) {
    const tab = state.tabs.find((candidate) => candidate.sessionId === sessionId);
    if (tab) pushToast(tab, { type: "warning", message: "No entries in session" });
    tui.requestRender();
    return;
  }

  initTreeSelector(
    state.treeSelector,
    tree,
    runtimeTab.session.getLeafId(),
    initialSelectedId,
    initialFilterMode,
    mode,
    allowedEntryIds,
  );
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
  closeTreeSelectorDisplay(tui, ownerSessionId);
  tui.requestRender();
}

export function handleTreeSelectorKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const selector = state.treeSelector;
  if (!selector.open) return false;

  if (selector.summarizePrompt !== null) {
    return handleSummarizeKey(state, data, tui, runtime, onStateChanged);
  }

  if (selector.mode === "navigate") {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      closeTreeSelector(state, tui);
      return true;
    }
    if (matchesKey(data, "up") || data === "k") {
      moveNavigateSelection(state, tui, runtime, onStateChanged, -1);
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      moveNavigateSelection(state, tui, runtime, onStateChanged, 1);
      return true;
    }
    return matchesKey(data, "left");
  }

  withTreeKeybindings(() => selector.component?.handleInput(data));
  syncTreeSelectorSelection(selector);
  drainTreeComponentEvents(state, tui, runtime, onStateChanged);
  refreshTreeSelectorDisplay(tui);
  tui.requestRender();
  return true;
}

function handleSummarizeKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const selector = state.treeSelector;
  const prompt = selector.summarizePrompt!;
  if (prompt.customMode) {
    if (matchesKey(data, "escape")) cancelCustomInstructions(selector);
    else if (matchesKey(data, "enter")) {
      const result = confirmCustomInstructions(selector);
      if (result) {
        const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
        const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
        if (active && runtimeRef?.extensionNavigateTree) {
          closeTreeSelector(state, tui);
          void navigateToEntry(
            state,
            tui,
            active.sessionId,
            result.targetEntryId,
            runtimeRef,
            onStateChanged,
            {
              summarize: true,
              customInstructions: result.customInstructions,
            },
          );
        }
      }
    } else if (data === "\u007f") prompt.customInput = prompt.customInput.slice(0, -1);
    else if (matchesKey(data, "ctrl+u")) prompt.customInput = "";
    else if (isPrintable(data)) prompt.customInput += data;
  } else if (matchesKey(data, "escape")) cancelSummarizePrompt(selector);
  else if (matchesKey(data, "up")) moveSummarizeSelection(selector, -1);
  else if (matchesKey(data, "down")) moveSummarizeSelection(selector, 1);
  else if (matchesKey(data, "enter")) {
    const result = confirmSummarizeSelection(selector);
    if (result) {
      const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
      const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
      if (active && runtimeRef?.extensionNavigateTree) {
        closeTreeSelector(state, tui);
        void navigateToEntry(
          state,
          tui,
          active.sessionId,
          result.targetEntryId,
          runtimeRef,
          onStateChanged,
          {
            summarize: result.summarize,
          },
        );
      }
    }
  }
  refreshTreeSelectorDisplay(tui);
  tui.requestRender();
  return true;
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && !/^[\x00-\x1f\x7f]$/.test(data);
}

function drainTreeComponentEvents(
  state: MixCodeState,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): void {
  const selector = state.treeSelector;
  const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);

  if (selector.labelChangeRequest) {
    const { entryId, label } = selector.labelChangeRequest;
    selector.labelChangeRequest = undefined;
    if (active) runtimeRef?.getTab(active.sessionId)?.session.appendLabelChange(entryId, label);
  }
  if (selector.copyRequest !== undefined) {
    const text = selector.copyRequest;
    selector.copyRequest = undefined;
    void copyToClipboard(text)
      .then(() => {
        if (active) pushToast(active, { type: "success", message: "Copied to clipboard" });
        tui.requestRender();
      })
      .catch((error: unknown) => showErrorOverlay(tui, error));
  }
  if (selector.cancelRequested) {
    selector.cancelRequested = false;
    closeTreeSelector(state, tui);
  }
  if (selector.selectRequest) {
    const entryId = selector.selectRequest;
    selector.selectRequest = undefined;
    if (entryId === selector.currentLeafId) {
      closeTreeSelector(state, tui);
      if (active) pushToast(active, { type: "info", message: "Already at this point" });
    } else if (active && runtimeRef?.extensionNavigateTree) {
      showSummarizePrompt(selector, entryId);
      void onStateChanged?.(state);
    }
  }
}

function moveNavigateSelection(
  state: MixCodeState,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  direction: -1 | 1,
): void {
  const selector = state.treeSelector;
  const nextIndex = selector.selectedIndex + direction;
  if (nextIndex < 0 || nextIndex >= selector.navigationEntryIds.length) {
    const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
    if (active) {
      pushToast(active, {
        type: "info",
        message: direction < 0 ? "No older user message" : "No newer user message",
      });
    }
  } else {
    withTreeKeybindings(() => selector.component?.handleInput(direction < 0 ? "\x1b[A" : "\x1b[B"));
    syncTreeSelectorSelection(selector);
    void navigateOnSelectionChange(state, tui, runtime, onStateChanged);
  }
  refreshTreeSelectorDisplay(tui);
  tui.requestRender();
}

function withTreeKeybindings<T>(action: () => T): T {
  const restore = applyMixCodeKeybindings();
  try {
    return action();
  } finally {
    restore();
  }
}

async function navigateOnSelectionChange(
  state: MixCodeState,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
  if (!active) return;
  if (isNewestTreeSelection(state.treeSelector)) {
    chatEnd(active);
    await onStateChanged?.(state);
    refreshTreeSelectorDisplay(tui);
    tui.requestRender();
    return;
  }

  const entryId = state.treeSelector.selectedEntryId;
  const runtimeRef = runtime as unknown as TreeSelectorRuntime | undefined;
  const runtimeTab = runtimeRef?.getTab(active.sessionId);
  if (!entryId || !runtimeTab) return;
  const branch = runtimeTab.session.getBranch?.() ?? [];
  const bounds = active.chatSurfaceBounds;
  const result = scrollChatToUserEntry(
    active,
    runtimeTab.chat ?? [],
    branch,
    entryId,
    bounds?.height ?? Math.max(1, Math.floor((process.stdout.rows || 24) / 2)),
    bounds?.width ?? (process.stdout.columns || 80),
  );
  if (!result.found) {
    pushToast(active, { type: "warning", message: "Message is not in the current chat" });
  }
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
  if (options?.summarize && active) {
    active.status = "running";
    active.workingStartedAt = new Date().toISOString();
    active.lastWorkedDurationSeconds = undefined;
    active.lastWorkedAt = undefined;
    active.extensionUi.workingMessage = "Summarizing branch... (escape to cancel)";
    active.extensionUi.workingVisible = true;
    tui.requestRender();
  }
  try {
    const result = await runtime.extensionNavigateTree(sessionId, entryId, options);
    if (result.aborted) {
      if (active) pushToast(active, { type: "warning", message: "Branch summarization cancelled" });
      openTreeSelector(state, runtime, tui, sessionId, entryId);
      return;
    }
    if (result.cancelled) {
      if (active) pushToast(active, { type: "warning", message: "Navigation cancelled" });
    } else if (active)
      pushToast(active, { type: "success", message: "Navigated to selected point" });
  } catch (error) {
    showErrorOverlay(tui, error);
  } finally {
    if (options?.summarize && active) {
      active.status = "idle";
      active.workingStartedAt = undefined;
      active.extensionUi.workingMessage = undefined;
      // Keep default visibility: agent_start only flips status, not workingVisible.
      // Leaving this false permanently hides the editor working spinner after summarize.
      active.extensionUi.workingVisible = true;
    }
  }
  await onStateChanged?.(state);
  tui.requestRender();
}
