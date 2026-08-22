import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, ProcessTerminal, TuiMainScreen, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { ExtensionCustomUiHost, MixCodeRuntime } from "../agent/runtime.js";
import { scanSkillEntries } from "../core/attachments.js";
import { applyDisabledModelFlags, buildAvailableModelRefs, modelRefId } from "../core/models.js";
import { availableThinkingLevelsForModel } from "../core/thinking-levels.js";
import { noteTabClosed } from "../core/open-tabs-store.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import { closeAgentTab, getActiveTab, onActiveTabChange } from "../core/tabs.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "./app-editor.js";
import { stopChatSelectionAutoScroll } from "./app-mouse.js";
import { handleMixCodeKeyInput } from "./app-input.js";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
  renderVisibleTabBar,
} from "./app-layout.js";
import {
  appOverlayHandlesInput,
  editTextWithTuiPaused,
  errorMessage,
  showErrorOverlay,
} from "./app-overlays.js";
import {
  activeExtensionCommands,
  bindActiveTabShimmerRedraw,
  bindLiveExtensionRedraw,
  bindLoadingRedraw,
  bindRuntimeRendering,
  bindWorkingRedraw,
  createActiveAutocompleteProvider,
  hydrateTabPromptHistory,
} from "./app-runtime.js";
import { handleSubmittedInput } from "./app-submit.js";
import { attachTreeSelectorDisplayHost } from "./components/tree-selector.js";
import {
  MixCodeCompletionProvider,
  type MixCodeCompletionSources,
  type MixCodeSkillCompletionSource,
} from "./components/completion.js";
import { renderExtensionFooter, renderFooter } from "./rendering.js";
import { InjectingTerminal, withMouseReporting } from "./terminal.js";
import { installStdoutScreenGuard, withHostStdoutGuard } from "./stdout-screen-guard.js";
import { noteActiveExtensionThemeId } from "../agent/runtime-extension-theme.js";
import { setTheme, themeForId } from "./themes.js";
import { workspaceNameCompletions } from "./workspace-actions.js";

export { handleMixCodeKeyInput } from "./app-input.js";
export { MixCodeRoot } from "./app-layout.js";
export {
  bindActiveTabShimmerRedraw,
  bindLiveExtensionRedraw,
  bindRuntimeRendering,
  bindWorkingRedraw,
} from "./app-runtime.js";
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
  terminal?: ConstructorParameters<typeof TuiMainScreen>[0];
  exitProcessOnQuit?: boolean;
  rootStateDir?: string;
  /** Required to enable the /settings overlay panel. */
  settingsDeps?: {
    settingsManager: SettingsManager;
    mixcodeFile: string;
    piSettingsFile: string;
  };
}
export type MixCodeTui = TuiType & {
  injectInput(data: string): void;
  /** Renderer-only terminal handoff (see OverlayTui.pause/resume). */
  pause(): void;
  resume(): void;
};

