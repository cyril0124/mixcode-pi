import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeExtensionCustomOverlays, disposeExtensionWidgets } from "./runtime-extension-ui.js";
import type { ExtensionCustomUiHost, RuntimeTab } from "./runtime-types.js";

export function resetExtensionHostState(
  runtimeTab: RuntimeTab,
  extensionUiHost: ExtensionCustomUiHost | undefined,
): void {
  const cachedBaseAutocompleteProvider = runtimeTab.extensionAutocompleteProviderCache?.base;
  runtimeTab.extensionTerminalInputHandlers.clear();
  for (const resolve of runtimeTab.extensionDialogResolvers.values()) {
    resolve(undefined);
  }
  runtimeTab.extensionDialogResolvers.clear();
  closeExtensionCustomOverlays(runtimeTab);
  runtimeTab.tab.extensionUi.pendingUserInteractions = [];
  runtimeTab.extensionAutocompleteProviderFactories = [];
  runtimeTab.extensionAutocompleteProviderCache = undefined;
  runtimeTab.tab.pendingQuestions = runtimeTab.tab.pendingQuestions.filter(
    (request) => !request.extensionResolverId,
  );
  disposeExtensionWidgets(runtimeTab.tab);
  runtimeTab.tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
  if (cachedBaseAutocompleteProvider) {
    extensionUiHost?.editor?.setAutocompleteProvider?.(cachedBaseAutocompleteProvider);
  }
  extensionUiHost?.editor?.setEditorComponent?.(undefined, runtimeTab.tab.sessionId);
}

export async function openOrCreateSession(
  sessionId: string,
  cwd: string,
  sessionsRoot: string,
): Promise<SessionManager> {
  const existing = (await SessionManager.list(cwd, sessionsRoot)).find(
    (metadata: SessionInfo) => metadata.id === sessionId,
  );
  if (existing) return SessionManager.open(existing.path, sessionsRoot, cwd);
  return createSession(cwd, sessionsRoot, sessionId);
}

export async function createSession(
  cwd: string,
  sessionsRoot: string,
  sessionId?: string,
  parentSession?: string,
): Promise<SessionManager> {
  const session = SessionManager.create(cwd, sessionsRoot);
  if (sessionId && session.getSessionId() !== sessionId) {
    session.newSession({ id: sessionId, parentSession });
  }
  return session;
}

export async function copySession(
  source: SessionManager,
  cwd: string,
  newSessionId: string,
  sessionsRoot: string,
): Promise<SessionManager> {
  await mkdir(sessionsRoot, { recursive: true });
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const file = join(sessionsRoot, `${fileTimestamp}_${newSessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: newSessionId,
    timestamp,
    cwd,
    parentSession: source.getSessionFile(),
  };
  const lines = [header, ...source.getBranch()].map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(file, `${lines}\n`, "utf8");
  return SessionManager.open(file, sessionsRoot, cwd);
}

export function reopenSessionInWorkdir(
  source: SessionManager,
  cwd: string,
  sessionsRoot: string,
): Promise<SessionManager> {
  const sessionFile = source.getSessionFile();
  if (sessionFile) return Promise.resolve(SessionManager.open(sessionFile, sessionsRoot, cwd));
  return createReplacementSession(source, cwd, sessionsRoot);
}

async function createReplacementSession(
  source: SessionManager,
  cwd: string,
  sessionsRoot: string,
): Promise<SessionManager> {
  await mkdir(sessionsRoot, { recursive: true });
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const file = join(sessionsRoot, `${fileTimestamp}_${source.getSessionId()}.jsonl`);
  const header = { type: "session", version: 3, id: source.getSessionId(), timestamp, cwd };
  const lines = [header, ...source.getBranch()].map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(file, `${lines}\n`, "utf8");
  return SessionManager.open(file, sessionsRoot, cwd);
}
