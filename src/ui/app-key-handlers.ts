import { matchesKey, type TUI as TuiType } from "@earendil-works/pi-tui";
import {
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  chatEnd,
  chatHome,
  closeCommandPalette,
  closeTabJump,
  commandPaletteEntriesWithExtensions,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  navigatePreview,
  previewEnd,
  previewHome,
  scrollChat,
  scrollPreview,
  scrollShell,
  updateCommandPaletteQueryWithExtensions,
  updateTabJumpQuery,
} from "../core/overlays.js";
import {
  buildQuestionAnswerPrompt,
  buildQuestionRejectionPrompt,
  moveQuestion,
  moveQuestionOption,
  toggleCurrentQuestionOption,
} from "../core/questions.js";
import type { MixCodeState } from "../core/types.js";
import {
  armPendingEscape,
  clearPendingEscape,
  closeRuntimeAndStop,
  hasPendingEscape,
} from "./app-actions.js";
import {
  closeAppOverlay,
  editTextWithTuiPaused,
  hasAnyOverlay,
  showErrorOverlay,
  showLinesOverlay,
  showTransientTextOverlay,
} from "./app-overlays.js";
import { renderExportText } from "./app-submit.js";
import type {
  CommandPaletteActions,
  ExportChooserActions,
  MixCodeKeyRuntime,
  OverlayTui,
  ShellKeyManager,
} from "./app-types.js";
import { renderCommandPalette, renderExportChooser, renderTabJumpOverlay } from "./rendering.js";

export { handleChromeMouseInput, handleMouseInput } from "./app-mouse.js";
export function handleStreamingAbortKey(
  active: MixCodeState["tabs"][number],
  tui: Pick<TuiType, "requestRender">,
  runtime?: MixCodeKeyRuntime,
): boolean {
  const runtimeTab = runtime?.getTab?.(active.sessionId);
  const isAgentStreaming = runtimeTab?.agent.state.isStreaming;
  const streaming =
    isAgentStreaming ?? (active.status === "running" || active.status === "thinking");
  // Also treat tab as "working" if status is running even when agent is not streaming
  // (e.g., branch summarization in progress)
  const working = streaming || (isAgentStreaming === false && active.status === "running");
  if (!working) return false;
  if (!hasPendingEscape(active, "abort-agent")) {
    armPendingEscape(active, "abort-agent");
    tui.requestRender();
    return true;
  }
  if (!runtime?.abortTab)
    throw new Error("Stopping an active agent requires runtime abort support");
  runtime.abortTab(active.sessionId);
  clearPendingEscape(active, "abort-agent");
  tui.requestRender();
  return true;
}

export function handleQueuedFlushKey(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  isEditorAutocompleteOpen: () => boolean,
): boolean {
  if (!matchesKey(data, "escape")) return false;
  if (state.activeTabId === "config") return false;
  if (hasAnyOverlay(tui) || isEditorAutocompleteOpen()) return false;
  if (active.shellOpen || active.previewOpen || active.pendingQuestions.length > 0) return false;
  const runtimeTab = runtime?.getTab?.(active.sessionId);
  const runtimeQueuedCount = runtimeQueuedMessageCount(runtimeTab);
  if (active.pendingMessages.length === 0 && runtimeQueuedCount === 0) return false;
  const streaming =
    runtimeTab?.agent.state.isStreaming ??
    (active.status === "running" || active.status === "thinking");
  if (!runtime?.flushPendingMessage)
    throw new Error("Flushing queued messages requires runtime queue support");
  if (streaming) {
    if (!runtime.abortTab)
      throw new Error(
        "Flushing queued messages from an active agent requires runtime abort support",
      );
    runtime.abortTab(active.sessionId);
  }
  clearPendingEscape(active, "abort-agent");
  void runtime
    .flushPendingMessage(active.sessionId, runtimeQueuedCount || undefined)
    .then(() => {
      tui.requestRender();
    })
    .catch((error: unknown) => {
      showErrorOverlay(tui, error);
    });
  tui.requestRender();
  return true;
}

