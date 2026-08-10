import {
  isBashAlreadyRunningError,
  type MixCodeRuntime,
  type RuntimeTab,
} from "../agent/runtime.js";

import {
  MIXCODE_EXTENSION_KEYBINDINGS,
  reloadMixCodeUserKeybindings,
} from "../agent/runtime-extension-theme.js";
import {
  applyContextLimit,
  applyContextLimitToSession,
  parseContextLimitValue,
} from "../core/context-limit.js";
import { isLocalCommand, parseInput, type LocalCommand } from "../core/commands.js";
import { createSessionId, createTab } from "../core/defaults.js";

import { assertModelEnabled, findModelRef } from "../core/models.js";
import { noteTabClosed, noteTabOpened, noteTabReplaced } from "../core/open-tabs-store.js";
import { createPicker } from "../core/pickers.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { pushToast } from "../core/toast.js";
import { activateTab, clampHomeSelectedTabIndex, getActiveTab, renameAgentTab } from "../core/tabs.js";
import type { MixCodeState, MixCodeTabInfo, PendingEscapeAction } from "../core/types.js";
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
import {
  editTextWithTuiPaused,
  errorMessage,
  showLinesOverlay,
  showTextOverlay,
} from "./app-overlays.js";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  MixCodeEditorActions,
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

interface SettingsPanelDependencies {
  settingsManager: SettingsManager;
  mixcodeFile: string;
  piSettingsFile: string;
}

interface LocalCommandContext {
  state: MixCodeState;
  runtime: MixCodeSubmitRuntime;
  active: MixCodeTabInfo | undefined;
  args: string;
  tui: OverlayTui;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
  authInputHost?: AuthInputHost;
  workspaceFile?: string;
  settingsDeps?: SettingsPanelDependencies;
}

const SKIP_FINALIZE = Symbol("skip-finalize");
type LocalCommandHandler = (
  context: LocalCommandContext,
) => undefined | typeof SKIP_FINALIZE | Promise<undefined | typeof SKIP_FINALIZE>;

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
  settingsDeps?: SettingsPanelDependencies,
  /** Optional editor restore hook for Pi-parity bash-already-running conflicts. */
  editorActions?: Pick<MixCodeEditorActions, "setText">,
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
      if (active && runtime.getTab(active.sessionId)) {
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
  if (isLocalCommand(parsed.command)) {
    const result = await LOCAL_COMMAND_HANDLERS[parsed.command]({
      state,
      runtime,
      active,
      args: parsed.args,
      tui,
      onStateChanged,
      authInputHost,
      workspaceFile,
      settingsDeps,
    });
    if (result === SKIP_FINALIZE) return;
  } else {
    appendActiveSystemMessage(state, runtime, `Unknown slash command: /${parsed.command}`.trim());
  }
  await onStateChanged?.(state);
  tui.requestRender();
}

const handleFollowUp: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  // Queue as followUp (wait until idle). Do not send "/follow-up ..." as model text.
  const message = args.trim();
  if (!message) {
    pushToast(active!, {
      type: "warning",
      message: "Usage: /follow-up <message>",
    });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  assertModelEnabled(active!.model);
  await runtime.prompt(active!.sessionId, message, { streamingBehavior: "followUp" });
};

const handleMarkDone: LocalCommandHandler = ({ active }) => {
  // Intentional: unlike agent_end (unread only until the tab is viewed),
  // /mark-done forces a sticky "!" on the current tab so the user can flag
  // work as done while still looking at it. activateTab() clears the badge
  // when focus leaves and returns (see core/tabs.ts).
  active!.unreadDone = true;
  active!.status = "done";
  // Ring terminal bell after 5s so the user gets an audible notification
  // even if they have switched away from the terminal window.
  setTimeout(() => process.stdout.write("\x07"), 5_000);
  return undefined;
};

const handleVim: LocalCommandHandler = ({ active }) => {
  active!.vimMode = true;
  active!.vimPendingEscapeAt = undefined;
  active!.vimPendingHome = false;
  return undefined;
};

const handleToggleZenMode: LocalCommandHandler = ({ active }) => {
  active!.zenMode = !active!.zenMode;
  return undefined;
};

