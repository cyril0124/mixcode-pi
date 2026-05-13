import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
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

/**
 * List sessions for a specific working directory.
 * Filters results to only include sessions whose cwd matches.
 */
export async function listSessionsForCwd(
  cwd: string,
  sessionsRoot: string,
): Promise<SessionInfo[]> {
  const all = await SessionManager.list(cwd, sessionsRoot);
  // SessionManager.list with explicit sessionsRoot returns all sessions in that dir.
  // Filter to only sessions matching the requested cwd.
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return all.filter((session) => session.cwd.replace(/\/+$/, "") === normalizedCwd);
}

/**
 * List all sessions across all working directories.
 * Scans the current sessionsRoot plus all sibling workdir session directories
 * under rootStateDir.
 */
export async function listAllSessionsGlobal(
  sessionsRoot: string,
  rootStateDir?: string,
): Promise<SessionInfo[]> {
  // Always include the current sessionsRoot
  const dirs = new Set<string>([sessionsRoot]);

  if (rootStateDir) {
    // All workdir session directories: rootStateDir/workdirs/*/sessions
    const workdirsDir = join(rootStateDir, "workdirs");
    if (existsSync(workdirsDir)) {
      try {
        const entries = readdirSync(workdirsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = join(workdirsDir, entry.name, "sessions");
          if (existsSync(candidate)) dirs.add(candidate);
        }
      } catch {
        // Ignore read errors on workdirs directory
      }
    }
  }

  // Collect sessions from all directories, dedup by path
  const seen = new Set<string>();
  const all: SessionInfo[] = [];
  for (const dir of dirs) {
    try {
      const sessions = await SessionManager.list("/", dir);
      for (const session of sessions) {
        if (seen.has(session.path)) continue;
        seen.add(session.path);
        all.push(session);
      }
    } catch {
      // Skip unreadable directories
    }
  }
  all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return all;
}
