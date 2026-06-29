import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createSessionId, createTab } from "../core/defaults.js";
import {
  createSessionSelectorState,
  cycleSessionSortMode,
  type FlatSessionNode,
  formatSessionDate,
  getFilteredSessions,
  getSelectedSessionPath,
  moveSessionSelectorSelection,
  type SessionSelectorState,
  toggleSessionNameFilter,
  toggleSessionSelectorScope,
  updateSessionSelectorQuery,
} from "../core/session-selector.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, closeAgentTab, getActiveTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { windowStart } from "./rendering/scroll-window.js";
import { themeForId } from "./themes.js";

// --- Open / Close ---

export interface SessionSelectorRuntime {
  listSessions: (cwd: string) => Promise<import("@earendil-works/pi-coding-agent").SessionInfo[]>;
  listAllSessions: () => Promise<import("@earendil-works/pi-coding-agent").SessionInfo[]>;
  extensionSwitchSession: (
    sessionId: string,
    sessionPath: string,
  ) => Promise<{ cancelled: boolean }>;
  createTab: (
    tab: import("../core/types.js").MixCodeTabInfo,
    config: { systemPrompt: string; thinkingLevel: string; workdir: string },
  ) => Promise<unknown>;
  getTab: (sessionId: string) => { session: { getSessionFile: () => string | null } } | undefined;
  closeTab: (sessionId: string) => Promise<void>;
}

export async function openSessionSelector(
  state: MixCodeState,
  runtime: SessionSelectorRuntime,
  tui: OverlayTui,
  cwd: string,
  currentSessionPath: string | null,
): Promise<void> {
  const selector = createSessionSelectorState();
  selector.open = true;
  selector.loading = true;
  selector.currentSessionPath = currentSessionPath;
  state.sessionSelector = selector;
  showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
  tui.requestRender();

  try {
    const sessions = await runtime.listSessions(cwd);
    selector.currentSessions = sessions;
    selector.loading = false;
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
  } catch (error) {
    selector.loading = false;
    selector.statusMessage = `Failed to load: ${error instanceof Error ? error.message : String(error)}`;
    selector.statusType = "error";
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
  }
}

