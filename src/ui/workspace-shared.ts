import { loadWorkspaces } from "../core/state-store.js";
import type { MixCodeState, WorkspaceSnapshot, WorkspaceTabSnapshot } from "../core/types.js";
import type { MixCodeKeyRuntime } from "./app-types.js";

export type WorkspaceSelectorMode = "restore" | "delete";

export interface WorkspaceRuntime
  extends Pick<
    MixCodeKeyRuntime,
    "createTab" | "closeTab" | "extensionSwitchSession" | "getTab" | "getPromptHistory"
  > {}

export function workspaceRuntimeWithHistory(
  runtime: MixCodeKeyRuntime | undefined,
): WorkspaceRuntime | undefined {
  return runtime;
}

export async function loadOptionalWorkspaces(workspaceFile: string): Promise<WorkspaceSnapshot[]> {
  try {
    return await loadWorkspaces(workspaceFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function compareWorkspaceUpdatedDesc(a: WorkspaceSnapshot, b: WorkspaceSnapshot): number {
  return dateValue(b.updatedAt) - dateValue(a.updatedAt) || a.name.localeCompare(b.name);
}

export function formatWorkspaceDate(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function workspaceItems(workspace: WorkspaceSnapshot): WorkspaceTabSnapshot[] {
  if (workspace.tabs.length) return workspace.tabs;
  return workspace.children.map((sessionId) => ({
    sessionId,
    title: sessionId,
    workdir: workspace.startupWorkdir,
  }));
}

export function workspaceTabCount(workspace: WorkspaceSnapshot | undefined): number {
  if (!workspace) return 0;
  return workspace.tabs.length || workspace.children.length;
}

export function selectedWorkspace(
  overlay: MixCodeState["workspaceOverlay"],
): WorkspaceSnapshot | undefined {
  return filteredWorkspaces(overlay)[overlay.selectedIndex];
}

export function filteredWorkspaces(overlay: MixCodeState["workspaceOverlay"]): WorkspaceSnapshot[] {
  const query = overlay.query.trim().toLowerCase();
  const workspaces = [...overlay.workspaces].sort(compareWorkspaceUpdatedDesc);
  if (!query) return workspaces;
  return workspaces.filter((workspace) => {
    if (workspace.name.toLowerCase().includes(query)) return true;
    return workspaceItems(workspace).some((item) => item.title.toLowerCase().includes(query));
  });
}

export function moveWorkspaceSelection(
  overlay: MixCodeState["workspaceOverlay"],
  delta: number,
): void {
  const count = filteredWorkspaces(overlay).length;
  if (count === 0) {
    overlay.selectedIndex = 0;
    return;
  }
  overlay.selectedIndex = (overlay.selectedIndex + delta + count) % count;
}

export function clampWorkspaceSelection(overlay: MixCodeState["workspaceOverlay"]): void {
  overlay.selectedIndex = Math.min(
    overlay.selectedIndex,
    Math.max(0, filteredWorkspaces(overlay).length - 1),
  );
}

export function dateValue(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}
