import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MixCodeState, WorkspaceSnapshot } from "../core/types.js";
import { activeRenderTheme, overlayPanel, padLine, renderWithTheme } from "./rendering.js";
import { windowStart } from "./rendering/scroll-window.js";
import { themeForId } from "./themes.js";
import {
  filteredWorkspaces,
  formatWorkspaceDate,
  selectedWorkspace,
  type WorkspaceOverlayView,
  workspaceTabCount,
} from "./workspace-shared.js";

export function renderWorkspaceOverlay(
  overlay: WorkspaceOverlayView,
  state: MixCodeState,
  width: number,
): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderWorkspaceOverlayInner(overlay, state, width),
  );
}

function renderWorkspaceOverlayInner(
  overlay: WorkspaceOverlayView,
  state: MixCodeState,
  width: number,
): string[] {
  if (overlay.mode === "save") return renderSaveOverlay(overlay, state, width);
  if (overlay.mode === "save-confirm-overwrite")
    return renderSaveConfirmOverlay(overlay, state, width);
  if (overlay.mode === "restore-confirm-close") return renderRestoreConfirmOverlay(overlay, width);
  if (overlay.mode === "delete-confirm") return renderDeleteConfirmOverlay(overlay, width);
  if (overlay.mode === "restoring") return renderRestoringOverlay(overlay, width);
  if (overlay.mode === "missing") return renderMissingOverlay(overlay, width);
  return renderWorkspaceSelector(overlay, state, width);
}

function renderSaveOverlay(
  overlay: WorkspaceOverlayView,
  state: MixCodeState,
  width: number,
): string[] {
  const panelWidth = Math.max(60, width);
  const inputWidth = Math.max(20, Math.min(60, panelWidth - 6));
  const tabs = state.tabs.map((tab) => tab.title).join(", ") || "none";
  return overlayPanel(
    "Save Workspace",
    [
      activeRenderTheme.dim(overlay.workdir || state.workdir),
      "",
      "Name",
      ...renderNameInputLines(overlay.input, inputWidth),
      "",
      `Current layout: ${state.tabs.length} ${state.tabs.length === 1 ? "tab" : "tabs"}`,
      `tabs: ${tabs}`,
      overlay.message ? activeRenderTheme.warning(overlay.message) : "",
      "Enter save \u00b7 Esc cancel",
    ],
    panelWidth,
  );
}

function renderNameInputLines(value: string, width: number): string[] {
  const innerWidth = Math.max(4, width - 2);
  const visibleValue = truncateToWidth(value, Math.max(0, innerWidth - 1), "\u2026");
  const cursor = activeRenderTheme.selectedBg(" ");
  const content = padLine(`${visibleValue}${CURSOR_MARKER}${cursor}`, innerWidth);
  return [
    `${activeRenderTheme.border("\u250c")}${activeRenderTheme.border("\u2500".repeat(innerWidth))}${activeRenderTheme.border("\u2510")}`,
    `${activeRenderTheme.border("\u2502")}${content}${activeRenderTheme.border("\u2502")}`,
    `${activeRenderTheme.border("\u2514")}${activeRenderTheme.border("\u2500".repeat(innerWidth))}${activeRenderTheme.border("\u2518")}`,
  ];
}

function renderSaveConfirmOverlay(
  overlay: WorkspaceOverlayView,
  state: MixCodeState,
  width: number,
): string[] {
  const name = overlay.pendingName ?? overlay.input.trim();
  return overlayPanel(
    "Confirm Update Workspace",
    [
      `Workspace "${name}" already exists.`,
      `Update it with current ${state.tabs.length}-tab layout?`,
      "",
      "This does not delete or modify sessions.",
      "",
      "[Enter/Y] Update    [Esc/N] Cancel",
    ],
    Math.min(width, 72),
  );
}

function renderRestoreConfirmOverlay(overlay: WorkspaceOverlayView, width: number): string[] {
  const workspace = overlay.pendingWorkspace;
  return overlayPanel(
    `Restore Workspace "${workspace?.name ?? ""}"?`,
    [
      `This will open ${workspaceTabCount(workspace)} tabs and close ${overlay.extraTabCount} tabs`,
      "not in this workspace.",
      "",
      "Sessions are not deleted.",
      "",
      "[Enter/Y] Restore    [Esc/N] Cancel",
    ],
    Math.min(width, 72),
  );
}

function renderDeleteConfirmOverlay(overlay: WorkspaceOverlayView, width: number): string[] {
  const workspace = overlay.pendingWorkspace;
  return overlayPanel(
    `Delete Workspace "${workspace?.name ?? ""}"?`,
    [
      "This only removes the saved workspace record.",
      "Agent sessions and chat history are not deleted.",
      "",
      "[Enter/Y] Delete    [Esc/N] Cancel",
    ],
    Math.min(width, 72),
  );
}

