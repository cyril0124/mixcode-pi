import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { disposeChatRenderers } from "../agent/runtime-chat.js";
import { findSessionFileByName } from "../agent/runtime-session.js";
import { LOCAL_COMMANDS, parseInput, type ParsedInput } from "../core/commands.js";
import { createSessionId, createTab } from "../core/defaults.js";
import { noteTabClosed, noteTabOpened, noteTabReplaced } from "../core/open-tabs-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, closeAgentTab } from "../core/tabs.js";
import type { MixCodeModel, MixCodeModelRef, MixCodeState, MixCodeTabInfo } from "../core/types.js";
import type { MixCodeSubmitRuntime } from "./app-types.js";
import { clearConversationCache } from "./rendering/agent-surface.js";

const LOCAL_COMMAND_NAMES = new Set<string>(LOCAL_COMMANDS.map((command) => command.name));

export interface CreateAgentTabOptions {
  title?: string;
  workdir?: string;
  model?: MixCodeModelRef;
  runtimeModel?: MixCodeModel;
  thinkingLevel?: ThinkingLevel;
  /** Base/identity system prompt; defaults to MIXCODE_SYSTEM_PROMPT. */
  systemPrompt?: string;
}

/**
 * Create the UI tab and Pi runtime tab as one transaction. Runtime startup can
 * fail after the tab is already visible, so rollback must restore both the tab
 * list and the previously active id for every caller, including batch mode.
 */
export async function createAgentTab(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "createTab">,
  options: CreateAgentTabOptions = {},
): Promise<MixCodeTabInfo> {
  const sessionId = createSessionId();
  const previousActiveId = state.activeTabId;
  const workdir = options.workdir ?? state.workdir;
  const model = options.model ?? state.model;
  const thinkingLevel = options.thinkingLevel ?? state.thinkingLevel;
  const customBasePrompt = isCustomBaseSystemPrompt(options.systemPrompt);
  const tab = createTab(state.tabs.length + 1, sessionId, workdir, {
    ...(options.title ? { title: options.title } : {}),
    model: { ...model },
    contextLimit: model.contextWindow,
    thinkingLevel,
    ...(customBasePrompt ? { customBasePrompt: true } : {}),
  });
  state.tabs.push(tab);
  activateTab(state, sessionId);
  try {
    await runtime.createTab(tab, {
      systemPrompt: options.systemPrompt ?? MIXCODE_SYSTEM_PROMPT,
      thinkingLevel,
      workdir,
      ...(options.runtimeModel ? { model: options.runtimeModel } : {}),
    });
    // Publish into the shared open-tab set so peer instances open this session.
    noteTabOpened(sessionId);
    return tab;
  } catch (error) {
    const index = state.tabs.findIndex((item) => item.sessionId === sessionId);
    if (index >= 0) state.tabs.splice(index, 1);
    activateTab(state, previousActiveId);
    throw error;
  }
}

export interface OpenExistingAgentTabOptions extends CreateAgentTabOptions {
  sessionId: string;
}

/**
 * Open a peer/shared session that already exists on disk as a local tab.
 * Does not steal focus (activeTabId stays put). Fails if the session file is
 * missing so callers can retry without creating an empty session.
 */
export async function openExistingAgentTab(
  state: MixCodeState,
  runtime: Pick<MixCodeRuntime, "createTab" | "getSessionsRoot">,
  options: OpenExistingAgentTabOptions,
): Promise<MixCodeTabInfo> {
  const sessionId = options.sessionId;
  if (state.tabs.some((tab) => tab.sessionId === sessionId)) {
    throw new Error(`Tab already exists: ${sessionId}`);
  }
  const sessionFile = findSessionFileByName(runtime.getSessionsRoot(), sessionId);
  if (!sessionFile) {
    throw new Error(`Peer session not on disk yet: ${sessionId}`);
  }
  const workdir = options.workdir ?? state.workdir;
  const model = options.model ?? state.model;
  const thinkingLevel = options.thinkingLevel ?? state.thinkingLevel;
  const customBasePrompt = isCustomBaseSystemPrompt(options.systemPrompt);
  const tab = createTab(state.tabs.length + 1, sessionId, workdir, {
    ...(options.title ? { title: options.title } : {}),
    model: { ...model },
    contextLimit: model.contextWindow,
    thinkingLevel,
    ...(customBasePrompt ? { customBasePrompt: true } : {}),
  });
  state.tabs.push(tab);
  try {
    await runtime.createTab(tab, {
      systemPrompt: options.systemPrompt ?? MIXCODE_SYSTEM_PROMPT,
      thinkingLevel,
      workdir,
      ...(options.runtimeModel ? { model: options.runtimeModel } : {}),
    });
    return tab;
  } catch (error) {
    const index = state.tabs.findIndex((item) => item.sessionId === sessionId);
    if (index >= 0) state.tabs.splice(index, 1);
    throw error;
  }
}

