import * as path from "node:path";
import {
  initTheme,
  SessionManager,
  SessionSelectorComponent,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, isKeyRelease } from "@earendil-works/pi-tui";

import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import { createSessionId, createTab } from "../core/defaults.js";
import { noteTabClosed, noteTabOpened, noteTabReplaced } from "../core/open-tabs-store.js";
import { invalidateSessionCatalog } from "../core/session-catalog.js";
import { createSessionSelectorState } from "../core/session-selector.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, closeAgentTab, getActiveTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";
import { showErrorOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import type { AuthInputHost } from "./app-submit.js";

export type SessionListProgress = (loaded: number, total: number) => void;

export function findOpenSessionTab(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime | undefined,
  sessionPath: string,
): MixCodeState["tabs"][number] | undefined {
  if (!runtime) return undefined;
  return state.tabs.find(
    (tab) => runtime.getTab(tab.sessionId)?.session.getSessionFile() === sessionPath,
  );
}

export interface SessionSelectorRuntime {
  listSessions: (
    cwd: string,
    signal?: AbortSignal,
    onProgress?: SessionListProgress,
  ) => Promise<SessionInfo[]>;
  listAllSessions: (
    signal?: AbortSignal,
    onProgress?: SessionListProgress,
  ) => Promise<SessionInfo[]>;
  extensionSwitchSession: (
    sessionId: string,
    sessionPath: string,
  ) => Promise<{ cancelled: boolean }>;
  createTab: (
    tab: MixCodeTabInfo,
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

/**
 * Open Pi's public SessionSelectorComponent in the editor slot (Pi InteractiveMode
 * showSelector parity — not a floating overlay).
 * Multi-tab resume glue stays in resumeSelectedSession.
 */
export async function openSessionSelector(
  state: MixCodeState,
  runtime: SessionSelectorRuntime,
  tui: OverlayTui,
  cwd: string,
  currentSessionPath: string | null,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  inputHost?: AuthInputHost,
): Promise<void> {
  if (!inputHost?.setInputComponent || !inputHost.clearInputComponent) {
    throw new Error("Resume requires editor input host (setInputComponent)");
  }

  // SessionSelectorComponent reads the SDK global theme for borders/hints.
  initTheme();

  // Drop any previous selector / input takeover before mounting.
  closeSessionSelector(state, tui);

  const selectorState = createSessionSelectorState();
  selectorState.open = true;
  selectorState.currentSessionPath = currentSessionPath;
  state.sessionSelector = selectorState;

  const ownerSessionId = state.activeTabId;
  const close = () => closeSessionSelector(state, tui);

  // Pi keeps the previous scope's rows until the All loader resolves. On large
  // trees that scan is multi-second, so the list still looks like Current Folder
  // while the header already says All. Start All only on first Tab; if still
  // loading, clear stale current-folder rows first.
  let listRef: { setSessions: (sessions: SessionInfo[], showCwd: boolean) => void } | undefined;
  let allWarmConsumed = false;

  const component = new SessionSelectorComponent(
    // Forward Pi header Loading n/m progress (was previously discarded).
    (onProgress) => runtime.listSessions(cwd, undefined, onProgress),
    async (onProgress) => {
      if (allWarmConsumed) {
        // Later refresh/delete must re-scan disk (not reuse the first All load).
        return runtime.listAllSessions(undefined, onProgress);
      }
      allWarmConsumed = true;
      const pending = runtime.listAllSessions(undefined, onProgress);
      const settled = await Promise.race([
        pending.then((sessions) => ({ ok: true as const, sessions })),
        Promise.resolve({ ok: false as const }),
      ]);
      if (settled.ok) return settled.sessions;
      // Still loading: drop current-folder rows so All is not a lie.
      listRef?.setSessions([], true);
      tui.requestRender();
      return pending;
    },
    (sessionPath) => {
      const nameAndId = readSessionNameAndId(sessionPath);
      close();
      resumeSelectedSession(
        state,
        tui,
        sessionPath,
        nameAndId.name,
        nameAndId.id,
        runtime as unknown as MixCodeKeyRuntime,
        onStateChanged,
      );
    },
    close,
    close, // onExit: multi-tab host does not quit from the selector
    () => tui.requestRender(),
    {
      renameSession: async (sessionFilePath, nextName) => {
        await renameOpenSession(
          state,
          runtime as unknown as MixCodeKeyRuntime,
          sessionFilePath,
          nextName,
        );
      },
      showRenameHint: true,
    },
    currentSessionPath ?? undefined,
  );

  // Guard multi-tab: refuse delete when another MixCode tab has the file open.
  const list = component.getSessionList();
  listRef = list;
  const piDelete = list.onDeleteSession;
  list.onDeleteSession = async (sessionPath) => {
    const openTab = findOpenSessionTab(
      state,
      runtime as unknown as MixCodeKeyRuntime,
      sessionPath,
    );
    if (openTab) {
      list.onError?.(`Cannot delete session open in tab: ${openTab.title}`);
      return;
    }
    // Delegate the actual delete (trash → unlink + in-memory list refresh +
    // status message) to Pi's own onDeleteSession. Deleting here ourselves
    // first made `trash` run twice for one deletion.
    if (piDelete) await piDelete(sessionPath);
    // The sessions-root fs.watch invalidation is async; invalidate eagerly so
    // the next catalog load never returns the just-deleted file.
    invalidateSessionCatalog(path.dirname(sessionPath));
  };

  selectorState.component = component;
  // Bridge app.session.* into nested+outer pi-tui getKeybindings for keyHint/matches.
  const host = wrapSessionSelectorWithKeybindings(component);
  selectorState.dispose = () => {
    inputHost.clearInputComponent(ownerSessionId);
  };
  inputHost.setInputComponent(host, ownerSessionId);
  tui.requestRender();
}

export function closeSessionSelector(state: MixCodeState, tui: OverlayTui): void {
  state.sessionSelector.dispose?.();
  state.sessionSelector.dispose = undefined;
  state.sessionSelector.open = false;
  state.sessionSelector.component = undefined;
  tui.requestRender();
}

/**
 * Fallback key path when the selector is open but input-host routing did not
 * consume the event. Primary path is EditorSlot input-component takeover.
 */
export function handleSessionSelectorKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  _runtime?: MixCodeKeyRuntime,
  _onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const component = state.sessionSelector.component;
  if (!state.sessionSelector.open || !component) return false;
  if (isKeyRelease(data)) return true;
  withSessionKeybindings(() => component.handleInput(data));
  tui.requestRender();
  return true;
}

/** Persist session_info name and sync any open MixCode tab title. */
export async function renameOpenSession(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime | undefined,
  sessionFilePath: string,
  nextName: string | undefined,
): Promise<void> {
  const next = (nextName ?? "").trim();
  if (!next) return;
  const mgr = SessionManager.open(sessionFilePath);
  mgr.appendSessionInfo(next);
  invalidateSessionCatalog(path.dirname(sessionFilePath));
  const openTab = findOpenSessionTab(state, runtime, sessionFilePath);
  if (openTab) openTab.title = next;
}

function readSessionNameAndId(sessionPath: string): { name?: string; id?: string } {
  try {
    const mgr = SessionManager.open(sessionPath);
    return {
      id: mgr.getSessionId(),
      name: mgr.getSessionName(),
    };
  } catch {
    return {};
  }
}

/**
 * Pi SessionSelectorComponent (and keyHint) read getKeybindings() from the
 * nested pi-tui shrinkwrap copy. Mirror MixCode bindings for the duration of
 * render/input — same bridge pattern as tree-selector.
 */
function withSessionKeybindings<T>(action: () => T): T {
  const restore = applyMixCodeKeybindings();
  try {
    return action();
  } finally {
    restore();
  }
}

function wrapSessionSelectorWithKeybindings(
  component: SessionSelectorComponent,
): Component & Focusable {
  return {
    render(width: number): string[] {
      return withSessionKeybindings(() => component.render(width));
    },
    handleInput(data: string): void {
      // Kitty releases are dropped in app-input before forwardToInputComponent.
      withSessionKeybindings(() => component.handleInput(data));
    },
    invalidate(): void {
      component.invalidate();
    },
    get focused(): boolean {
      return component.focused;
    },
    set focused(value: boolean) {
      component.focused = value;
    },
  };
}

/**
 * Multi-tab resume: open target in a new tab (or focus existing tab).
 * Exported for contract tests that drive resume without the full Pi UI.
 */
export function resumeSelectedSession(
  state: MixCodeState,
  tui: OverlayTui,
  sessionPath: string,
  sessionName: string | undefined,
  /** Durable session id from SessionManager (filename embed). */
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
  if (
    state.sessionSelector.currentSessionPath &&
    sessionPath === state.sessionSelector.currentSessionPath
  ) {
    if (active) {
      pushToast(active, { type: "info", message: "Already the active session" });
    }
    tui.requestRender();
    return;
  }
  const existingTab = state.tabs.find((tab) => {
    const rt = runtimeRef.getTab(tab.sessionId);
    return rt?.session.getSessionFile() === sessionPath;
  });
  if (existingTab) {
    closeSessionSelector(state, tui);
    activateTab(state, existingTab.sessionId);
    const openName =
      runtimeRef.getTab(existingTab.sessionId)?.session.getSessionName?.() ?? sessionName;
    if (openName) existingTab.title = openName;
    void onStateChanged?.(state);
    tui.requestRender();
    return;
  }
  closeSessionSelector(state, tui);
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
      status: "Not Ready",
    },
  );
  noteTabOpened(ephemeralSessionId);
  state.tabs.push(newTab);
  activateTab(state, ephemeralSessionId);
  void (async () => {
    let runtimeTabCreated = false;
    let identityPublished = false;
    const durableId = targetSessionId?.trim() || undefined;
    try {
      await runtimeRef.createTab(newTab, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: newTab.thinkingLevel,
        workdir: newTab.workdir,
      });
      runtimeTabCreated = true;
      if (durableId && durableId !== ephemeralSessionId) {
        newTab.sessionId = durableId;
        activateTab(state, durableId);
        noteTabReplaced(ephemeralSessionId, durableId);
        identityPublished = true;
      }
      const result = await runtimeRef.extensionSwitchSession(ephemeralSessionId, sessionPath);
      if (result.cancelled) {
        await runtimeRef.closeTab(ephemeralSessionId);
        noteTabClosed(identityPublished && durableId ? durableId : ephemeralSessionId);
        discardResumeTabState(
          state,
          identityPublished && durableId ? durableId : ephemeralSessionId,
          previousActiveTabId,
        );
        const tab = getActiveTab(state);
        if (tab) pushToast(tab, { type: "info", message: "Resume cancelled" });
        await onStateChanged?.(state);
        tui.requestRender();
        return;
      }
      activateTab(state, newTab.sessionId);
      const resumedName =
        runtimeRef.getTab(newTab.sessionId)?.session.getSessionName?.() ?? sessionName;
      if (resumedName) newTab.title = resumedName;
      newTab.status = "idle";
      if (!identityPublished) {
        noteTabReplaced(ephemeralSessionId, newTab.sessionId);
      }
      await onStateChanged?.(state);
      tui.requestRender();
    } catch (error: unknown) {
      if (runtimeTabCreated) {
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
