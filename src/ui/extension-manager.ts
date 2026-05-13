import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionReloadResult } from "../core/extension-manager.js";
import type { ExtensionManagerEntryInfo, MixCodeState } from "../core/types.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, MixCodeSubmitRuntime, OverlayTui } from "./app-types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { themeForId } from "./themes.js";

export function openExtensionManager(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  tui: OverlayTui,
): void {
  const active = activeExtensionManagerTab(state);
  if (!active) throw new Error("Extension manager requires an active agent tab");
  if (!runtime.getExtensionManagerEntries)
    throw new Error("Extension manager requires runtime extension metadata support");
  state.extensionManager = {
    open: true,
    selectedIndex: 0,
    entries: runtime.getExtensionManagerEntries(active.sessionId),
    selectedKeys: [],
    message: "",
    error: "",
    working: false,
  };
  showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
}

export function renderExtensionManager(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderExtensionManagerInner(state, width));
}

function renderExtensionManagerInner(state: MixCodeState, width: number): string[] {
  const panelWidth = Math.min(Math.max(60, width - 6), width);
  const manager = state.extensionManager;
  const entries = manager.entries;
  const selectedKeys = new Set(manager.selectedKeys);
  const bodyWidth = Math.max(1, panelWidth - 4);
  const lines = [
    activeRenderTheme.dim(
      "space: toggle  enter: save+reload  r: reload tab  a: reload workdir  esc: close",
    ),
    "",
  ];
  if (manager.working) lines.push(activeRenderTheme.accent("Working..."), "");
  if (manager.error) lines.push(activeRenderTheme.danger(manager.error), "");
  if (manager.message) lines.push(activeRenderTheme.success(manager.message), "");
  if (!entries.length) {
    lines.push(activeRenderTheme.dim("No Pi extensions loaded for this workdir."));
  } else {
    entries.forEach((entry, index) => {
      const selected = index === manager.selectedIndex;
      const checked = entry.enabled ? "x" : " ";
      const pending = selectedKeys.has(entry.key) ? "*" : " ";
      const source = formatExtensionSource(entry);
      const metrics = `tools:${entry.toolCount} commands:${entry.commandCount}`;
      const pathWidth = Math.max(12, bodyWidth - source.length - metrics.length - 12);
      const path = truncateToWidth(formatExtensionPath(entry.path), pathWidth);
      const text = `${selected ? ">" : " "} [${checked}]${pending} ${path}  ${source}  ${metrics}`;
      const line = entry.error
        ? `${activeRenderTheme.danger(text)} ${activeRenderTheme.danger(entry.error)}`
        : entry.enabled
          ? text
          : activeRenderTheme.dim(text);
      lines.push(selected ? activeRenderTheme.selection(padLine(line, bodyWidth)) : line);
    });
  }
  return overlayPanel("Extension Manager", lines, panelWidth);
}

export function handleExtensionManagerKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (!state.extensionManager.open) return false;
  if (matchesKey(data, "escape")) {
    closeExtensionManager(state, tui);
    return true;
  }
  if (state.extensionManager.working) return true;
  if (matchesKey(data, "down") || matchesKey(data, "tab")) {
    moveExtensionManagerSelection(state, 1);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
    moveExtensionManagerSelection(state, -1);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (data === " ") {
    toggleSelectedExtension(state);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "apply-current");
    return true;
  }
  if (data.toLowerCase() === "r") {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "reload-current");
    return true;
  }
  if (data.toLowerCase() === "a") {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "reload-workdir");
    return true;
  }
  return true;
}