const handleToggleHiddenMessages: LocalCommandHandler = ({ active, runtime, tui }) => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) {
    pushToast(active!, {
      type: "warning",
      message: "Toggling hidden messages requires an active agent chat",
    });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  runtimeTab.showHiddenMessages = !runtimeTab.showHiddenMessages;
  // Rebuild via host so projection stays behind the multi-tab seam.
  runtime.rebuildChatFromSession(active!.sessionId);
  clearConversationCache(active!.sessionId);
  pushToast(active!, {
    type: "info",
    message: runtimeTab.showHiddenMessages
      ? "Hidden extension messages shown"
      : "Hidden extension messages hidden",
  });
  tui.requestRender();
};

const handleSettings: LocalCommandHandler = async ({
  state,
  runtime,
  tui,
  settingsDeps,
}): Promise<typeof SKIP_FINALIZE> => {
  if (settingsDeps) {
    await openSettingsPanel(
      state,
      tui,
      settingsDeps.settingsManager,
      settingsDeps.mixcodeFile,
      settingsDeps.piSettingsFile,
      { setHideThinkingBlock: runtime.setHideThinkingBlock.bind(runtime) },
    );
  } else {
    appendActiveSystemMessage(
      state,
      runtime,
      "Settings panel not available: missing configuration context.",
    );
  }
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleHideThinking: LocalCommandHandler = ({ state, active, runtime, tui }) => {
  // App-level toggle mirroring Pi's hideThinkingBlock: folds thinking content
  // to a placeholder across every tab, persists via Pi's SettingsManager, and
  // invalidates cached conversation lines so the change shows immediately.
  state.hideThinkingBlock = !(state.hideThinkingBlock ?? false);
  runtime.setHideThinkingBlock(state.hideThinkingBlock);
  for (const tab of state.tabs) clearConversationCache(tab.sessionId);
  const message = state.hideThinkingBlock ? "Thinking blocks: hidden" : "Thinking blocks: visible";
  // Home paints the selected agent's toast (renderConfig + applyToastOverlay).
  if (active) pushToast(active, { type: "info", message });
  tui.requestRender();
  return undefined;
};

const handleNavigate: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab?.session.getTree || !runtimeTab.session.getLeafId || !runtimeTab.session.getBranch) {
    pushToast(active!, { type: "warning", message: "Navigate requires an active agent chat" });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  const userEntryIds = userMessageEntryIdsInBranch(runtimeTab.session.getBranch());
  if (userEntryIds.length === 0) {
    pushToast(active!, { type: "warning", message: "No user messages in current chat" });
    tui.requestRender();
    return SKIP_FINALIZE;
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
  return SKIP_FINALIZE;
};

const handleClear: LocalCommandHandler = ({ state, active, runtime, tui }) => {
  // Home send keeps activeTabId=config while overriding the target tab; stay there
  // after clear instead of following completeAgentTabClear's activateTab(next).
  const stayOnHome = state.activeTabId === "config";
  let prepared: ReturnType<typeof prepareAgentTabClear>;
  try {
    prepared = prepareAgentTabClear(state, runtime, active!.sessionId);
  } catch (error: unknown) {
    appendActiveSystemMessage(
      state,
      runtime,
      `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
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
        // Identity was rolled back; restore wiped chat from the surviving session.
        // Best-effort only: requireTab throws if the map lost the id mid-clear.
        try {
          if (runtime.getTab(prepared.tab.sessionId)) {
            runtime.rebuildChatFromSession(prepared.tab.sessionId);
          }
        } catch {
          // Always surface the clear failure below even if restore fails.
        }
        appendActiveSystemMessage(
          state,
          runtime,
          `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        tui.requestRender();
      });
  }, 32);
};

const handleNewSession: LocalCommandHandler = async ({ state, args, runtime, tui }) => {
  // Paint Not Ready immediately; createAgentTab still awaits full runtime startup.
  // Do not reuse services here — independent SettingsManager isolation.
  // Optional args: `/new-session Name` ≡ create + rename (same as `/rename Name`).
  const title = args.trim();
  const tab = await createAgentTab(state, runtime, {
    onQueued: () => tui.requestRender(),
    ...(title ? { title } : {}),
  });
  if (title) {
    // createAgentTab already set tab.title; keep session-file metadata in sync.
    runtime.renameSession(tab.sessionId, title);
  }
  return undefined;
};

