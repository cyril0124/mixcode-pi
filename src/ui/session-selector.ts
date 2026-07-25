import { homedir } from "node:os";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createSessionId, createTab } from "../core/defaults.js";
import { noteTabClosed, noteTabOpened, noteTabReplaced } from "../core/open-tabs-store.js";
import {
  createSessionSelectorState,
  cycleSessionSortMode,
  type FlatSessionNode,
  formatSessionDate,
  getFilteredSessions,
  getSelectedSessionPath,
  moveSessionSelectorSelection,
  type SessionSelectorState,
  sessionDisplayHighlightPositions,
  toggleSessionNameFilter,
  toggleSessionSelectorScope,
  searchSessionsWithRegex,
  sessionDisplayText,
  updateSessionSelectorQuery,
} from "../core/session-selector.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, closeAgentTab, getActiveTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { deleteSessionFile, findOpenSessionTab } from "./session-delete.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { highlightRanges } from "./rendering/highlight.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { windowStart } from "./rendering/scroll-window.js";
import { themeForId } from "./themes.js";

const regexSearches = new WeakMap<
  SessionSelectorState,
  { generation: number; cancel: () => void }
>();

function cancelRegexSearch(selector: SessionSelectorState): number {
  const active = regexSearches.get(selector);
  if (active) active.cancel();
  return active?.generation ?? 0;
}

function refreshRegexSearch(state: MixCodeState, tui: OverlayTui): void {
  const selector = state.sessionSelector;
  const previousGeneration = cancelRegexSearch(selector);
  selector.regexCancel = undefined;
  selector.regexError = "";
  selector.regexResults = {};
  selector.regexHighlights = {};
  const query = selector.query.trim();
  if (!query.startsWith("re:")) {
    selector.regexQuery = "";
    selector.regexStatus = "idle";
    regexSearches.delete(selector);
    return;
  }
  const pattern = query.slice(3).trim();
  if (!pattern) {
    selector.regexQuery = query;
    selector.regexStatus = "error";
    selector.regexError = "Empty regex";
    regexSearches.delete(selector);
    return;
  }
  const sessions = selector.scope === "all" ? selector.allSessions : selector.currentSessions;
  const generation = previousGeneration + 1;
  selector.regexQuery = query;
  selector.regexStatus = "loading";
  const search = searchSessionsWithRegex(sessions, pattern);
  regexSearches.set(selector, { generation, cancel: search.cancel });
  selector.regexCancel = () => {
    cancelRegexSearch(selector);
    regexSearches.delete(selector);
    selector.regexCancel = undefined;
  };
  void search.promise
    .then((results) => {
      const active = regexSearches.get(selector);
      if (!active || active.generation !== generation || selector.query.trim() !== query) return;
      selector.regexResults = Object.fromEntries(
        results.map((result) => [result.path, result.index]),
      );
      selector.regexHighlights = Object.fromEntries(
        results.map((result) => [
          result.path,
          { index: result.highlightIndex, length: result.highlightLength },
        ]),
      );
      selector.regexStatus = "ready";
      selector.regexError = "";
      tui.requestRender();
    })
    .catch((error: unknown) => {
      const active = regexSearches.get(selector);
      if (!active || active.generation !== generation || selector.query.trim() !== query) return;
      selector.regexStatus = "error";
      selector.regexError = error instanceof Error ? error.message : String(error);
      tui.requestRender();
    });
}

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
  getTab: (sessionId: string) =>
    | {
        session: {
          getSessionFile: () => string | null;
          getSessionName?: () => string | undefined;
        };
        tab?: { title: string };
      }
    | undefined;
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
    refreshRegexSearch(state, tui);
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
  cancelRegexSearch(state.sessionSelector);
  regexSearches.delete(state.sessionSelector);
  state.sessionSelector.regexCancel = undefined;
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
      void deleteSessionAndRefresh(state, tui, pathToDelete, runtime);
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
        void confirmRenameSession(state, tui, targetPath, name, runtime);
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
    refreshRegexSearch(state, tui);
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
    startDeleteConfirmation(state, selector, runtime);
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
        selected.session.id,
        runtime,
        onStateChanged,
      );
    }
    return true;
  }
  // Backspace
  if (data === "\u007f") {
    updateSessionSelectorQuery(selector, selector.query.slice(0, -1));
    refreshRegexSearch(state, tui);
    tui.requestRender();
    return true;
  }
  // Ctrl+U: clear query
  if (matchesKey(data, "ctrl+u")) {
    updateSessionSelectorQuery(selector, "");
    refreshRegexSearch(state, tui);
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
    refreshRegexSearch(state, tui);
    tui.requestRender();
    return true;
  }
  return true; // Consume all input while selector is open
}

