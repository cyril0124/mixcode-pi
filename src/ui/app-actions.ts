import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import {
  buildAvailableModelRefs,
  isModelRefAvailable,
  normalizeModelRef,
  setStateModel,
  setTabModel,
} from "../core/models.js";
import { DEFAULT_MODEL_REF } from "../core/defaults.js";
import { openOverlay } from "../core/overlays.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { getActiveTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState } from "../core/types.js";
import {
  quitOverlayOptions,
  renderQuitConfirm,
  showLinesOverlay,
  showNoticeTextOverlay,
} from "./app-overlays.js";
import type { OverlayTui } from "./app-types.js";
import { shutdownRuntimeAndStopTui, type RuntimeQuitTarget } from "./quit.js";
import { themeForId } from "./themes.js";

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
  // openOverlay enforces mutual exclusion (closes any active overlay first).
  openOverlay(state, "quit-confirm");
  showLinesOverlay(tui, (width) => renderQuitConfirm(width, themeForId(state.theme)), quitOverlayOptions());
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

/**
 * Re-read model configuration from disk and reconcile it into UI state.
 *
 * Runs after a /reload: asks the runtime to refresh models.json, then rebuilds
 * the selectable list and repairs any selected model (global + per-tab) that no
 * longer exists. The active tab's runtime session is updated in place so the
 * agent immediately uses the repaired model. Returns true when the runtime
 * actually performed a model reload (i.e. a registry was wired).
 */
export function reloadRuntimeModels(
  state: MixCodeState,
  runtime: Partial<Pick<MixCodeRuntime, "reloadModelConfig" | "resolveModel" | "updateTabModel">>,
): boolean {
  if (!runtime.reloadModelConfig) return false;
  const configured = runtime.reloadModelConfig();
  state.availableModels = buildAvailableModelRefs(configured);
  const preferred = configured.at(-1) ?? { ...DEFAULT_MODEL_REF };
  const nextStateModel = isModelRefAvailable(state.availableModels, state.model)
    ? normalizeModelRef(state.availableModels, state.model)
    : preferred;
  setStateModel(state, nextStateModel);
  // The active tab is the one /reload operates on (mirrors the submit handler:
  // activeTabId may be "config", in which case the first tab is treated active).
  const active = getActiveTab(state);
  for (const tab of state.tabs) {
    const repaired = isModelRefAvailable(state.availableModels, tab.model)
      ? normalizeModelRef(state.availableModels, tab.model)
      : nextStateModel;
    // Always update persisted state so background tabs reflect the repair too.
    setTabModel(tab, repaired);
    // Additionally sync the active tab's live runtime agent. Reload is blocked
    // while that tab streams, so updateTabModel is safe here.
    if (tab === active && runtime.updateTabModel && runtime.resolveModel) {
      const resolved = runtime.resolveModel(repaired.provider, repaired.modelId);
      if (resolved) runtime.updateTabModel(tab.sessionId, resolved);
    }
  }
  return true;
}

export function applyWorkdirSelection(
  active: MixCodeState["tabs"][number],
  workdir: string,
  runtime?: Partial<Pick<MixCodeRuntime, "updateTabWorkdir">>,
): void | Promise<void> {
  // Skip the expensive teardown/rebuild if the resolved path is unchanged.
  if (path.resolve(workdir) === path.resolve(active.workdir)) {
    pushToast(active, { type: "info", message: "workdir unchanged" });
    return;
  }
  if (runtime?.updateTabWorkdir)
    return runtime.updateTabWorkdir(active.sessionId, workdir, MIXCODE_SYSTEM_PROMPT);
  active.workdir = workdir;
}

export function appendActiveSystemMessage(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "appendSystemMessage">,
  message: string,
): void {
  const active = getActiveTab(state);
  if (!active) throw new Error("No active tab for system message");
  runtime.appendSystemMessage(active.sessionId, message);
}

export function showSystemMessageOrToast(
  state: MixCodeState,
  runtime: Partial<Pick<MixCodeRuntime, "appendSystemMessage">>,
  tui: OverlayTui,
  message: string,
): void {
  const active = getActiveTab(state);
  if (!active || state.activeTabId === "config" || !runtime.appendSystemMessage) {
    showNoticeTextOverlay(tui, message);
    return;
  }
  runtime.appendSystemMessage(active.sessionId, message);
}

export async function closeRuntimeAndStop(
  runtime: RuntimeQuitTarget | undefined,
  tui: OverlayTui,
): Promise<void> {
  await shutdownRuntimeAndStopTui(runtime, tui);
  tui.requestRender();
}
