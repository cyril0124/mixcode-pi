import type { LocalCommand } from "../core/commands.js";
import { assertConfiguredOpenTabsReadable, noteTabReplaced } from "../core/open-tabs-store.js";
import { createPicker } from "../core/pickers.js";
import { activateTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import { applyWorkdirSelection } from "./app-actions.js";
import { showLinesOverlay } from "./app-overlays.js";
import { HOME_TAB_ID } from "../core/types.js";
import { type LocalCommandHandler, type MixCodeSubmitRuntime, SKIP_FINALIZE } from "./app-types.js";
import { renderPickerOverlay } from "./rendering.js";
import { openSaveWorkspaceOverlay, openWorkspaceSelector } from "./components/workspace-overlay.js";
import {
  deleteWorkspaceByName,
  restoreWorkspaceByName,
  saveWorkspaceByName,
} from "./workspace-actions.js";

const handleWorkdir: LocalCommandHandler = async ({
  state,
  active,
  args,
  runtime,
  tui,
  onStateChanged,
}) => {
  if (!args.trim()) {
    state.picker = createPicker("workdir", state, active);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    await onStateChanged?.(state);
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  await applyWorkdirSelection(active!, args.trim(), runtime);
};

const handleSaveWorkspace: LocalCommandHandler = async ({
  state,
  args,
  runtime,
  tui,
  onStateChanged,
  workspaceFile,
}) => {
  if (!workspaceFile) throw new Error("Workspace file is not configured");
  const name = args.trim();
  if (!name) {
    await openSaveWorkspaceOverlay(state, tui, workspaceFile, runtime, onStateChanged);
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await saveWorkspaceByName(state, runtime, tui, workspaceFile, name);
};

const handleRestoreWorkspace: LocalCommandHandler = async ({
  state,
  args,
  runtime,
  tui,
  onStateChanged,
  workspaceFile,
}) => {
  if (!workspaceFile) throw new Error("Workspace file is not configured");
  const name = args.trim();
  if (!name) {
    await openWorkspaceSelector(state, tui, workspaceFile, "restore", runtime, onStateChanged);
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await restoreWorkspaceByName(state, runtime, tui, workspaceFile, name, onStateChanged);
};

const handleDeleteWorkspace: LocalCommandHandler = async ({
  state,
  args,
  runtime,
  tui,
  onStateChanged,
  workspaceFile,
}) => {
  if (!workspaceFile) throw new Error("Workspace file is not configured");
  const name = args.trim();
  if (!name) {
    await openWorkspaceSelector(state, tui, workspaceFile, "delete", runtime, onStateChanged);
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await deleteWorkspaceByName(state, tui, workspaceFile, name);
};

const handleImport: LocalCommandHandler = async ({ state, active, args, runtime }) => {
  assertConfiguredOpenTabsReadable();
  const request = parseImportRequest(args);
  const oldSessionId = active!.sessionId;
  const { sessionId: targetSessionId } = await runtime.previewSessionImport(
    request.path,
    request.cwdOverride,
    active!.workdir,
  );
  const identityChanged = targetSessionId !== oldSessionId;
  const publishIdentity = (from: string, to: string) => {
    noteTabReplaced(from, to);
    active!.sessionId = to;
    activateTab(state, to);
  };
  const rollbackIdentity = (...originalErrors: [] | [unknown]) => {
    let publicationFailed = false;
    let publicationError: unknown;
    try {
      noteTabReplaced(targetSessionId, oldSessionId);
    } catch (rollbackError) {
      publicationFailed = true;
      publicationError = rollbackError;
    }
    active!.sessionId = oldSessionId;
    activateTab(state, oldSessionId);
    if (publicationFailed) {
      throw new AggregateError(
        [...originalErrors, publicationError],
        "Import failed and open_tabs rollback also failed",
      );
    }
  };
  if (identityChanged) publishIdentity(oldSessionId, targetSessionId);
  let result: Awaited<ReturnType<MixCodeSubmitRuntime["importFromJsonl"]>>;
  try {
    result = await runtime.importFromJsonl(oldSessionId, request.path, request.cwdOverride);
  } catch (error) {
    if (identityChanged) rollbackIdentity(error);
    throw error;
  }
  if (result.cancelled) {
    if (identityChanged) rollbackIdentity();
    pushToast(active!, { type: "warning", message: "Import cancelled." });
  } else {
    pushToast(active!, { type: "success", message: `Imported session: ${request.path}` });
  }
  return undefined;
};

const handleExport: LocalCommandHandler = async ({ state, active, args, runtime }) => {
  // Pi handleExportCommand: .jsonl path -> exportToJsonl, else HTML.
  if (state.activeTabId === HOME_TAB_ID) return SKIP_FINALIZE;
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const outputPath = args.trim() || undefined;
  try {
    const filePath =
      outputPath?.endsWith(".jsonl") === true
        ? runtimeTab.agentSession.exportToJsonl(outputPath)
        : await runtimeTab.agentSession.exportToHtml(outputPath);
    pushToast(active!, { type: "success", message: `Session exported to: ${filePath}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushToast(active!, { type: "error", message: `Error: Failed to export session: ${message}` });
  }
};

export const WORKSPACE_COMMAND_HANDLERS = {
  workdir: handleWorkdir,
  "save-workspace": handleSaveWorkspace,
  "restore-workspace": handleRestoreWorkspace,
  "delete-workspace": handleDeleteWorkspace,
  import: handleImport,
  export: handleExport,
} satisfies Partial<Record<LocalCommand, LocalCommandHandler>>;

function parseImportRequest(args: string): { path: string; cwdOverride?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const path = parts[0];
  if (!path) throw new Error("Missing import JSONL path");
  return { path, cwdOverride: parts[1] };
}
