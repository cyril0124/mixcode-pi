import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentSessionServices,
  type LoadExtensionsResult,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  type ExtensionManagerEntry,
  syncExtensionManagerEntrySources,
} from "../core/extension-manager.js";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";
import {
  invalidateSessionCatalog,
  listSessionsInBackground,
} from "../core/session-catalog.js";
import { closeExtensionCustomOverlays, disposeExtensionWidgets } from "./runtime-extension-ui.js";
import type { ExtensionCustomUiHost, RuntimeTab } from "./runtime-types.js";

// Registry mapping an AgentSessionServices instance to the extension manager
// entries computed for it. Lives here (next to bindRuntimeSessionCore) so the
// session-bound derived state has a single owner.
const extensionManagerEntriesByServices = new WeakMap<
  AgentSessionServices,
  ExtensionManagerEntry[]
>();

/** Associate extension manager entries with a services instance. */
export function setExtensionManagerEntriesForServices(
  services: AgentSessionServices,
  entries: ExtensionManagerEntry[],
): void {
  extensionManagerEntriesByServices.set(services, entries);
}

/**
 * Entries are captured inside extensionsOverride (before Pi applies package
 * sourceInfo). Sync display fields from the live loader result on every read so
 * callers always see npm:/git: labels after applyExtensionSourceInfo runs.
 */
export function getExtensionManagerEntriesForServices(
  services: AgentSessionServices,
): ExtensionManagerEntry[] {
  const entries = extensionManagerEntriesByServices.get(services) ?? [];
  if (entries.length > 0) {
    syncExtensionManagerEntrySources(entries, services.resourceLoader.getExtensions());
  }
  return entries;
}

/**
 * Rebind the session-owned core of a {@link RuntimeTab} after a new AgentSession
 * is created (clear / reload / workdir change). Sets the four source fields and
 * derives `agent` and `extensionManagerEntries` from them, so the derived fields
 * can never drift out of sync with their source — the bug class that arose from
 * three call sites hand-copying this assignment block.
 */
export function bindRuntimeSessionCore(
  runtimeTab: RuntimeTab,
  core: {
    agentSession: RuntimeTab["agentSession"];
    services: AgentSessionServices;
    extensionsResult: LoadExtensionsResult;
    extensionToolOwnerPolicy: ExtensionToolOwnerPolicy;
  },
): void {
  runtimeTab.agentSession = core.agentSession;
  runtimeTab.services = core.services;
  runtimeTab.extensionsResult = core.extensionsResult;
  runtimeTab.extensionToolOwnerPolicy = core.extensionToolOwnerPolicy;
  runtimeTab.agent = core.agentSession.agent;
  runtimeTab.extensionManagerEntries = getExtensionManagerEntriesForServices(core.services);
}

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
  runtimeTab.tab.pendingDialogs = runtimeTab.tab.pendingDialogs.filter(
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
  // Most restores already know the durable MixCode tab id, which is embedded in
  // the session filename. Open it directly instead of parsing every JSONL in a
  // large session directory.
  const byFileName = findSessionFileByName(sessionsRoot, sessionId);
  if (byFileName) return SessionManager.open(byFileName, sessionsRoot, cwd);

  const existing = (await SessionManager.list(cwd, sessionsRoot)).find(
    (metadata: SessionInfo) => metadata.id === sessionId,
  );
  if (existing) return SessionManager.open(existing.path, sessionsRoot, cwd);
  return createSession(cwd, sessionsRoot, sessionId);
}

// Session files are named `${ISO-timestamp}_${sessionId}.jsonl`. The timestamp
// never contains "_", so the substring after the first "_" is the sessionId
// (which may itself contain "-"). Returns the newest matching file path.
export function findSessionFileByName(sessionsRoot: string, sessionId: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter((name) => sessionIdFromFileName(name) === sessionId)
    .sort();
  const latest = matches.at(-1);
  return latest ? path.join(sessionsRoot, latest) : undefined;
}

function sessionIdFromFileName(name: string): string | undefined {
  if (!name.endsWith(".jsonl")) return undefined;
  const separator = name.indexOf("_");
  if (separator < 0) return undefined;
  return name.slice(separator + 1, -".jsonl".length);
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

/**
 * Pi defers writing a new session JSONL until the first assistant message
 * (`flushed === false`, exclusive create on first flush). Multi-instance tab
 * discovery needs the file present as soon as a tab is open, so materialize
 * the in-memory header (+ any already-appended entries) and mark the manager
 * flushed so later appends use appendFile instead of wx.
 */
export function materializeSessionFile(session: SessionManager): void {
  const file = session.getSessionFile();
  if (!file) return;
  // Pi keeps `flushed` private; multi-instance discovery needs the file on disk
  // before the first assistant reply, so write then mark flushed for append path.
  const mutable = session as unknown as { flushed?: boolean };
  if (fs.existsSync(file)) {
    // File already on disk (reopened or previously materialized): ensure later
    // appends do not attempt exclusive create.
    mutable.flushed = true;
    return;
  }
  const header = session.getHeader();
  if (!header) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry));
  // Exclusive create (wx): keep node:fs; Bun.write has no exclusive-create flag.
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
  mutable.flushed = true;
  invalidateSessionCatalog(path.dirname(file));
}

