import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, TuiMainScreen as PiTui } from "@earendil-works/pi-tui";
import { gitBranchForWorkdir, onGitBranchChange } from "../core/git-branch.js";
import type {
  ExtensionDynamicLines,
  ExtensionWidgetPlacement,
  MixCodeTabInfo,
} from "../core/types.js";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
  getActiveExtensionThemeId,
} from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import { NullTerminal } from "./runtime-null-terminal.js";
import type {
  ExtensionFooterFactory,
  ExtensionHeaderFactory,
  RuntimeTab,
} from "./runtime-types.js";

export function setExtensionStatus(
  tab: MixCodeTabInfo,
  key: string,
  text: string | undefined,
): void {
  const index = tab.extensionUi.statuses.findIndex((status) => status.key === key);
  if (text === undefined) {
    if (index !== -1) tab.extensionUi.statuses.splice(index, 1);
    return;
  }
  const status = { key, text };
  if (index === -1) tab.extensionUi.statuses.push(status);
  else tab.extensionUi.statuses[index] = status;
}

export function setExtensionFooter(
  runtimeTab: RuntimeTab,
  factory: ExtensionFooterFactory | undefined,
): void {
  runtimeTab.tab.extensionUi.footer?.dispose?.();
  runtimeTab.tab.extensionUi.footer = factory
    ? createLiveExtensionFooter(runtimeTab, factory)
    : undefined;
}

export function setExtensionHeader(
  runtimeTab: RuntimeTab,
  factory: ExtensionHeaderFactory | undefined,
): void {
  runtimeTab.tab.extensionUi.header?.dispose?.();
  runtimeTab.tab.extensionUi.header = factory
    ? createLiveExtensionHeader(factory, runtimeTab.requestRender)
    : undefined;
}

function createLiveExtensionFooter(
  runtimeTab: RuntimeTab,
  factory: ExtensionFooterFactory,
): ExtensionDynamicLines {
  return createLiveExtensionRenderer(
    (tui) =>
      factory(tui, currentExtensionTheme(), createMixCodeFooterDataProvider(runtimeTab)),
    runtimeTab.requestRender,
  );
}

function createLiveExtensionHeader(
  factory: ExtensionHeaderFactory,
  requestRender: (() => void) | undefined,
): ExtensionDynamicLines {
  return createLiveExtensionRenderer(
    (tui) => factory(tui, currentExtensionTheme()),
    requestRender,
  );
}

interface LiveExtensionRenderer {
  lines: string[];
  render: (width: number, maxLines?: number) => string[];
  dispose: () => void;
}

function createLiveExtensionRenderer(
  factory: (tui: PiTui) => Component & { dispose?(): void },
  requestRender: (() => void) | undefined,
): LiveExtensionRenderer {
  ensureExtensionThemeInitialized();
  const terminal = new NullTerminal();
  if (requestRender) terminal.requestRender = requestRender;
  const tui = new PiTui(terminal);
  if (requestRender) tui.requestRender = () => requestRender();
  let themeKey = getActiveExtensionThemeId();
  let component = factory(tui);
  return {
    lines: renderExtensionLines(component, terminal.columns),
    render: (width, maxLines) => {
      // Rebuild when theme changes so factories re-bind accent colors.
      const nextTheme = getActiveExtensionThemeId();
      if (nextTheme !== themeKey) {
        component.dispose?.();
        themeKey = nextTheme;
        component = factory(tui);
      }
      terminal.columns = Math.max(1, Math.floor(width));
      return renderExtensionLines(component, terminal.columns, maxLines);
    },
    dispose: () => {
      component.dispose?.();
      tui.stop();
    },
  };
}

function createMixCodeFooterDataProvider(runtimeTab: RuntimeTab): ReadonlyFooterDataProvider {
  return {
    // Share the same non-blocking git cache as the MixCode chrome footer badge.
    // Empty string means unknown / loading / not a repo → Pi-style null.
    getGitBranch: () => gitBranchForWorkdir(runtimeTab.tab.workdir) || null,
    getExtensionStatuses: () =>
      new Map(runtimeTab.tab.extensionUi.statuses.map((status) => [status.key, status.text])),
    getAvailableProviderCount: () =>
      runtimeTab.services.modelRuntime
        .getModels()
        .filter((model) => runtimeTab.services.modelRuntime.hasConfiguredAuth(model.provider))
        .map((model) => model.provider)
        .filter((provider, index, providers) => providers.indexOf(provider) === index).length,
    // Notify when the shared git cache sees a different branch for this workdir.
    onBranchChange: (callback) =>
      onGitBranchChange(runtimeTab.tab.workdir, () => {
        callback();
        runtimeTab.requestRender?.();
      }),
  };
}

export function setExtensionWidget(
  tab: MixCodeTabInfo,
  key: string,
  content: string[] | ((tui: PiTui, theme: Theme) => Component & { dispose?(): void }) | undefined,
  placement: ExtensionWidgetPlacement,
  requestRender: () => void,
): void {
  const existingIndex = tab.extensionUi.widgets.findIndex((widget) => widget.key === key);
  const existing = existingIndex === -1 ? undefined : tab.extensionUi.widgets[existingIndex];
  if (content === undefined) {
    if (existingIndex !== -1) {
      existing?.dispose?.();
      tab.extensionUi.widgets.splice(existingIndex, 1);
    }
    return;
  }
  existing?.dispose?.();
  const widget = Array.isArray(content)
    ? { key, placement, lines: limitExtensionWidgetLines(content) }
    : createLiveExtensionWidget(key, placement, content, requestRender);
  if (existingIndex === -1) tab.extensionUi.widgets.push(widget);
  else tab.extensionUi.widgets[existingIndex] = widget;
}

function createLiveExtensionWidget(
  key: string,
  placement: ExtensionWidgetPlacement,
  factory: (tui: PiTui, theme: Theme) => Component & { dispose?(): void },
  requestRender: () => void,
): MixCodeTabInfo["extensionUi"]["widgets"][number] {
  return {
    key,
    placement,
    ...createLiveExtensionRenderer(
      (tui) => factory(tui, currentExtensionTheme()),
      requestRender,
    ),
  };
}

export function disposeExtensionWidgets(tab: MixCodeTabInfo): void {
  for (const widget of tab.extensionUi.widgets) {
    widget.dispose?.();
  }
  tab.extensionUi.header?.dispose?.();
  tab.extensionUi.footer?.dispose?.();
}

function renderExtensionLines(component: Component, width: number, maxLines?: number): string[] {
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    ensureExtensionThemeInitialized();
    return limitExtensionWidgetLines(component.render(width), maxLines);
  } finally {
    restoreKeybindings();
  }
}

function limitExtensionWidgetLines(lines: string[], maxLines?: number): string[] {
  // Keep blank lines: factory widgets (e.g. pi-subagents FleetView) use them as
  // intentional vertical separators. Pi's native widget Container preserves
  // every rendered row, so MixCode preserves them here too; app-layout applies
  // one viewport-aware budget across all editor widgets to protect chat/editor.
  const normalized = lines.map((line) => line.replace(/[\r\n\t]+/g, " "));
  if (maxLines === undefined) return normalized;
  // Caller-provided budget (e.g. the side panel): clip silently and let the
  // caller render its own overflow indicator, avoiding a double marker.
  const budget = Math.max(0, Math.floor(maxLines));
  return normalized.length <= budget ? normalized : normalized.slice(0, budget);
}
