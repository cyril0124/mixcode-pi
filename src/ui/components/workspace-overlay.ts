/**
 * Workspace overlay: save / restore / delete workspaces with confirmation and
 * restore-progress modes. Upstream pi component style: the mode state machine
 * lives in this class, input arrives via TUI focus, and the app keeps only the
 * routing flag (state.workspaceOverlay.open).
 *
 * The restore engine (workspace-restore.ts) drives the "restoring"/"missing"
 * modes by mutating this component through the WorkspaceOverlayView interface.
 */

import { matchesKey, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import type { MixCodeState, WorkspaceSnapshot } from "../../core/types.js";
import {
  closeAppOverlay,
  errorMessage,
  showComponentOverlay,
  showNoticeTextOverlay,
} from "../app-overlays.js";
import type { OverlayTui } from "../app-types.js";
import { renderWorkspaceOverlay } from "../workspace-rendering.js";
import { restoreWorkspace } from "../workspace-restore.js";
import { deleteWorkspaceByName, saveWorkspaceByName } from "../workspace-actions.js";
import {
  clampWorkspaceSelection,
  compareWorkspaceUpdatedDesc,
  loadOptionalWorkspaces,
  moveWorkspaceSelection,
  selectedWorkspace,
  type WorkspaceOverlayMode,
  type WorkspaceOverlayView,
  type WorkspaceRuntime,
  type WorkspaceSelectorMode,
} from "../workspace-shared.js";

export interface WorkspaceOverlayDeps {
  /** Read-only render source (tabs, theme, workdir) and toast target. */
  state: MixCodeState;
  tui: OverlayTui;
  workspaceFile: string;
  runtime?: WorkspaceRuntime;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
}

const WORKSPACE_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "center",
  width: "82%",
  maxHeight: "95%",
  margin: 1,
};

export class WorkspaceOverlay implements Component, WorkspaceOverlayView {
  mode: WorkspaceOverlayMode;
  query = "";
  selectedIndex = 0;
  workspaces: WorkspaceSnapshot[];
  workdir: string;
  message = "";
  input = "";
  pendingName?: string;
  pendingWorkspace?: WorkspaceSnapshot;
  extraTabCount = 0;
  restoredCount = 0;
  skippedMissing: string[] = [];
  progressCurrent = 0;
  progressTotal = 0;

  constructor(
    private readonly deps: WorkspaceOverlayDeps,
    init: { mode: WorkspaceOverlayMode; workspaces?: WorkspaceSnapshot[] },
  ) {
    this.mode = init.mode;
    this.workspaces = init.workspaces ?? [];
    this.workdir = deps.state.workdir;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderWorkspaceOverlay(this, this.deps.state, width);
  }

  handleInput(data: string): void {
    if (this.handleCancelKey(data)) return;
    if (this.mode === "save") this.handleSaveKey(data);
    else if (this.mode === "save-confirm-overwrite") this.handleSaveOverwriteKey(data);
    else if (this.mode === "restore" || this.mode === "delete") this.handleListKey(data);
    else if (this.mode === "restore-confirm-close") this.handleRestoreConfirmKey(data);
    else if (this.mode === "delete-confirm") this.handleDeleteConfirmKey(data);
    // "restoring" swallows keys; "missing" closes via Esc in handleCancelKey.
  }

  /** Esc steps confirm modes back to their parent mode; otherwise closes. */
  private handleCancelKey(data: string): boolean {
    const inConfirmMode =
      this.mode === "save-confirm-overwrite" ||
      this.mode === "delete-confirm" ||
      this.mode === "restore-confirm-close";
    const cancelConfirm = inConfirmMode && (data === "n" || data === "N");
    if (!matchesKey(data, "escape") && !cancelConfirm) return false;
    if (this.mode === "restoring") return true; // not cancellable mid-restore
    if (this.mode === "save-confirm-overwrite") {
      this.mode = "save";
      this.pendingName = undefined;
    } else if (this.mode === "delete-confirm") {
      this.mode = "delete";
      this.pendingWorkspace = undefined;
    } else if (this.mode === "restore-confirm-close") {
      this.mode = "restore";
      this.pendingWorkspace = undefined;
    } else {
      closeWorkspaceOverlay(this.deps.state, this.deps.tui);
      return true;
    }
    this.deps.tui.requestRender();
    return true;
  }

