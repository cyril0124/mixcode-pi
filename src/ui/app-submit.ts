import { isBashAlreadyRunningError, type MixCodeRuntime } from "../agent/runtime.js";
import { entriesToChatLines } from "../agent/runtime-chat.js";
import { MIXCODE_EXTENSION_KEYBINDINGS } from "../agent/runtime-extension-theme.js";
import { applyContextLimit, parseContextLimitValue, adjustCompactionSettingsForLimit } from "../core/context-limit.js";
import { parseInput } from "../core/commands.js";
import { createSessionId, createTab } from "../core/defaults.js";
import { stringifyJson } from "../core/json.js";
import { findModelRef } from "../core/models.js";
import { noteTabClosed, noteTabOpened } from "../core/open-tabs-store.js";
import { createPicker } from "../core/pickers.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { pushToast } from "../core/toast.js";
import { activateTab, clampHomeSelectedTabIndex, getActiveTab, renameAgentTab } from "../core/tabs.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";
import {
  appendActiveSystemMessage,
  applyModelSelection,
  applyThinkingLevel,
  applyWorkdirSelection,
  openCloseAllSessionsConfirm,
  openDeleteAllSessionsConfirm,
  openSessionActionConfirm,
  reloadRuntimeModels,
} from "./app-actions.js";
import {
  completeAgentTabClear,
  createAgentTab,
  prepareAgentTabClear,
  submitAgentInput,
} from "./agent-tab-actions.js";
import { createTuiDebugState } from "./app-debug.js";
import {
  editTextWithTuiPaused,
  errorMessage,
  showLinesOverlay,
  showTextOverlay,
} from "./app-overlays.js";
import type { Component } from "@earendil-works/pi-tui";
import type {
  MixCodeSubmitRuntime,
  OverlayTui,
  RuntimeShortcutInfo,
  RuntimeToolInfo,
} from "./app-types.js";
import { userMessageEntryIdsInBranch } from "./chat-scroll-target.js";
import { openExtensionManager } from "./extension-manager.js";
import { renderHotkeysText } from "./hotkeys.js";
import { renderSystemToolsText } from "./system-tools.js";
import { getConfiguredQuitOptions, quitMixCode } from "./quit.js";
import { clearConversationCache, renderPickerOverlay } from "./rendering.js";
import { openSessionSelector, type SessionSelectorRuntime } from "./session-selector.js";
import { renderSessionInfoText as formatSessionInfoText } from "./session-info.js";

import { openTreeSelector, type TreeSelectorRuntime } from "./tree-selector.js";
import { openSettingsPanel } from "./settings-panel.js";
import {
  deleteWorkspaceByName,
  openSaveWorkspaceOverlay,
  openWorkspaceSelector,
  restoreWorkspaceByName,
  saveWorkspaceByName,
} from "./workspace-overlay.js";
export interface AuthInputHost {
  setInputComponent: (component: Component, sessionId?: string) => void;
  clearInputComponent: (sessionId?: string) => void;
  requestRender: () => void;
}

