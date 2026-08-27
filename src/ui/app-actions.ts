import * as fs from "node:fs";
import * as path from "node:path";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { normalizeWorkdirInput } from "../core/pickers.js";
import {
  applyDisabledModelFlags,
  assertModelEnabled,
  buildAvailableModelRefs,
  isModelRefAvailable,
  normalizeModelRef,
  setStateModel,
  setTabModel,
} from "../core/models.js";
import { loadMixCodeSettings } from "../core/mixcode-settings.js";
import { configureDisabledModelRuntime } from "../core/pi-models.js";
import { DEFAULT_MODEL_REF } from "../core/defaults.js";
import { closeActiveOverlay, openOverlay } from "../core/overlays.js";
import { closeTreeSelector } from "./components/tree-selector.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { getActiveTab } from "../core/tabs.js";
import { isThinkingLevelAvailable, validThinkingLevelsMessage } from "../core/thinking-levels.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState } from "../core/types.js";
import {
  quitOverlayOptions,
  renderCloseAllSessionsConfirm,
  renderDeleteAllSessionsConfirm,
  renderQuitConfirm,
  showLinesOverlay,
  syncOwnedAppOverlay,
} from "./app-overlays.js";
import type { OverlayTui } from "./app-types.js";
import { themeForId } from "./themes.js";

export function applyThinkingLevel(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  level: string,
  runtime?: Pick<MixCodeRuntime, "updateTabThinkingLevel">,
): void {
  if (!isThinkingLevelAvailable(level, active.model)) {
    throw new Error(
      `Error: Unknown thinking level: ${level}. Valid values: ${validThinkingLevelsMessage(active.model)}`,
    );
  }
  const effectiveLevel = runtime ? runtime.updateTabThinkingLevel(active.sessionId, level) : level;
  active.thinkingLevel = effectiveLevel;
  state.thinkingLevel = effectiveLevel;
}

/** Unload Session Tree editor before state-only closeActiveOverlay paths. */
function closeTreeSelectorIfOpen(state: MixCodeState, tui: OverlayTui): void {
  if (state.treeSelector.open) closeTreeSelector(state, tui);
}

export function openQuitConfirm(state: MixCodeState, tui: OverlayTui): void {
  // openOverlay only flips treeSelector.open; unload the editor replacement first
  // so cancel-quit does not leave a dead Session Tree in the input slot.
  closeTreeSelectorIfOpen(state, tui);
  openOverlay(state, "quit-confirm");
  showLinesOverlay(
    tui,
    (width) => renderQuitConfirm(width, themeForId(state.theme)),
    quitOverlayOptions(),
  );
}

export function openDeleteAllSessionsConfirm(state: MixCodeState, tui: OverlayTui): void {
  // Same mutual-exclusion + centered-panel mechanism as openQuitConfirm, guarding
  // /delete-all-sessions (a destructive, hard-to-undo action) behind a Y/N step.
  closeTreeSelectorIfOpen(state, tui);
  openOverlay(state, "delete-all-sessions-confirm");
  showLinesOverlay(
    tui,
    (width) => renderDeleteAllSessionsConfirm(width, themeForId(state.theme)),
    quitOverlayOptions(),
  );
}

export function openCloseAllSessionsConfirm(state: MixCodeState, tui: OverlayTui): void {
  // Same shape as openDeleteAllSessionsConfirm, but for the non-destructive
  // /close-all-sessions (tabs close, session files are kept).
  closeTreeSelectorIfOpen(state, tui);
  openOverlay(state, "close-all-sessions-confirm");
  showLinesOverlay(
    tui,
    (width) => renderCloseAllSessionsConfirm(width, themeForId(state.theme)),
    quitOverlayOptions(),
  );
}

export function openSessionActionConfirm(
  state: MixCodeState,
  tui: OverlayTui,
  action: "close" | "delete",
  tab: MixCodeState["tabs"][number],
): void {
  closeTreeSelectorIfOpen(state, tui);
  closeActiveOverlay(state);
  state.sessionActionConfirm = { action, sessionId: tab.sessionId };
  syncOwnedAppOverlay(state, tui);
}