export function closeSessionSelector(state: MixCodeState, tui: OverlayTui): void {
  state.sessionSelector.open = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

// --- Key handling ---

export function handleSessionSelectorKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const selector = state.sessionSelector;
  if (!selector.open) return false;

  // Delete confirmation mode: only accept confirm/cancel
  if (selector.confirmingDeletePath !== null) {
    if (matchesKey(data, "enter") || data === "y" || data === "Y") {
      const pathToDelete = selector.confirmingDeletePath;
      selector.confirmingDeletePath = null;
      void deleteSessionAndRefresh(state, tui, pathToDelete);
      return true;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      selector.confirmingDeletePath = null;
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
      return true;
    }
    return true; // Consume all keys during confirmation
  }

  // Rename mode: separate input handling
  if (selector.renameMode) {
    if (matchesKey(data, "escape")) {
      selector.renameMode = false;
      selector.renameTargetPath = null;
      selector.renameInput = "";
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "enter")) {
      const name = selector.renameInput.trim();
      const targetPath = selector.renameTargetPath;
      selector.renameMode = false;
      selector.renameTargetPath = null;
      selector.renameInput = "";
      if (name && targetPath) {
        void confirmRenameSession(state, tui, targetPath, name);
      } else {
        showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
        tui.requestRender();
      }
      return true;
    }
    if (data === "\u007f") {
      selector.renameInput = selector.renameInput.slice(0, -1);
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "ctrl+u")) {
      selector.renameInput = "";
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
      return true;
    }
    // Accept printable text input; multi-byte escape/control sequences are navigation keys.
    if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      selector.renameInput += data;
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
      return true;
    }
    return true;
  }

  if (matchesKey(data, "escape")) {
    closeSessionSelector(state, tui);
    return true;
  }
  if (matchesKey(data, "tab")) {
    toggleSessionSelectorScope(selector);
    // Load all sessions on first toggle to "all"
    if (selector.scope === "all" && !selector.allLoaded) {
      loadAllSessions(state, tui, runtime);
    }
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+s")) {
    cycleSessionSortMode(selector);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+n")) {
    toggleSessionNameFilter(selector);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+p")) {
    selector.showPath = !selector.showPath;
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+d")) {
    startDeleteConfirmation(selector);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+r")) {
    enterRenameMode(selector);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "up")) {
    moveSessionSelectorSelection(selector, -1);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveSessionSelectorSelection(selector, 1);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "pageUp")) {
    moveSessionSelectorSelection(selector, -10);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "pageDown")) {
    moveSessionSelectorSelection(selector, 10);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "enter")) {
    const nodes = getFilteredSessions(selector);
    const selected = nodes[selector.selectedIndex];
    if (selected) {
      resumeSelectedSession(
        state,
        tui,
        selected.session.path,
        selected.session.name,
        runtime,
        onStateChanged,
      );
    }
    return true;
  }
  // Backspace
  if (data === "\u007f") {
    updateSessionSelectorQuery(selector, selector.query.slice(0, -1));
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  // Ctrl+U: clear query
  if (matchesKey(data, "ctrl+u")) {
    updateSessionSelectorQuery(selector, "");
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  // Printable characters (ASCII + multibyte like CJK)
  // Exclude escape sequences (start with \x1b) which are special key combos
  if (
    data.length > 0 &&
    !data.startsWith("\x1b") &&
    !matchesKey(data, "escape") &&
    !/^[\x00-\x1f\x7f]$/.test(data)
  ) {
    updateSessionSelectorQuery(selector, selector.query + data);
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return true;
  }
  return true; // Consume all input while selector is open
}

// --- Internal actions ---

function startDeleteConfirmation(selector: SessionSelectorState): void {
  const path = getSelectedSessionPath(selector);
  if (!path) return;
  if (selector.currentSessionPath && path === selector.currentSessionPath) {
    selector.statusMessage = "Cannot delete the currently active session";
    selector.statusType = "error";
    return;
  }
  selector.confirmingDeletePath = path;
}

function enterRenameMode(selector: SessionSelectorState): void {
  const nodes = getFilteredSessions(selector);
  const selected = nodes[selector.selectedIndex];
  if (!selected) return;
  selector.renameMode = true;
  selector.renameTargetPath = selected.session.path;
  selector.renameInput = selected.session.name ?? "";
}

async function confirmRenameSession(
  state: MixCodeState,
  tui: OverlayTui,
  sessionPath: string,
  name: string,
): Promise<void> {
  const selector = state.sessionSelector;
  try {
    // Open the session file and append session_info
    const { SessionManager: SM } = await import("@earendil-works/pi-coding-agent");
    const mgr = SM.open(sessionPath);
    mgr.appendSessionInfo(name);
    // Refresh the session list to reflect the new name
    const sessions = selector.scope === "all" ? selector.allSessions : selector.currentSessions;
    const session = sessions.find((s) => s.path === sessionPath);
    if (session) session.name = name;
    // Sync tab title if the renamed session is the active one
    if (selector.currentSessionPath && sessionPath === selector.currentSessionPath) {
      const activeTab = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
      if (activeTab) activeTab.title = name;
    }
    selector.statusMessage = `Renamed: ${name}`;
    selector.statusType = "info";
  } catch (error) {
    selector.statusMessage = `Rename failed: ${error instanceof Error ? error.message : String(error)}`;
    selector.statusType = "error";
  }
  showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
  tui.requestRender();
}

async function deleteSessionAndRefresh(
  state: MixCodeState,
  tui: OverlayTui,
  sessionPath: string,
): Promise<void> {
  const selector = state.sessionSelector;
  const result = await deleteSessionFile(sessionPath);
  if (result.ok) {
    selector.currentSessions = selector.currentSessions.filter((s) => s.path !== sessionPath);
    selector.allSessions = selector.allSessions.filter((s) => s.path !== sessionPath);
    const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
    selector.statusMessage = msg;
    selector.statusType = "info";
    // Clamp selection
    const count = getFilteredSessions(selector).length;
    selector.selectedIndex = Math.min(selector.selectedIndex, Math.max(0, count - 1));
  } else {
    selector.statusMessage = `Failed to delete: ${result.error ?? "Unknown error"}`;
    selector.statusType = "error";
  }
  showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
  tui.requestRender();
}

async function deleteSessionFile(
  sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  if (trashResult.status === 0 || !existsSync(sessionPath)) {
    return { ok: true, method: "trash" };
  }
  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err) {
    return { ok: false, method: "unlink", error: err instanceof Error ? err.message : String(err) };
  }
}

