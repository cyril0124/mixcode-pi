import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { LOCAL_COMMANDS } from "../core/commands.js";
import { appendSystemMessage } from "./runtime-chat.js";
import {
  createExtensionCustomOverlay,
  createExtensionEditorOverlay,
} from "./runtime-extension-custom.js";
import { createExtensionDialog } from "./runtime-extension-dialog.js";
import {
  applyExtensionTheme,
  availableExtensionThemes,
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
  extensionThemeByName,
  MIXCODE_EXTENSION_KEYBINDINGS,
} from "./runtime-extension-theme.js";
import {
  setExtensionFooter,
  setExtensionHeader,
  setExtensionStatus,
  setExtensionWidget,
} from "./runtime-extension-widgets.js";
import type { ExtensionCustomUiHost, RuntimeTab } from "./runtime-types.js";
import { PI_BUILTIN_TOOL_NAMES } from "./tools.js";

export { createExtensionCommandActions } from "./runtime-extension-actions.js";
export { closeExtensionCustomOverlays } from "./runtime-extension-custom.js";
export { disposeExtensionWidgets } from "./runtime-extension-widgets.js";

/**
 * Extension load error lines for the startup header's [Diagnostics] section.
 * Returned (not pushed to chat) so they live on tab.startupSummary and survive
 * chat rebuilds from session entries.
 */
export function extensionLoadErrorLines(runtimeTab: RuntimeTab): string[] {
  return runtimeTab.extensionsResult.errors.map(
    (error) => `Extension load error: ${error.path}: ${error.error}`,
  );
}

export function extensionConflictDiagnosticLines(
  runtimeTab: RuntimeTab,
  extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy,
): string[] {
  return extensionConflictDiagnostics(runtimeTab, extensionToolOwnerPolicy);
}

function extensionConflictDiagnostics(
  runtimeTab: RuntimeTab,
  extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy,
): string[] {
  const diagnostics: string[] = [];
  const localCommands = new Set(LOCAL_COMMANDS.map((command) => command.name));
  for (const command of runtimeTab.agentSession.extensionRunner.getRegisteredCommands()) {
    if (!localCommands.has(command.invocationName as never)) continue;
    diagnostics.push(
      `Extension command conflict: /${command.invocationName} from ${formatSourceInfo(command.sourceInfo)} is shadowed by MixCode local command /${command.invocationName}.`,
    );
  }
  const builtInToolNames = new Set(PI_BUILTIN_TOOL_NAMES);
  const seenExtensionTools = new Set<string>();
  for (const extensionTool of runtimeTab.agentSession.extensionRunner.getAllRegisteredTools()) {
    const name = extensionTool.definition.name;
    if (seenExtensionTools.has(name) || !builtInToolNames.has(name as never)) continue;
    seenExtensionTools.add(name);
    const source = formatSourceInfo(extensionTool.sourceInfo);
    diagnostics.push(
      extensionToolOwnerPolicy?.(extensionTool.sourceInfo, name)
        ? `Extension tool override: ${name} from ${source} overrides Pi builtin tool ${name}.`
        : `Extension tool conflict: ${name} from ${source} is shadowed by Pi builtin tool ${name}.`,
    );
  }
  runtimeTab.agentSession.extensionRunner.getShortcuts(MIXCODE_EXTENSION_KEYBINDINGS);
  for (const diagnostic of runtimeTab.agentSession.extensionRunner.getShortcutDiagnostics()) {
    diagnostics.push(diagnostic.message);
  }
  return diagnostics;
}

export function surfaceShortcutError(runtimeTab: RuntimeTab, error: unknown): void {
  appendSystemMessage(
    runtimeTab,
    `Shortcut handler error: ${error instanceof Error ? error.message : String(error)}`,
    "error",
  );
}

function formatSourceInfo(sourceInfo: { path?: string; source?: string } | undefined): string {
  return sourceInfo?.path || sourceInfo?.source || "unknown extension";
}