export async function copySession(
  source: SessionManager,
  cwd: string,
  newSessionId: string,
  sessionsRoot: string,
): Promise<SessionManager> {
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const file = path.join(sessionsRoot, `${fileTimestamp}_${newSessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: newSessionId,
    timestamp,
    cwd,
    parentSession: source.getSessionFile(),
  };
  const lines = [header, ...source.getBranch()].map((entry) => JSON.stringify(entry)).join("\n");
  // Bun.write creates parent dirs (sessionsRoot).
  await Bun.write(file, `${lines}\n`);
  invalidateSessionCatalog(sessionsRoot);
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
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const file = path.join(sessionsRoot, `${fileTimestamp}_${source.getSessionId()}.jsonl`);
  const header = { type: "session", version: 3, id: source.getSessionId(), timestamp, cwd };
  const lines = [header, ...source.getBranch()].map((entry) => JSON.stringify(entry)).join("\n");
  await Bun.write(file, `${lines}\n`);
  invalidateSessionCatalog(sessionsRoot);
  return SessionManager.open(file, sessionsRoot, cwd);
}

/**
 * List sessions for a specific working directory.
 * Filters results to only include sessions whose cwd matches.
 */
/** Pi SessionSelectorComponent loader progress: (loaded, total) file counts. */
export type SessionListProgress = (loaded: number, total: number) => void;

export async function listSessionsForCwd(
  cwd: string,
  sessionsRoot: string,
  signal?: AbortSignal,
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  // Progress needs main-thread SessionManager.list so the selector can show Loading n/m.
  // Background worker path has no progress channel.
  const all = onProgress
    ? await SessionManager.list(cwd, sessionsRoot, onProgress)
    : await listSessionsInBackground({ mode: "current", cwd, sessionsRoot }, signal);
  // SessionManager.list with explicit sessionsRoot returns all sessions in that dir.
  // Filter to only sessions matching the requested cwd.
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return all.filter((session) => session.cwd.replace(/\/+$/, "") === normalizedCwd);
}

/**
 * List all sessions across all working directories.
 *
 * Sources:
 * 1. Current sessionsRoot
 * 2. Pi default layout siblings: parent of sessionsRoot is sessions/ and each
 *    child is an encoded-cwd directory under agentDir/sessions/.
 *    Without this, All-scope only sees the active workdir.
 */
export async function listAllSessionsGlobal(
  sessionsRoot: string,
  signal?: AbortSignal,
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  const dirs = collectAllSessionDirs(sessionsRoot);

  if (onProgress) {
    return listAllSessionDirsWithProgress([...dirs], onProgress);
  }

  return listSessionsInBackground({ mode: "all", sessionDirs: [...dirs] }, signal);
}

function collectAllSessionDirs(sessionsRoot: string): Set<string> {
  const dirs = new Set<string>([sessionsRoot]);

  // Pi layout: agentDir/sessions/<encoded-cwd>/ — scan siblings of sessionsRoot.
  const sessionsParent = path.dirname(sessionsRoot);
  if (path.basename(sessionsParent) === "sessions") {
    try {
      for (const entry of fs.readdirSync(sessionsParent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(path.join(sessionsParent, entry.name));
      }
    } catch {
      // Ignore read errors on the sessions parent.
    }
  }

  return dirs;
}

/** Main-thread multi-dir list with cumulative Loading n/m progress (Pi parity). */
async function listAllSessionDirsWithProgress(
  dirs: string[],
  onProgress: SessionListProgress,
): Promise<SessionInfo[]> {
  const dirFiles: string[][] = [];
  let totalFiles = 0;
  for (const dir of dirs) {
    try {
      const files = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".jsonl"));
      dirFiles.push(files);
      totalFiles += files.length;
    } catch {
      dirFiles.push([]);
    }
  }

  const seen = new Set<string>();
  const sessions: SessionInfo[] = [];
  let completedFiles = 0;

  for (let index = 0; index < dirs.length; index++) {
    const dir = dirs[index]!;
    const fileCount = dirFiles[index]?.length ?? 0;
    if (fileCount === 0) continue;
    const listed = await SessionManager.listAll(dir, (loaded) => {
      onProgress(Math.min(completedFiles + loaded, totalFiles), totalFiles);
    });
    for (const session of listed) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      sessions.push(session);
    }
    completedFiles += fileCount;
    onProgress(Math.min(completedFiles, totalFiles), totalFiles);
  }

  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}