function loadAllSessions(state: MixCodeState, tui: OverlayTui, runtime?: MixCodeKeyRuntime): void {
  const selector = state.sessionSelector;
  const runtimeRef = runtime as unknown as SessionSelectorRuntime | undefined;
  if (!runtimeRef?.listAllSessions) {
    selector.statusMessage = "All-sessions listing not available";
    selector.statusType = "error";
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return;
  }
  selector.loading = true;
  showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
  tui.requestRender();
  void runtimeRef
    .listAllSessions()
    .then((sessions) => {
      selector.allSessions = sessions;
      selector.allLoaded = true;
      selector.loading = false;
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
    })
    .catch((error: unknown) => {
      selector.loading = false;
      selector.statusMessage = `Failed to load: ${error instanceof Error ? error.message : String(error)}`;
      selector.statusType = "error";
      showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
      tui.requestRender();
    });
}

function resumeSelectedSession(
  state: MixCodeState,
  tui: OverlayTui,
  sessionPath: string,
  sessionName: string | undefined,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): void {
  const runtimeRef = runtime as unknown as SessionSelectorRuntime | undefined;
  if (
    !runtimeRef?.extensionSwitchSession ||
    !runtimeRef.createTab ||
    !runtimeRef.getTab ||
    !runtimeRef.closeTab
  ) {
    showErrorOverlay(tui, new Error("Resume requires runtime session switch support"));
    tui.requestRender();
    return;
  }
  const active = getActiveTab(state);
  // Prevent resuming the already-active session
  const selector = state.sessionSelector;
  if (selector.currentSessionPath && sessionPath === selector.currentSessionPath) {
    selector.statusMessage = "Already the active session";
    selector.statusType = "info";
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return;
  }
  // If the target session is already open in another tab, just switch to that tab
  const existingTab = state.tabs.find((tab) => {
    const rt = runtimeRef.getTab(tab.sessionId);
    return rt?.session.getSessionFile() === sessionPath;
  });
  if (existingTab) {
    closeSessionSelector(state, tui);
    activateTab(state, existingTab.sessionId);
    void onStateChanged?.(state);
    tui.requestRender();
    return;
  }
  closeSessionSelector(state, tui);
  // Create a new tab and switch its session to the target.
  const previousActiveTabId = state.activeTabId;
  const newSessionId = createSessionId();
  const newTab = createTab(state.tabs.length + 1, newSessionId, active?.workdir ?? state.workdir, {
    model: { ...(active?.model ?? state.model) },
    contextLimit: active?.contextLimit ?? state.model.contextWindow,
    thinkingLevel: active?.thinkingLevel ?? state.thinkingLevel,
  });
  state.tabs.push(newTab);
  activateTab(state, newSessionId);
  void (async () => {
    let runtimeTabCreated = false;
    try {
      await runtimeRef.createTab(newTab, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: newTab.thinkingLevel,
        workdir: newTab.workdir,
      });
      runtimeTabCreated = true;
      const result = await runtimeRef.extensionSwitchSession(newSessionId, sessionPath);
      if (result.cancelled) {
        await runtimeRef.closeTab(newSessionId);
        discardResumeTabState(state, newSessionId, previousActiveTabId);
        state.sessionSelector.statusMessage = "Resume cancelled";
        state.sessionSelector.statusType = "info";
        await onStateChanged?.(state);
        tui.requestRender();
        return;
      }
      // Runtime replacement rewrites the tab to the real resumed session ID.
      // Keep activeTabId aligned so registry/workspace/status see the real ID.
      activateTab(state, newTab.sessionId);
      // Sync tab title from session name
      if (sessionName) newTab.title = sessionName;
      await onStateChanged?.(state);
      tui.requestRender();
    } catch (error: unknown) {
      if (runtimeTabCreated) {
        await runtimeRef.closeTab(newSessionId);
      }
      discardResumeTabState(state, newSessionId, previousActiveTabId);
      showErrorOverlay(tui, error);
      tui.requestRender();
    }
  })();
}