function renderRestoringOverlay(overlay: WorkspaceOverlayView, width: number): string[] {
  return overlayPanel(
    "Restoring Workspace",
    [
      overlay.pendingWorkspace?.name ?? "",
      `Opening ${overlay.progressCurrent}/${overlay.progressTotal} sessions...`,
      "",
      "Please wait.",
    ],
    Math.min(width, 60),
  );
}

function renderMissingOverlay(overlay: WorkspaceOverlayView, width: number): string[] {
  return overlayPanel(
    "Missing Sessions",
    [
      "Workspace restored with missing sessions.",
      "",
      `Restored: ${overlay.restoredCount}`,
      `Skipped: ${overlay.skippedMissing.length}`,
      "",
      "Missing:",
      ...overlay.skippedMissing.map((item) => `- ${item}`),
      "",
      "Esc close",
    ],
    Math.min(width, 72),
  );
}

function renderWorkspaceSelector(
  overlay: WorkspaceOverlayView,
  state: MixCodeState,
  width: number,
): string[] {
  const panelWidth = Math.max(60, width);
  const bodyWidth = Math.max(20, panelWidth - 2);
  if (!overlay.workspaces.length) {
    return overlayPanel(
      "Project Workspaces",
      [
        activeRenderTheme.dim(overlay.workdir || state.workdir),
        "",
        "No saved workspaces for this directory.",
        "",
        "Use /save-workspace to save the current tab layout.",
        "",
        "Esc close",
      ],
      panelWidth,
    );
  }
  const leftWidth = Math.max(24, Math.floor(bodyWidth * 0.38));
  const rightWidth = Math.max(20, bodyWidth - leftWidth - 3);
  const workspace = selectedWorkspace(overlay);
  const rows = workspaceSelectorRows(overlay.workspaces.length, workspace);
  const left = renderWorkspaceList(overlay, leftWidth, rows);
  const right = renderWorkspaceDetails(workspace, rightWidth, rows);
  const lines = [
    activeRenderTheme.dim(overlay.workdir || state.workdir),
    "",
    ...zipColumns(left, right, leftWidth, rightWidth),
    "",
    `type: filter \u00b7 up/down: select \u00b7 enter: ${overlay.mode === "delete" ? "delete" : "restore"} \u00b7 esc: cancel`,
  ];
  return overlayPanel("Project Workspaces", lines, panelWidth);
}

function workspaceSelectorRows(
  workspaceCount: number,
  workspace: WorkspaceSnapshot | undefined,
): number {
  const detailRows = workspace ? Math.min(18, workspace.tabs.length + 5) : 8;
  const listRows = workspaceCount + 2;
  return Math.max(10, Math.min(18, Math.max(detailRows, listRows)));
}

function renderWorkspaceList(overlay: WorkspaceOverlayView, width: number, rows: number): string[] {
  const workspaces = filteredWorkspaces(overlay);
  const lines = [`filter: ${overlay.query}`, ""];
  const startIndex = windowStart(overlay.selectedIndex, workspaces.length, rows - 2);
  for (
    let index = startIndex;
    index < Math.min(workspaces.length, startIndex + rows - 2);
    index++
  ) {
    const workspace = workspaces[index]!;
    const selected = index === overlay.selectedIndex;
    const right = `${workspaceTabCount(workspace)} tabs \u00b7 ${formatWorkspaceDate(workspace.updatedAt)}`;
    const nameWidth = Math.max(6, width - visibleWidth(right) - 4);
    const line = `${selected ? ">" : " "} ${truncateToWidth(workspace.name, nameWidth)} ${right}`;
    lines.push(
      selected ? activeRenderTheme.selectedBg(padLine(line, width)) : truncateToWidth(line, width),
    );
  }
  while (lines.length < rows) lines.push("");
  return lines;
}

function renderWorkspaceDetails(
  workspace: WorkspaceSnapshot | undefined,
  width: number,
  rows: number,
): string[] {
  const lines = ["Details"];
  if (!workspace) {
    lines.push("No matching workspaces");
  } else {
    const items = workspace.tabs;
    const active = items.find((item) => item.sessionId === workspace.activeSessionId) ?? items[0];
    lines.push(
      `name: ${workspace.name}`,
      `updated: ${formatWorkspaceDate(workspace.updatedAt)} \u00b7 tabs: ${items.length}`,
      `active: ${active?.title ?? active?.sessionId ?? ""}`,
      `workdir: ${workspace.startupWorkdir}`,
      ...items
        .slice(0, Math.max(0, rows - 5))
        .map((item, index) => ` ${index + 1}. ${item.title || item.sessionId}`),
    );
  }
  while (lines.length < rows) lines.push("");
  return lines.map((line) => truncateToWidth(line, width));
}

function zipColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
): string[] {
  const count = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(
      `${padLine(left[index] ?? "", leftWidth)} \u2502 ${padLine(right[index] ?? "", rightWidth)}`,
    );
  }
  return lines;
}
