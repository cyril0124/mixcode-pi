import type { TUI as TuiType } from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS } from "../agent/runtime-extension-theme.js";
import { parseInput } from "../core/commands.js";
import { createTab } from "../core/defaults.js";
import { MIXCODE_KEYMAP } from "../core/keymap.js";
import { buildModelPrompt } from "../core/prompt-build.js";
import { expandLocalPromptCommand } from "../core/prompt-templates.js";
import type { ShellManager } from "../core/shell-session.js";
import { resolveThemeInput, setTheme } from "../core/theme-registry.js";
import { stringifyJson } from "../core/json.js";
import { deleteWorkspace, loadWorkspaces, saveWorkspaces } from "../core/state-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { restoreWorkspaceOrder, snapshotWorkspace, upsertWorkspace } from "../core/workspace.js";
import { activateTab, closeAgentTab, renameAgentTab } from "../core/tabs.js";
import { findModelRef } from "../core/models.js";
import { createPicker } from "../core/pickers.js";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { MixCodeState } from "../core/types.js";
import { renderPickerOverlay } from "./rendering.js";
import type {
  ExportRequest,
  MixCodeSubmitRuntime,
  OverlayTui,
  RuntimeShortcutInfo,
  RuntimeToolInfo,
} from "./app-types.js";
import { createTuiDebugState } from "./app-debug.js";
import {
  editTextWithTuiPaused,
  renderHelpOverlay,
  showLinesOverlay,
  showTextOverlay,
} from "./app-overlays.js";
import {
  appendActiveSystemMessage,
  applyModelSelection,
  applyThinkingLevel,
  applyWorkdirSelection,
  showSystemMessageOrToast,
} from "./app-actions.js";
import { openExtensionManager } from "./extension-manager.js";
export async function handleSubmittedInput(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  text: string,
  tui: Pick<TuiType, "requestRender" | "showOverlay"> & Partial<Pick<TuiType, "stop">>,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  shellManager?: Pick<ShellManager, "open" | "close">,
  workspaceFile?: string,
): Promise<void> {
  const parsed = parseInput(text);
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  const requiresActive =
    parsed.kind === "prompt" || parsed.kind === "shell" || !configScopedCommand(parsed.command);
  if (!active && requiresActive) return;
  if (parsed.kind === "prompt") {
    clearRedoSession(active);
    await runtime.prompt(active!.sessionId, await buildModelPrompt(parsed.args, active!.workdir));
  } else if (parsed.kind === "shell") {
    clearRedoSession(active);
    if (!runtime.executeShellCommand) {
      throw new Error("Shell command execution requires pi runtime bash support");
    }
    await runtime.executeShellCommand(active!.sessionId, parsed.args, {
      excludeFromContext: parsed.excludeFromContext === true,
    });
  } else if (parsed.command === "mark-done") {
    active!.unreadDone = true;
    active!.status = "done";
    // Ring terminal bell after 5s so the user gets an audible notification
    // even if they have switched away from the terminal window.
    setTimeout(() => process.stdout.write("\x07"), 5_000);
  } else if (parsed.command === "vim") {
    active!.vimMode = true;
    active!.vimPendingEscapeAt = undefined;
    active!.vimPendingHome = false;
  } else if (parsed.command === "clear") {
    clearRedoSession(active);
    if (!runtime.clearTab) throw new Error("Clear requires runtime session replacement support");
    const oldSessionId = active!.sessionId;
    const previousStatus = active!.status;
    const previousWorkingStartedAt = active!.workingStartedAt;
    const previousLastWorkedDurationSeconds = active!.lastWorkedDurationSeconds;
    active!.status = "running";
    active!.workingStartedAt = new Date().toISOString();
    active!.lastWorkedDurationSeconds = undefined;
    tui.requestRender();
    await waitForTuiRenderFrame();
    try {
      const cleared = await runtime.clearTab(oldSessionId, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: active!.thinkingLevel,
        workdir: active!.workdir,
      });
      activateTab(state, cleared.tab.sessionId);
    } catch (error) {
      active!.status = previousStatus;
      active!.workingStartedAt = previousWorkingStartedAt;
      active!.lastWorkedDurationSeconds = previousLastWorkedDurationSeconds;
      throw error;
    }
  } else if (parsed.command === "new-session") {
    const sessionId = parsed.args.trim() || `session-${Date.now()}`;
    const tab = createTab(state.tabs.length + 1, sessionId, state.workdir, {
      model: { ...state.model },
      contextLimit: state.model.contextWindow,
      thinkingLevel: state.thinkingLevel,
    });
    state.tabs.push(tab);
    activateTab(state, sessionId);
    await runtime.createTab(tab, {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: state.thinkingLevel,
      workdir: state.workdir,
    });
  } else if (parsed.command === "close-session") {
    await runtime.closeTab(active!.sessionId);
    closeAgentTab(state, active!.sessionId);
  } else if (parsed.command === "delete-session") {
    await runtime.deleteTab(active!.sessionId);
    closeAgentTab(state, active!.sessionId);
  } else if (parsed.command === "delete-all-sessions") {
    await runtime.deleteAllTabs();
    state.tabs.length = 0;
    activateTab(state, "config");
  } else if (parsed.command === "save-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = requireCommandArg(parsed.args, "workspace name");
    await saveWorkspaces(
      workspaceFile,
      upsertWorkspace(await loadOptionalWorkspaces(workspaceFile), snapshotWorkspace(state, name)),
    );
    showSystemMessageOrToast(state, runtime, tui, `Workspace saved: ${name}`);
  } else if (parsed.command === "restore-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = requireCommandArg(parsed.args, "workspace name");
    const workspace = (await loadWorkspaces(workspaceFile)).find((item) => item.name === name);
    if (!workspace) throw new Error(`Unknown workspace: ${name}`);
    restoreWorkspaceOrder(state, workspace);
    showSystemMessageOrToast(state, runtime, tui, `Workspace restored: ${name}`);
  } else if (parsed.command === "delete-workspace") {
    if (!workspaceFile) throw new Error("Workspace file is not configured");
    const name = requireCommandArg(parsed.args, "workspace name");
    await deleteWorkspace(workspaceFile, name);
    showSystemMessageOrToast(state, runtime, tui, `Workspace deleted: ${name}`);
  } else if (parsed.command === "export") {
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const request = parseExportRequest(parsed.args);
    const text = renderExportText(request.target, runtimeTab);
    if (request.editorDisabled) {
      showTextOverlay(tui, text);
    } else {
      await editTextWithTuiPaused(tui, text, request.editor);
    }
  } else if (parsed.command === "import") {
    clearRedoSession(active);
    if (!runtime.importFromJsonl)
      throw new Error("Import requires pi runtime session import support");
    const request = parseImportRequest(parsed.args);
    const result = await runtime.importFromJsonl(
      active!.sessionId,
      request.path,
      request.cwdOverride,
    );
    if (result.cancelled) {
      showSystemMessageOrToast(state, runtime, tui, "Import cancelled.");
    } else {
      activateTab(state, active!.sessionId);
      showSystemMessageOrToast(state, runtime, tui, `Imported session: ${request.path}`);
    }
  } else if (parsed.command === "extension-manager") {
    openExtensionManager(state, runtime, tui);
  } else if (parsed.command === "reload") {
    if (!runtime.extensionReload) throw new Error("Reload requires pi runtime reload support");
    await runtime.extensionReload(active!.sessionId);
    showSystemMessageOrToast(
      state,
      runtime,
      tui,
      "Reloaded keybindings, extensions, skills, prompts, and themes",
    );
  } else if (parsed.command === "fork") {
    clearRedoSession(active);
    const sessionId = parsed.args.trim() || `${active!.sessionId}-fork-${Date.now()}`;
    await runtime.forkSession(active!.sessionId, sessionId);
    const tab = createTab(state.tabs.length + 1, sessionId, active!.workdir, {
      model: { ...active!.model },
      thinkingLevel: active!.thinkingLevel,
      title: `${active!.title}-fork`,
    });
    state.tabs.push(tab);
    activateTab(state, sessionId);
    await runtime.createTab(tab, {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: tab.thinkingLevel,
      workdir: tab.workdir,
    });
  } else if (parsed.command === "rename") {
    renameAgentTab(state, active!.sessionId, parsed.args);
  } else if (parsed.command === "models") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("models", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    const model = findModelRef(state.availableModels, parsed.args);
    applyModelSelection(state, active!, model, runtime);
  } else if (parsed.command === "theme") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("theme", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    setTheme(state, resolveThemeInput(parsed.args));
  } else if (parsed.command === "workdir") {
    clearRedoSession(active);
    if (!parsed.args.trim()) {
      state.picker = createPicker("workdir", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    await applyWorkdirSelection(active!, parsed.args.trim(), runtime);
  } else if (parsed.command === "thinking") {
    if (!parsed.args.trim()) {
      state.picker = createPicker("thinking", state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    applyThinkingLevel(state, active!, parsed.args.trim(), runtime);
  } else if (parsed.command === "help") {
    state.helpOpen = true;
    showLinesOverlay(tui, renderHelpOverlay);
  } else if (parsed.command === "hotkeys") {
    const shortcuts = active ? getExtensionShortcuts(runtime, active.sessionId) : [];
    showSystemMessageOrToast(state, runtime, tui, renderHotkeysText(shortcuts));
  } else if (parsed.command === "system-prompt") {
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const request = parseEditorFlag(parsed.args);
    if (request.editorDisabled) {
      showTextOverlay(tui, runtimeTab.agent.state.systemPrompt);
    } else {
      await editTextWithTuiPaused(tui, runtimeTab.agent.state.systemPrompt, request.editor);
    }
  } else if (parsed.command === "system-tools") {
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const request = parseEditorFlag(parsed.args);
    const text = renderSystemToolsText(getRuntimeTools(runtime, active!.sessionId, runtimeTab));
    if (request.editorDisabled) {
      showTextOverlay(tui, text);
    } else {
      await editTextWithTuiPaused(tui, text, request.editor);
    }
  } else if (parsed.command === "session") {
    const runtimeTab = runtime.getTab(active!.sessionId);
    if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
    const info = runtimeTab.agentSession.getSessionStats();
    syncTabContextUsage(active!, info.contextUsage);
    runtime.appendSystemMessage(active!.sessionId, renderSessionInfoText(runtimeTab, info));
  } else if (parsed.command === "tui-state") {
    const request = parseEditorFlag(parsed.args);
    const text = stringifyJson(createTuiDebugState(state), true);
    if (request.editorDisabled) {
      showTextOverlay(tui, text);
    } else {
      await editTextWithTuiPaused(tui, text, request.editor);
    }
  } else if (parsed.command === "quit" || parsed.command === "exit") {
    if (!tui.stop) throw new Error("Quit command requires TUI stop support");
    await runtime.closeAllTabs();
    tui.stop();
  } else if (parsed.command === "undo") {
    await runtime.undoLastUserTurn(active!.sessionId);
    activateTab(state, active!.sessionId);
  } else if (parsed.command === "redo") {
    if (!runtime.redoLastUndo)
      throw new Error("Redo requires pi runtime session replacement support");
    await runtime.redoLastUndo(active!.sessionId);
    activateTab(state, active!.sessionId);
  } else if (parsed.command === "compact") {
    clearRedoSession(active);
    await runtime.compactSession(active!.sessionId, parsed.args);
  } else if (isExtensionCommand(runtime, active!.sessionId, parsed.command)) {
    clearRedoSession(active);
    await runtime.prompt(active!.sessionId, `/${parsed.command} ${parsed.args}`.trim());
  } else {
    appendActiveSystemMessage(state, runtime, `Unknown slash command: /${parsed.command}`.trim());
  }
  await onStateChanged?.(state);
  tui.requestRender();
}

function isExtensionCommand(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  command: string | undefined,
): boolean {
  if (!command || !runtime.getExtensionCommands) return false;
  return runtime.getExtensionCommands(sessionId).some((item) => item.name === command);
}

function clearRedoSession(tab: MixCodeState["tabs"][number] | undefined): void {
  if (tab) tab.redoSessionId = undefined;
}

function configScopedCommand(command: string | undefined): boolean {
  return (
    command === "theme" ||
    command === "tui-state" ||
    command === "new-session" ||
    command === "delete-all-sessions" ||
    command === "save-workspace" ||
    command === "restore-workspace" ||
    command === "delete-workspace" ||
    command === "extension-manager" ||
    command === "vim" ||
    command === "quit" ||
    command === "exit" ||
    command === "help" ||
    command === "hotkeys"
  );
}
async function loadOptionalWorkspaces(workspaceFile: string) {
  try {
    return await loadWorkspaces(workspaceFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function requireCommandArg(args: string, label: string): string {
  const value = args.trim();
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function parseImportRequest(args: string): { path: string; cwdOverride?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const path = parts[0];
  if (!path) throw new Error("Missing import JSONL path");
  return { path, cwdOverride: parts[1] };
}

export function renderExportText(
  args: string,
  runtimeTab: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>,
): string {
  const target = parseExportRequest(args).target;
  if (target === "thinking") {
    return [
      "Thinking Export",
      "",
      ...(runtimeTab.reasoning.length ? runtimeTab.reasoning : ["No thinking entries."]),
    ].join("\n");
  }
  if (target === "chatlog") {
    return ["Chat Export", "", ...runtimeTab.chat.map(formatExportChatLine)].join("\n");
  }
  if (target === "latest-agent" || target === "latest-agent-reply") {
    const latest = [...runtimeTab.chat].reverse().find((line) => line.role === "assistant");
    return ["Latest Agent Reply", "", latest?.text ?? "No assistant message."].join("\n");
  }
  if (target === "latest-user" || target === "latest-user-message") {
    const latest = [...runtimeTab.chat].reverse().find((line) => line.role === "user");
    return ["Latest User Message", "", latest?.text ?? "No user message."].join("\n");
  }
  if (target === "system-info") {
    const sections: string[] = [];
    sections.push(renderSessionInfoText(runtimeTab));
    sections.push("");
    sections.push("═".repeat(60));
    sections.push("");
    sections.push("System Prompt");
    sections.push("");
    sections.push(runtimeTab.agent.state.systemPrompt || "(empty)");
    sections.push("");
    sections.push("═".repeat(60));
    sections.push("");
    const tools = runtimeTab.agentSession.getAllTools();
    sections.push(renderSystemToolsText(Array.isArray(tools) ? tools : []));
    return sections.join("\n");
  }
  throw new Error(`Unknown export target: ${target}`);
}

function getRuntimeTools(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  runtimeTab: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>,
): RuntimeToolInfo[] {
  const tools = runtime.getExtensionTools?.(sessionId) ?? runtimeTab.agentSession.getAllTools();
  return Array.isArray(tools) ? tools : [];
}

function getExtensionShortcuts(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
): RuntimeShortcutInfo[] {
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${sessionId}`);
  return [
    ...runtimeTab.agentSession.extensionRunner
      .getShortcuts(MIXCODE_EXTENSION_KEYBINDINGS)
      .entries(),
  ].map(([key, shortcut]) => ({
    key,
    description: shortcut.description,
    source: shortcut.extensionPath,
  }));
}

export function renderSystemToolsText(tools: RuntimeToolInfo[]): string {
  if (tools.length === 0) return ["System Tools", "", "No tools available."].join("\n");
  return [
    "System Tools",
    "",
    ...tools
      .map((tool) => formatSystemTool(tool))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

export function renderHotkeysText(extensionShortcuts: RuntimeShortcutInfo[] = []): string {
  const lines = [
    "Keyboard Shortcuts",
    "",
    ...formatHotkeyGroup("Global", hotkeysForScope("global")),
    "",
    ...formatHotkeyGroup("Picker", hotkeysForScope("picker")),
    "",
    ...formatHotkeyGroup("Command Palette", hotkeysForScope("command-palette")),
    "",
    ...formatHotkeyGroup("Tab Jump", hotkeysForScope("tab-jump")),
    "",
    ...formatHotkeyGroup("Export", hotkeysForScope("export")),
    "",
    ...formatHotkeyGroup("Question", hotkeysForScope("question")),
    "",
    ...formatHotkeyGroup("Preview", hotkeysForScope("preview")),
    "",
    ...formatHotkeyGroup("Shell", hotkeysForScope("shell")),
    "",
    "Other",
    "| Key | Action |",
    "|-----|--------|",
    "| `/` | Slash commands |",
    "| `!` | Run bash command |",
    "| `!!` | Run bash command (excluded from context) |",
  ];
  const extensions = extensionShortcuts.filter((shortcut) => shortcut.key.trim());
  if (extensions.length > 0) {
    lines.push(
      "",
      ...formatHotkeyGroup(
        "Extensions",
        extensions.map((shortcut) => ({
          key: shortcut.key,
          description: shortcut.description?.trim() || shortcut.source || "Extension shortcut",
        })),
      ),
    );
  }
  return lines.join("\n");
}

function hotkeysForScope(scope: string): Array<{ key: string; description: string }> {
  return MIXCODE_KEYMAP.filter((item) => (item.scope ?? "global") === scope).map((item) => ({
    key: item.key,
    description: item.description,
  }));
}

function formatHotkeyGroup(
  title: string,
  entries: Array<{ key: string; description: string }>,
): string[] {
  return [
    title,
    "| Key | Action |",
    "|-----|--------|",
    ...entries.map((entry) => `| \`${formatHotkey(entry.key)}\` | ${entry.description} |`),
  ];
}

function formatHotkey(key: string): string {
  if (key === "/") return "/";
  const parts = key.includes("+/") ? [key] : key.split("/");
  return parts.map((part) => formatHotkeyChord(part)).join(" / ");
}

function formatHotkeyChord(chord: string): string {
  return chord
    .split("+")
    .map((segment) => formatHotkeySegment(segment))
    .join("+");
}

function formatHotkeySegment(segment: string): string {
  const normalized = segment.trim();
  const labels: Record<string, string> = {
    alt: "Alt",
    ctrl: "Ctrl",
    down: "Down",
    end: "End",
    enter: "Enter",
    escape: "Escape",
    home: "Home",
    j: "J",
    k: "K",
    l: "L",
    left: "Left",
    pageDown: "PageDown",
    pageup: "PageUp",
    pageUp: "PageUp",
    right: "Right",
    shift: "Shift",
    space: "Space",
    tab: "Tab",
    up: "Up",
  };
  if (/^[a-z]$/.test(normalized)) return normalized.toUpperCase();
  return labels[normalized] ?? normalized;
}

type SessionStatsInfo = ReturnType<
  NonNullable<ReturnType<MixCodeRuntime["getTab"]>>["agentSession"]["getSessionStats"]
>;

function syncTabContextUsage(
  tab: MixCodeState["tabs"][number],
  contextUsage: SessionStatsInfo["contextUsage"],
): void {
  if (!contextUsage) return;
  tab.contextLimit = contextUsage.contextWindow;
  tab.currentContextTokens = contextUsage.tokens === null ? undefined : contextUsage.tokens;
}

export function renderSessionInfoText(
  runtimeTab: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>,
  info: SessionStatsInfo = runtimeTab.agentSession.getSessionStats(),
): string {
  const name = runtimeTab.session.getSessionName();
  const lines = ["Session Info", ""];
  if (name) lines.push(`Name: ${name}`);
  lines.push(
    `File: ${info.sessionFile ?? "In-memory"}`,
    `ID: ${info.sessionId}`,
    "",
    "Messages",
    `User: ${info.userMessages}`,
    `Assistant: ${info.assistantMessages}`,
    `Tool Calls: ${info.toolCalls}`,
    `Tool Results: ${info.toolResults}`,
    `Total: ${info.totalMessages}`,
    "",
    "Tokens",
    `Input: ${info.tokens.input.toLocaleString()}`,
    `Output: ${info.tokens.output.toLocaleString()}`,
  );
  if (info.tokens.cacheRead > 0) lines.push(`Cache Read: ${info.tokens.cacheRead.toLocaleString()}`);
  if (info.tokens.cacheWrite > 0)
    lines.push(`Cache Write: ${info.tokens.cacheWrite.toLocaleString()}`);
  lines.push(`Total: ${info.tokens.total.toLocaleString()}`);
  if (info.contextUsage) {
    lines.push(
      "",
      "Context",
      `Current: ${formatSessionContextTokens(info.contextUsage.tokens)}`,
      `Limit: ${formatSessionContextLimit(info.contextUsage.contextWindow)}`,
      `Usage: ${formatSessionContextPercent(info.contextUsage.percent)}`,
    );
  }
  if (info.cost > 0) lines.push("", "Cost", `Total: ${info.cost.toFixed(4)}`);
  return lines.join("\n");
}

function formatSessionContextTokens(tokens: number | null): string {
  return tokens === null ? "unknown" : formatCompactAndExactTokenCount(tokens);
}

function formatSessionContextLimit(tokens: number): string {
  return formatCompactAndExactTokenCount(tokens);
}

function formatCompactAndExactTokenCount(tokens: number): string {
  const compact = formatCompactTokenCount(tokens);
  const exact = tokens.toLocaleString();
  return compact === exact ? exact : `${compact} (${exact})`;
}

function formatCompactTokenCount(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${tokens < 10_000 ? value.toFixed(2) : value.toFixed(1)}k`;
}

function formatSessionContextPercent(percent: number | null): string {
  return percent === null ? "unknown" : `${percent.toFixed(1)}%`;
}

function formatSystemTool(tool: RuntimeToolInfo): string {
  const name = String(tool.name ?? "(unnamed)");
  const lines = [`## ${name}`];
  if (typeof tool.description === "string" && tool.description.trim())
    lines.push(tool.description.trim());
  const source = formatToolSource(tool.sourceInfo);
  if (source) lines.push(`source: ${source}`);
  if (tool.parameters !== undefined)
    lines.push("parameters:", stringifyJson(tool.parameters, true));
  return lines.join("\n");
}

function formatToolSource(sourceInfo: RuntimeToolInfo["sourceInfo"]): string {
  if (!sourceInfo) return "";
  const parts = [
    typeof sourceInfo.source === "string" && sourceInfo.source
      ? displayToolSource(sourceInfo.source)
      : "",
    typeof sourceInfo.scope === "string" && sourceInfo.scope ? sourceInfo.scope : "",
    typeof sourceInfo.origin === "string" && sourceInfo.origin ? sourceInfo.origin : "",
    typeof sourceInfo.path === "string" && sourceInfo.path
      ? displayToolSourcePath(sourceInfo.path)
      : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function displayToolSource(source: string): string {
  if (source === "builtin") return "pi-builtin";
  if (source === "sdk") return "mixcode-custom";
  return source;
}

function displayToolSourcePath(path: string): string {
  return path.replace(/^<builtin:/, "<pi-builtin:").replace(/^<sdk:/, "<mixcode-custom:");
}

function waitForTuiRenderFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 17);
  });
}

function parseExportRequest(args: string): ExportRequest {
  const { remaining, editor, editorDisabled } = parseEditorFlag(args);
  const parts = remaining.trim().split(/\s+/).filter(Boolean);
  let target = "chatlog";
  for (const part of parts) {
    target = part;
  }
  return { target, editor, editorDisabled };
}

function parseEditorFlag(args: string): {
  remaining: string;
  editor?: string;
  editorDisabled?: boolean;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let editor: string | undefined;
  let editorDisabled = false;
  const remaining: string[] = [];
  for (const part of parts) {
    if (part === "--editor") {
      editor = "";
      editorDisabled = false;
      continue;
    }
    if (part.startsWith("--editor=")) {
      const value = part.slice("--editor=".length);
      editorDisabled = value === "false";
      editor = editorDisabled ? undefined : value;
      continue;
    }
    remaining.push(part);
  }
  return { remaining: remaining.join(" "), editor, editorDisabled };
}

function formatExportChatLine(
  line: NonNullable<ReturnType<MixCodeRuntime["getTab"]>>["chat"][number],
): string {
  if (line.role === "tool") {
    const title = line.title ? `:${line.title}` : "";
    const status = line.status ? `:${line.status}` : "";
    return `[tool${title}${status}] ${line.text}`;
  }
  return `[${line.role}] ${line.text}`;
}