function runtimeQueuedMessageCount(
  runtimeTab: ReturnType<NonNullable<MixCodeKeyRuntime["getTab"]>> | undefined,
): number {
  const queuedPromptCount =
    typeof runtimeTab?.queuedPromptCount === "number" ? runtimeTab.queuedPromptCount : 0;
  const steeringCount = runtimeTab?.agentSession?.getSteeringMessages().length ?? 0;
  return Math.max(queuedPromptCount, steeringCount);
}

export function handleQuitConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
): boolean {
  if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
    state.quitConfirmOpen = false;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (data.toLowerCase() === "y") {
    state.quitConfirmOpen = false;
    closeAppOverlay(tui);
    void closeRuntimeAndStop(runtime, tui).catch((error: unknown) => {
      showErrorOverlay(tui, error);
    });
    tui.requestRender();
    return true;
  }
  return true;
}
export function canOpenCommandPalette(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  tui: OverlayTui,
  isEditorAutocompleteOpen: () => boolean,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): boolean {
  if (isEditorAutocompleteOpen()) return false;
  if (hasAnyOverlay(tui)) return false;
  if (state.picker || state.sessionSelector.open || state.treeSelector.open || state.tabJumpOpen || state.exportChooserOpen)
    return false;
  if (active?.previewOpen || active?.pendingQuestions.length) return false;
  return commandPaletteEntriesWithExtensions(state, extensionCommands).length > 0;
}