export interface PreparedAgentTabClear {
  oldSessionId: string;
  tab: MixCodeTabInfo;
}

/**
 * Clear the visible conversation before replacing the Pi session. TUI callers
 * deliberately paint this state first because extension loading is synchronous
 * enough to freeze the next frame; batch callers reuse the same reset so both
 * adapters preserve identical tab invariants.
 */
export function prepareAgentTabClear(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
): PreparedAgentTabClear {
  const tab = state.tabs.find((item) => item.sessionId === sessionId);
  if (!tab) throw new Error(`Cannot clear unknown tab: ${sessionId}`);
  // Validate replacement support before destructively clearing the visible tab.
  if (!runtime.clearTab) throw new Error("Clear requires runtime session replacement support");
  const runtimeTab = runtime.getTab?.(sessionId);
  if (runtimeTab) {
    disposeChatRenderers(runtimeTab.chat);
    runtimeTab.chat = [];
  }
  tab.previewMessages = [];
  tab.previewIndex = 0;
  tab.chatScrollOffset = 0;
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
  tab.status = "idle";
  tab.workingStartedAt = undefined;
  tab.lastWorkedDurationSeconds = undefined;
  tab.lastWorkedAt = undefined;
  clearConversationCache(sessionId);
  return { oldSessionId: sessionId, tab };
}

/**
 * Replace the session after the cleared frame is published. The old id is kept
 * separately because `runtime.clearTab()` mutates the existing tab object's
 * session id in place during the replacement.
 */
export async function completeAgentTabClear(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  prepared: PreparedAgentTabClear,
  options?: { systemPrompt?: string; rebuildServices?: boolean },
): Promise<string> {
  if (!runtime.clearTab) throw new Error("Clear requires runtime session replacement support");
  const cleared = await runtime.clearTab(prepared.oldSessionId, {
    systemPrompt: options?.systemPrompt ?? MIXCODE_SYSTEM_PROMPT,
    thinkingLevel: prepared.tab.thinkingLevel,
    workdir: prepared.tab.workdir,
    ...(options?.rebuildServices ? { rebuildServices: true } : {}),
  });
  // Batch clear can install a new base identity; keep the UI badge in sync.
  if (options?.systemPrompt !== undefined) {
    prepared.tab.customBasePrompt = isCustomBaseSystemPrompt(options.systemPrompt)
      ? true
      : undefined;
  }
  const nextSessionId = cleared.tab.sessionId;
  activateTab(state, nextSessionId);
  // The cache is keyed by session id; clear the new key as well because session
  // replacement changes identity while retaining the same tab object.
  clearConversationCache(nextSessionId);
  // /clear swaps session identity: replace the shared open-tab entry so peers
  // drop the old file and open the fresh one.
  if (prepared.oldSessionId !== nextSessionId) {
    // Replace in-place so the tab keeps its position in the shared ordered list.
    noteTabReplaced(prepared.oldSessionId, nextSessionId);
  }
  return nextSessionId;
}

/**
 * Delete runtime persistence before removing the visible tab. If disk/runtime
 * deletion fails, keeping the tab in state makes the failure recoverable rather
 * than presenting a successful close while the session still exists.
 */
