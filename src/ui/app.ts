import { matchesKey, ProcessTerminal, TUI, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { ExtensionCustomUiHost, MixCodeRuntime } from "../agent/runtime.js";
import { scanProjectFiles } from "../core/file-picker.js";
import { ShellManager } from "../core/shell-session.js";
import { setTheme } from "../core/theme-registry.js";
import type { MixCodeState } from "../core/types.js";
import { appendActiveSystemMessage } from "./app-actions.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "./app-editor.js";
import { handleMixCodeKeyInput } from "./app-input.js";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
  TERMINAL_SCROLL_GUARD_ROWS,
} from "./app-layout.js";
import { editTextWithTuiPaused, errorMessage, showErrorOverlay } from "./app-overlays.js";
import {
  activeExtensionCommands,
  bindRuntimeRendering,
  createActiveAutocompleteProvider,
  hydrateTabPromptHistory,
} from "./app-runtime.js";
import { handleSubmittedInput } from "./app-submit.js";
import { attachTreeSelectorDisplayHost } from "./tree-selector.js";
import { MixCodeCompletionProvider, type MixCodeCompletionSources } from "./completion.js";
import {
  renderExtensionHeader,
  renderFooter,
  renderHeader,
  renderStatus,
  renderTabBar,
} from "./rendering.js";
import { withMouseReporting } from "./terminal.js";
import { themeForId } from "./themes.js";

export { handleMixCodeKeyInput } from "./app-input.js";
export { MixCodeRoot } from "./app-layout.js";
export { bindRuntimeRendering, bindWorkingRedraw } from "./app-runtime.js";
export {
  handleSubmittedInput,
  renderExportText,
  renderHotkeysText,
  renderSessionInfoText,
  renderSystemToolsText,
} from "./app-submit.js";
export interface MixCodeTuiOptions {
  completionSources?: MixCodeCompletionSources;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
  shellManager?: ShellManager;
  workspaceFile?: string;
  externalEditor?: string;
  terminal?: ConstructorParameters<typeof TUI>[0];
}
export function createMixCodeTui(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  options: MixCodeTuiOptions = {},
): TuiType {
  const tui = new TUI(withMouseReporting(options.terminal ?? new ProcessTerminal()));
  bindRuntimeRendering(runtime, tui, state, options.onStateChanged);
  const shellManager = options.shellManager ?? new ShellManager();
  let editorRows = 0;
  let metaRows = state.activeTabId === "config" ? 0 : 1;
  const main = new MixCodeRoot(
    state,
    runtime,
    () => tui.terminal.rows,
    () =>
      editorRows +
      metaRows +
      renderFooter(tui.terminal.columns).length +
      TERMINAL_SCROLL_GUARD_ROWS,
  );
  const defaultEditor = new CompactPromptEditor(
    tui,
    {
      ...editorThemeFor(themeForId(state.theme)),
    },
    state,
  );
  defaultEditor.setAutocompleteMaxVisible(8);
  const editor = new EditorSlot(tui, defaultEditor, state);
  attachTreeSelectorDisplayHost(tui, state, (factory, sessionId) =>
    editor.setEditorComponent(factory, sessionId),
  );
  hydrateTabPromptHistory(state, runtime);
  editor.onSubmit = (text) => {
    const activeSessionId = state.activeTabId;
    editor.addToHistory(text, activeSessionId);
    void handleSubmittedInput(
      state,
      runtime,
      text,
      tui,
      options.onStateChanged,
      shellManager,
      options.workspaceFile,
    ).catch((error: unknown) => {
      appendActiveSystemMessage(state, runtime, errorMessage(error));
      tui.setFocus(editor);
      tui.requestRender();
    });
  };
  const baseCompletionProvider = new MixCodeCompletionProvider({
    ...(options.completionSources ?? { skills: [], files: [] }),
    files: createActiveFileCompletionSource(state, options.completionSources?.files),
    commands: () => {
      const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
      return active && state.activeTabId !== "config"
        ? runtime.getExtensionCommands(active.sessionId)
        : runtime.getAllExtensionCommands();
    },
  });
  const activeCompletionProvider = createActiveAutocompleteProvider(
    state,
    runtime,
    baseCompletionProvider,
  );
  editor.setAutocompleteProvider(activeCompletionProvider);
  runtime.setExtensionUiHost?.({
    tui,
    editor: {
      getText: (sessionId) => editor.getText(sessionId),
      getExpandedText: (sessionId) => editor.getExpandedText(sessionId),
      setText: (text, sessionId) => editor.setText(text, sessionId),
      pasteToEditor: (text, sessionId) => editor.pasteToEditor(text, sessionId),
      setAutocompleteProvider: () => editor.setAutocompleteProvider(activeCompletionProvider),
      setEditorComponent: (factory, sessionId) => editor.setEditorComponent(factory, sessionId),
      getEditorComponent: (sessionId) => editor.getEditorComponent(sessionId),
    },
    themes: {
      getTheme: () => state.theme,
      setTheme: (themeId) => {
        setTheme(state, themeId);
        void options.onStateChanged?.(state);
        tui.requestRender();
      },
      requestRender: () => tui.requestRender(),
    },
    isSessionActive: (sessionId) => state.activeTabId === sessionId,
    topReservedRows: (sessionId) => {
      const active = state.tabs.find((tab) => tab.sessionId === sessionId);
      if (!active) return 0;
      const width = tui.terminal.columns;
      return (
        renderHeader(width, themeForId(state.theme)).length +
        renderExtensionHeader(active, width).length +
        renderTabBar(state, width, themeForId(state.theme)).length +
        renderStatus(active, width, themeForId(state.theme)).length
      );
    },
  } satisfies ExtensionCustomUiHost);
  tui.addInputListener((data) => {
    const result = handleMixCodeKeyInput(
      state,
      data,
      tui,
      shellManager,
      runtime,
      options.onStateChanged,
      () => editor.isShowingAutocomplete(),
      {
        getText: () => editor.getText(),
        setText: (text) => editor.setText(text),
        addToHistory: (text) => editor.addToHistory(text),
        insertTextAtCursor: (text) => editor.insertTextAtCursor(text),
        submitCurrentText: () => editor.submitCurrentText(),
      },
      {
        executeCommand: (command) =>
          handleSubmittedInput(
            state,
            runtime,
            command,
            tui,
            options.onStateChanged,
            shellManager,
            options.workspaceFile,
          ),
        extensionCommands: () => activeExtensionCommands(state, runtime),
      },
      { editor: options.externalEditor },
    );
    if (result?.consume) return result;
    if (matchesKey(data, "ctrl+e")) {
      void editTextWithTuiPaused(tui, editor.getText(), options.externalEditor)
        .then((text) => {
          editor.setText(text);
          tui.requestRender();
        })
        .catch((error: unknown) => {
          showErrorOverlay(tui, error);
          tui.setFocus(editor);
        });
      return { consume: true };
    }
    return result;
  });
  const root = new MixCodeLayoutRoot(
    state,
    main,
    editor,
    new MixCodeFooterRoot(state),
    (rows) => {
      editorRows = rows;
    },
    (rows) => {
      metaRows = rows;
    },
    () => tui.terminal.rows,
    tui,
  );
  const originalStop = tui.stop.bind(tui);
  tui.stop = () => {
    root.dispose();
    originalStop();
  };
  tui.addChild(root);
  tui.setFocus(editor);
  return tui;
}

