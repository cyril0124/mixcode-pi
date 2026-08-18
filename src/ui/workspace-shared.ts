import { loadWorkspaces } from "../core/state-store.js";
import type { MixCodeState, WorkspaceSnapshot } from "../core/types.js";
import type { MixCodeRuntime } from "../agent/runtime.js";

export type WorkspaceSelectorMode = "restore" | "delete";

/** Narrow host surface for workspace restore/save (not a Partial kitchen sink). */
export type WorkspaceRuntime = Pick<
  MixCodeRuntime,
  "createTab" | "closeTab" | "extensionSwitchSession" | "getTab" | "getPromptHistory"
>;

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

export function workspaceTabCount(workspace: WorkspaceSnapshot | undefined): number {
  return workspace?.tabs.length ?? 0;
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
    return workspace.tabs.some((item) => item.title.toLowerCase().includes(query));
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