const handleResume: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
  authInputHost,
}): Promise<typeof SKIP_FINALIZE> => {
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
    onStateChanged,
    authInputHost,
  );
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleCloseSession: LocalCommandHandler = async ({
  state,
  active,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  openSessionActionConfirm(state, tui, "close", active!);
  await onStateChanged?.(state);
  return SKIP_FINALIZE;
};

const handleDeleteSession: LocalCommandHandler = async ({
  state,
  active,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  openSessionActionConfirm(state, tui, "delete", active!);
  await onStateChanged?.(state);
  return SKIP_FINALIZE;
};

const handleDeleteAllSessions: LocalCommandHandler = async ({
  state,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  // Destructive (closes every tab and deletes every session file): gate
  // behind a Y/N confirmation instead of running immediately. The actual
  // deletion happens in handleDeleteAllSessionsConfirmKey once confirmed.
  openDeleteAllSessionsConfirm(state, tui);
  await onStateChanged?.(state);
  return SKIP_FINALIZE;
};

const handleCloseAllSessions: LocalCommandHandler = async ({
  state,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  // Same Y/N gate as delete-all-sessions; the confirmed close happens in
  // handleCloseAllSessionsConfirmKey (keeps session files, unlike delete).
  openCloseAllSessionsConfirm(state, tui);
  await onStateChanged?.(state);
  return SKIP_FINALIZE;
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
    await openSaveWorkspaceOverlay(state, tui, workspaceFile);
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
    await openWorkspaceSelector(state, tui, workspaceFile, "restore");
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await restoreWorkspaceByName(state, runtime, tui, workspaceFile, name, onStateChanged);
};

const handleDeleteWorkspace: LocalCommandHandler = async ({
  state,
  args,
  tui,
  onStateChanged,
  workspaceFile,
}) => {
  if (!workspaceFile) throw new Error("Workspace file is not configured");
  const name = args.trim();
  if (!name) {
    await openWorkspaceSelector(state, tui, workspaceFile, "delete");
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await deleteWorkspaceByName(state, tui, workspaceFile, name);
};

const handleImport: LocalCommandHandler = async ({ state, active, args, runtime }) => {
  const request = parseImportRequest(args);
  const oldSessionId = active!.sessionId;
  const { sessionId: targetSessionId } = await runtime.previewSessionImport(
    request.path,
    request.cwdOverride,
    active!.workdir,
  );
  const identityChanged = targetSessionId !== oldSessionId;
  const publishIdentity = (from: string, to: string) => {
    active!.sessionId = to;
    activateTab(state, to);
    noteTabReplaced(from, to);
  };
  if (identityChanged) publishIdentity(oldSessionId, targetSessionId);
  try {
    const result = await runtime.importFromJsonl(oldSessionId, request.path, request.cwdOverride);
    if (result.cancelled) {
      if (identityChanged) publishIdentity(targetSessionId, oldSessionId);
      pushToast(active!, { type: "warning", message: "Import cancelled." });
    } else {
      pushToast(active!, { type: "success", message: `Imported session: ${request.path}` });
    }
  } catch (error) {
    if (identityChanged) publishIdentity(targetSessionId, oldSessionId);
    throw error;
  }
  return undefined;
};

const handleExtensionManager: LocalCommandHandler = ({ state, runtime, tui }) => {
  openExtensionManager(state, runtime, tui);
  return undefined;
};

const handleReload: LocalCommandHandler = async ({ state, active, runtime, settingsDeps }) => {
  reloadMixCodeUserKeybindings();
  await runtime.extensionReload(active!.sessionId);
  // Native reload covers extensions/skills/prompts/themes but not models; the
  // model registry is loaded once at bootstrap, so refresh it here too.
  const modelsResult = await reloadRuntimeModels(state, runtime, {
    mixcodeFile: settingsDeps?.mixcodeFile,
  });
  // Short status line (Pi showStatus); agent tab required (not config-scoped).
  if (modelsResult.ok) {
    appendActiveSystemMessage(
      state,
      runtime,
      "Reloaded keybindings, extensions, skills, prompts, themes, and models",
    );
  } else {
    // Extensions already reloaded; keep prior model selection and surface Pi's error.
    appendActiveSystemMessage(
      state,
      runtime,
      `Reloaded keybindings, extensions, skills, prompts, and themes; models failed: ${modelsResult.error}`,
      "error",
    );
  }
  return undefined;
};

const handleLogin: LocalCommandHandler = async ({ state, args, runtime, authInputHost }) => {
  const { openPiLogin } = await import("./pi-auth.js");
  await openPiLogin(state, runtime, authInputHost, args || undefined);
  return undefined;
};

const handleLogout: LocalCommandHandler = async ({ state, runtime, authInputHost }) => {
  const { openPiLogout } = await import("./pi-auth.js");
  await openPiLogout(state, runtime, authInputHost);
  return undefined;
};

const handleFork: LocalCommandHandler = async ({ state, active, runtime }) => {
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
      preserveCallerTitle: true,
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
  runtime.renameSession(sessionId, tab.title);
  return undefined;
};

const handleTree: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  openTreeSelector(state, runtime as unknown as TreeSelectorRuntime, tui, active!.sessionId);
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleRename: LocalCommandHandler = ({ state, active, args, runtime }) => {
  renameAgentTab(state, active!.sessionId, args);
  runtime.renameSession(active!.sessionId, args);
  return undefined;
};

const handleModels: LocalCommandHandler = async ({ state, active, args, runtime, tui, onStateChanged }) => {
  if (!args.trim()) {
    state.picker = createPicker("models", state, active);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    await onStateChanged?.(state);
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  const model = findModelRef(state.availableModels, args);
  await applyModelSelection(state, active!, model, runtime);
};

const handleWorkdir: LocalCommandHandler = async ({ state, active, args, runtime, tui, onStateChanged }) => {
  if (!args.trim()) {
    state.picker = createPicker("workdir", state, active);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    await onStateChanged?.(state);
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  await applyWorkdirSelection(active!, args.trim(), runtime);
};

const handleThinking: LocalCommandHandler = async ({ state, active, args, runtime, tui, onStateChanged }) => {
  if (!args.trim()) {
    state.picker = createPicker("thinking", state, active);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    await onStateChanged?.(state);
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  applyThinkingLevel(state, active!, args.trim(), runtime);
};

const handleContextLimit: LocalCommandHandler = async ({
  state,
  active,
  args,
  runtime,
  tui,
  onStateChanged,
}) => {
  if (!args.trim()) {
    state.picker = createPicker("context-limit", state, active);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    await onStateChanged?.(state);
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  const value = parseContextLimitValue(args);
  if (value === undefined) {
    pushToast(active!, {
      type: "error",
      message: `Invalid context limit: "${args}". Use a number (e.g. 32k, 40000) or "reset".`,
    });
  } else {
    // Drive UI + live model.contextWindow + SDK compaction budgets so Pi and
    // extensions see the same window as the footer limit.
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (runtimeTab) {
      applyContextLimitToSession(active!, value, {
        model: runtimeTab.agentSession.model,
        settingsManager: runtimeTab.agentSession.settingsManager,
      });
    } else {
      applyContextLimit(active!, value);
    }
  }
};

const handleHotkeys: LocalCommandHandler = ({ state, active, runtime }) => {
  // Agent-tab only: Home has no chat surface for permanent shortcut dumps.
  if (state.activeTabId === "config") return SKIP_FINALIZE;
  const shortcuts = active ? getExtensionShortcuts(runtime, active.sessionId) : [];
  // Pi handleHotkeysCommand permanently appends Markdown (not showStatus).
  appendActiveSystemMessage(state, runtime, renderHotkeysText(shortcuts), "block");
};

const handleSystemPrompt: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  if (args.trim()) throw new Error("Usage: /system-prompt");
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  await editTextWithTuiPaused(tui, runtimeTab.agent.state.systemPrompt);
  return undefined;
};

const handleSystemTools: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const request = parseEditorFlag(args);
  const text = renderSystemToolsText(getRuntimeTools(runtime, active!.sessionId, runtimeTab));
  if (request.editorDisabled) {
    showTextOverlay(tui, text);
  } else {
    await editTextWithTuiPaused(tui, text, request.editor);
  }
  return undefined;
};

const handleSession: LocalCommandHandler = ({ state, active, runtime }) => {
  // Agent-tab only: session stats dump into the active chat.
  if (state.activeTabId === "config") return SKIP_FINALIZE;
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const info = runtimeTab.agentSession.getSessionStats();
  syncTabContextUsage(active!, info.contextUsage);
  // Pi handleSessionCommand adds a permanent plain Text child (not showStatus).
  runtime.appendSystemMessage(active!.sessionId, renderSessionInfoText(runtimeTab, info), "plain");
};

const handleExport: LocalCommandHandler = async ({ state, active, args, runtime }) => {
  // Pi handleExportCommand: .jsonl path → exportToJsonl, else HTML.
  if (state.activeTabId === "config") return SKIP_FINALIZE;
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
    pushToast(active!, { type: "error", message: `Failed to export session: ${message}` });
  }
};

const handleTuiState: LocalCommandHandler = async ({ state, args, tui }) => {
  const request = parseEditorFlag(args);
  const text = JSON.stringify(createTuiDebugState(state), null, 2);
  if (request.editorDisabled) {
    showTextOverlay(tui, text);
  } else {
    await editTextWithTuiPaused(tui, text, request.editor);
  }
  return undefined;
};

const handleQuit: LocalCommandHandler = async ({ runtime, tui }) => {
  await quitMixCode(runtime, tui, getConfiguredQuitOptions(tui));
  return undefined;
};

const handleCompact: LocalCommandHandler = async ({ active, args, runtime }) => {
  await runtime.compactSession(active!.sessionId, args);
  return undefined;
};

const LOCAL_COMMAND_HANDLERS = {
  models: handleModels,
  thinking: handleThinking,
  "context-limit": handleContextLimit,
  workdir: handleWorkdir,
  fork: handleFork,
  "follow-up": handleFollowUp,
  tree: handleTree,
  "close-session": handleCloseSession,
  "delete-session": handleDeleteSession,
  "close-all-sessions": handleCloseAllSessions,
  "delete-all-sessions": handleDeleteAllSessions,
  "save-workspace": handleSaveWorkspace,
  "restore-workspace": handleRestoreWorkspace,
  "delete-workspace": handleDeleteWorkspace,
  import: handleImport,
  "extension-manager": handleExtensionManager,
  reload: handleReload,
  "system-prompt": handleSystemPrompt,
  "system-tools": handleSystemTools,
  "toggle-hidden-messages": handleToggleHiddenMessages,
  "hide-thinking": handleHideThinking,
  settings: handleSettings,
  session: handleSession,
  export: handleExport,
  compact: handleCompact,
  clear: handleClear,
  "mark-done": handleMarkDone,
  vim: handleVim,
  "toggle-zen-mode": handleToggleZenMode,
  navigate: handleNavigate,
  "new-session": handleNewSession,
  resume: handleResume,
  login: handleLogin,
  logout: handleLogout,
  help: handleHotkeys,
  hotkeys: handleHotkeys,
  rename: handleRename,
  "tui-state": handleTuiState,
  quit: handleQuit,
  exit: handleQuit,
} satisfies Record<LocalCommand, LocalCommandHandler>;

const CONFIG_SCOPED_COMMANDS: ReadonlySet<LocalCommand> = new Set([
  "tui-state",
  "new-session",
  "resume",
  "hide-thinking",
  "settings",
  "delete-all-sessions",
  "close-all-sessions",
  "save-workspace",
  "restore-workspace",
  "delete-workspace",
  "extension-manager",
  "vim",
  "toggle-zen-mode",
  "login",
  "logout",
  "quit",
  "exit",
]);

function configScopedCommand(command: string | undefined): boolean {
  return isLocalCommand(command) && CONFIG_SCOPED_COMMANDS.has(command);
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
  runtimeTab: RuntimeTab,
): RuntimeToolInfo[] {
  const tools = runtime.getExtensionTools(sessionId) ?? runtimeTab.agentSession.getAllTools();
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

type SessionStatsInfo = ReturnType<RuntimeTab["agentSession"]["getSessionStats"]>;

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
  runtimeTab: RuntimeTab,
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

interface MixCodeTuiDebugState {
  version: 1;
  workdir: string;
  activeTabId: string;
  theme: string;
  overlays: {
    quitConfirmOpen: boolean;
    deleteAllSessionsConfirmOpen: boolean;
    closeAllSessionsConfirmOpen: boolean;
    sessionActionConfirm: MixCodeState["sessionActionConfirm"];
    commandPaletteOpen: boolean;
    commandPalette: MixCodeState["commandPalette"];
    tabJumpOpen: boolean;
    tabJumpQuery: string;
    tabJumpIndex: number;
    tabJumpNonIdleOnly: boolean;
    picker?: Omit<NonNullable<MixCodeState["picker"]>, "items"> & { itemCount: number };
  };
  tabs: Array<{
    index: number;
    sessionId: string;
    title: string;
    status: string;
    active: boolean;
    workdir: string;
    alias: string;
    thinkingLevel: string;
    pendingDialogCount: number;
    chatScrollOffset: number;
    previewOpen: boolean;
    previewIndex: number;
    previewScrollOffset: number;
    previewHint: string;
    unreadDone: boolean;
    pendingEscapeAction?: PendingEscapeAction;
    workingStartedAt?: string;
    lastWorkedDurationSeconds?: number;
    extensionUi: {
      statusCount: number;
      widgetCount: number;
      toolsExpanded: boolean;
      workingVisible: boolean;
      hasWorkingIndicatorFrames: boolean;
      workingIndicatorIntervalMs?: number;
      hasWorkingMessage: boolean;
      hasTitle: boolean;
      headerLineCount: number;
      footerLineCount: number;
    };
    inputMetaHitRegions?: MixCodeState["tabs"][number]["inputMetaHitRegions"];
  }>;
}

/** Snapshot used by /tui-state — only consumed in this module. */
function createTuiDebugState(state: MixCodeState): MixCodeTuiDebugState {
  return {
    version: 1,
    workdir: state.workdir,
    activeTabId: state.activeTabId,
    theme: state.theme,
    overlays: {
      quitConfirmOpen: state.quitConfirmOpen,
      deleteAllSessionsConfirmOpen: state.deleteAllSessionsConfirmOpen,
      closeAllSessionsConfirmOpen: state.closeAllSessionsConfirmOpen,
      sessionActionConfirm: state.sessionActionConfirm,
      commandPaletteOpen: state.commandPaletteOpen,
      commandPalette: state.commandPalette,
      tabJumpOpen: state.tabJumpOpen,
      tabJumpQuery: state.tabJumpQuery,
      tabJumpIndex: state.tabJumpIndex,
      tabJumpNonIdleOnly: state.tabJumpNonIdleOnly,
      picker: state.picker
        ? {
            kind: state.picker.kind,
            title: state.picker.title,
            query: state.picker.query,
            selectedIndex: state.picker.selectedIndex,
            workdirBase: state.picker.workdirBase,
            itemCount: state.picker.items.length,
          }
        : undefined,
    },
    tabs: state.tabs.map((tab) => ({
      index: tab.index,
      sessionId: tab.sessionId,
      title: tab.title,
      status: tab.status,
      active: tab.sessionId === state.activeTabId,
      workdir: tab.workdir,
      alias: tab.alias,
      thinkingLevel: tab.thinkingLevel,
      pendingDialogCount: tab.pendingDialogs.length,
      chatScrollOffset: tab.chatScrollOffset,
      previewOpen: tab.previewOpen,
      previewIndex: tab.previewIndex,
      previewScrollOffset: tab.previewScrollOffset,
      previewHint: tab.previewHint,
      unreadDone: tab.unreadDone,
      pendingEscapeAction: tab.pendingEscapeAction,
      workingStartedAt: tab.workingStartedAt,
      lastWorkedDurationSeconds: tab.lastWorkedDurationSeconds,
      extensionUi: {
        statusCount: tab.extensionUi.statuses.length,
        widgetCount: tab.extensionUi.widgets.length,
        toolsExpanded: tab.extensionUi.toolsExpanded,
        workingVisible: tab.extensionUi.workingVisible,
        hasWorkingIndicatorFrames: Boolean(tab.extensionUi.workingIndicatorFrames?.length),
        workingIndicatorIntervalMs: tab.extensionUi.workingIndicatorIntervalMs,
        hasWorkingMessage: Boolean(tab.extensionUi.workingMessage),
        hasTitle: Boolean(tab.extensionUi.title),
        headerLineCount: tab.extensionUi.header?.lines.length ?? 0,
        footerLineCount: tab.extensionUi.footer?.lines.length ?? 0,
      },
      inputMetaHitRegions: tab.inputMetaHitRegions,
    })),
  };
}
