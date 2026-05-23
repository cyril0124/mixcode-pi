import { clampHomeSelectedTabIndex } from "./tabs.js";
import type { MixCodeState, WorkspaceSnapshot, WorkspaceTabSnapshot } from "./types.js";

export const AUTO_SAVED_WORKSPACE = "[auto-saved]";

export interface WorkspaceRuntimeSnapshotSource {
  getTab?: (sessionId: string) => { session?: { getSessionFile?: () => string | null | undefined } } | undefined;
}

export function snapshotWorkspace(
  state: MixCodeState,
  name: string,
  now = new Date(),
  runtime?: WorkspaceRuntimeSnapshotSource,
): WorkspaceSnapshot {
  return {
    name,
    children: state.tabs.map((tab) => tab.sessionId),
    startupWorkdir: state.workdir,
    updatedAt: now.toISOString(),
    activeSessionId: state.activeTabId === "config" ? state.tabs[0]?.sessionId : state.activeTabId,
    tabs: state.tabs.map((tab): WorkspaceTabSnapshot => {
      const sessionPath = runtime?.getTab?.(tab.sessionId)?.session?.getSessionFile?.() ?? undefined;
      return {
        sessionId: tab.sessionId,
        sessionPath: sessionPath || undefined,
        title: tab.title,
        workdir: tab.workdir,
        model: { ...tab.model },
        thinkingLevel: tab.thinkingLevel,
      };
    }),
  };
}

export function upsertWorkspace(
  workspaces: WorkspaceSnapshot[],
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshot[] {
  const next = workspaces.filter((workspace) => workspace.name !== snapshot.name);
  next.push(snapshot);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

export function autoSaveWorkspace(
  state: MixCodeState,
  workspaces: WorkspaceSnapshot[],
  now = new Date(),
): WorkspaceSnapshot[] {
  return upsertWorkspace(workspaces, snapshotWorkspace(state, AUTO_SAVED_WORKSPACE, now));
}

export function restoreWorkspaceOrder(state: MixCodeState, workspace: WorkspaceSnapshot): void {
  const originalTabIds = workspace.tabs?.map((tab) => tab.sessionId) ?? [];
  const tabIds = originalTabIds.filter((id) => workspace.children.includes(id));
  const orderedIds =
    tabIds.length > 0 && sameWorkspaceOrder(workspace.children, tabIds) ? tabIds : workspace.children;
  const tabById = new Map(state.tabs.map((tab) => [tab.sessionId, tab]));
  state.tabs = orderedIds.flatMap((sessionId) => {
    const tab = tabById.get(sessionId);
    return tab ? [tab] : [];
  });
  reindexWorkspaceTabs(state);
  const preferredActive =
    workspace.children.length === originalTabIds.length ? workspace.activeSessionId : undefined;
  state.activeTabId =
    (preferredActive && state.tabs.some((tab) => tab.sessionId === preferredActive)
      ? preferredActive
      : state.tabs[0]?.sessionId) ?? "config";
  clampHomeSelectedTabIndex(state);
}

export function reindexWorkspaceTabs(state: MixCodeState): void {
  state.tabs.forEach((tab, index) => {
    tab.index = index + 1;
  });
}

function sameWorkspaceOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