export async function deleteAgentTab(
  state: MixCodeState,
  runtime: { deleteTab?: (sessionId: string) => Promise<void> },
  sessionId: string,
): Promise<void> {
  if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
    throw new Error(`Cannot delete unknown tab: ${sessionId}`);
  }
  if (!runtime.deleteTab) throw new Error("Deleting a session requires runtime support");
  await runtime.deleteTab(sessionId);
  closeAgentTab(state, sessionId);
  clearConversationCache(sessionId);
  // Drop from the shared open-tab set so peer instances close it too.
  noteTabClosed(sessionId);
}

/**
 * Close a tab locally without deleting the session file. Used by peer reconcile
 * when the shared open-tab set no longer includes this session, and by user
 * /close-session. Does not steal focus beyond closeAgentTab's normal rules.
 */
export async function closeExistingAgentTab(
  state: MixCodeState,
  runtime: { closeTab?: (sessionId: string) => Promise<void> },
  sessionId: string,
  options: { publishClose?: boolean } = {},
): Promise<void> {
  if (!state.tabs.some((tab) => tab.sessionId === sessionId)) return;
  if (!runtime.closeTab) throw new Error("Closing a session requires runtime support");
  try {
    await runtime.closeTab(sessionId);
  } catch (error) {
    // If the runtime tab is already gone (e.g. peer /clear replaced the session
    // before reconcile finished), still clean up state and cache.
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.startsWith("Unknown tab session:")) throw error;
  }
  closeAgentTab(state, sessionId);
  clearConversationCache(sessionId);
  if (options.publishClose !== false) noteTabClosed(sessionId);
}

/**
 * Dispatch only input that belongs to the agent pipeline. Returning false is
 * intentional: MixCode local commands remain owned by the TUI adapter, while a
 * non-interactive adapter can reject them instead of silently prompting the model.
 */
export async function submitAgentInput(
  tab: MixCodeTabInfo,
  runtime: MixCodeSubmitRuntime,
  text: string,
  parsed: ParsedInput = parseInput(text),
): Promise<boolean> {
  if (parsed.kind === "prompt") {
    // Pass the raw user text to Pi. AgentSession.prompt() owns the native
    // pipeline order: extension commands -> input event -> skill/template
    // expansion. Pre-expanding here would hide the original text from
    // extension input handlers and skip Pi's template syntax (e.g. ${N:-default}).
    await runtime.prompt(tab.sessionId, parsed.args);
    return true;
  }
  if (parsed.kind === "shell") {
    if (!runtime.executeShellCommand) {
      throw new Error("Shell command execution requires pi runtime bash support");
    }
    await runtime.executeShellCommand(tab.sessionId, parsed.args, {
      excludeFromContext: parsed.excludeFromContext === true,
    });
    return true;
  }
  if (!parsed.command || LOCAL_COMMAND_NAMES.has(parsed.command)) return false;
  // Local command names are reserved by MixCode even when an extension declares
  // the same name; only unknown slash commands enter extension/template lookup.
  const commandText = text.trimStart();
  // Both extension commands and prompt templates are handled by Pi's native
  // prompt pipeline; forward the raw command text and let AgentSession.prompt()
  // dispatch and expand it. Unknown slash commands still fall through (return
  // false) so MixCode does not silently send them to the model.
  if (
    isExtensionCommand(runtime, tab.sessionId, parsed.command) ||
    isPromptTemplate(runtime, tab.sessionId, parsed.command)
  ) {
    await runtime.prompt(tab.sessionId, commandText);
    return true;
  }
  return false;
}

function isExtensionCommand(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  command: string,
): boolean {
  return runtime.getExtensionCommands?.(sessionId).some((item) => item.name === command) ?? false;
}

function isPromptTemplate(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  command: string,
): boolean {
  const runtimeTab = runtime.getTab(sessionId);
  return (
    runtimeTab?.services?.resourceLoader
      .getPrompts()
      .prompts.some((prompt) => prompt.name === command) ?? false
  );
}

/** True when the caller overrode the default base/identity system prompt. */
function isCustomBaseSystemPrompt(systemPrompt: string | undefined): boolean {
  return systemPrompt !== undefined && systemPrompt !== MIXCODE_SYSTEM_PROMPT;
}