export async function applyModelSelection(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  model: MixCodeState["model"],
  runtime?: Pick<MixCodeRuntime, "resolveModel" | "updateTabModel">,
): Promise<void> {
  assertModelEnabled(model);
  if (runtime) {
    const resolvedModel = runtime.resolveModel(model.provider, model.modelId);
    if (!resolvedModel) throw new Error("Model is not registered in runtime: " + model.displayName);
    await runtime.updateTabModel(active.sessionId, resolvedModel);
  }
  setTabModel(active, model);
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
export type ModelReloadResult = { ok: true } | { ok: false; error: string };

export async function reloadRuntimeModels(
  state: MixCodeState,
  runtime: Pick<
    MixCodeRuntime,
    | "reloadModelConfig"
    | "resolveModel"
    | "updateTabModel"
    | "getSharedModelRuntime"
    | "refreshScopedModels"
  >,
  options?: { mixcodeFile?: string },
): Promise<ModelReloadResult> {
  const configured = await runtime.reloadModelConfig();
  // Pi keeps parse/schema/provider failures on ModelRuntime.getError() instead of throwing.
  const modelRuntime = runtime.getSharedModelRuntime();
  // Re-read mixcode disabled lists on /reload so /settings writes take effect.
  if (options?.mixcodeFile) {
    const mixcode = await loadMixCodeSettings(options.mixcodeFile);
    state.disabledProviders = mixcode.disabledProviders;
    state.disabledModels = mixcode.disabledModels;
  }
  if (modelRuntime) {
    configureDisabledModelRuntime(modelRuntime, state.disabledProviders, state.disabledModels);
    // Live sessions hold a scope snapshot; hand them the reloaded denylist.
    runtime.refreshScopedModels();
  }
  const modelError = modelRuntime?.getError?.();
  if (modelError) {
    state.availableModels = applyDisabledModelFlags(
      state.availableModels,
      state.disabledProviders,
      state.disabledModels,
    );
    setStateModel(
      state,
      applyDisabledModelFlags([state.model], state.disabledProviders, state.disabledModels)[0]!,
    );
    state.tabs.forEach((tab) =>
      setTabModel(
        tab,
        applyDisabledModelFlags([tab.model], state.disabledProviders, state.disabledModels)[0]!,
      ),
    );
    return { ok: false, error: modelError };
  }
  const availableModels = applyDisabledModelFlags(
    buildAvailableModelRefs(configured),
    state.disabledProviders,
    state.disabledModels,
  );
  const preferred = applyDisabledModelFlags(
    [configured.at(-1) ?? { ...DEFAULT_MODEL_REF }],
    state.disabledProviders,
    state.disabledModels,
  )[0]!;
  // Keep disabled current models (do not auto-switch); only repair truly missing ones.
  const nextStateModel = isModelRefAvailable(availableModels, state.model)
    ? normalizeModelRef(availableModels, state.model)
    : preferred;
  const repairs = state.tabs.map((tab) =>
    isModelRefAvailable(availableModels, tab.model)
      ? normalizeModelRef(availableModels, tab.model)
      : nextStateModel,
  );
  // The active tab is the one /reload operates on (mirrors the submit handler:
  // activeTabId may be HOME_TAB_ID, in which case the first tab is treated active).
  const active = getActiveTab(state);
  if (active && runtime.updateTabModel && runtime.resolveModel) {
    const activeIndex = state.tabs.indexOf(active);
    const repaired = repairs[activeIndex]!;
    // Skip runtime model swap when the repaired selection is disabled; send path will reject.
    if (!repaired.disabled) {
      const resolved = runtime.resolveModel(repaired.provider, repaired.modelId);
      if (resolved) await runtime.updateTabModel(active.sessionId, resolved);
    }
  }
  state.availableModels = availableModels;
  setStateModel(state, nextStateModel);
  state.tabs.forEach((tab, index) => setTabModel(tab, repairs[index]!));
  return { ok: true };
}

export function applyWorkdirSelection(
  active: MixCodeState["tabs"][number],
  workdir: string,
  runtime?: Pick<MixCodeRuntime, "updateTabWorkdir">,
): void | Promise<void> {
  // Relative paths resolve against the current agent workdir (same as picker).
  const resolved = normalizeWorkdirInput(active.workdir, workdir);
  // Skip the expensive teardown/rebuild if the resolved path is unchanged.
  if (path.resolve(resolved) === path.resolve(active.workdir)) {
    pushToast(active, { type: "info", message: "workdir unchanged" });
    return;
  }
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    pushToast(active, {
      type: "error",
      message: `workdir not found or not a directory: ${resolved}`,
    });
    return;
  }
  if (runtime) return runtime.updateTabWorkdir(active.sessionId, resolved, MIXCODE_SYSTEM_PROMPT);
  active.workdir = resolved;
}

export function appendActiveSystemMessage(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "appendSystemMessage">,
  message: string,
  kind?: Parameters<MixCodeRuntime["appendSystemMessage"]>[2],
): void {
  const active = getActiveTab(state);
  if (!active) throw new Error("No active tab for system message");
  runtime.appendSystemMessage(active.sessionId, message, kind);
}
