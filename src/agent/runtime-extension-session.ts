import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  emitBeforeFork,
  emitBeforeSwitch,
  hasNoVisibleRunOutput,
  hasPriorVisibleConversation,
  inspectSessionImport,
} from "./runtime-chat.js";
import { contentText } from "./runtime-tool-chat.js";
import type {
  ExtensionCustomUiHost,
  ExtensionForkOptions,
  ExtensionNavigateTreeOptions,
  ExtensionNewSessionOptions,
  ExtensionSwitchSessionOptions,
  RuntimeEvent,
  RuntimeTab,
} from "./runtime-types.js";

type ForkPosition = NonNullable<NonNullable<ExtensionForkOptions>["position"]>;

export interface RuntimeExtensionSessionContext {
  requireTab: (sessionId: string) => RuntimeTab;
  createSession: (
    cwd: string,
    sessionId?: string,
    parentSession?: string,
  ) => Promise<SessionManager>;
  replaceRuntimeTabSession: (
    runtimeTab: RuntimeTab,
    sessionManager: SessionManager,
    reason: "new" | "resume" | "fork",
  ) => Promise<RuntimeTab>;
  syncChatFromSession: (runtimeTab: RuntimeTab) => Promise<void>;
  emitChange: (event: RuntimeEvent, runtimeTab: RuntimeTab) => void;
  extensionUiHost: () => ExtensionCustomUiHost | undefined;
  setLiveEditorText: (text: string) => void;
}

export async function extensionNewRuntimeSession(
  sessionId: string,
  options: ExtensionNewSessionOptions | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const beforeResult = await emitBeforeSwitch(runtimeTab, "new");
  if (beforeResult.cancelled) return beforeResult;
  const sessionManager = SessionManager.create(
    runtimeTab.tab.workdir,
    runtimeTab.session.getSessionDir(),
  );
  if (options?.parentSession) {
    sessionManager.newSession({ parentSession: options.parentSession });
  }
  const result = await context.replaceRuntimeTabSession(runtimeTab, sessionManager, "new");
  if (options?.setup) {
    await options.setup(result.session);
    result.agentSession.agent.state.messages = result.session.buildSessionContext().messages;
    await context.syncChatFromSession(result);
  }
  await options?.withSession?.(result.agentSession.createReplacedSessionContext());
  return { cancelled: false };
}

export async function forkRuntimeSession(
  sessionId: string,
  entryId: string,
  options: ExtensionForkOptions | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const position = options?.position ?? "before";
  const selectedEntry = runtimeTab.session.getEntry(entryId);
  if (!selectedEntry) throw new Error("Invalid entry ID for forking");
  if (
    position !== "at" &&
    (selectedEntry.type !== "message" || selectedEntry.message.role !== "user")
  ) {
    throw new Error("Invalid entry ID for forking");
  }
  const beforeResult = await emitBeforeFork(runtimeTab, entryId, position);
  if (beforeResult.cancelled) return beforeResult;
  const { targetLeafId, selectedText } = resolveForkTarget(selectedEntry, position);
  const sessionManager = createForkSession(runtimeTab, targetLeafId, position);
  const result = await context.replaceRuntimeTabSession(runtimeTab, sessionManager, "fork");
  await options?.withSession?.(result.agentSession.createReplacedSessionContext());
  context.setLiveEditorText(selectedText ?? "");
  return { cancelled: false };
}

export async function navigateRuntimeTree(
  sessionId: string,
  targetId: string,
  options: ExtensionNavigateTreeOptions | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean; aborted?: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const result = await runtimeTab.agentSession.navigateTree(targetId, {
    summarize: options?.summarize,
    customInstructions: options?.customInstructions,
    replaceInstructions: options?.replaceInstructions,
    label: options?.label,
  });
  if (result.cancelled) return { cancelled: true, aborted: result.aborted };
  await context.syncChatFromSession(runtimeTab);
  if (result.editorText && !context.extensionUiHost()?.editor?.getText().trim()) {
    context.setLiveEditorText(result.editorText);
  }
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  return { cancelled: false };
}

/**
 * Retract the in-flight turn as if it was never submitted: abort the run, rewind
 * the branch leaf to before the current run's own user message, and return that
 * message text so the caller can refill the input box.
 *
 * Returns undefined (no retract) when the run already produced visible output
 * (assistant/thinking text or any tool call) or when the run has no user message
 * of its own — e.g. it was triggered by an extension custom message, where
 * rewinding to an older user message would wipe completed turns. The caller
 * should then abort normally.
 *
 * Refills an empty editor immediately (before awaiting abort idle) so double-Esc
 * undo does not feel stuck behind provider stream teardown. The key handler may
 * still setText after settle as a fallback when no editor host is wired.
 */
export async function retractRuntimeTurn(
  sessionId: string,
  context: RuntimeExtensionSessionContext,
): Promise<{ editorText: string } | undefined> {
  const runtimeTab = context.requireTab(sessionId);
  // Capture eligibility before aborting: agent_end clears the run start marker.
  if (!hasNoVisibleRunOutput(runtimeTab)) return undefined;
  const lastUser = lastUserMessage(runtimeTab);
  if (!lastUser) return undefined;
  if (!belongsToCurrentRun(runtimeTab, lastUser.id)) return undefined;
  // Optimistic prefill: abort() waits for stream idle, which can lag hundreds of
  // ms on a real provider. Restore the message first so the UI feels instant.
  if (!context.extensionUiHost()?.editor?.getText().trim()) {
    context.setLiveEditorText(lastUser.text);
  }
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  // Stop the stream and wait for idle so navigateTree rebuilds from a settled state.
  if (runtimeTab.agentSession.isStreaming) await runtimeTab.agentSession.abort();
  await runtimeTab.agentSession.navigateTree(lastUser.id);
  await context.syncChatFromSession(runtimeTab);
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  return { editorText: lastUser.text };
}

