import { matchesKey, ProcessTerminal, TUI, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { ExtensionCustomUiHost, MixCodeRuntime } from "../agent/runtime.js";
import { scanSkillEntries } from "../core/attachments.js";
import { recordSubmittedHistory } from "../core/conversation-history.js";
import { resolveFdBinary } from "../core/detect-search-tools.js";
import { scanProjectFiles } from "../core/file-picker.js";
import type { MixCodeState } from "../core/types.js";
import { getActiveTab } from "../core/tabs.js";
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
  bindLiveExtensionRedraw,
  bindRuntimeRendering,
  bindWorkingRedraw,
  createActiveAutocompleteProvider,
  hydrateTabPromptHistory,
} from "./app-runtime.js";
import { handleSubmittedInput } from "./app-submit.js";
import { attachTreeSelectorDisplayHost } from "./tree-selector.js";
import {
  MixCodeCompletionProvider,
  type MixCodeCompletionSources,
  type MixCodeSkillCompletionSource,
} from "./completion.js";
import {
  renderFooter,
  renderHeader,
  renderTabBar,
} from "./rendering.js";
import { withMouseReporting } from "./terminal.js";
import { setTheme, themeForId } from "./themes.js";
import { workspaceNameCompletions } from "./workspace-overlay.js";

export { handleMixCodeKeyInput } from "./app-input.js";
export { MixCodeRoot } from "./app-layout.js";
export { bindLiveExtensionRedraw, bindRuntimeRendering, bindWorkingRedraw } from "./app-runtime.js";
export {
  handleSubmittedInput,
  renderSessionInfoText,
} from "./app-submit.js";
export { renderHotkeysText } from "./hotkeys.js";
export { renderSystemToolsText } from "./system-tools.js";
export interface MixCodeTuiOptions {
  completionSources?: MixCodeCompletionSources;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
  workspaceFile?: string;
  externalEditor?: string;
  terminal?: ConstructorParameters<typeof TUI>[0];
  exitProcessOnQuit?: boolean;
  rootStateDir?: string;
}
export function createMixCodeTui(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  options: MixCodeTuiOptions = {},
): TuiType {
  const tui = new TUI(withMouseReporting(options.terminal ?? new ProcessTerminal()));
  (tui as TuiType & { mixCodeExitProcessOnQuit?: boolean }).mixCodeExitProcessOnQuit =
    options.exitProcessOnQuit === true;
  bindRuntimeRendering(runtime, tui, state, options.onStateChanged);
  const stopWorkingRedraw = bindWorkingRedraw(state, tui);
  const stopLiveExtensionRedraw = bindLiveExtensionRedraw(state, tui);
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
    { paddingX: 1 },
    state,
  );
  defaultEditor.setAutocompleteMaxVisible(8);
  const editor = new EditorSlot(tui, defaultEditor, state);
  attachTreeSelectorDisplayHost(
    tui,
    state,
    (factory, sessionId) => editor.setEditorComponent(factory, sessionId),
    (sessionId) => editor.getEditorMaxRows(sessionId),
  );
  hydrateTabPromptHistory(state, runtime);
  editor.onSubmit = (text) => {
    const activeSessionId = state.activeTabId;
    editor.addToHistory(text, activeSessionId);
    if (activeSessionId !== "config" && options.rootStateDir) {
      void recordSubmittedHistory({
        rootStateDir: options.rootStateDir,
        sessionId: activeSessionId,
        text,
      }).catch((error: unknown) => {
        appendActiveSystemMessage(state, runtime, `History warning: ${errorMessage(error)}`);
        tui.requestRender();
      });
    }
    void handleSubmittedInput(
      state,
      runtime,
      text,
      tui,
      options.onStateChanged,
      {
        setInputComponent: (component, sessionId) => editor.setInputComponent(component, sessionId),
        clearInputComponent: (sessionId) => editor.clearInputComponent(sessionId),
        requestRender: () => tui.requestRender(),
      },
      options.workspaceFile,
    ).catch((error: unknown) => {
      appendActiveSystemMessage(state, runtime, errorMessage(error));
      tui.setFocus(editor);
      tui.requestRender();
    });
  };
  const baseCompletionProvider = new MixCodeCompletionProvider({
    ...(options.completionSources ?? { skills: [], files: [] }),
    skills: createActiveSkillCompletionSource(state, runtime, options.completionSources?.skills),
    files: createActiveFileCompletionSource(state, options.completionSources?.files),
    fileSearch: createActiveFileSearchSource(state),
    commands: () => {
      const active = getActiveTab(state);
      const extensionCommands =
        active && state.activeTabId !== "config"
          ? runtime.getExtensionCommands(active.sessionId)
          : runtime.getAllExtensionCommands();
      return [
        ...extensionCommands,
        {
          name: "restore-workspace",
          argumentHint: "<workspace>",
          getArgumentCompletions: (prefix: string) =>
            workspaceNameCompletions(options.workspaceFile, prefix),
        },
        {
          name: "delete-workspace",
          argumentHint: "<workspace>",
          getArgumentCompletions: (prefix: string) =>
            workspaceNameCompletions(options.workspaceFile, prefix),
        },
      ];
    },
    promptTemplates: () => {
      // Dynamically resolve prompt templates from the active tab's resource loader,
      // which includes extension-contributed templates.
      const active = getActiveTab(state);
      if (active && state.activeTabId !== "config") {
        const runtimeTab = runtime.getTab(active.sessionId);
        if (runtimeTab?.services?.resourceLoader) {
          return runtimeTab.services.resourceLoader
            .getPrompts()
            .prompts.map((p) => ({
              name: p.name,
              description: p.description,
              argumentHint: p.argumentHint,
              sourceInfo: p.sourceInfo
                ? { scope: p.sourceInfo.scope, source: p.sourceInfo.source }
                : undefined,
            }));
        }
      }
      return [];
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
      getEmbeddedTerminalRows: (sessionId) => editor.getEmbeddedTerminalRows(sessionId),
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
        renderTabBar(state, width, themeForId(state.theme)).length
      );
    },
  } satisfies ExtensionCustomUiHost);
  tui.addInputListener((data) => {
    const result = handleMixCodeKeyInput(
      state,
      data,
      tui,
      undefined,
      runtime,
      options.onStateChanged,
      () => editor.isShowingAutocomplete(),
      {
        getText: () => editor.getText(),
        getExpandedText: () => editor.getExpandedText(),
        setText: (text) => editor.setText(text),
        addToHistory: (text, sessionId) => editor.addToHistory(text, sessionId),
        insertTextAtCursor: (text) => editor.insertTextAtCursor(text),
        submitCurrentText: () => editor.submitCurrentText(),
        browsePromptHistory: (input) => editor.browsePromptHistory(input),
        hasEditorReplacement: () => editor.getEditorComponent() !== undefined || editor.hasInputComponent(),
        hasInputComponent: () => editor.hasInputComponent(),
        forwardToInputComponent: (data) => editor.handleInput(data),
      },
      {
        executeCommand: (command) =>
          handleSubmittedInput(
            state,
            runtime,
            command,
            tui,
            options.onStateChanged,
            undefined,
            options.workspaceFile,
          ),
        extensionCommands: () => activeExtensionCommands(state, runtime),
      },
      { workspaceFile: options.workspaceFile, rootStateDir: options.rootStateDir },
    );
    if (result?.consume) return result;
    // Global Ctrl+E opens the MAIN input editor's text in an external editor.
    // Skip it while an extension component owns the editor slot (e.g. the /view
    // editor): the key must fall through to the focused EditorSlot so the
    // extension editor's own Ctrl+E opens ITS content, not the empty main input.
    if (matchesKey(data, "ctrl+e") && !editor.getEditorComponent()) {
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
    stopWorkingRedraw();
    stopLiveExtensionRedraw();
    root.dispose();
    originalStop();
  };
  tui.addChild(root);
  tui.setFocus(editor);
  return tui;
}

const SKILL_CACHE_TTL_MS = 10_000; // Background refresh after 10 seconds

/**
 * Stale-while-revalidate skill completion source.
 * Returns cached skills immediately and triggers a background filesystem re-scan
 * when the cache is stale, so newly added skills appear within ~10s.
 */
export function createActiveSkillCompletionSource(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "getTab">,
  fallbackSkills: MixCodeCompletionSources["skills"] | undefined,
): () => Array<string | MixCodeSkillCompletionSource> {
  let cachedSkills: Array<string | MixCodeSkillCompletionSource> = [];
  let cacheTimestamp = 0;
  let pendingRescan: Promise<void> | undefined;

  function readSkillsFromLoader(): Array<string | MixCodeSkillCompletionSource> | undefined {
    const active = getActiveTab(state);
    if (active && state.activeTabId !== "config") {
      const runtimeTab = runtime.getTab(active.sessionId);
      if (runtimeTab?.services?.resourceLoader) {
        return runtimeTab.services.resourceLoader
          .getSkills()
          .skills.map((skill) => ({
            name: skill.name,
            path: skill.filePath,
            description: skill.description,
            sourceInfo: skill.sourceInfo
              ? { scope: skill.sourceInfo.scope, source: skill.sourceInfo.source }
              : undefined,
          }));
      }
    }
    return undefined;
  }

  function triggerBackgroundRescan(): void {
    if (pendingRescan) return;
    const workdir = activeCompletionWorkdir(state);
    pendingRescan = scanSkillEntries(workdir)
      .then((entries) => {
        // Merge filesystem-scanned skills with resource loader skills.
        // Resource loader skills (extension-contributed) take precedence for duplicates.
        const loaderSkills = readSkillsFromLoader();
        const loaderNames = new Set(
          (loaderSkills ?? []).map((s) => (typeof s === "string" ? s : s.name)),
        );
        const newSkills: Array<string | MixCodeSkillCompletionSource> = [
          ...(loaderSkills ?? []),
        ];
        for (const entry of entries) {
          if (!loaderNames.has(entry.name)) {
            newSkills.push({
              name: entry.name,
              path: entry.path,
              description: entry.description,
            });
          }
        }
        cachedSkills = newSkills;
        cacheTimestamp = Date.now();
      })
      .catch(() => {
        // Silently ignore rescan errors for background refresh
      })
      .finally(() => {
        pendingRescan = undefined;
      });
  }

  return () => {
    const fresh = readSkillsFromLoader();
    if (fresh) {
      // If cache is fresh, return it directly
      if (cacheTimestamp > 0 && Date.now() - cacheTimestamp < SKILL_CACHE_TTL_MS) {
        return cachedSkills;
      }
      // Cache is stale or first load — update cache and trigger background rescan
      cachedSkills = fresh;
      cacheTimestamp = Date.now();
      triggerBackgroundRescan();
      return cachedSkills;
    }
    // Fallback to static bootstrap skills
    return fallbackSkills ? (typeof fallbackSkills === "function" ? fallbackSkills() : fallbackSkills) : [];
  };
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

/**
 * Provide live fd-backed `@` file completion sources for the active tab's
 * workdir. fd presence is probed once and memoized; when fd is missing this
 * returns undefined so the provider falls back to the static file list.
 */
export function createActiveFileSearchSource(
  state: MixCodeState,
): () => { fdPath: string; workdir: string } | undefined {
  let resolved = false;
  let fdPath: string | undefined;
  return () => {
    if (!resolved) {
      fdPath = resolveFdBinary();
      resolved = true;
    }
    if (!fdPath) return undefined;
    return { fdPath, workdir: activeCompletionWorkdir(state) };
  };
}

function activeCompletionWorkdir(state: MixCodeState): string {
  if (state.activeTabId === "config") {
    // On Agent View, use the selected agent's workdir for file completion.
    const selected = state.tabs[state.homeSelectedTabIndex];
    return selected?.workdir ?? state.workdir;
  }
  const active = getActiveTab(state);
  return active ? active.workdir : state.workdir;
}
