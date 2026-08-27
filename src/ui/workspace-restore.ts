import { createSessionId, createTab } from "../core/defaults.js";
import { assertConfiguredOpenTabsReadable, noteTabsReplaced } from "../core/open-tabs-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, clampHomeSelectedTabIndex, closeAgentTab } from "../core/tabs.js";
import {
  HOME_TAB_ID,
  type MixCodeState,
  type MixCodeTabInfo,
  type WorkspaceSnapshot,
  type WorkspaceTabSnapshot,
} from "../core/types.js";
import { reindexWorkspaceTabs } from "../core/workspace.js";
import { hydrateTabPromptHistory } from "./app-runtime.js";
import type { OverlayTui } from "./app-types.js";
import {
  closeWorkspaceOverlay,
  presentWorkspaceOverlay,
  presentWorkspaceRestoreProgress,
  type WorkspaceOverlay,
} from "./components/workspace-overlay.js";
import { showWorkspaceToast } from "./workspace-actions.js";
import type { WorkspaceRuntime } from "./workspace-shared.js";

interface RestoredWorkspaceTab {
  item: WorkspaceTabSnapshot;
  tab: MixCodeTabInfo;
}

export async function restoreWorkspace(
  state: MixCodeState,
  runtime: WorkspaceRuntime | undefined,
  tui: OverlayTui,
  workspace: WorkspaceSnapshot,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  /** Presented overlay to reuse for progress; created when absent. */
  progressOverlay?: WorkspaceOverlay,
): Promise<void> {
  assertConfiguredOpenTabsReadable();
  if (!runtime) {
    restoreAlreadyOpenWorkspaceOrder(state, workspace);
    noteTabsReplaced(state.tabs.map((tab) => tab.sessionId));
    await onStateChanged?.(state);
    showWorkspaceToast(state, tui, `Workspace restored: ${workspace.name}`, "success");
    return;
  }
  const items = workspace.tabs;
  const overlay = progressOverlay ?? presentWorkspaceRestoreProgress(state, tui, runtime);
  overlay.mode = "restoring";
  overlay.pendingWorkspace = workspace;
  overlay.progressCurrent = 0;
  overlay.progressTotal = items.length;
  tui.requestRender();
  const restoredTabs: RestoredWorkspaceTab[] = [];
  const missing: string[] = [];
  const originalTabs = [...state.tabs];
  for (const [index, item] of items.entries()) {
    overlay.progressCurrent = index;
    tui.requestRender();
    const existing = findOpenWorkspaceTab(state, runtime, item);
    if (existing) {
      applyWorkspaceTabMetadata(existing, item);
      restoredTabs.push({ item, tab: existing });
      continue;
    }
    if (!item.sessionPath) {
      missing.push(`${item.title || item.sessionId} (no session path saved)`);
      continue;
    }
    if (!(await Bun.file(item.sessionPath).exists())) {
      missing.push(item.title || item.sessionId);
      continue;
    }
    const created = createWorkspaceRuntimeTab(state, item, index);
    state.tabs.push(created);
    await runtime.createTab(created, {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: created.thinkingLevel,
      workdir: created.workdir,
    });
    const result = await runtime.extensionSwitchSession(created.sessionId, item.sessionPath);
    if (result.cancelled) {
      await runtime.closeTab(created.sessionId);
      closeAgentTab(state, created.sessionId);
      missing.push(item.title || item.sessionId);
      continue;
    }
    applyWorkspaceTabMetadata(created, item);
    restoredTabs.push({ item, tab: created });
  }
  overlay.progressCurrent = items.length;
  tui.requestRender();
  for (const tab of originalTabs) {
    if (restoredTabs.some((restored) => restored.tab === tab)) continue;
    await runtime.closeTab(tab.sessionId);
  }
  finishWorkspaceRestore(state, overlay, workspace, restoredTabs, missing);
  hydrateTabPromptHistory(state, runtime);
  noteTabsReplaced(state.tabs.map((tab) => tab.sessionId));
  await onStateChanged?.(state);
  showWorkspaceToast(
    state,
    tui,
    missing.length
      ? `Workspace restored: ${workspace.name} · restored ${restoredTabs.length}, skipped ${missing.length}`
      : `Workspace restored: ${workspace.name} · ${restoredTabs.length} tabs`,
    "success",
  );
  if (missing.length) {
    overlay.mode = "missing";
    // Re-present: a no-active-tab toast falls back to a notice overlay that
    // hides this component (showComponentOverlay closes the previous one).
    presentWorkspaceOverlay(state, tui, overlay);
  } else {
    closeWorkspaceOverlay(state, tui);
  }
  tui.requestRender();
}

