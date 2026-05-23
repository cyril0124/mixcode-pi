import type { WorkspaceSnapshot } from "./types.js";

export type WorkspaceOverlayMode =
  | "save"
  | "save-confirm-overwrite"
  | "restore"
  | "restore-confirm-close"
  | "restoring"
  | "delete"
  | "delete-confirm"
  | "missing";

export interface WorkspaceOverlayState {
  open: boolean;
  mode: WorkspaceOverlayMode;
  query: string;
  selectedIndex: number;
  workspaces: WorkspaceSnapshot[];
  workdir: string;
  message: string;
  input: string;
  pendingName?: string;
  pendingWorkspace?: WorkspaceSnapshot;
  extraTabCount: number;
  restoredCount: number;
  skippedMissing: string[];
  progressCurrent: number;
  progressTotal: number;
}

export function createWorkspaceOverlayState(): WorkspaceOverlayState {
  return {
    open: false,
    mode: "restore",
    query: "",
    selectedIndex: 0,
    workspaces: [],
    workdir: "",
    message: "",
    input: "",
    pendingName: undefined,
    pendingWorkspace: undefined,
    extraTabCount: 0,
    restoredCount: 0,
    skippedMissing: [],
    progressCurrent: 0,
    progressTotal: 0,
  };
}
