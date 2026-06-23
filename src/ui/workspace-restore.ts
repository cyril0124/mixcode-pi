import { existsSync } from "node:fs";
import { createSessionId, createTab } from "../core/defaults.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, clampHomeSelectedTabIndex, closeAgentTab } from "../core/tabs.js";
import type { MixCodeState, MixCodeTabInfo, WorkspaceSnapshot, WorkspaceTabSnapshot } from "../core/types.js";
import { reindexWorkspaceTabs } from "../core/workspace.js";
import type { OverlayTui } from "./app-types.js";
import { closeWorkspaceOverlay, showWorkspaceOverlay, showWorkspaceToast } from "./workspace-overlay.js";
import { type WorkspaceRuntime, workspaceItems } from "./workspace-shared.js";

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
): Promise<void> {
  if (!runtime?.createTab || !runtime.closeTab || !runtime.extensionSwitchSession) {
    restoreAlreadyOpenWorkspaceOrder(state, workspace);
    await onStateChanged?.(state);
    showWorkspaceToast(state, tui, `Workspace restored: ${workspace.name}`, "success");
    return;
  }
  const items = workspaceItems(workspace);
  state.workspaceOverlay.mode = "restoring";
  state.workspaceOverlay.pendingWorkspace = workspace;
  state.workspaceOverlay.progressCurrent = 0;
  state.workspaceOverlay.progressTotal = items.length;
  showWorkspaceOverlay(state, tui);
  const restoredTabs: RestoredWorkspaceTab[] = [];
  const missing: string[] = [];
  const originalTabs = [...state.tabs];
  for (const [index, item] of items.entries()) {
    state.workspaceOverlay.progressCurrent = index;
    showWorkspaceOverlay(state, tui);
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
    if (!existsSync(item.sessionPath)) {
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
  state.workspaceOverlay.progressCurrent = items.length;
  showWorkspaceOverlay(state, tui);
  for (const tab of originalTabs) {
    if (restoredTabs.some((restored) => restored.tab === tab)) continue;
    await runtime.closeTab(tab.sessionId);
  }
  finishWorkspaceRestore(state, workspace, restoredTabs, missing);
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
    state.workspaceOverlay.mode = "missing";
    showWorkspaceOverlay(state, tui);
  } else {
    closeWorkspaceOverlay(state, tui);
  }
  tui.requestRender();
}

function restoreAlreadyOpenWorkspaceOrder(state: MixCodeState, workspace: WorkspaceSnapshot): void {
  const items = workspaceItems(workspace);
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
    (active && state.tabs.some((tab) => tab.sessionId === active) ? active : state.tabs[0]?.sessionId) ??
      "config",
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
  });
}

function finishWorkspaceRestore(
  state: MixCodeState,
  workspace: WorkspaceSnapshot,
  restoredTabs: RestoredWorkspaceTab[],
  missing: string[],
): void {
  state.tabs = restoredTabs.map((restored) => restored.tab);
  reindexWorkspaceTabs(state);
  const activeTab = workspace.activeSessionId
    ? restoredTabs.find((restored) => restored.item.sessionId === workspace.activeSessionId)?.tab
    : undefined;
  activateTab(state, activeTab?.sessionId ?? state.tabs[0]?.sessionId ?? "config");
  clampHomeSelectedTabIndex(state);
  state.workspaceOverlay.restoredCount = restoredTabs.length;
  state.workspaceOverlay.skippedMissing = missing;
}

function findOpenWorkspaceTab(
  state: MixCodeState,
  runtime: WorkspaceRuntime | undefined,
  item: WorkspaceTabSnapshot,
): MixCodeTabInfo | undefined {
  if (item.sessionPath && runtime?.getTab) {
    const byPath = state.tabs.find(
      (tab) => runtime.getTab?.(tab.sessionId)?.session?.getSessionFile?.() === item.sessionPath,
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