export function createActiveFileCompletionSource(
  state: MixCodeState,
  initialFiles: MixCodeCompletionSources["files"] | undefined,
): () => string[] | Promise<string[]> {
  const cache = new Map<string, { files: string[]; timestamp: number }>();
  const pending = new Map<string, Promise<string[]>>();
  const FILE_CACHE_TTL_MS = 10_000; // Background refresh after 10 seconds
  if (Array.isArray(initialFiles))
    cache.set(state.workdir, { files: initialFiles, timestamp: Date.now() });
  return () => {
    const workdir = activeCompletionWorkdir(state);
    const cached = cache.get(workdir);
    if (cached && Date.now() - cached.timestamp < FILE_CACHE_TTL_MS) return cached.files;
    // Stale-while-revalidate: return old results immediately, refresh in background.
    if (!pending.has(workdir)) {
      const refresh = scanProjectFiles(workdir)
        .then((files) => {
          cache.set(workdir, { files, timestamp: Date.now() });
          return files;
        })
        .finally(() => pending.delete(workdir));
      pending.set(workdir, refresh);
      if (cached) void refresh.catch(() => undefined);
    }
    // If we have stale data, return it without waiting.
    if (cached) return cached.files;
    // First load ever — must wait.
    return pending.get(workdir)!;
  };
}

function activeCompletionWorkdir(state: MixCodeState): string {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  return active && state.activeTabId !== "config" ? active.workdir : state.workdir;
}
