import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, TUI as PiTui } from "@earendil-works/pi-tui";
import type {
  ExtensionDynamicLines,
  ExtensionWidgetPlacement,
  MixCodeTabInfo,
} from "../core/types.js";
import {
  ensureExtensionThemeInitialized,
  MIXCODE_EXTENSION_THEME,
} from "./runtime-extension-theme.js";
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
  return createLiveExtensionLines(
    (tui) => factory(tui, MIXCODE_EXTENSION_THEME, createMixCodeFooterDataProvider(runtimeTab)),
    runtimeTab.requestRender,
  );
}

function createLiveExtensionHeader(
  factory: ExtensionHeaderFactory,
  requestRender: (() => void) | undefined,
): ExtensionDynamicLines {
  return createLiveExtensionLines((tui) => factory(tui, MIXCODE_EXTENSION_THEME), requestRender);
}

function createLiveExtensionLines(
  factory: (tui: PiTui) => Component & { dispose?(): void },
  requestRender: (() => void) | undefined,
): ExtensionDynamicLines {
  ensureExtensionThemeInitialized();
  const terminal = new NullTerminal();
  if (requestRender) terminal.requestRender = requestRender;
  const tui = new PiTui(terminal);
  if (requestRender) tui.requestRender = () => requestRender();
  const component = factory(tui);
  return {
    lines: limitExtensionWidgetLines(component.render(terminal.columns)),
    render: (width) => {
      terminal.columns = Math.max(1, Math.floor(width));
      return limitExtensionWidgetLines(component.render(terminal.columns));
    },
    dispose: () => {
      component.dispose?.();
      tui.stop();
    },
  };
}

function createMixCodeFooterDataProvider(runtimeTab: RuntimeTab): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => null,
    getExtensionStatuses: () =>
      new Map(runtimeTab.tab.extensionUi.statuses.map((status) => [status.key, status.text])),
    getAvailableProviderCount: () =>
      runtimeTab.services.modelRegistry
        .getAll()
        .filter((model) => runtimeTab.services.modelRegistry.hasConfiguredAuth(model))
        .map((model) => model.provider)
        .filter((provider, index, providers) => providers.indexOf(provider) === index).length,
    onBranchChange: () => () => undefined,
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
  ensureExtensionThemeInitialized();
  const terminal = new NullTerminal();
  terminal.requestRender = requestRender;
  const tui = new PiTui(terminal);
  tui.requestRender = () => requestRender();
  const component = factory(tui, MIXCODE_EXTENSION_THEME);
  return {
    key,
    placement,
    lines: limitExtensionWidgetLines(component.render(terminal.columns)),
    render: (width) => {
      terminal.columns = Math.max(1, Math.floor(width));
      return limitExtensionWidgetLines(component.render(terminal.columns));
    },
    dispose: () => {
      component.dispose?.();
      tui.stop();
    },
  };
}

export function disposeExtensionWidgets(tab: MixCodeTabInfo): void {
  for (const widget of tab.extensionUi.widgets) {
    widget.dispose?.();
  }
  tab.extensionUi.header?.dispose?.();
  tab.extensionUi.footer?.dispose?.();
}

function limitExtensionWidgetLines(lines: string[]): string[] {
  const normalized = lines
    .map((line) => line.replace(/[\r\n\t]+/g, " "))
    .filter((line) => line.trim());
  if (normalized.length <= 10) return normalized;
  return [...normalized.slice(0, 10), "... (widget truncated)"];
}
