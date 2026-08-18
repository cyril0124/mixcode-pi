import { matchesKey } from "@earendil-works/pi-tui";
import { deleteWorkspace, saveWorkspaces } from "../core/state-store.js";
import type { ToastType } from "../core/toast.js";
import { getActiveTab } from "../core/tabs.js";
import type { MixCodeState, WorkspaceSnapshot } from "../core/types.js";
import { createWorkspaceOverlayState } from "../core/defaults.js";
import { snapshotWorkspace, upsertWorkspace } from "../core/workspace.js";
import {
  closeAppOverlay,
  errorMessage,
  showLinesOverlay,
  showNoticeTextOverlay,
} from "./app-overlays.js";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { renderWorkspaceOverlay } from "./workspace-rendering.js";
import { restoreWorkspace } from "./workspace-restore.js";
import {
  clampWorkspaceSelection,
  compareWorkspaceUpdatedDesc,
  filteredWorkspaces,
  formatWorkspaceDate,
  loadOptionalWorkspaces,
  moveWorkspaceSelection,
  selectedWorkspace,
  type WorkspaceSelectorMode,
  workspaceItems,
  workspaceTabCount,
} from "./workspace-shared.js";
import { pushToast } from "../core/toast.js";

export { renderWorkspaceOverlay } from "./workspace-rendering.js";

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

export async function openSaveWorkspaceOverlay(
  state: MixCodeState,
  tui: OverlayTui,
  workspaceFile: string,
): Promise<void> {
  state.workspaceOverlay = {
    ...createWorkspaceOverlayState(),
    open: true,
    mode: "save",
    workspaces: await loadOptionalWorkspaces(workspaceFile),
    workdir: state.workdir,
  };
  showWorkspaceOverlay(state, tui);
}

export async function openWorkspaceSelector(
  state: MixCodeState,
  tui: OverlayTui,
  workspaceFile: string,
  mode: WorkspaceSelectorMode,
): Promise<void> {
  state.workspaceOverlay = {
    ...createWorkspaceOverlayState(),
    open: true,
    mode,
    workspaces: (await loadOptionalWorkspaces(workspaceFile)).sort(compareWorkspaceUpdatedDesc),
    workdir: state.workdir,
  };
  showWorkspaceOverlay(state, tui);
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
  if (!workspace) throw new Error(`Unknown workspace: ${name}`);
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

export function handleWorkspaceOverlayKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  workspaceFile: string | undefined,
): boolean {
  const overlay = state.workspaceOverlay;
  if (!overlay.open) return false;
  if (!workspaceFile) {
    showNoticeTextOverlay(tui, "Workspace file is not configured");
    return true;
  }
  if (handleWorkspaceCancelKey(state, data, tui)) return true;
  if (overlay.mode === "save")
    return handleSaveKey(state, data, tui, runtime, workspaceFile, onStateChanged);
  if (overlay.mode === "save-confirm-overwrite")
    return handleSaveOverwriteKey(state, data, tui, runtime, workspaceFile, onStateChanged);
  if (overlay.mode === "restore" || overlay.mode === "delete")
    return handleWorkspaceListKey(state, data, tui, runtime, workspaceFile, onStateChanged);
  if (overlay.mode === "restore-confirm-close")
    return handleRestoreConfirmKey(state, data, tui, runtime, onStateChanged);
  if (overlay.mode === "delete-confirm")
    return handleDeleteConfirmKey(state, data, tui, workspaceFile, onStateChanged);
  return true;
}

const WORKSPACE_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "center",
  width: "82%",
  maxHeight: "95%",
  margin: 1,
};

export function showWorkspaceOverlay(state: MixCodeState, tui: OverlayTui): void {
  showLinesOverlay(tui, (width) => renderWorkspaceOverlay(state, width), WORKSPACE_OVERLAY_OPTIONS);
  tui.requestRender();
}

export function closeWorkspaceOverlay(state: MixCodeState, tui: OverlayTui): void {
  state.workspaceOverlay = createWorkspaceOverlayState();
  closeAppOverlay(tui);
  tui.requestRender();
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

function handleWorkspaceCancelKey(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  const overlay = state.workspaceOverlay;
  const inConfirmMode =
    overlay.mode === "save-confirm-overwrite" ||
    overlay.mode === "delete-confirm" ||
    overlay.mode === "restore-confirm-close";
  const cancelConfirm = inConfirmMode && (data === "n" || data === "N");
  if (!matchesKey(data, "escape") && !cancelConfirm) return false;
  if (overlay.mode === "save-confirm-overwrite") {
    overlay.mode = "save";
    overlay.pendingName = undefined;
    showWorkspaceOverlay(state, tui);
    return true;
  }
  if (overlay.mode === "delete-confirm") {
    overlay.mode = "delete";
    overlay.pendingWorkspace = undefined;
    showWorkspaceOverlay(state, tui);
    return true;
  }
  if (overlay.mode === "restore-confirm-close") {
    overlay.mode = "restore";
    overlay.pendingWorkspace = undefined;
    showWorkspaceOverlay(state, tui);
    return true;
  }
  closeWorkspaceOverlay(state, tui);
  return true;
}

function handleSaveKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: Pick<MixCodeKeyRuntime, "getTab"> | undefined,
  workspaceFile: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const overlay = state.workspaceOverlay;
  if (matchesKey(data, "enter")) {
    const name = overlay.input.trim();
    if (!name) {
      overlay.message = "Enter a workspace name";
      showWorkspaceOverlay(state, tui);
      return true;
    }
    if (overlay.workspaces.some((workspace) => workspace.name === name)) {
      overlay.mode = "save-confirm-overwrite";
      overlay.pendingName = name;
      showWorkspaceOverlay(state, tui);
      return true;
    }
    void saveAndClose(state, runtime, tui, workspaceFile, name, onStateChanged);
    return true;
  }
  if (matchesKey(data, "ctrl+u")) overlay.input = "";
  else if (data === "\u007f") overlay.input = overlay.input.slice(0, -1);
  else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) overlay.input += data;
  else return true;
  overlay.message = "";
  showWorkspaceOverlay(state, tui);
  return true;
}

function handleSaveOverwriteKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: Pick<MixCodeKeyRuntime, "getTab"> | undefined,
  workspaceFile: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return true;
  const name = state.workspaceOverlay.pendingName;
  if (!name) return true;
  void saveAndClose(state, runtime, tui, workspaceFile, name, onStateChanged);
  return true;
}

function handleWorkspaceListKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  _workspaceFile: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const overlay = state.workspaceOverlay;
  if (matchesKey(data, "down") || matchesKey(data, "tab")) {
    moveWorkspaceSelection(overlay, 1);
    showWorkspaceOverlay(state, tui);
    return true;
  }
  if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
    moveWorkspaceSelection(overlay, -1);
    showWorkspaceOverlay(state, tui);
    return true;
  }
  if (handleWorkspaceQueryKey(state, data, tui)) return true;
  if (!matchesKey(data, "enter")) return true;
  const workspace = selectedWorkspace(overlay);
  if (!workspace) return true;
  if (overlay.mode === "delete") return startDeleteConfirmation(state, tui, workspace);
  const extraTabCount = countExtraTabs(state, runtime, workspace);
  if (extraTabCount > 0) return startRestoreConfirmation(state, tui, workspace, extraTabCount);
  void restoreWorkspace(
    state,
    runtime,
    tui,
    workspace,
    onStateChanged,
  ).catch((error: unknown) => showNoticeTextOverlay(tui, errorMessage(error)));
  return true;
}

function handleWorkspaceQueryKey(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  const overlay = state.workspaceOverlay;
  if (data === "\u007f") overlay.query = overlay.query.slice(0, -1);
  else if (matchesKey(data, "ctrl+u")) {
    overlay.query = "";
    overlay.selectedIndex = 0;
  } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) overlay.query += data;
  else return false;
  clampWorkspaceSelection(overlay);
  showWorkspaceOverlay(state, tui);
  return true;
}

function startDeleteConfirmation(
  state: MixCodeState,
  tui: OverlayTui,
  workspace: WorkspaceSnapshot,
): boolean {
  state.workspaceOverlay.mode = "delete-confirm";
  state.workspaceOverlay.pendingWorkspace = workspace;
  showWorkspaceOverlay(state, tui);
  return true;
}

function startRestoreConfirmation(
  state: MixCodeState,
  tui: OverlayTui,
  workspace: WorkspaceSnapshot,
  extraTabCount: number,
): boolean {
  state.workspaceOverlay.mode = "restore-confirm-close";
  state.workspaceOverlay.pendingWorkspace = workspace;
  state.workspaceOverlay.extraTabCount = extraTabCount;
  showWorkspaceOverlay(state, tui);
  return true;
}

function handleRestoreConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return true;
  const workspace = state.workspaceOverlay.pendingWorkspace;
  if (!workspace) return true;
  void restoreWorkspace(
    state,
    runtime,
    tui,
    workspace,
    onStateChanged,
  ).catch((error: unknown) => showNoticeTextOverlay(tui, errorMessage(error)));
  return true;
}

function handleDeleteConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  workspaceFile: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return true;
  const workspace = state.workspaceOverlay.pendingWorkspace;
  if (!workspace) return true;
  void (async () => {
    await deleteWorkspaceByName(state, tui, workspaceFile, workspace.name);
    closeWorkspaceOverlay(state, tui);
    await onStateChanged?.(state);
    tui.requestRender();
  })().catch((error: unknown) => showNoticeTextOverlay(tui, errorMessage(error)));
  return true;
}

async function saveAndClose(
  state: MixCodeState,
  runtime: Pick<MixCodeKeyRuntime, "getTab"> | undefined,
  tui: OverlayTui,
  workspaceFile: string,
  name: string,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  await saveWorkspaceByName(state, runtime, tui, workspaceFile, name);
  closeWorkspaceOverlay(state, tui);
  await onStateChanged?.(state);
  tui.requestRender();
}

function countExtraTabs(
  state: MixCodeState,
  runtime: Pick<MixCodeKeyRuntime, "getTab"> | undefined,
  workspace: WorkspaceSnapshot,
): number {
  const items = workspaceItems(workspace);
  return state.tabs.filter(
    (tab) =>
      !items.some(
        (item) =>
          item.sessionId === tab.sessionId ||
          (item.sessionPath && runtime?.getTab?.(tab.sessionId)?.session?.getSessionFile?.() === item.sessionPath),
      ),
  ).length;
}
