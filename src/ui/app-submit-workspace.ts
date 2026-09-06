import * as path from "node:path";
import type { LocalCommand } from "../core/commands.js";
import { assertConfiguredOpenTabsReadable } from "../core/open-tabs-store.js";
import { createPicker } from "../core/pickers.js";
import { pushToast } from "../core/toast.js";
import { appendActiveSystemMessage, applyWorkdirSelection } from "./app-actions.js";
import { syncOwnedAppOverlay } from "./app-overlays.js";
import { HOME_TAB_ID } from "../core/types.js";
import { type LocalCommandHandler, SKIP_FINALIZE } from "./app-types.js";
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
    syncOwnedAppOverlay(state, tui);
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

const handleImport: LocalCommandHandler = async ({ active, args, runtime }) => {
  assertConfiguredOpenTabsReadable();
  const request = parseImportRequest(args);
  const importPath = resolveAgainstWorkdir(active!.workdir, request.path);
  await runtime.previewSessionImport(importPath, request.cwdOverride, active!.workdir);
  const result = await runtime.importFromJsonl(active!.sessionId, importPath, request.cwdOverride);
  if (result.cancelled) {
    pushToast(active!, { type: "warning", message: "Import cancelled." });
  } else {
    pushToast(active!, { type: "success", message: `Imported session: ${importPath}` });
  }
  return undefined;
};

function resolveAgainstWorkdir(workdir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workdir, filePath);
}

function resolveExportOutputPath(
  workdir: string,
  outputPath: string | undefined,
  sessionFile: string | undefined,
): string {
  if (outputPath) return resolveAgainstWorkdir(workdir, outputPath);
  const name = sessionFile
    ? `pi-session-${path.basename(sessionFile, path.extname(sessionFile))}.html`
    : "pi-session.html";
  return path.join(workdir, name);
}

const handleExport: LocalCommandHandler = async ({ state, active, args, runtime }) => {
  // Pi handleExportCommand: .jsonl path -> exportToJsonl, else HTML.
  if (state.activeTabId === HOME_TAB_ID) return SKIP_FINALIZE;
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const outputPath = resolveExportOutputPath(
    active!.workdir,
    args.trim() || undefined,
    runtimeTab.agentSession.sessionFile,
  );
  try {
    const filePath = outputPath.endsWith(".jsonl")
      ? runtimeTab.agentSession.exportToJsonl(outputPath)
      : // MixCode themes are in-memory and have no sourcePath; Pi HTML export
        // throws on those names. Use Pi's builtin dark JSON instead.
        await runtimeTab.agentSession.exportToHtml(outputPath, { themeName: "dark" });
    appendActiveSystemMessage(state, runtime, `Session exported to: ${filePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.startsWith("Error:") ? message : `Error: Failed to export session: ${message}`,
    );
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
  const filePath = parts[0];
  if (!filePath) throw new Error("Error: Usage: /import <path> [cwd]");
  return { path: filePath, cwdOverride: parts[1] };
}