function discardResumeTabState(
  state: MixCodeState,
  sessionId: string,
  previousActiveTabId: string,
): void {
  if (state.tabs.some((tab) => tab.sessionId === sessionId)) {
    closeAgentTab(state, sessionId);
  }
  if (
    previousActiveTabId === "config" ||
    state.tabs.some((tab) => tab.sessionId === previousActiveTabId)
  ) {
    activateTab(state, previousActiveTabId);
  }
}

// --- Rendering ---

export function renderSessionSelector(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderSessionSelectorInner(state.sessionSelector, width),
  );
}

const MAX_VISIBLE = 12;

function renderSessionSelectorInner(selector: SessionSelectorState, width: number): string[] {
  const panelWidth = Math.min(Math.max(70, width - 4), width);
  const bodyWidth = Math.max(1, panelWidth - 4);

  // Rename mode: show a simple rename panel
  if (selector.renameMode) {
    const lines = [
      activeRenderTheme.bold("Rename Session"),
      "",
      `name: ${selector.renameInput}`,
      "",
      activeRenderTheme.dim("Enter: save  Esc: cancel  Ctrl+U: clear"),
    ];
    return overlayPanel("Rename Session", lines, panelWidth);
  }

  // Header line: title + scope + sort + name filter
  const title =
    selector.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
  const sortLabel =
    selector.sortMode === "threaded"
      ? "Threaded"
      : selector.sortMode === "recent"
        ? "Recent"
        : "Fuzzy";
  const nameLabel = selector.nameFilter === "all" ? "All" : "Named";
  const scopeText =
    selector.scope === "current"
      ? activeRenderTheme.accent("◉ Current") + activeRenderTheme.dim(" | ○ All")
      : activeRenderTheme.dim("○ Current | ") + activeRenderTheme.accent("◉ All");
  const sortText = activeRenderTheme.dim("Sort:") + activeRenderTheme.accent(sortLabel);
  const nameText = activeRenderTheme.dim("Name:") + activeRenderTheme.accent(nameLabel);
  const headerRight = `${scopeText}  ${nameText}  ${sortText}`;

  // Hints
  let hintLine: string;
  if (selector.confirmingDeletePath !== null) {
    hintLine = activeRenderTheme.danger("Delete session? Enter/y: confirm · Esc/n: cancel");
  } else if (selector.statusMessage) {
    const color = selector.statusType === "error" ? "danger" : "accent";
    hintLine = activeRenderTheme[color](selector.statusMessage);
  } else {
    hintLine = activeRenderTheme.dim(
      "Tab: scope  Ctrl+S: sort  Ctrl+N: named  Ctrl+D: delete  Ctrl+R: rename  Ctrl+P: path",
    );
  }

  // Search input
  const searchLine = `filter: ${selector.query}${selector.loading ? " (loading...)" : ""}`;

  const lines: string[] = [
    truncateToWidth(headerRight, bodyWidth),
    truncateToWidth(hintLine, bodyWidth),
    "",
    searchLine,
    "",
  ];

  // Session list
  const nodes = getFilteredSessions(selector);
  if (nodes.length === 0) {
    if (selector.loading) {
      lines.push(activeRenderTheme.dim("  Loading sessions..."));
    } else if (selector.nameFilter === "named") {
      lines.push(activeRenderTheme.dim("  No named sessions. Ctrl+N to show all."));
    } else if (selector.scope === "current") {
      lines.push(activeRenderTheme.dim("  No sessions in current folder. Tab to view all."));
    } else {
      lines.push(activeRenderTheme.dim("  No sessions found."));
    }
  } else {
    const startIndex = windowStart(selector.selectedIndex, nodes.length, MAX_VISIBLE);
    const endIndex = Math.min(startIndex + MAX_VISIBLE, nodes.length);

    for (let i = startIndex; i < endIndex; i++) {
      const node = nodes[i]!;
      const line = renderSessionLine(node, i, selector, bodyWidth);
      lines.push(line);
    }

    if (startIndex > 0 || endIndex < nodes.length) {
      lines.push(activeRenderTheme.dim(`  (${selector.selectedIndex + 1}/${nodes.length})`));
    }
  }

  lines.push("", activeRenderTheme.dim("up/down: select  enter: resume  esc: cancel"));

  return overlayPanel(title, lines, panelWidth);
}