export async function handleSubmittedInput(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  text: string,
  tui: OverlayTui,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  authInputHost?: AuthInputHost,
  workspaceFile?: string,
  /** When set (e.g. Home send), submit targets this tab without changing activeTabId. */
  activeTabOverride?: MixCodeTabInfo,
  /** Settings panel dependencies — required to open /settings overlay. */
  settingsDeps?: {
    settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager;
    mixcodeFile: string;
    piSettingsFile: string;
  },
  /** Optional editor restore hook for Pi-parity bash-already-running conflicts. */
  editorActions?: Pick<import("./app-types.js").MixCodeEditorActions, "setText">,
): Promise<void> {
  const parsed = parseInput(text);
  const active = activeTabOverride ?? getActiveTab(state);
  const requiresActive =
    parsed.kind === "prompt" || parsed.kind === "shell" || !configScopedCommand(parsed.command);
  if (!active && requiresActive) return;
  if (active?.status === "Not Ready" && requiresActive) {
    throw new Error("Tab is still loading extensions. Please wait a moment.");
  }
  try {
    if (active && (await submitAgentInput(active, runtime, text, parsed))) {
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
  } catch (error) {
    // Pi restores the editor and warns instead of dropping a concurrent !shell.
    if (isBashAlreadyRunningError(error)) {
      editorActions?.setText(text);
      const message = errorMessage(error);
      if (active && runtime.getTab?.(active.sessionId)) {
        runtime.appendSystemMessage(active.sessionId, message, "error");
      } else if (active) {
        pushToast(active, {
          type: "warning",
          message,
        });
      }
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    throw error;
  }
  if (parsed.command === "mark-done") {
    active!.unreadDone = true;
    active!.status = "done";
    // Ring terminal bell after 5s so the user gets an audible notification
    // even if they have switched away from the terminal window.
    setTimeout(() => process.stdout.write("\x07"), 5_000);
  } else if (parsed.command === "vim") {
    active!.vimMode = true;
    active!.vimPendingEscapeAt = undefined;
    active!.vimPendingHome = false;
  } else if (parsed.command === "toggle-zen-mode") {
    active!.zenMode = !active!.zenMode;
  } else if (parsed.command === "toggle-hidden-messages") {
    const runtimeTab = runtime.getTab?.(active!.sessionId);
    if (!runtimeTab) {
      pushToast(active!, {
        type: "warning",
        message: "Toggling hidden messages requires an active agent chat",
      });
      return void tui.requestRender();
    }
    runtimeTab.showHiddenMessages = !runtimeTab.showHiddenMessages;
    // Rebuild the chat lines from the session branch so already-persisted
    // hidden entries appear/disappear immediately (same pattern as branch
    // switching in runtime-events).
    runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
    clearConversationCache(active!.sessionId);
    pushToast(active!, {
      type: "info",
      message: runtimeTab.showHiddenMessages
        ? "Hidden extension messages shown"
        : "Hidden extension messages hidden",
    });
    tui.requestRender();
  } else if (parsed.command === "settings") {
    if (settingsDeps) {
      await openSettingsPanel(
          state,
          tui,
          settingsDeps.settingsManager,
          settingsDeps.mixcodeFile,
          settingsDeps.piSettingsFile,
          { setHideThinkingBlock: runtime.setHideThinkingBlock?.bind(runtime) },
        );
    } else {
      appendActiveSystemMessage(state, runtime, "Settings panel not available: missing configuration context.");
    }
    tui.requestRender();
    return;
  } else if (parsed.command === "hide-thinking") {
    // App-level toggle mirroring Pi's hideThinkingBlock: folds thinking content
    // to a placeholder across every tab, persists via Pi's SettingsManager, and
    // invalidates cached conversation lines so the change shows immediately.
    state.hideThinkingBlock = !(state.hideThinkingBlock ?? false);
    runtime.setHideThinkingBlock?.(state.hideThinkingBlock);
    for (const tab of state.tabs) clearConversationCache(tab.sessionId);
    const message = state.hideThinkingBlock ? "Thinking blocks: hidden" : "Thinking blocks: visible";
    // Home paints the selected agent's toast (renderConfig + applyToastOverlay).
    if (active) pushToast(active, { type: "info", message });
    tui.requestRender();
  } else if (parsed.command === "navigate") {
    const runtimeTab = runtime.getTab?.(active!.sessionId);
    if (!runtimeTab?.session.getTree || !runtimeTab.session.getLeafId || !runtimeTab.session.getBranch) {
      pushToast(active!, { type: "warning", message: "Navigate requires an active agent chat" });
      return void tui.requestRender();
    }
    const userEntryIds = userMessageEntryIdsInBranch(runtimeTab.session.getBranch());
    if (userEntryIds.length === 0) {
      pushToast(active!, { type: "warning", message: "No user messages in current chat" });
      return void tui.requestRender();
    }
    openTreeSelector(
      state,
      runtime as unknown as TreeSelectorRuntime,
      tui,
      active!.sessionId,
      undefined,
      "user-only",
      "navigate",
      new Set(userEntryIds),
    );
    await onStateChanged?.(state);
    tui.requestRender();
    return;
  } else if (parsed.command === "clear") {
    // Home send keeps activeTabId=config while overriding the target tab; stay there
    // after clear instead of following completeAgentTabClear's activateTab(next).
    const stayOnHome = state.activeTabId === "config";
    const prepared = prepareAgentTabClear(state, runtime, active!.sessionId);
    tui.requestRender();
    // Session replacement loads extensions synchronously. Delay it until the TUI
    // has painted the empty conversation, otherwise the clear appears frozen.
    setTimeout(() => {
      completeAgentTabClear(state, runtime, prepared)
        .then(() => {
          if (stayOnHome) activateTab(state, "config");
          tui.requestRender();
        })
        .catch((error: unknown) => {
          appendActiveSystemMessage(
            state,
            runtime,
            `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          tui.requestRender();
        });
    }, 32);
  } else if (parsed.command === "new-session") {
    // Paint Not Ready immediately; createAgentTab still awaits full runtime startup.
    // Do not reuse services here — independent SettingsManager isolation.
    await createAgentTab(state, runtime, {
      onQueued: () => tui.requestRender(),
    });
  } else if (parsed.command === "resume") {
    if (!runtime.listSessions) {
      throw new Error("Resume requires pi runtime session listing support");
    }
    if (!runtime.extensionSwitchSession) {
      throw new Error("Resume requires pi runtime session switch support");
    }
    const cwd = active?.workdir ?? state.workdir;
    const runtimeTab = active ? runtime.getTab(active.sessionId) : undefined;
    const currentSessionPath =
      (
        runtimeTab as { session?: { getSessionFile?: () => string | null } } | undefined
      )?.session?.getSessionFile?.() ?? null;
    await openSessionSelector(
      state,
      runtime as unknown as SessionSelectorRuntime,
      tui,
      cwd,
      currentSessionPath,
    );
    await onStateChanged?.(state);
    tui.requestRender();
    return;
  } else if (parsed.command === "close-session") {
    openSessionActionConfirm(state, tui, "close", active!);
    await onStateChanged?.(state);
    return;
  } else if (parsed.command === "delete-session") {
    openSessionActionConfirm(state, tui, "delete", active!);
    await onStateChanged?.(state);
    return;
  } else if (parsed.command === "delete-all-sessions") {
    // Destructive (closes every tab and deletes every session file): gate
    // behind a Y/N confirmation instead of running immediately. The actual
    // deletion happens in handleDeleteAllSessionsConfirmKey once confirmed.
    openDeleteAllSessionsConfirm(state, tui);
    await onStateChanged?.(state);
    return;
  } else if (parsed.command === "close-all-sessions") {
    // Same Y/N gate as delete-all-sessions; the confirmed close happens in
    // handleCloseAllSessionsConfirmKey (keeps session files, unlike delete).
    openCloseAllSessionsConfirm(state, tui);
    await onStateChanged?.(state);
    return;
  } else if (parsed.command === "save-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = parsed.args.trim();
    if (!name) {
      await openSaveWorkspaceOverlay(state, tui, workspaceFile);
      await onStateChanged?.(state);
      return;
    }
    await saveWorkspaceByName(state, runtime, tui, workspaceFile, name);
  } else if (parsed.command === "restore-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = parsed.args.trim();
    if (!name) {
      await openWorkspaceSelector(state, tui, workspaceFile, "restore");
      await onStateChanged?.(state);
      return;
    }
    await restoreWorkspaceByName(state, runtime, tui, workspaceFile, name, onStateChanged);
  } else if (parsed.command === "delete-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = parsed.args.trim();
    if (!name) {
      await openWorkspaceSelector(state, tui, workspaceFile, "delete");
      await onStateChanged?.(state);
      return;
    }
    await deleteWorkspaceByName(state, tui, workspaceFile, name);
  } else if (parsed.command === "import") {
    if (!runtime.importFromJsonl)
      throw new Error("Import requires pi runtime session import support");
    const request = parseImportRequest(parsed.args);
    const result = await runtime.importFromJsonl(
      active!.sessionId,
      request.path,
      request.cwdOverride,
    );
    if (result.cancelled) {
      pushToast(active!, { type: "warning", message: "Import cancelled." });
    } else {
      activateTab(state, active!.sessionId);
      pushToast(active!, { type: "success", message: `Imported session: ${request.path}` });
    }
  } else if (parsed.command === "extension-manager") {
    openExtensionManager(state, runtime, tui);
  } else if (parsed.command === "reload") {
    if (!runtime.extensionReload) throw new Error("Reload requires pi runtime reload support");
    await runtime.extensionReload(active!.sessionId);
    // Native reload covers extensions/skills/prompts/themes but not models; the
    // model registry is loaded once at bootstrap, so refresh it here too.
    const modelsReloaded = await reloadRuntimeModels(state, runtime);
    // Short status line (Pi showStatus); agent tab required (not config-scoped).
    appendActiveSystemMessage(
      state,
      runtime,
      modelsReloaded
        ? "Reloaded keybindings, extensions, skills, prompts, themes, and models"
        : "Reloaded keybindings, extensions, skills, prompts, and themes",
    );
  } else if (parsed.command === "login") {
    const { openPiLogin } = await import("./pi-auth.js");
    await openPiLogin(state, runtime, authInputHost, parsed.args || undefined);
  } else if (parsed.command === "logout") {
    const { openPiLogout } = await import("./pi-auth.js");
    await openPiLogout(state, runtime, authInputHost);
  } else if (parsed.command === "fork") {
    const sessionId = createSessionId();
    await runtime.forkSession(active!.sessionId, sessionId);
    // The fork file now exists. Publish its ordered position before runtime tab
    // startup so the local reconciler cannot treat the in-progress tab as extra.
    noteTabOpened(sessionId, active!.sessionId);
    // Use the source tab, not activeTabId — on Home the latter is "config" (-1 → insert at 0).
    const activeIndex = state.tabs.findIndex((t) => t.sessionId === active!.sessionId);
    const tab = createTab(state.tabs.length + 1, sessionId, active!.workdir, {
      model: { ...active!.model },
      thinkingLevel: active!.thinkingLevel,
      title: `${active!.title}-fork`,
    });
    state.tabs.splice(activeIndex + 1, 0, tab);
    state.tabs.forEach((item, index) => {
      item.index = index + 1;
    });
    activateTab(state, sessionId);
    try {
      await runtime.createTab(tab, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: tab.thinkingLevel,
        workdir: tab.workdir,
        reuseServicesFromSessionId: active!.sessionId,
      });
    } catch (error) {
      // Rollback: remove the broken fork tab and shared ordered entry.
      const idx = state.tabs.findIndex((t) => t.sessionId === sessionId);
      if (idx >= 0) state.tabs.splice(idx, 1);
      noteTabClosed(sessionId);
      activateTab(state, active!.sessionId);
      throw error;
    }
    // Persist the fork title into the session file so it survives restarts.
    runtime.renameSession?.(sessionId, tab.title);
  } else if (parsed.command === "tree") {
    if (!runtime.extensionNavigateTree) {
      throw new Error("Tree navigation requires pi runtime tree support");
    }
    openTreeSelector(state, runtime as unknown as TreeSelectorRuntime, tui, active!.sessionId);
    await onStateChanged?.(state);
    tui.requestRender();
    return;
  } else if (parsed.command === "rename") {
    renameAgentTab(state, active!.sessionId, parsed.args);
    runtime.renameSession?.(active!.sessionId, parsed.args);
  } else if (parsed.command === "models") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("models", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    const model = findModelRef(state.availableModels, parsed.args);
    await applyModelSelection(state, active!, model, runtime);
  } else if (parsed.command === "workdir") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("workdir", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    await applyWorkdirSelection(active!, parsed.args.trim(), runtime);
  } else if (parsed.command === "thinking") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("thinking", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    applyThinkingLevel(state, active!, parsed.args.trim(), runtime);
  } else if (parsed.command === "context-limit") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("context-limit", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    const value = parseContextLimitValue(parsed.args);
    if (value === undefined) {
      pushToast(active!, {
        type: "error",
        message: `Invalid context limit: "${parsed.args}". Use a number (e.g. 32k, 40000) or "reset".`,
      });
    } else {
      applyContextLimit(active!, value);
      // Adjust SDK compaction settings to match the new limit
      const runtimeTab = runtime.getTab(active!.sessionId);
      if (runtimeTab) {
        adjustCompactionSettingsForLimit(
          runtimeTab.agentSession.settingsManager,
          active!.contextLimit,
          active!.contextLimitOverridden ?? false,
        );
      }
    }
  } else if (parsed.command === "help" || parsed.command === "hotkeys") {
    // Agent-tab only: Home has no chat surface for permanent shortcut dumps.
    if (state.activeTabId === "config") return;
    const shortcuts = active ? getExtensionShortcuts(runtime, active.sessionId) : [];
    // Pi handleHotkeysCommand permanently appends Markdown (not showStatus).
    appendActiveSystemMessage(state, runtime, renderHotkeysText(shortcuts), "block");
  } else if (parsed.command === "system-prompt") {
    if (parsed.args.trim()) throw new Error("Usage: /system-prompt");
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    await editTextWithTuiPaused(tui, runtimeTab.agent.state.systemPrompt);
  } else if (parsed.command === "system-tools") {
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const request = parseEditorFlag(parsed.args);
    const text = renderSystemToolsText(getRuntimeTools(runtime, active!.sessionId, runtimeTab));
    if (request.editorDisabled) {
      showTextOverlay(tui, text);
    } else {
      await editTextWithTuiPaused(tui, text, request.editor);
    }
  } else if (parsed.command === "session") {
    // Agent-tab only: session stats dump into the active chat.
    if (state.activeTabId === "config") return;
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const info = runtimeTab.agentSession.getSessionStats();
    syncTabContextUsage(active!, info.contextUsage);
    // Pi handleSessionCommand adds a permanent plain Text child (not showStatus).
    runtime.appendSystemMessage(
      active!.sessionId,
      renderSessionInfoText(runtimeTab, info),
      "plain",
    );
  } else if (parsed.command === "tui-state") {
    const request = parseEditorFlag(parsed.args);
    const text = stringifyJson(createTuiDebugState(state), true);
    if (request.editorDisabled) {
      showTextOverlay(tui, text);
    } else {
      await editTextWithTuiPaused(tui, text, request.editor);
    }
  } else if (parsed.command === "quit" || parsed.command === "exit") {
    await quitMixCode(runtime, tui, getConfiguredQuitOptions(tui));
  } else if (parsed.command === "compact") {
    await runtime.compactSession(active!.sessionId, parsed.args);
  } else {
    appendActiveSystemMessage(state, runtime, `Unknown slash command: /${parsed.command}`.trim());
  }
  await onStateChanged?.(state);
  tui.requestRender();
}

function configScopedCommand(command: string | undefined): boolean {
  return (
    command === "tui-state" ||
    command === "new-session" ||
    command === "resume" ||
    command === "hide-thinking" ||
    command === "settings" ||
    command === "delete-all-sessions" ||
    command === "close-all-sessions" ||
    command === "save-workspace" ||
    command === "restore-workspace" ||
    command === "delete-workspace" ||
    command === "extension-manager" ||
    command === "vim" ||
    command === "toggle-zen-mode" ||
    command === "login" ||
    command === "logout" ||
    command === "quit" ||
    command === "exit"
  );
}
function parseImportRequest(args: string): { path: string; cwdOverride?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const path = parts[0];
  if (!path) throw new Error("Missing import JSONL path");
  return { path, cwdOverride: parts[1] };
}

function getRuntimeTools(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  runtimeTab: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>,
): RuntimeToolInfo[] {
  const tools = runtime.getExtensionTools?.(sessionId) ?? runtimeTab.agentSession.getAllTools();
  return Array.isArray(tools) ? tools : [];
}

function getExtensionShortcuts(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
): RuntimeShortcutInfo[] {
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${sessionId}`);
  const runner = runtimeTab.agentSession?.extensionRunner;
  if (!runner) return [];
  return [...runner.getShortcuts(MIXCODE_EXTENSION_KEYBINDINGS).entries()].map(
    ([key, shortcut]) => ({
      key,
      description: shortcut.description,
      source: shortcut.extensionPath,
    }),
  );
}

type SessionStatsInfo = ReturnType<
  NonNullable<ReturnType<MixCodeRuntime["getTab"]>>["agentSession"]["getSessionStats"]
>;

function syncTabContextUsage(
  tab: MixCodeState["tabs"][number],
  contextUsage: SessionStatsInfo["contextUsage"],
): void {
  if (!contextUsage) return;
  // Only sync contextLimit from the runtime if the user hasn't overridden it
  if (!tab.contextLimitOverridden) {
    tab.contextLimit = contextUsage.contextWindow;
  }
  tab.currentContextTokens = contextUsage.tokens === null ? undefined : contextUsage.tokens;
}

export function renderSessionInfoText(
  runtimeTab: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>,
  info: SessionStatsInfo = runtimeTab.agentSession.getSessionStats(),
): string {
  // Pi handleSessionCommand: permanent stats dump with prompt-volume Input,
  // Cached/Uncached split, $cost, optional multi-model and cache re-bill lines.
  // Context usage is footer-only (syncTabContextUsage), not part of this dump.
  const entries =
    typeof runtimeTab.session.getEntries === "function"
      ? runtimeTab.session.getEntries()
      : [];
  const models = runtimeTab.agentSession.modelRuntime;
  return formatSessionInfoText(runtimeTab.session, info, { entries, models });
}

function parseEditorFlag(args: string): {
  remaining: string;
  editor?: string;
  editorDisabled?: boolean;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let editor: string | undefined;
  let editorDisabled = false;
  const remaining: string[] = [];
  for (const part of parts) {
    if (part === "--editor") {
      editor = "";
      editorDisabled = false;
      continue;
    }
    if (part.startsWith("--editor=")) {
      const value = part.slice("--editor=".length);
      editorDisabled = value === "false";
      editor = editorDisabled ? undefined : value;
      continue;
    }
    remaining.push(part);
  }
  return { remaining: remaining.join(" "), editor, editorDisabled };
}
