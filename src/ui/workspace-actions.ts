/**
 * Workspace command actions shared by slash commands (/save-workspace NAME,
 * /restore-workspace NAME, /delete-workspace NAME) and the workspace overlay
 * component. Pure persistence + feedback; no overlay UI state lives here.
 */

import { deleteWorkspace, saveWorkspaces } from "../core/state-store.js";
import { getActiveTab } from "../core/tabs.js";
import { pushToast, type ToastType } from "../core/toast.js";
import type { MixCodeState } from "../core/types.js";
import { snapshotWorkspace, upsertWorkspace } from "../core/workspace.js";
import { showNoticeTextOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { restoreWorkspace } from "./workspace-restore.js";
import {
  compareWorkspaceUpdatedDesc,
  formatWorkspaceDate,
  loadOptionalWorkspaces,
  workspaceTabCount,
} from "./workspace-shared.js";

export async function workspaceNameCompletions(
  workspaceFile: string | undefined,
  prefix: string,
): Promise<Array<{ value: string; label: string; description?: string }>> {
  if (!workspaceFile) return [];
  const workspaces = await loadOptionalWorkspaces(workspaceFile);
  const normalized = prefix.trim().toLowerCase();
  return workspaces
    .filter((workspace) => !normalized || workspace.name.toLowerCase().includes(normalized))
    .sort(compareWorkspaceUpdatedDesc)
    .map((workspace) => ({
      value: workspace.name,
      label: workspace.name,
      description: `${workspaceTabCount(workspace)} tabs · ${formatWorkspaceDate(workspace.updatedAt)}`,
    }));
}

export async function saveWorkspaceByName(
  state: MixCodeState,
  runtime: Pick<MixCodeKeyRuntime, "getTab"> | undefined,
  tui: OverlayTui,
  workspaceFile: string,
  name: string,
): Promise<void> {
  const existing = await loadOptionalWorkspaces(workspaceFile);
  const existed = existing.some((workspace) => workspace.name === name);
  await saveWorkspaces(
    workspaceFile,
    upsertWorkspace(existing, snapshotWorkspace(state, name, new Date(), runtime)),
  );
  showWorkspaceToast(state, tui, `Workspace ${existed ? "updated" : "saved"}: ${name}`, "success");
}

export async function restoreWorkspaceByName(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime | undefined,
  tui: OverlayTui,
  workspaceFile: string,
  name: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  const workspace = (await loadOptionalWorkspaces(workspaceFile)).find((item) => item.name === name);
  if (!workspace) throw new Error(`Error: Unknown workspace: ${name}`);
  await restoreWorkspace(state, runtime, tui, workspace, onStateChanged);
}

export async function deleteWorkspaceByName(
  state: MixCodeState,
  tui: OverlayTui,
  workspaceFile: string,
  name: string,
): Promise<void> {
  await deleteWorkspace(workspaceFile, name);
  showWorkspaceToast(state, tui, `Workspace deleted: ${name}`, "success");
}

export function showWorkspaceToast(
  state: MixCodeState,
  tui: OverlayTui,
  message: string,
  type: ToastType = "info",
): void {
  const active = getActiveTab(state);
  if (!active) {
    showNoticeTextOverlay(tui, message);
    return;
  }
  pushToast(active, { type, message });
}
