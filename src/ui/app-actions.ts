import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { setTabModel } from "../core/models.js";
import { closeCommandPalette, closeTabJump } from "../core/overlays.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import type { MixCodeState } from "../core/types.js";
import {
  quitOverlayOptions,
  renderQuitConfirm,
  showLinesOverlay,
  showTransientTextOverlay,
} from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";

export {
  armPendingEscape,
  clearPendingEscape,
  hasPendingEscape,
  isPendingEscapeActive,
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
} from "../core/escape.js";

export function applyThinkingLevel(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  level: string,
  runtime?: Partial<Pick<MixCodeRuntime, "updateTabThinkingLevel">>,
): void {
  if (!isThinkingLevel(level)) throw new Error("Unknown thinking level: " + level);
  const effectiveLevel = runtime?.updateTabThinkingLevel
    ? runtime.updateTabThinkingLevel(active.sessionId, level)
    : level;
  active.thinkingLevel = effectiveLevel;
  state.thinkingLevel = effectiveLevel;
}

function isThinkingLevel(level: string): level is ThinkingLevel {
  return (
    level === "off" ||
    level === "minimal" ||
    level === "low" ||
    level === "medium" ||
    level === "high" ||
    level === "xhigh"
  );
}

export function openQuitConfirm(state: MixCodeState, tui: OverlayTui): void {
  state.quitConfirmOpen = true;
  state.exportChooserOpen = false;
  state.exportChooserIndex = 0;
  closeCommandPalette(state);
  closeTabJump(state);
  state.picker = undefined;
  showLinesOverlay(tui, (width) => renderQuitConfirm(width), quitOverlayOptions());
}

export function applyModelSelection(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  model: MixCodeState["model"],
  runtime?: Partial<Pick<MixCodeRuntime, "resolveModel" | "updateTabModel">>,
): void {
  const resolvedModel = runtime?.resolveModel?.(model.provider, model.modelId);
  if (runtime?.resolveModel && !resolvedModel)
    throw new Error("Model is not registered in runtime: " + model.displayName);
  if (runtime?.updateTabModel && resolvedModel)
    runtime.updateTabModel(active.sessionId, resolvedModel);
  else setTabModel(active, model);
  state.model = model;
}

export function applyWorkdirSelection(
  active: MixCodeState["tabs"][number],
  workdir: string,
  runtime?: Partial<Pick<MixCodeRuntime, "updateTabWorkdir">>,
): void | Promise<void> {
  if (runtime?.updateTabWorkdir)
    return runtime.updateTabWorkdir(active.sessionId, workdir, MIXCODE_SYSTEM_PROMPT);
  active.workdir = workdir;
}

export function appendActiveSystemMessage(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "appendSystemMessage">,
  message: string,
): void {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (!active) throw new Error("No active tab for system message");
  runtime.appendSystemMessage(active.sessionId, message);
}

export function showSystemMessageOrToast(
  state: MixCodeState,
  runtime: Partial<Pick<MixCodeRuntime, "appendSystemMessage">>,
  tui: OverlayTui,
  message: string,
): void {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (!active || state.activeTabId === "config" || !runtime.appendSystemMessage) {
    showTransientTextOverlay(tui, message);
    return;
  }
  runtime.appendSystemMessage(active.sessionId, message);
}

export async function closeRuntimeAndStop(
  runtime: MixCodeKeyRuntime | undefined,
  tui: OverlayTui,
): Promise<void> {
  if (!tui.stop) throw new Error("Quit command requires TUI stop support");
  if (runtime?.closeAllTabs) await runtime.closeAllTabs();
  tui.stop();
  tui.requestRender();
}