function restoreAlreadyOpenWorkspaceOrder(state: MixCodeState, workspace: WorkspaceSnapshot): void {
  const items = workspace.tabs;
  const tabById = new Map(state.tabs.map((tab) => [tab.sessionId, tab]));
  state.tabs = items.flatMap((item) => {
    const tab = tabById.get(item.sessionId);
    if (!tab) return [];
    applyWorkspaceTabMetadata(tab, item);
    return [tab];
  });
  reindexWorkspaceTabs(state);
  const active = workspace.activeSessionId;
  activateTab(
    state,
    (active && state.tabs.some((tab) => tab.sessionId === active)
      ? active
      : state.tabs[0]?.sessionId) ?? HOME_TAB_ID,
  );
  clampHomeSelectedTabIndex(state);
}

function createWorkspaceRuntimeTab(
  state: MixCodeState,
  item: WorkspaceTabSnapshot,
  index: number,
): MixCodeTabInfo {
  return createTab(state.tabs.length + 1, createSessionId(), item.workdir || state.workdir, {
    title: item.title || `Agent-${String(index + 1).padStart(2, "0")}`,
    model: item.model ? { ...item.model } : { ...state.model },
    contextLimit: item.model?.contextWindow ?? state.model.contextWindow,
    thinkingLevel: item.thinkingLevel ?? state.thinkingLevel,
    inlineWidgets: state.ui?.inlineWidgets === true,
  });
}

function finishWorkspaceRestore(
  state: MixCodeState,
  overlay: WorkspaceOverlay,
  workspace: WorkspaceSnapshot,
  restoredTabs: RestoredWorkspaceTab[],
  missing: string[],
): void {
  state.tabs = restoredTabs.map((restored) => restored.tab);
  reindexWorkspaceTabs(state);
  const activeTab = workspace.activeSessionId
    ? restoredTabs.find((restored) => restored.item.sessionId === workspace.activeSessionId)?.tab
    : undefined;
  activateTab(state, activeTab?.sessionId ?? state.tabs[0]?.sessionId ?? HOME_TAB_ID);
  clampHomeSelectedTabIndex(state);
  overlay.restoredCount = restoredTabs.length;
  overlay.skippedMissing = missing;
}

function findOpenWorkspaceTab(
  state: MixCodeState,
  runtime: WorkspaceRuntime | undefined,
  item: WorkspaceTabSnapshot,
): MixCodeTabInfo | undefined {
  if (item.sessionPath && runtime) {
    const byPath = state.tabs.find(
      (tab) => runtime.getTab(tab.sessionId)?.session?.getSessionFile?.() === item.sessionPath,
    );
    if (byPath) return byPath;
  }
  return state.tabs.find((tab) => tab.sessionId === item.sessionId);
}

function applyWorkspaceTabMetadata(tab: MixCodeTabInfo, item: WorkspaceTabSnapshot): void {
  if (item.title) tab.title = item.title;
  if (item.workdir) tab.workdir = item.workdir;
  if (item.model) {
    tab.model = { ...item.model };
    tab.contextLimit = item.model.contextWindow;
    tab.contextLimitOverridden = false;
  }
  if (item.thinkingLevel) tab.thinkingLevel = item.thinkingLevel;
}
