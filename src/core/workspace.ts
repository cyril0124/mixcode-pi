import { getActiveTab } from "./tabs.js";
import type { MixCodeState, WorkspaceSnapshot, WorkspaceTabSnapshot } from "./types.js";

export interface WorkspaceRuntimeSnapshotSource {
  getTab?: (
    sessionId: string,
  ) => { session?: { getSessionFile?: () => string | null | undefined } } | undefined;
}

export function snapshotWorkspace(
  state: MixCodeState,
  name: string,
  now = new Date(),
  runtime?: WorkspaceRuntimeSnapshotSource,
): WorkspaceSnapshot {
  return {
    name,
    startupWorkdir: state.workdir,
    updatedAt: now.toISOString(),
    // Home (config) should record the selected agent row, not always tabs[0].
    activeSessionId: getActiveTab(state)?.sessionId,
    tabs: state.tabs.map((tab): WorkspaceTabSnapshot => {
      const sessionPath =
        runtime?.getTab?.(tab.sessionId)?.session?.getSessionFile?.() ?? undefined;
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

export function reindexWorkspaceTabs(state: MixCodeState): void {
  state.tabs.forEach((tab, index) => {
    tab.index = index + 1;
  });
}