// --- Internal actions ---

function startDeleteConfirmation(
  state: MixCodeState,
  selector: SessionSelectorState,
  runtime?: MixCodeKeyRuntime,
): void {
  const path = getSelectedSessionPath(selector);
  if (!path) return;
  if (selector.currentSessionPath && path === selector.currentSessionPath) {
    selector.statusMessage = "Cannot delete the currently active session";
    selector.statusType = "error";
    return;
  }
  const openTab = findOpenSessionTab(state, runtime, path);
  if (openTab) {
    selector.statusMessage = `Cannot delete session open in tab: ${openTab.title}`;
    selector.statusType = "error";
    return;
  }
  selector.statusMessage = "";
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
  runtime?: MixCodeKeyRuntime,
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
    // Sync tab title for any open tab bound to this session file (not only active).
    if (runtime) {
      const openTab = findOpenSessionTab(state, runtime, sessionPath);
      if (openTab) openTab.title = name;
    } else if (selector.currentSessionPath && sessionPath === selector.currentSessionPath) {
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
  runtime?: MixCodeKeyRuntime,
): Promise<void> {
  const selector = state.sessionSelector;
  const openTab = findOpenSessionTab(state, runtime, sessionPath);
  if (openTab) {
    selector.statusMessage = `Cannot delete session open in tab: ${openTab.title}`;
    selector.statusType = "error";
    showLinesOverlay(tui, (width) => renderSessionSelector(state, width));
    tui.requestRender();
    return;
  }
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
      refreshRegexSearch(state, tui);
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
  /** Durable session id from SessionManager.list (filename embed). */
  targetSessionId: string | undefined,
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
    // Keep the open tab's label aligned with the session file (rename may have
    // landed while this tab was backgrounded).
    const openName =
      runtimeRef.getTab(existingTab.sessionId)?.session.getSessionName?.() ?? sessionName;
    if (openName) existingTab.title = openName;
    void onStateChanged?.(state);
    tui.requestRender();
    return;
  }
  closeSessionSelector(state, tui);
  // Create a new tab and switch its session to the target.
  const previousActiveTabId = state.activeTabId;
  const ephemeralSessionId = createSessionId();
  const newTab = createTab(
    state.tabs.length + 1,
    ephemeralSessionId,
    active?.workdir ?? state.workdir,
    {
      model: { ...(active?.model ?? state.model) },
      contextLimit: active?.contextLimit ?? state.model.contextWindow,
      thinkingLevel: active?.thinkingLevel ?? state.thinkingLevel,
      // Visible while create/switch run (same badge as /new-session).
      status: "Not Ready",
    },
  );
  // Publish before createTab/switch so peer reconcile cannot treat this tab as
  // missing (same race as createAgentTab / completeAgentTabClear).
  noteTabOpened(ephemeralSessionId);
  state.tabs.push(newTab);
  activateTab(state, ephemeralSessionId);
  void (async () => {
    let runtimeTabCreated = false;
    /** True after UI+open_tabs already show the durable resumed id. */
    let identityPublished = false;
    const durableId = targetSessionId?.trim() || undefined;
    try {
      await runtimeRef.createTab(newTab, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: newTab.thinkingLevel,
        workdir: newTab.workdir,
      });
      runtimeTabCreated = true;
      // Predict the post-switch id (list id matches SessionManager.getSessionId).
      // Move local id + open_tabs together BEFORE switch awaits, so reconcile
      // never sees local=real while open_tabs still lists the ephemeral id
      // (that race closed the resumed tab and reopened Agent-NN).
      if (durableId && durableId !== ephemeralSessionId) {
        newTab.sessionId = durableId;
        activateTab(state, durableId);
        noteTabReplaced(ephemeralSessionId, durableId);
        identityPublished = true;
      }
      // Runtime map is still keyed by the ephemeral id until replace commits.
      const result = await runtimeRef.extensionSwitchSession(ephemeralSessionId, sessionPath);
      if (result.cancelled) {
        await runtimeRef.closeTab(ephemeralSessionId);
        noteTabClosed(identityPublished && durableId ? durableId : ephemeralSessionId);
        discardResumeTabState(
          state,
          identityPublished && durableId ? durableId : ephemeralSessionId,
          previousActiveTabId,
        );
        state.sessionSelector.statusMessage = "Resume cancelled";
        state.sessionSelector.statusType = "info";
        await onStateChanged?.(state);
        tui.requestRender();
        return;
      }
      // Runtime replacement rewrites the tab to the real resumed session ID.
      // Keep activeTabId aligned so registry/workspace/status see the real ID.
      activateTab(state, newTab.sessionId);
      // Prefer the fully-loaded session name (authoritative) over the selector's
      // list scan, which can miss session_info past the header scan window.
      const resumedName =
        runtimeRef.getTab(newTab.sessionId)?.session.getSessionName?.() ?? sessionName;
      if (resumedName) newTab.title = resumedName;
      newTab.status = "idle";
      // If list did not supply an id, publish the post-switch identity now.
      if (!identityPublished) {
        noteTabReplaced(ephemeralSessionId, newTab.sessionId);
      }
      await onStateChanged?.(state);
      tui.requestRender();
    } catch (error: unknown) {
      if (runtimeTabCreated) {
        // Runtime still uses the pre-replace key when switch fails before commit;
        // after commit the map key is the durable id on the tab object.
        const runtimeKey =
          runtimeRef.getTab(newTab.sessionId) !== undefined
            ? newTab.sessionId
            : ephemeralSessionId;
        await runtimeRef.closeTab(runtimeKey);
      }
      noteTabClosed(identityPublished && durableId ? durableId : ephemeralSessionId);
      discardResumeTabState(state, newTab.sessionId, previousActiveTabId);
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
    } else if (selector.regexStatus === "loading") {
      lines.push(activeRenderTheme.dim("  Searching with regex..."));
    } else if (selector.regexStatus === "error") {
      lines.push(activeRenderTheme.danger(`  ${selector.regexError}`));
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
  const normalizedMessage = sessionDisplayText(session);

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

  // Style message: base color depends on state, matched chars always get
  // bold+accent as a sibling span (never nested inside the selected-bold
  // wrap) — see rendering/highlight.ts for why that ordering matters.
  const baseStyle = isConfirmingDelete
    ? activeRenderTheme.danger
    : isCurrent
      ? activeRenderTheme.accent
      : hasName
        ? activeRenderTheme.warning
        : (text: string) => text;
  const restStyle = isSelected
    ? (text: string) => activeRenderTheme.bold(baseStyle(text))
    : baseStyle;
  const highlightPositions = regexHighlightPositions(selector, session.path, truncatedMsg);
  const styledMsg = highlightRanges(
    truncatedMsg,
    highlightPositions,
    (text) => activeRenderTheme.bold(activeRenderTheme.accent(text)),
    restStyle,
  );

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

function regexHighlightPositions(
  selector: SessionSelectorState,
  sessionPath: string,
  displayText: string,
): number[] {
  if (!selector.query.trim().startsWith("re:")) {
    return sessionDisplayHighlightPositions(selector.query, displayText);
  }
  const highlight = selector.regexHighlights[sessionPath];
  if (!highlight || highlight.index < 0 || highlight.length <= 0) return [];
  const end = Math.min(displayText.length, highlight.index + highlight.length);
  return Array.from({ length: Math.max(0, end - highlight.index) }, (_, offset) =>
    highlight.index + offset,
  );
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