  private handleSaveKey(data: string): void {
    if (matchesKey(data, "enter")) {
      const name = this.input.trim();
      if (!name) {
        this.message = "Enter a workspace name";
        this.deps.tui.requestRender();
        return;
      }
      if (this.workspaces.some((workspace) => workspace.name === name)) {
        this.mode = "save-confirm-overwrite";
        this.pendingName = name;
        this.deps.tui.requestRender();
        return;
      }
      void this.saveAndClose(name);
      return;
    }
    if (matchesKey(data, "ctrl+u")) this.input = "";
    else if (data === "\u007f") this.input = this.input.slice(0, -1);
    else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) this.input += data;
    else return;
    this.message = "";
    this.deps.tui.requestRender();
  }

  private handleSaveOverwriteKey(data: string): void {
    if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return;
    const name = this.pendingName;
    if (!name) return;
    void this.saveAndClose(name);
  }

  private handleListKey(data: string): void {
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      moveWorkspaceSelection(this, 1);
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      moveWorkspaceSelection(this, -1);
      this.deps.tui.requestRender();
      return;
    }
    if (this.handleQueryKey(data)) return;
    if (!matchesKey(data, "enter")) return;
    const workspace = selectedWorkspace(this);
    if (!workspace) return;
    if (this.mode === "delete") {
      this.mode = "delete-confirm";
      this.pendingWorkspace = workspace;
      this.deps.tui.requestRender();
      return;
    }
    const extraTabCount = this.countExtraTabs(workspace);
    if (extraTabCount > 0) {
      this.mode = "restore-confirm-close";
      this.pendingWorkspace = workspace;
      this.extraTabCount = extraTabCount;
      this.deps.tui.requestRender();
      return;
    }
    this.startRestore(workspace);
  }

  private handleQueryKey(data: string): boolean {
    if (data === "\u007f") this.query = this.query.slice(0, -1);
    else if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.selectedIndex = 0;
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) this.query += data;
    else return false;
    clampWorkspaceSelection(this);
    this.deps.tui.requestRender();
    return true;
  }

  private handleRestoreConfirmKey(data: string): void {
    if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return;
    const workspace = this.pendingWorkspace;
    if (!workspace) return;
    this.startRestore(workspace);
  }

  private handleDeleteConfirmKey(data: string): void {
    if (!matchesKey(data, "enter") && data !== "y" && data !== "Y") return;
    const workspace = this.pendingWorkspace;
    if (!workspace) return;
    const { state, tui, workspaceFile, onStateChanged } = this.deps;
    void (async () => {
      await deleteWorkspaceByName(state, tui, workspaceFile, workspace.name);
      closeWorkspaceOverlay(state, tui);
      await onStateChanged?.(state);
      tui.requestRender();
    })().catch((error: unknown) => showNoticeTextOverlay(tui, errorMessage(error)));
  }

  private startRestore(workspace: WorkspaceSnapshot): void {
    const { state, tui, runtime, onStateChanged } = this.deps;
    void restoreWorkspace(state, runtime, tui, workspace, onStateChanged, this).catch(
      (error: unknown) => showNoticeTextOverlay(tui, errorMessage(error)),
    );
  }

  private async saveAndClose(name: string): Promise<void> {
    const { state, tui, runtime, workspaceFile, onStateChanged } = this.deps;
    try {
      await saveWorkspaceByName(state, runtime, tui, workspaceFile, name);
      closeWorkspaceOverlay(state, tui);
      await onStateChanged?.(state);
      tui.requestRender();
    } catch (error) {
      showNoticeTextOverlay(tui, errorMessage(error));
    }
  }

  private countExtraTabs(workspace: WorkspaceSnapshot): number {
    const { state, runtime } = this.deps;
    return state.tabs.filter(
      (tab) =>
        !workspace.tabs.some(
          (item) =>
            item.sessionId === tab.sessionId ||
            (item.sessionPath &&
              runtime?.getTab?.(tab.sessionId)?.session?.getSessionFile?.() === item.sessionPath),
        ),
    ).length;
  }
}

/** Show the overlay component and flip the routing flag. */
export function presentWorkspaceOverlay(
  state: MixCodeState,
  tui: OverlayTui,
  overlay: WorkspaceOverlay,
): void {
  state.workspaceOverlay.open = true;
  showComponentOverlay(tui, overlay, WORKSPACE_OVERLAY_OPTIONS);
  tui.requestRender();
}

export function closeWorkspaceOverlay(state: MixCodeState, tui: OverlayTui): void {
  state.workspaceOverlay.open = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

export async function openSaveWorkspaceOverlay(
  state: MixCodeState,
  tui: OverlayTui,
  workspaceFile: string,
  runtime?: WorkspaceRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  const overlay = new WorkspaceOverlay(
    { state, tui, workspaceFile, runtime, onStateChanged },
    { mode: "save", workspaces: await loadOptionalWorkspaces(workspaceFile) },
  );
  presentWorkspaceOverlay(state, tui, overlay);
}

export async function openWorkspaceSelector(
  state: MixCodeState,
  tui: OverlayTui,
  workspaceFile: string,
  mode: WorkspaceSelectorMode,
  runtime?: WorkspaceRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): Promise<void> {
  const overlay = new WorkspaceOverlay(
    { state, tui, workspaceFile, runtime, onStateChanged },
    {
      mode,
      workspaces: (await loadOptionalWorkspaces(workspaceFile)).sort(compareWorkspaceUpdatedDesc),
    },
  );
  presentWorkspaceOverlay(state, tui, overlay);
}

/**
 * Present a bare progress overlay for command-path restores
 * (/restore-workspace NAME) where no selector was open.
 */
export function presentWorkspaceRestoreProgress(
  state: MixCodeState,
  tui: OverlayTui,
  runtime: WorkspaceRuntime | undefined,
): WorkspaceOverlay {
  const overlay = new WorkspaceOverlay(
    { state, tui, workspaceFile: "", runtime },
    { mode: "restoring" },
  );
  presentWorkspaceOverlay(state, tui, overlay);
  return overlay;
}