export function createMixCodeExtensionUiContext(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  getCustomUiHost: () => ExtensionCustomUiHost | undefined,
): ExtensionUIContext & { requestRender: () => void } {
  // Match Pi showExtensionNotify: info -> replaceable status; warning/error always append.
  const notify = (message: string, type?: "info" | "warning" | "error") => {
    // Match Pi showExtensionNotify: info is raw status text; warning/error use
    // Warning:/Error: prefixes and never coalesce into the status chain.
    if (type === "error") {
      appendSystemMessage(runtimeTab, `Error: ${message}`, "error");
    } else if (type === "warning") {
      appendSystemMessage(runtimeTab, `Warning: ${message}`, "warning");
    } else {
      appendSystemMessage(runtimeTab, message, "status");
    }
    requestRender();
  };
  const getEditorHost = () => {
    const host = getCustomUiHost()?.editor;
    if (!host) throw new Error("Pi extension UI editor is not available in MixCode yet");
    return host;
  };
  return {
    select: (title, options, opts) =>
      createExtensionDialog(
        runtimeTab,
        requestRender,
        getCustomUiHost,
        "select",
        title,
        title,
        options.map((option) => ({ label: option, description: "" })),
        false,
        false,
        opts,
      ),
    confirm: (title, message, opts) =>
      createExtensionDialog(
        runtimeTab,
        requestRender,
        getCustomUiHost,
        "confirm",
        title,
        message,
        [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        false,
        false,
        opts,
      ).then((value) => value === "Yes"),
    input: (title, placeholder, opts) =>
      createExtensionDialog(
        runtimeTab,
        requestRender,
        getCustomUiHost,
        "input",
        title,
        placeholder || title,
        [],
        false,
        true,
        opts,
      ),
    notify,
    onTerminalInput: (handler) => {
      runtimeTab.extensionTerminalInputHandlers.add(handler);
      return () => {
        runtimeTab.extensionTerminalInputHandlers.delete(handler);
      };
    },
    setStatus: (key, text) => {
      setExtensionStatus(runtimeTab.tab, key, text);
      requestRender();
    },
    setWorkingMessage: (message) => {
      runtimeTab.tab.extensionUi.workingMessage = message;
      requestRender();
    },
    setWorkingVisible: (visible) => {
      runtimeTab.tab.extensionUi.workingVisible = visible;
      requestRender();
    },
    setWorkingIndicator: (options) => {
      runtimeTab.tab.extensionUi.workingIndicatorFrames = options?.frames;
      runtimeTab.tab.extensionUi.workingIndicatorIntervalMs = options?.intervalMs;
      requestRender();
    },
    setHiddenThinkingLabel: (label) => {
      // Pi: set label when thinking is collapsed; omit / undefined restores default.
      runtimeTab.tab.extensionUi.hiddenThinkingLabel =
        label === undefined || label === "" ? undefined : label;
      requestRender();
    },
    setWidget: (key, content, options) => {
      setExtensionWidget(
        runtimeTab.tab,
        key,
        content,
        options?.placement ?? "aboveEditor",
        requestRender,
      );
      requestRender();
    },
    setFooter: (factory) => {
      setExtensionFooter(runtimeTab, factory);
      requestRender();
    },
    setHeader: (factory) => {
      setExtensionHeader(runtimeTab, factory);
      requestRender();
    },
    setTitle: (title) => {
      runtimeTab.tab.extensionUi.title = title;
      requestRender();
    },
    custom: (factory, options) =>
      createExtensionCustomOverlay(runtimeTab, requestRender, getCustomUiHost, factory, options),
    pasteToEditor: (text) => {
      getEditorHost().pasteToEditor(text, runtimeTab.tab.sessionId);
      requestRender();
    },
    setEditorText: (text) => {
      getEditorHost().setText(text, runtimeTab.tab.sessionId);
      requestRender();
    },
    getEditorText: () => {
      const editor = getEditorHost();
      return (
        editor.getExpandedText?.(runtimeTab.tab.sessionId) ??
        editor.getText(runtimeTab.tab.sessionId)
      );
    },
    editor: (title, prefill) =>
      createExtensionEditorOverlay(runtimeTab, requestRender, getCustomUiHost, title, prefill),
    addAutocompleteProvider: (factory) => {
      runtimeTab.extensionAutocompleteProviderFactories.push(factory);
      const editor = getCustomUiHost()?.editor;
      if (!editor?.setAutocompleteProvider || !runtimeTab.extensionAutocompleteProviderCache)
        return;
      editor.setAutocompleteProvider(
        applyExtensionAutocompleteProviders(
          runtimeTab,
          runtimeTab.extensionAutocompleteProviderCache.base,
        ),
      );
      requestRender();
    },
    setEditorComponent: (factory) => {
      const editor = getEditorHost();
      if (!editor.setEditorComponent)
        throw new Error(
          "Pi extension UI editor component replacement is not available in MixCode yet",
        );
      if (factory) ensureExtensionThemeInitialized();
      editor.setEditorComponent(factory, runtimeTab.tab.sessionId);
      requestRender();
    },
    getEditorComponent: () => getEditorHost().getEditorComponent?.(runtimeTab.tab.sessionId),
    get theme() {
      return currentExtensionTheme(getCustomUiHost()?.themes);
    },
    getAllThemes: () => availableExtensionThemes(),
    getTheme: (name) => extensionThemeByName(name),
    setTheme: (theme) => applyExtensionTheme(theme, getCustomUiHost()?.themes, requestRender),
    getToolsExpanded: () => runtimeTab.tab.extensionUi.toolsExpanded,
    setToolsExpanded: (expanded) => {
      runtimeTab.tab.extensionUi.toolsExpanded = expanded;
      requestRender();
    },
    requestRender,
  };
}

export function applyExtensionAutocompleteProviders(
  runtimeTab: RuntimeTab,
  base: AutocompleteProvider,
): AutocompleteProvider {
  const cached = runtimeTab.extensionAutocompleteProviderCache;
  if (
    cached &&
    cached.base === base &&
    cached.factoryCount === runtimeTab.extensionAutocompleteProviderFactories.length
  ) {
    return cached.provider;
  }
  let provider = base;
  for (const factory of runtimeTab.extensionAutocompleteProviderFactories) {
    provider = factory(provider);
  }
  runtimeTab.extensionAutocompleteProviderCache = {
    base,
    factoryCount: runtimeTab.extensionAutocompleteProviderFactories.length,
    provider,
  };
  return provider;
}
