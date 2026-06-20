import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSessionServices,
  type LoadExtensionsResult,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionManagerEntry } from "../core/extension-manager.js";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";
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

export function getExtensionManagerEntriesForServices(
  services: AgentSessionServices,
): ExtensionManagerEntry[] {
  return extensionManagerEntriesByServices.get(services) ?? [];
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
function findSessionFileByName(sessionsRoot: string, sessionId: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  const matches = entries.filter((name) => name.endsWith(suffix)).sort();
  const latest = matches.at(-1);
  return latest ? join(sessionsRoot, latest) : undefined;
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
      const sessions = await SessionManager.listAll(dir);
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
