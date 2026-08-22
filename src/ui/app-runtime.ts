import type { AutocompleteProvider, TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { getActiveTab } from "../core/tabs.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import { addPromptHistory } from "./app-editor.js";
import type { RuntimeChangeSource } from "./app-types.js";

export const WORKING_REDRAW_INTERVAL_MS = 80;
export const LIVE_EXTENSION_REDRAW_INTERVAL_MS = 1_000;
export function hydrateTabPromptHistory(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "getPromptHistory">,
): void {
  for (const tab of state.tabs) {
    for (const prompt of runtime.getPromptHistory(tab.sessionId)) {
      addPromptHistory(tab, prompt);
    }
  }
}
export function bindWorkingRedraw(
  state: MixCodeState,
  tui: Pick<TuiType, "requestRender">,
): () => void {
  return bindConditionalRedraw(state, tui, WORKING_REDRAW_INTERVAL_MS, activeTabNeedsWorkingRedraw);
}

export function bindLoadingRedraw(
  state: MixCodeState,
  tui: Pick<TuiType, "requestRender">,
): () => void {
  // Loading glyphs/phase chips are wall-clock driven; repaint while any tab is
  // still Not Ready so tabStatusGlyph animates on Home cards and the tab bar.
  return bindConditionalRedraw(
    state,
    tui,
    WORKING_REDRAW_INTERVAL_MS,
    (current) => current.tabs.some((tab) => tab.status === "Not Ready"),
  );
}

export function bindLiveExtensionRedraw(
  state: MixCodeState,
  tui: Pick<TuiType, "requestRender">,
  intervalMs = LIVE_EXTENSION_REDRAW_INTERVAL_MS,
): () => void {
  return bindConditionalRedraw(state, tui, intervalMs, activeTabNeedsLiveExtensionRedraw);
}

function bindConditionalRedraw(
  state: MixCodeState,
  tui: Pick<TuiType, "requestRender">,
  intervalMs: number,
  shouldRedraw: (state: MixCodeState) => boolean,
): () => void {
  const interval = setInterval(() => {
    if (shouldRedraw(state)) tui.requestRender();
  }, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

function activeTabNeedsWorkingRedraw(state: MixCodeState): boolean {
  if (state.activeTabId === HOME_TAB_ID) return state.tabs.some((tab) => isWorkingStatus(tab.status));
  const active = getActiveTab(state);
  return isWorkingStatus(active?.status);
}

function activeTabNeedsLiveExtensionRedraw(state: MixCodeState): boolean {
  if (state.activeTabId === HOME_TAB_ID) return state.tabs.some(tabHasLiveExtensionUi);
  const active = getActiveTab(state);
  return active ? tabHasLiveExtensionUi(active) : false;
}

function tabHasLiveExtensionUi(tab: MixCodeState["tabs"][number]): boolean {
  return Boolean(
    tab.extensionUi.header?.render ||
      tab.extensionUi.footer?.render ||
      tab.extensionUi.widgets.some((widget) => widget.render) ||
      tab.extensionUi.waitingForInputs.length > 0,
  );
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
    const currentCount = runtimeTab.tab.extensionUi.waitingForInputs.length;
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
  runtime: Pick<MixCodeRuntime, "getExtensionCommands" | "getAllExtensionCommands"> | undefined,
): Array<{ name: string; description?: string }> {
  if (!runtime) return [];
  const active = getActiveTab(state);
  if (active && state.activeTabId !== HOME_TAB_ID) {
    return runtime.getExtensionCommands(active.sessionId);
  }
  return runtime.getAllExtensionCommands();
}

export function createActiveAutocompleteProvider(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  base: AutocompleteProvider,
): AutocompleteProvider {
  const current = () => resolveActiveAutocompleteProvider(state, runtime, base);
  // Pi Editor reads provider.triggerCharacters in setAutocompleteProvider.
  // Mirror InteractiveMode.setupAutocompleteProvider: expose the live merged list
  // from all extension wrappers. No MixCode-only force path.
  return {
    get triggerCharacters() {
      return current().triggerCharacters;
    },
    getSuggestions: (lines, cursorLine, cursorCol, options) =>
      current().getSuggestions(lines, cursorLine, cursorCol, options),
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current().applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    // Pi: omit/undefined => allow trigger; only explicit false cancels.
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => {
      const provider = current();
      if (!provider.shouldTriggerFileCompletion) return true;
      return provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    },
  };
}

function resolveActiveAutocompleteProvider(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  base: AutocompleteProvider,
): AutocompleteProvider {
  const active = getActiveTab(state);
  if (!active || state.activeTabId === HOME_TAB_ID) {
    // On the Agent (home) view, messages are sent to the selected tab, so
    // stack that tab's extension autocomplete providers on top of the base
    // provider before applying the home filter.
    const selected = state.tabs[state.homeSelectedTabIndex];
    const withExtensions =
      selected && runtime.getTab(selected.sessionId)
        ? runtime.applyExtensionAutocompleteProviders(selected.sessionId, base)
        : base;
    return homeAutocompleteFilter(withExtensions);
  }
  if (!runtime.getTab(active.sessionId)) return base;
  return runtime.applyExtensionAutocompleteProviders(active.sessionId, base);
}

// On Agent View, only allow $ (skills) and @ (files) autocomplete; block / (commands).
function homeAutocompleteFilter(base: AutocompleteProvider): AutocompleteProvider {
  return {
    get triggerCharacters() {
      return base.triggerCharacters;
    },
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      const token = before.match(/(?:^|\s)([^\s]*)$/)?.[1] ?? "";
      if (token.startsWith("/")) return null;
      return base.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => {
      if (!base.shouldTriggerFileCompletion) return true;
      return base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    },
  };
}
