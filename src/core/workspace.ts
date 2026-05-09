import type { MixCodeState, WorkspaceSnapshot } from "./types.js";

export const AUTO_SAVED_WORKSPACE = "[auto-saved]";

export function snapshotWorkspace(
  state: MixCodeState,
  name: string,
  now = new Date(),
): WorkspaceSnapshot {
  return {
    name,
    children: state.tabs.map((tab) => tab.sessionId),
    startupWorkdir: state.workdir,
    updatedAt: now.toISOString(),
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
  const tabById = new Map(state.tabs.map((tab) => [tab.sessionId, tab]));
  state.tabs = workspace.children.flatMap((sessionId) => {
    const tab = tabById.get(sessionId);
    return tab ? [tab] : [];
  });
  state.tabs.forEach((tab, index) => {
    tab.index = index + 1;
  });
  state.activeTabId = state.tabs[0]?.sessionId ?? "config";
}