function runExtensionManagerAction(
  state: MixCodeState,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  action: "apply-current" | "reload-current" | "reload-workdir",
): void {
  const active = activeExtensionManagerTab(state);
  if (!active) throw new Error("Extension manager requires an active agent tab");
  if (!runtime?.reloadExtensionManagerTab || !runtime.reloadExtensionManagerWorkdir) {
    throw new Error("Extension manager requires runtime reload support");
  }
  const runtimeWithReload = runtime as MixCodeKeyRuntime &
    Required<
      Pick<MixCodeKeyRuntime, "reloadExtensionManagerTab" | "reloadExtensionManagerWorkdir">
    >;
  state.extensionManager.working = true;
  state.extensionManager.error = "";
  state.extensionManager.message = "";
  showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
  void (async () => {
    if (action === "apply-current")
      await persistExtensionManagerToggles(state, runtimeWithReload, active.sessionId);
    const results =
      action === "reload-workdir"
        ? await runtimeWithReload.reloadExtensionManagerWorkdir(active.workdir)
        : [await runtimeWithReload.reloadExtensionManagerTab(active.sessionId)];
    refreshExtensionManagerEntries(state, runtimeWithReload, active.sessionId);
    state.extensionManager.message = formatReloadResults(results);
    state.extensionManager.selectedKeys = [];
    state.extensionManager.working = false;
    await onStateChanged?.(state);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    tui.requestRender();
  })().catch((error: unknown) => {
    state.extensionManager.working = false;
    state.extensionManager.error = error instanceof Error ? error.message : String(error);
    showErrorOverlay(tui, error);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    tui.requestRender();
  });
}

async function persistExtensionManagerToggles(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime,
  sessionId: string,
): Promise<void> {
  if (!runtime.setExtensionEnabled)
    throw new Error("Extension manager requires runtime persistence support");
  const selectedKeys = new Set(state.extensionManager.selectedKeys);
  for (const entry of state.extensionManager.entries) {
    if (!selectedKeys.has(entry.key)) continue;
    await runtime.setExtensionEnabled(sessionId, entry.key, entry.enabled);
  }
}

function refreshExtensionManagerEntries(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime,
  sessionId: string,
): void {
  if (!runtime.getExtensionManagerEntries) return;
  state.extensionManager.entries = runtime.getExtensionManagerEntries(sessionId);
  state.extensionManager.selectedIndex = Math.min(
    state.extensionManager.selectedIndex,
    Math.max(0, state.extensionManager.entries.length - 1),
  );
}

function closeExtensionManager(state: MixCodeState, tui: OverlayTui): void {
  state.extensionManager.open = false;
  state.extensionManager.selectedIndex = 0;
  state.extensionManager.selectedKeys = [];
  closeAppOverlay(tui);
  tui.requestRender();
}

function moveExtensionManagerSelection(state: MixCodeState, delta: number): void {
  const total = state.extensionManager.entries.length;
  if (total === 0) {
    state.extensionManager.selectedIndex = 0;
    return;
  }
  state.extensionManager.selectedIndex =
    (state.extensionManager.selectedIndex + delta + total) % total;
}

function toggleSelectedExtension(state: MixCodeState): void {
  const entry = state.extensionManager.entries[state.extensionManager.selectedIndex];
  if (!entry) return;
  entry.enabled = !entry.enabled;
  const selected = new Set(state.extensionManager.selectedKeys);
  if (selected.has(entry.key)) selected.delete(entry.key);
  else selected.add(entry.key);
  state.extensionManager.selectedKeys = [...selected];
  state.extensionManager.message = "";
  state.extensionManager.error = "";
}

function activeExtensionManagerTab(state: MixCodeState): MixCodeState["tabs"][number] | undefined {
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
}

function formatReloadResults(results: ExtensionReloadResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  return [
    `reloaded:${counts.get("reloaded") ?? 0}`,
    `skipped:${counts.get("skipped") ?? 0}`,
    `errors:${counts.get("error") ?? 0}`,
  ].join("  ");
}

function formatExtensionSource(entry: ExtensionManagerEntryInfo): string {
  const prefix = entry.source === "local" ? "local" : `ext:${entry.source}`;
  return `${prefix}/${entry.scope}`;
}

function formatExtensionPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