function renderSessionLine(
  node: FlatSessionNode,
  index: number,
  selector: SessionSelectorState,
  width: number,
): string {
  const session = node.session;
  const isSelected = index === selector.selectedIndex;
  const isConfirmingDelete = session.path === selector.confirmingDeletePath;
  const isCurrent =
    selector.currentSessionPath !== null && session.path === selector.currentSessionPath;

  // Tree prefix
  const prefix = buildTreePrefix(node);

  // Display text
  const hasName = Boolean(session.name);
  const displayText = session.name ?? session.firstMessage;
  const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

  // Right side: message count + age + optional path/cwd
  const age = formatSessionDate(session.modified);
  const msgCount = String(session.messageCount);
  let rightPart = `${msgCount} ${age}`;
  if (selector.scope === "all" && session.cwd) {
    rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
  }
  if (selector.showPath) {
    rightPart = `${shortenPath(session.path)} ${rightPart}`;
  }

  // Cursor
  const cursor = isSelected ? activeRenderTheme.accent("› ") : "  ";

  // Calculate available width
  const prefixWidth = visibleWidth(prefix);
  const rightWidth = visibleWidth(rightPart) + 2;
  const availableForMsg = width - 2 - prefixWidth - rightWidth;
  const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

  // Style message
  let styledMsg: string;
  if (isConfirmingDelete) {
    styledMsg = activeRenderTheme.danger(truncatedMsg);
  } else if (isCurrent) {
    styledMsg = activeRenderTheme.accent(truncatedMsg);
  } else if (hasName) {
    styledMsg = activeRenderTheme.warning(truncatedMsg);
  } else {
    styledMsg = truncatedMsg;
  }
  if (isSelected) styledMsg = activeRenderTheme.bold(styledMsg);

  // Build line
  const leftPart = cursor + activeRenderTheme.dim(prefix) + styledMsg;
  const leftWidth = visibleWidth(leftPart);
  const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
  const styledRight = isConfirmingDelete
    ? activeRenderTheme.danger(rightPart)
    : activeRenderTheme.dim(rightPart);

  let line = leftPart + " ".repeat(spacing) + styledRight;
  if (isSelected) {
    line = activeRenderTheme.selection(padLine(line, width));
  }
  return truncateToWidth(line, width);
}

function buildTreePrefix(node: FlatSessionNode): string {
  if (node.depth === 0) return "";
  const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
  const branch = node.isLast ? "└─ " : "├─ ";
  return parts.join("") + branch;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}
