import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  assertImportHasCwd,
  emitBeforeFork,
  emitBeforeSwitch,
  hasPriorVisibleConversation,
} from "./runtime-chat.js";
import { contentText } from "./runtime-text.js";
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
  openOrCreateSession: (sessionId: string, cwd: string) => Promise<SessionManager>;
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
    result.agent.state.messages = result.session.buildSessionContext().messages;
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
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const result = await runtimeTab.agentSession.navigateTree(targetId, {
    summarize: options?.summarize,
    customInstructions: options?.customInstructions,
    replaceInstructions: options?.replaceInstructions,
    label: options?.label,
  });
  if (result.cancelled) return { cancelled: true };
  await context.syncChatFromSession(runtimeTab);
  if (result.editorText && !context.extensionUiHost()?.editor?.getText().trim()) {
    context.setLiveEditorText(result.editorText);
  }
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  return { cancelled: false };
}

export async function switchRuntimeSession(
  sessionId: string,
  sessionPath: string,
  options: ExtensionSwitchSessionOptions | undefined,
  context: RuntimeExtensionSessionContext,
): Promise<{ cancelled: boolean }> {
  const runtimeTab = context.requireTab(sessionId);
  const resolvedPath = resolve(sessionPath);
  if (!existsSync(resolvedPath)) throw new Error(`Session file not found: ${resolvedPath}`);
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
  const resolvedPath = resolve(inputPath);
  if (!existsSync(resolvedPath)) throw new Error(`Session import file not found: ${resolvedPath}`);
  const sessionDir = runtimeTab.session.getSessionDir();
  await mkdir(sessionDir, { recursive: true });
  const destinationPath = join(sessionDir, basename(resolvedPath));
  const beforeResult = await emitBeforeSwitch(runtimeTab, "resume", destinationPath);
  if (beforeResult.cancelled) return beforeResult;
  await assertImportHasCwd(resolvedPath, cwdOverride, runtimeTab.tab.workdir);
  if (resolve(destinationPath) !== resolvedPath) {
    await copyFile(resolvedPath, destinationPath);
  }
  const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
  await context.replaceRuntimeTabSession(runtimeTab, sessionManager, "resume");
  return { cancelled: false };
}

export async function undoRuntimeUserTurn(
  sessionId: string,
  context: RuntimeExtensionSessionContext,
): Promise<void> {
  const runtimeTab = context.requireTab(sessionId);
  const redoSessionId = runtimeTab.tab.sessionId;
  const branch = runtimeTab.session.getBranch();
  const latestUser = [...branch]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!latestUser) {
    throw new Error("No user message found to undo");
  }
  let undoSession: SessionManager;
  if (latestUser.parentId) {
    const undoSessionFile = runtimeTab.session.createBranchedSession(latestUser.parentId);
    if (!undoSessionFile) throw new Error("Undo requires a persisted session file");
    undoSession = SessionManager.open(
      undoSessionFile,
      runtimeTab.session.getSessionDir(),
      runtimeTab.tab.workdir,
    );
  } else {
    const parentSession = runtimeTab.session.getSessionFile();
    undoSession = await context.createSession(runtimeTab.tab.workdir, undefined, parentSession);
  }
  const result = await context.replaceRuntimeTabSession(runtimeTab, undoSession, "fork");
  result.tab.redoSessionId = redoSessionId;
  result.tab.status = "idle";
  result.tab.unreadDone = false;
}

export async function redoRuntimeUserTurn(
  sessionId: string,
  context: RuntimeExtensionSessionContext,
): Promise<void> {
  const runtimeTab = context.requireTab(sessionId);
  const redoSessionId = runtimeTab.tab.redoSessionId;
  if (!redoSessionId) throw new Error("No undone session to redo");
  const redoSession = await context.openOrCreateSession(redoSessionId, runtimeTab.tab.workdir);
  const result = await context.replaceRuntimeTabSession(runtimeTab, redoSession, "resume");
  result.tab.redoSessionId = undefined;
  result.tab.status = "idle";
  result.tab.unreadDone = false;
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
