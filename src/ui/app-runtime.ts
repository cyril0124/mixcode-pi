import type { AutocompleteProvider, TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { MixCodeState } from "../core/types.js";
import { addPromptHistory } from "./app-editor.js";
import type { RuntimeChangeSource } from "./app-types.js";

export const WORKING_REDRAW_INTERVAL_MS = 80;
export function hydrateTabPromptHistory(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "getPromptHistory">,
): void {
  for (const tab of state.tabs) {
    const prompts = runtime.getPromptHistory?.(tab.sessionId) ?? [];
    for (const prompt of prompts) {
      addPromptHistory(tab, prompt);
    }
  }
}
export function bindWorkingRedraw(
  state: MixCodeState,
  tui: Pick<TuiType, "requestRender" | "stop">,
): () => void {
  const interval = setInterval(() => {
    if (activeTabNeedsWorkingRedraw(state)) tui.requestRender();
  }, WORKING_REDRAW_INTERVAL_MS);
  interval.unref?.();
  const originalStop = tui.stop.bind(tui);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };
  tui.stop = () => {
    stop();
    originalStop();
  };
  return stop;
}

function activeTabNeedsWorkingRedraw(state: MixCodeState): boolean {
  if (state.activeTabId === "config") return state.tabs.some((tab) => isWorkingStatus(tab.status));
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  return isWorkingStatus(active?.status);
}
export function bindRuntimeRendering(
  runtime: RuntimeChangeSource,
  tui: Pick<TuiType, "requestRender"> & Partial<Pick<TuiType, "terminal">>,
  state?: MixCodeState,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): () => void {
  const previousStatus = new Map<string, MixCodeState["tabs"][number]["status"]>();
  const previousInteractionCount = new Map<string, number>();
  return runtime.onChange((event, runtimeTab) => {
    const sessionId = runtimeTab.tab.sessionId;
    const before = previousStatus.get(sessionId);
    if (shouldRingCompletionBell(event, runtimeTab.tab, before)) {
      tui.terminal?.write("\x07");
    }
    // Ring terminal bell when a new user interaction appears (extension dialog,
    // custom UI question overlay, confirm, etc.) so the user is notified even
    // if the terminal is in the background.
    const prevCount = previousInteractionCount.get(sessionId) ?? 0;
    const currentCount =
      runtimeTab.tab.pendingDialogs.length +
      runtimeTab.tab.extensionUi.pendingUserInteractions.length;
    if (currentCount > prevCount) {
      tui.terminal?.write("\x07");
    }
    previousInteractionCount.set(sessionId, currentCount);
    if (
      state &&
      (event.type === "agent_end" || event.type === "compaction_end") &&
      runtimeTab.tab.sessionId === state.activeTabId &&
      runtimeTab.tab.unreadDone
    ) {
      runtimeTab.tab.unreadDone = false;
      void onStateChanged?.(state);
    }
    previousStatus.set(sessionId, runtimeTab.tab.status);
    tui.requestRender();
  });
}

function shouldRingCompletionBell(
  event: Parameters<Parameters<RuntimeChangeSource["onChange"]>[0]>[0],
  tab: MixCodeState["tabs"][number],
  previousStatus: MixCodeState["tabs"][number]["status"] | undefined,
): boolean {
  if (!tab.unreadDone) return false;
  if (event.type === "agent_end") return true;
  if (event.type === "compaction_end" && !event.errorMessage) return true;
  return isWorkingStatus(previousStatus) && !isWorkingStatus(tab.status);
}

function isWorkingStatus(status: MixCodeState["tabs"][number]["status"] | undefined): boolean {
  return status === "running" || status === "thinking";
}
export function activeExtensionCommands(
  state: MixCodeState,
  runtime:
    | Partial<Pick<MixCodeRuntime, "getExtensionCommands" | "getAllExtensionCommands">>
    | undefined,
): Array<{ name: string; description?: string }> {
  if (!runtime) return [];
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (active && state.activeTabId !== "config" && runtime.getExtensionCommands) {
    return runtime.getExtensionCommands(active.sessionId);
  }
  return runtime.getAllExtensionCommands?.() ?? [];
}

export function createActiveAutocompleteProvider(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  base: AutocompleteProvider,
): AutocompleteProvider {
  const current = () => resolveActiveAutocompleteProvider(state, runtime, base);
  return {
    getSuggestions: (lines, cursorLine, cursorCol, options) =>
      current().getSuggestions(lines, cursorLine, cursorCol, options),
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current().applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      current().shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
  };
}

function resolveActiveAutocompleteProvider(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  base: AutocompleteProvider,
): AutocompleteProvider {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (!active || state.activeTabId === "config") return base;
  if (!runtime.getTab(active.sessionId)) return base;
  return runtime.applyExtensionAutocompleteProviders?.(active.sessionId, base) ?? base;
}
