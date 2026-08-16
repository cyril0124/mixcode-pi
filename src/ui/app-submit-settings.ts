import { reloadMixCodeUserKeybindings } from "../agent/runtime-extension-theme.js";
import type { LocalCommand } from "../core/commands.js";
import {
  applyContextLimit,
  applyContextLimitToSession,
  parseContextLimitValue,
} from "../core/context-limit.js";
import { findModelRef } from "../core/models.js";
import { createPicker } from "../core/pickers.js";
import { pushToast } from "../core/toast.js";
import {
  appendActiveSystemMessage,
  applyModelSelection,
  applyThinkingLevel,
  reloadRuntimeModels,
} from "./app-actions.js";
import { showLinesOverlay } from "./app-overlays.js";
import { type LocalCommandHandler, SKIP_FINALIZE } from "./app-types.js";
import { openExtensionManager } from "./extension-manager.js";
import { clearConversationCache, renderPickerOverlay } from "./rendering.js";
import { openSettingsPanel } from "./settings-panel.js";

const handleModels: LocalCommandHandler = async ({
  state,
  active,
  args,
  runtime,
  tui,
  onStateChanged,
}) => {
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

const handleThinking: LocalCommandHandler = async ({
  state,
  active,
  args,
  runtime,
  tui,
  onStateChanged,
}) => {
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

const handleHideThinking: LocalCommandHandler = async ({ state, active, runtime, tui }) => {
  // Persist before changing live state so a failed global write cannot report success.
  const hide = !(state.hideThinkingBlock ?? false);
  try {
    await runtime.setHideThinkingBlock(hide);
  } catch (error) {
    appendActiveSystemMessage(
      state,
      runtime,
      `Hide thinking failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  state.hideThinkingBlock = hide;
  for (const tab of state.tabs) clearConversationCache(tab.sessionId);
  const message = hide ? "Thinking blocks: hidden" : "Thinking blocks: visible";
  // Home paints the selected agent's toast (renderConfig + applyToastOverlay).
  if (active) pushToast(active, { type: "info", message });
  tui.requestRender();
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
  // Toast, not chat: a coalesced status would replace session_start notifies
  // (pi-tps restore via setTimeout(0)). Agent tab required (not config-scoped).
  if (modelsResult.ok) {
    pushToast(active!, {
      type: "info",
      message: "Reloaded keybindings, extensions, skills, prompts, themes, and models",
    });
  } else {
    pushToast(active!, {
      type: "error",
      message: `Reloaded keybindings, extensions, skills, prompts, and themes; models failed: ${modelsResult.error}`,
    });
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

const handleExtensionManager: LocalCommandHandler = ({ state, runtime, tui }) => {
  openExtensionManager(state, runtime, tui);
  return undefined;
};

export const SETTINGS_COMMAND_HANDLERS = {
  models: handleModels,
  thinking: handleThinking,
  "context-limit": handleContextLimit,
  "extension-manager": handleExtensionManager,
  reload: handleReload,
  "hide-thinking": handleHideThinking,
  settings: handleSettings,
  login: handleLogin,
  logout: handleLogout,
} satisfies Partial<Record<LocalCommand, LocalCommandHandler>>;