export function handleCommandPaletteKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  commandPaletteActions?: CommandPaletteActions,
): boolean {
  const extensionCommands = commandPaletteActions?.extensionCommands?.() ?? [];
  if (matchesKey(data, "escape")) {
    closeCommandPalette(state);
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    moveCommandPaletteSelection(state, matchesKey(data, "shift+tab") ? -1 : 1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (matchesKey(data, "enter")) {
    const entries = commandPaletteEntriesWithExtensions(state, extensionCommands);
    const selected =
      entries[
        Math.min(Math.max(state.commandPalette.selectedIndex, 0), Math.max(0, entries.length - 1))
      ];
    if (selected && !selected.enabled) {
      closeCommandPalette(state);
      closeAppOverlay(tui);
      showTransientTextOverlay(tui, selected.disabledReason || "Command unavailable");
      tui.requestRender();
      return true;
    }
    if (selected && !commandPaletteActions?.executeCommand) {
      throw new Error("Command palette selection requires command execution support");
    }
    const command = acceptCommandPaletteSelection(state, extensionCommands);
    closeAppOverlay(tui);
    if (command) {
      void Promise.resolve(commandPaletteActions!.executeCommand(command)).catch(
        (error: unknown) => {
          showErrorOverlay(tui, error);
          tui.requestRender();
        },
      );
    }
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveCommandPaletteSelection(state, 1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (matchesKey(data, "up")) {
    moveCommandPaletteSelection(state, -1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (data === "\u007f") {
    updateCommandPaletteQueryWithExtensions(
      state,
      state.commandPalette.query.slice(0, -1),
      extensionCommands,
    );
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (/^[\x20-\x7e]$/.test(data)) {
    updateCommandPaletteQueryWithExtensions(
      state,
      state.commandPalette.query + data,
      extensionCommands,
    );
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  return false;
}

export function handleTabJumpKey(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  if (matchesKey(data, "escape")) {
    closeTabJump(state);
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    moveTabJumpSelection(state, matchesKey(data, "shift+tab") ? -1 : 1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    const prev = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
    const targetId = acceptTabJumpSelection(state);
    // Transfer vim mode to the target tab when jumping
    if (prev?.vimMode && targetId && targetId !== prev.sessionId) {
      prev.vimMode = false;
      prev.vimPendingEscapeAt = undefined;
      prev.vimPendingHome = false;
      const next = state.tabs.find((tab) => tab.sessionId === targetId);
      if (next) {
        next.vimMode = true;
        next.vimPendingEscapeAt = undefined;
        next.vimPendingHome = false;
      }
    }
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveTabJumpSelection(state, 1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "up")) {
    moveTabJumpSelection(state, -1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (data === "\u007f") {
    updateTabJumpQuery(state, state.tabJumpQuery.slice(0, -1));
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (/^[\x20-\x7e]$/.test(data)) {
    updateTabJumpQuery(state, state.tabJumpQuery + data);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  return false;
}

export function handleExportChooserKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  actions: ExportChooserActions = {},
): boolean {
  if (matchesKey(data, "escape")) {
    state.exportChooserOpen = false;
    state.exportChooserIndex = 0;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down") || matchesKey(data, "tab")) {
    moveExportChooserSelection(state, 1);
    showLinesOverlay(tui, (width) => renderExportChooser(state, width));
    return true;
  }
  if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
    moveExportChooserSelection(state, -1);
    showLinesOverlay(tui, (width) => renderExportChooser(state, width));
    return true;
  }
  const target = matchesKey(data, "enter")
    ? exportTargetAt(state.exportChooserIndex)
    : exportTargetForKey(data);
  if (!target) return false;
  if (!runtime?.getTab) throw new Error("Export chooser requires runtime tab access");
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (!active) throw new Error("No active tab for export");
  const runtimeTab = runtime.getTab(active.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active.sessionId}`);
  state.exportChooserOpen = false;
  state.exportChooserIndex = 0;
  closeAppOverlay(tui);
  void editTextWithTuiPaused(tui, renderExportText(target, runtimeTab), actions.editor)
    .then(() => {
      tui.requestRender();
    })
    .catch((error: unknown) => {
      showErrorOverlay(tui, error);
      tui.requestRender();
    });
  tui.requestRender();
  return true;
}

function moveExportChooserSelection(state: MixCodeState, delta: number): void {
  const total = 5;
  state.exportChooserIndex = (state.exportChooserIndex + delta + total) % total;
}

function exportTargetAt(index: number): string {
  return ["thinking", "chatlog", "latest-agent", "latest-user", "system-info"][
    Math.min(Math.max(index, 0), 4)
  ]!;
}

function exportTargetForKey(data: string): string | undefined {
  const key = data.toLowerCase();
  if (key === "t") return "thinking";
  if (key === "c") return "chatlog";
  if (key === "a") return "latest-agent";
  if (key === "u") return "latest-user";
  if (key === "s") return "system-info";
  return undefined;
}

export function handleQuestionKey(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  data: string,
  tui: Pick<TuiType, "requestRender" | "showOverlay"> & Partial<Pick<TuiType, "stop">>,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const request = active.pendingQuestions[0];
  if (!request) return false;
  if (request.editingCustomIndex !== undefined) {
    return handleQuestionCustomEditKey(request, data, tui);
  }
  if (matchesKey(data, "escape")) {
    if (hasPendingEscape(active, "reject-question")) {
      submitQuestionResponse(state, active, "reject", tui, runtime, onStateChanged);
    } else {
      armPendingEscape(active, "reject-question");
      tui.requestRender();
    }
    return true;
  }
  clearPendingEscape(active, "reject-question");
  if (matchesQuestionArrowKey(data, "left") || data === "h") {
    active.previewPendingHome = false;
    if (request.currentQuestionIndex > 0) moveQuestion(request, -1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "right") || data === "l") {
    active.previewPendingHome = false;
    if (request.currentQuestionIndex < request.questions.length - 1) moveQuestion(request, 1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "down") || data === "j") {
    active.previewPendingHome = false;
    moveQuestionOption(request, 1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "up") || data === "k") {
    active.previewPendingHome = false;
    moveQuestionOption(request, -1);
    tui.requestRender();
    return true;
  }
  if (request.extensionResolverId && (data === " " || matchesKey(data, "enter"))) {
    active.previewPendingHome = false;
    submitQuestionResponse(state, active, "answer", tui, runtime, onStateChanged);
    return true;
  }
  if (data === " " || matchesKey(data, "enter")) {
    active.previewPendingHome = false;
    toggleCurrentQuestionOption(request);
    tui.requestRender();
    return true;
  }
  if (data === "y" || data === "n") {
    submitQuestionResponse(
      state,
      active,
      data === "y" ? "answer" : "reject",
      tui,
      runtime,
      onStateChanged,
    );
    return true;
  }
  return false;
}

function handleQuestionCustomEditKey(
  request: NonNullable<MixCodeState["tabs"][number]["pendingQuestions"][number]>,
  data: string,
  tui: Pick<TuiType, "requestRender">,
): boolean {
  const index = request.editingCustomIndex;
  if (index === undefined) return false;
  if (matchesQuestionArrowKey(data, "up")) {
    request.editingCustomIndex = undefined;
    moveQuestionOption(request, -1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "down")) {
    request.editingCustomIndex = undefined;
    moveQuestionCustomEditSelection(request, index, 1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "left")) {
    request.editingCustomIndex = undefined;
    if (request.currentQuestionIndex > 0) moveQuestion(request, -1);
    tui.requestRender();
    return true;
  }
  if (matchesQuestionArrowKey(data, "right")) {
    request.editingCustomIndex = undefined;
    if (request.currentQuestionIndex < request.questions.length - 1) moveQuestion(request, 1);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    request.editingCustomIndex = undefined;
    moveQuestionOption(request, matchesKey(data, "shift+tab") ? -1 : 1);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
    request.editingCustomIndex = undefined;
    tui.requestRender();
    return true;
  }
  if (data === "\u007f") {
    request.customAnswers[index] = (request.customAnswers[index] ?? "").slice(0, -1);
    request.dirty = true;
    tui.requestRender();
    return true;
  }
  if (/^[\x20-\x7e]$/.test(data)) {
    request.customAnswers[index] = `${request.customAnswers[index] ?? ""}${data}`;
    request.dirty = true;
    tui.requestRender();
    return true;
  }
  return true;
}

function matchesQuestionArrowKey(data: string, key: "up" | "down" | "left" | "right"): boolean {
  if (matchesKey(data, key)) return true;
  const finalByte: Record<typeof key, string> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
  };
  return (
    data === `\x1b[1${finalByte[key]}` || new RegExp(`^\\x1b\\[1;\\d+${finalByte[key]}$`).test(data)
  );
}

function moveQuestionCustomEditSelection(
  request: NonNullable<MixCodeState["tabs"][number]["pendingQuestions"][number]>,
  index: number,
  delta: number,
): void {
  const question = request.questions[index];
  if (!question) throw new Error(`Question index out of range: ${index}`);
  const selectableCount = question.options.length + (question.custom ? 1 : 0);
  const current = request.highlightedOptionIndices[index] ?? 0;
  if (delta > 0 && selectableCount > 1 && current >= selectableCount - 1) {
    request.highlightedOptionIndices[index] = 0;
    return;
  }
  moveQuestionOption(request, delta);
}

function submitQuestionResponse(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  mode: "answer" | "reject",
  tui: Pick<TuiType, "requestRender" | "showOverlay">,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): void {
  const request = active.pendingQuestions[0];
  if (!request) return;
  if (request.extensionResolverId) {
    if (!runtime?.resolveExtensionDialog)
      throw new Error("Extension dialog submission requires runtime resolver support");
    const result = mode === "answer" ? extensionDialogResult(request) : undefined;
    runtime.resolveExtensionDialog(active.sessionId, request.extensionResolverId, result);
    clearPendingEscape(active, "reject-question");
    void onStateChanged?.(state);
    tui.requestRender();
    return;
  }
  if (!runtime?.prompt) throw new Error("Question submission requires runtime prompt support");
  const prompt =
    mode === "answer" ? buildQuestionAnswerPrompt(request) : buildQuestionRejectionPrompt(request);
  void runtime
    .prompt(active.sessionId, prompt)
    .then(async () => {
      active.pendingQuestions.shift();
      clearPendingEscape(active, "reject-question");
      await onStateChanged?.(state);
      tui.requestRender();
    })
    .catch((error: unknown) => {
      showErrorOverlay(tui, error);
      tui.requestRender();
    });
}

function extensionDialogResult(
  request: NonNullable<MixCodeState["tabs"][number]["pendingQuestions"][number]>,
): string | boolean | undefined {
  const index = request.currentQuestionIndex;
  const selected = request.selectedAnswers[index] ?? [];
  const custom = request.customAnswers[index] ?? "";
  if (request.extensionUiKind === "input") return custom;
  if (request.extensionUiKind === "confirm")
    return selected[0] ?? request.questions[index]?.options[0]?.label;
  if (request.extensionUiKind === "select")
    return (
      selected[0] ??
      request.questions[index]?.options[request.highlightedOptionIndices[index] ?? 0]?.label
    );
  return selected[0];
}

export function handleShellKey(
  active: MixCodeState["tabs"][number],
  data: string,
  shellManager?: ShellKeyManager,
): boolean {
  if (matchesKey(data, "escape")) {
    shellManager?.close?.(active);
    if (!shellManager?.close) active.shellOpen = false;
    clearPendingEscape(active, "close-shell");
    return true;
  }
  if (matchesKey(data, "up")) return scrollShell(active, -3);
  if (matchesKey(data, "down")) return scrollShell(active, 3);
  if (matchesKey(data, "pageUp")) return scrollShell(active, -10);
  if (matchesKey(data, "pageDown")) return scrollShell(active, 10);
  if (matchesKey(data, "home")) return scrollShell(active, Number.NEGATIVE_INFINITY);
  if (matchesKey(data, "end")) return scrollShell(active, Number.POSITIVE_INFINITY);
  clearPendingEscape(active, "close-shell");
  return shellManager?.write(active, data) ?? false;
}

export function handlePreviewKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (matchesKey(data, "escape")) {
    active.previewPendingHome = false;
    active.previewOpen = false;
    return true;
  }
  if (matchesKey(data, "left") || data === "h") {
    active.previewPendingHome = false;
    return navigatePreview(active, -1);
  }
  if (matchesKey(data, "right") || data === "l") {
    active.previewPendingHome = false;
    return navigatePreview(active, 1);
  }
  if (matchesKey(data, "down") || data === "j") {
    active.previewPendingHome = false;
    return scrollPreview(active, 3);
  }
  if (matchesKey(data, "up") || data === "k") {
    active.previewPendingHome = false;
    return scrollPreview(active, -3);
  }
  if (matchesKey(data, "end") || data === "G") {
    active.previewPendingHome = false;
    return previewEnd(active);
  }
  if (matchesKey(data, "home") || (data === "g" && active.previewPendingHome)) {
    active.previewPendingHome = false;
    return previewHome(active);
  }
  if (data === "g") {
    active.previewPendingHome = true;
    return true;
  }
  return false;
}

export function handleVimModeKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (!active.vimMode) return false;
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) return false;
  if (matchesKey(data, "ctrl+t")) return false;
  if (data === "q") {
    active.vimMode = false;
    active.vimPendingEscapeAt = undefined;
    active.vimPendingHome = false;
    return true;
  }
  active.vimPendingEscapeAt = undefined;
  if (data === "g" && active.vimPendingHome) {
    active.vimPendingHome = false;
    return chatHome(active);
  }
  if (data === "g") {
    active.vimPendingHome = true;
    return true;
  }
  active.vimPendingHome = false;
  if (matchesKey(data, "up") || data === "k") return scrollChat(active, 3);
  if (matchesKey(data, "down") || data === "j") return scrollChat(active, -3);
  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) return scrollChat(active, 10);
  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) return scrollChat(active, -10);
  if (matchesKey(data, "home")) return chatHome(active);
  if (matchesKey(data, "end") || data === "G") return chatEnd(active);
  return true;
}

export function handleChatScrollKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (matchesKey(data, "pageUp")) return scrollChat(active, 10);
  if (matchesKey(data, "pageDown")) return scrollChat(active, -10);
  if (matchesKey(data, "home")) return chatHome(active);
  if (matchesKey(data, "end")) return chatEnd(active);
  return false;
}