/**
 * True when the entry was appended during the current run, i.e. after the leaf
 * recorded at agent_start. Guards retract against rewinding to a user message
 * from an earlier completed turn when the run was started by an extension
 * custom message (which is not a user message).
 */
function belongsToCurrentRun(runtimeTab: RuntimeTab, entryId: string): boolean {
  const startLeafId = runtimeTab.currentRunStartLeafId;
  if (startLeafId === undefined) return false;
  if (startLeafId === null) return true; // run started from an empty branch
  const branch = runtimeTab.session.getBranch();
  const startIndex = branch.findIndex((entry) => entry.id === startLeafId);
  const entryIndex = branch.findIndex((entry) => entry.id === entryId);
  return entryIndex > startIndex;
}

// Last user message on the current branch (root -> leaf order), with its text.
function lastUserMessage(runtimeTab: RuntimeTab): { id: string; text: string } | undefined {
  const branch = runtimeTab.session.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message.role === "user") {
      return { id: entry.id, text: contentText(entry.message.content) };
    }
  }
  return undefined;
}

export async function switchRuntimeSession(
  sessionId: string,
  sessionPath: string,
  options: ExtensionSwitchSessionOptions | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const resolvedPath = path.resolve(sessionPath);
  if (!(await Bun.file(resolvedPath).exists())) {
    throw new Error(`Session file not found: ${resolvedPath}`);
  }
  const beforeResult = await emitBeforeSwitch(runtimeTab, "resume", resolvedPath);
  if (beforeResult.cancelled) return beforeResult;
  const sessionManager = SessionManager.open(resolvedPath, runtimeTab.session.getSessionDir());
  const result = await context.replaceRuntimeTabSession(runtimeTab, sessionManager, "resume");
  await options?.withSession?.(result.agentSession.createReplacedSessionContext());
  return { cancelled: false };
}

export async function importRuntimeJsonl(
  sessionId: string,
  inputPath: string,
  cwdOverride: string | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const resolvedPath = path.resolve(inputPath);
  if (!(await Bun.file(resolvedPath).exists())) {
    throw new Error(`Error: Session import file not found: ${resolvedPath}`);
  }
  const sessionDir = runtimeTab.session.getSessionDir();
  await fs.mkdir(sessionDir, { recursive: true });
  const destinationPath = path.join(sessionDir, path.basename(resolvedPath));
  const beforeResult = await emitBeforeSwitch(runtimeTab, "resume", destinationPath);
  if (beforeResult.cancelled) return beforeResult;
  await inspectSessionImport(resolvedPath, cwdOverride, runtimeTab.tab.workdir);
  if (path.resolve(destinationPath) !== resolvedPath) {
    await publishImportedSession(resolvedPath, destinationPath, sessionDir, cwdOverride);
  }
  const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
  await context.replaceRuntimeTabSession(runtimeTab, sessionManager, "resume");
  return { cancelled: false };
}

async function publishImportedSession(
  sourcePath: string,
  destinationPath: string,
  sessionDir: string,
  cwdOverride: string | undefined,
): Promise<void> {
  const tempPath = path.join(path.dirname(destinationPath), `.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(tempPath, Bun.file(sourcePath));
    // Pi migrates legacy files in place; do that before the copy becomes visible.
    SessionManager.open(tempPath, sessionDir, cwdOverride);
    try {
      // Hard-link publication is atomic and never replaces an existing session.
      await fs.link(tempPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Session import destination already exists: ${destinationPath}`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function resolveForkTarget(
  selectedEntry: SessionEntry,
  position: ForkPosition,
): { targetLeafId: string | null; selectedText?: string } {
  if (position === "at") {
    return { targetLeafId: selectedEntry.id };
  }
  if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
    throw new Error("Invalid entry ID for forking");
  }
  return {
    targetLeafId: selectedEntry.parentId,
    selectedText: contentText(selectedEntry.message.content),
  };
}

function createForkSession(
  runtimeTab: RuntimeTab,
  targetLeafId: string | null,
  position: ForkPosition,
): SessionManager {
  const shouldCreateEmptyFork =
    !targetLeafId ||
    (position === "before" &&
      !hasPriorVisibleConversation(runtimeTab.session.getBranch(targetLeafId)));
  const sessionFile = runtimeTab.session.getSessionFile();
  if (!sessionFile) throw new Error("Persisted session is missing a session file");
  if (shouldCreateEmptyFork) {
    const sessionManager = SessionManager.create(
      runtimeTab.tab.workdir,
      runtimeTab.session.getSessionDir(),
    );
    sessionManager.newSession({ parentSession: sessionFile });
    return sessionManager;
  }
  const branchLeafId = targetLeafId;
  if (!branchLeafId) throw new Error("Invalid fork target");
  const sourceManager = SessionManager.open(sessionFile, runtimeTab.session.getSessionDir());
  const forkedSessionPath = sourceManager.createBranchedSession(branchLeafId);
  if (!forkedSessionPath) throw new Error("Failed to create forked session");
  return SessionManager.open(forkedSessionPath, runtimeTab.session.getSessionDir());
}