export function createMixCodeTui(
  state: MixCodeState,
  runtime: MixCodeRuntime,
  options: MixCodeTuiOptions = {},
): MixCodeTui {
  noteActiveExtensionThemeId(state.theme);
  // Host owns the tty: Terminal writes run under host depth; extension-direct
  // full-screen clears (CSI 2J/3J) are stripped and coalesced into one repaint.
  const injecting = new InjectingTerminal(
    withHostStdoutGuard(withMouseReporting(options.terminal ?? new ProcessTerminal())),
  );
  const tui = new TuiMainScreen(injecting) as unknown as MixCodeTui;
  tui.injectInput = (data) => injecting.inject(data);
  // Strip only: extension clears never hit the wire, so the previous frame is still
  // valid. Do not requestRender/clearScreen on block — that reintroduces the flash.
  const uninstallStdoutGuard = installStdoutScreenGuard({});
  (tui as TuiType & { mixCodeExitProcessOnQuit?: boolean }).mixCodeExitProcessOnQuit =
    options.exitProcessOnQuit === true;
  bindRuntimeRendering(runtime, tui, state, options.onStateChanged);
  const stopWorkingRedraw = bindWorkingRedraw(state, tui);
  const stopLoadingRedraw = bindLoadingRedraw(state, tui);
  // Extension ctx.ui.setTitle owns the terminal title per tab: the active tab
  // writes immediately (runtime ui context); stored titles re-apply on switch.
  // Tabs without a title leave the current title untouched (Pi: persists until
  // overwritten).
  const stopExtensionTitleSync = onActiveTabChange((tabId) => {
    const title = state.tabs.find((tab) => tab.sessionId === tabId)?.extensionUi.title;
    if (title !== undefined) tui.terminal.setTitle(title);
  });
  const stopLiveExtensionRedraw = bindLiveExtensionRedraw(state, tui);
  const stopActiveTabShimmerRedraw = bindActiveTabShimmerRedraw(state, tui);
  let editorRows = 0;
  let metaRows = state.activeTabId === HOME_TAB_ID ? 0 : 1;
  // Filled after EditorSlot construction; MixCodeRoot reads it lazily each render.
  let editorSlot: EditorSlot | undefined;
  const main = new MixCodeRoot(
    state,
    runtime,
    () => tui.terminal.rows,
    () => {
      // Home has no agent extension footer; only count it on agent tabs.
      const active =
        state.activeTabId === HOME_TAB_ID ? undefined : getActiveTab(state);
      // Extension footer is real footer chrome; include it in the main surface budget
      // so multi-line setFooter cannot push the tab bar into scrollback.
      return (
        editorRows +
        metaRows +
        renderExtensionFooter(active, tui.terminal.columns).length +
        renderFooter(tui.terminal.columns).length
      );
    },
    // Custom input skins only (setEditorComponent), not temporary dialog overrides.
    () => editorSlot?.getEditorComponent() !== undefined,
    () => editorSlot?.hasInputComponent() === true,
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
  editorSlot = editor;
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
      undefined,
      options.settingsDeps,
      { setText: (value) => editor.setText(value) },
    ).catch((error: unknown) => {
      // Avoid secondary Unknown tab session when the active tab has no runtime yet
      // (e.g. create failed and rolled back to a Not Ready tab, or peer closed it).
      const active = getActiveTab(state);
      if (active && state.activeTabId !== HOME_TAB_ID && runtime.getTab(active.sessionId)) {
        try {
          runtime.appendSystemMessage(active.sessionId, errorMessage(error));
        } catch {
          showErrorOverlay(tui, error);
        }
      } else {
        showErrorOverlay(tui, error);
      }
      tui.setFocus(editor);
      tui.requestRender();
    });
  };
  const baseCompletionProvider = new MixCodeCompletionProvider({
    ...(options.completionSources ?? { skills: [] }),
    skills: createActiveSkillCompletionSource(state, runtime, options.completionSources?.skills),
    workdir: () => activeCompletionWorkdir(state),
    // @-mention source: agent tabs of this instance, excluding the tab the
    // prompt will be sent to (active tab; on Home, the selected tab).
    tabs: () => {
      const self = getActiveTab(state);
      return state.tabs
        .filter((tab) => tab.sessionId !== self?.sessionId)
        .map((tab) => ({ title: tab.title, status: tab.status }));
    },
    commands: () => {
      const active = getActiveTab(state);
      const extensionCommands =
        active && state.activeTabId !== HOME_TAB_ID
          ? runtime.getExtensionCommands(active.sessionId)
          : runtime.getAllExtensionCommands();
      return [
        ...extensionCommands,
        {
          name: "models",
          argumentHint: "[provider/model-id]",
          getArgumentCompletions: (prefix: string) => modelArgumentCompletions(state, prefix),
        },
        {
          name: "thinking",
          argumentHint: "[level]",
          getArgumentCompletions: (prefix: string) => thinkingArgumentCompletions(state, prefix),
        },
        {
          name: "restore-workspace",
          argumentHint: "[name]",
          getArgumentCompletions: (prefix: string) =>
            workspaceNameCompletions(options.workspaceFile, prefix),
        },
        {
          name: "delete-workspace",
          argumentHint: "[name]",
          getArgumentCompletions: (prefix: string) =>
            workspaceNameCompletions(options.workspaceFile, prefix),
        },
      ];
    },
    promptTemplates: () => {
      // Dynamically resolve prompt templates from the active tab's resource loader,
      // which includes extension-contributed templates.
      const active = getActiveTab(state);
      if (active && state.activeTabId !== HOME_TAB_ID) {
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
  runtime.setExtensionUiHost({
    tui,
    editor: {
      getText: (sessionId) => editor.getText(sessionId),
      getExpandedText: (sessionId) => editor.getExpandedText(sessionId),
      setText: (text, sessionId) => editor.setText(text, sessionId),
      pasteToEditor: (text, sessionId) => editor.pasteToEditor(text, sessionId),
      // Always rebind the multi-tab live proxy. Extension addAutocompleteProvider
      // invalidates per-session cache and only needs a rebind so EditorSlot can
      // re-snapshot triggerCharacters; never install a single-session concrete
      // chain into the shared editor (that freezes wrappers to one tab).
      setAutocompleteProvider: () =>
        editor.setAutocompleteProvider(activeCompletionProvider),
      setEditorComponent: (factory, sessionId) => editor.setEditorComponent(factory, sessionId),
      getEditorComponent: (sessionId) => editor.getEditorComponent(sessionId),
      getEmbeddedTerminalRows: (sessionId) => editor.getEmbeddedTerminalRows(sessionId),
    },
    themes: {
      getTheme: () => state.theme,
      setTheme: (themeId) => {
        setTheme(state, themeId);
        noteActiveExtensionThemeId(themeId);
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
      const theme = themeForId(state.theme);
      return renderVisibleTabBar(state, width, theme).length;
    },
  } satisfies ExtensionCustomUiHost);
  // Extension ctx.shutdown() closes the runtime tab; mirror into MixCodeState.
  runtime.onTabClosed((sessionId) => {
    if (!state.tabs.some((tab) => tab.sessionId === sessionId)) return;
    // Publish before removing local state so a write failure leaves the tab visible.
    noteTabClosed(sessionId);
    closeAgentTab(state, sessionId);
    void options.onStateChanged?.(state);
    tui.requestRender();
  });
  // Extension pi.registerProvider → ModelRegistry; keep /model picker in sync.
  runtime.onModelsChanged((refs) => {
    state.availableModels = applyDisabledModelFlags(
      buildAvailableModelRefs(refs),
      state.disabledProviders,
      state.disabledModels,
    );
    void options.onStateChanged?.(state);
    tui.requestRender();
  });
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
        // Skin vs takeover: permanent setEditorComponent is visual only.
        hasCustomEditorSkin: () => editor.getEditorComponent() !== undefined,
        hasInputComponent: () => editor.hasInputComponent(),
        forwardToInputComponent: (data) => editor.handleInput(data),
        setInputComponent: (component, sessionId) => editor.setInputComponent(component, sessionId),
        clearInputComponent: (sessionId) => editor.clearInputComponent(sessionId),
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
            undefined,
            options.settingsDeps,
          ),
        extensionCommands: () => activeExtensionCommands(state, runtime),
      },
      { workspaceFile: options.workspaceFile, rootStateDir: options.rootStateDir, settingsDeps: options.settingsDeps },
    );
    if (result?.consume) return result;
    // Global Ctrl+E opens the active input editor in an external editor.
    // Pending extension interactions (e.g. /view dialog) own the key; permanent
    // setEditorComponent skins still use MixCode external-edit on active text.
    const activeForEdit = state.activeTabId === HOME_TAB_ID ? undefined : getActiveTab(state);
    if (
      matchesKey(data, "ctrl+e") &&
      !appOverlayHandlesInput(tui) &&
      !(activeForEdit?.extensionUi.waitingForInputs.length)
    ) {
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
  const originalStart = tui.start.bind(tui);
  const originalStop = tui.stop.bind(tui);
  tui.start = () => {
    originalStart();
    // MouseReportingTerminal.start() clears the screen. Force a full paint so
    // unchanged chrome (input meta) is rewritten after extension stop/start.
    tui.renderNow(true);
  };
  tui.stop = () => {
    stopWorkingRedraw();
    stopLoadingRedraw();
    stopLiveExtensionRedraw();
    stopActiveTabShimmerRedraw();
    stopChatSelectionAutoScroll();
    stopExtensionTitleSync();
    root.dispose();
    originalStop();
    uninstallStdoutGuard();
  };
  // Renderer-only pause for external-process handoff ($EDITOR). Must bypass
  // the destructive stop() wrappers above and in interactive-app (they dispose
  // the ctl server, clear the instance heartbeat, and kill peer tab sync —
  // permanently, since nothing restarts them on tui.start()). While paused,
  // background requestRender calls are no-ops inside pi-tui, so redraw timers
  // may keep running without painting over the editor.
  tui.pause = originalStop;
  tui.resume = () => {
    originalStart();
    tui.renderNow(true);
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
    if (active && state.activeTabId !== HOME_TAB_ID) {
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

type ArgumentCompletion = { value: string; label: string; description?: string };

/** /models argument completions: enabled models as provider/model-id. */
function modelArgumentCompletions(state: MixCodeState, prefix: string): ArgumentCompletion[] {
  const needle = prefix.trim().toLowerCase();
  return state.availableModels
    .filter((model) => !model.disabled)
    .map((model) => ({
      value: modelRefId(model),
      label: modelRefId(model),
      description: model.displayName,
    }))
    .filter(
      (item) =>
        !needle ||
        item.value.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle),
    );
}

/** /thinking argument completions: levels supported by the target tab's model. */
function thinkingArgumentCompletions(state: MixCodeState, prefix: string): ArgumentCompletion[] {
  const active = getActiveTab(state);
  const needle = prefix.trim().toLowerCase();
  const current = active?.thinkingLevel ?? state.thinkingLevel;
  return availableThinkingLevelsForModel(active?.model ?? state.model)
    .filter((level) => !needle || level.startsWith(needle))
    .map((level) => ({
      value: level,
      label: level,
      description: level === current ? "current" : "thinking level",
    }));
}

function activeCompletionWorkdir(state: MixCodeState): string {
  if (state.activeTabId === HOME_TAB_ID) {
    // On Agent View, use the selected agent's workdir for file completion.
    const selected = state.tabs[state.homeSelectedTabIndex];
    return selected?.workdir ?? state.workdir;
  }
  const active = getActiveTab(state);
  return active ? active.workdir : state.workdir;
}
