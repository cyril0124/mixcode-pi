import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

export type SessionCatalogRequest =
  | { mode: "current"; cwd: string; sessionsRoot: string }
  | { mode: "all"; sessionDirs: string[] };

type WorkerResult =
  | { type: "result"; sessions: SessionInfo[] }
  | { type: "error"; message: string };

type CachedListing = {
  roots: string[];
  sessions: SessionInfo[];
};

export const SESSION_CATALOG_WORKER_ARG = "--mixcode-session-catalog-worker";
const SESSION_CATALOG_REQUEST_ENV = "MIXCODE_SESSION_CATALOG_REQUEST";

async function executeSessionCatalogRequestWithManager(
  request: SessionCatalogRequest,
  manager: Pick<typeof SessionManager, "list" | "listAll">,
): Promise<SessionInfo[]> {
  if (request.mode === "current") {
    return manager.list(request.cwd, request.sessionsRoot);
  }
  const seen = new Set<string>();
  const sessions: SessionInfo[] = [];
  for (const dir of request.sessionDirs) {
    const listed = await manager.listAll(dir);
    for (const session of listed) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      sessions.push(session);
    }
  }
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}

const SESSION_LIST_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";

const executeSessionCatalogRequest = ${executeSessionCatalogRequestWithManager.toString()};

try {
  const { SessionManager } = await import(workerData.sessionManagerUrl);
  const sessions = await executeSessionCatalogRequest(workerData.request, SessionManager);
  parentPort.postMessage({ type: "result", sessions });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
`;

const cache = new Map<string, CachedListing>();
const rootCache = new Map<string, SessionInfo[]>();
const inFlight = new Map<string, Promise<SessionInfo[]>>();

// Per-root snapshots (name + size + mtime). Other instances appending to an
// existing jsonl must invalidate too; names-only leaves /resume previews and
// search text stale. Poll replaces fs.watch (inotify is a scarce per-user quota).
const DEFAULT_CATALOG_POLL_INTERVAL_MS = 5_000;
const rootSnapshots = new Map<string, { timer: ReturnType<typeof setInterval>; names: string[] | undefined }>();

export function listSessionsInBackground(
  request: SessionCatalogRequest,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  if (signal?.aborted) return Promise.reject(abortError());

  const seeded = listingFromRootCache(request);
  if (seeded) return Promise.resolve(copySessions(seeded));

  const key = requestKey(request);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(copySessions(cached.sessions));

  if (!signal) {
    const pending = inFlight.get(key);
    if (pending) return pending.then(copySessions);
  }

  const roots = requestRoots(request);
  for (const root of roots) ensureSessionCatalogPoll(root);
  const listing = runBackgroundListing(request, signal).then((sessions) => {
    cache.set(key, { roots, sessions });
    return sessions;
  });
  if (signal) return listing;

  inFlight.set(key, listing);
  void listing.then(
    () => {
      if (inFlight.get(key) === listing) inFlight.delete(key);
    },
    () => {
      if (inFlight.get(key) === listing) inFlight.delete(key);
    },
  );
  return listing.then(copySessions);
}

export function invalidateSessionCatalog(root: string): void {
  rootCache.delete(root);
  for (const [key, entry] of cache) {
    if (entry.roots.includes(root)) cache.delete(key);
  }
}

export async function runSessionCatalogWorkerCommand(args: string[]): Promise<boolean> {
  if (args.length !== 1 || args[0] !== SESSION_CATALOG_WORKER_ARG) return false;
  try {
    const encoded = process.env[SESSION_CATALOG_REQUEST_ENV];
    if (!encoded) throw new Error("Missing session catalog worker request");
    const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionCatalogRequest;
    const sessions = await executeSessionCatalogRequest(request);
    process.stdout.write(JSON.stringify({ type: "result", sessions } satisfies WorkerResult));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
  return true;
}

async function executeSessionCatalogRequest(request: SessionCatalogRequest): Promise<SessionInfo[]> {
  return executeSessionCatalogRequestWithManager(request, SessionManager);
}

function runBackgroundListing(
  request: SessionCatalogRequest,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  // Bun supports eval worker_threads (verified), so the worker path works under
  // bun test / dev / dist alike. The subprocess path is only for bun --compile
  // binaries, where the virtual FS cannot eval worker threads and the binary
  // itself must be re-spawned with the worker arg (its main() handles it).
  // Never reuse process.argv[1] for the subprocess entry here: under bun test
  // argv[1] is the test file, which would re-run the test suite in a worker.
  return process.argv[1]?.startsWith("/$bunfs/") === true
    ? runListingSubprocess(request, signal)
    : runListingWorkerThread(request, signal);
}

function runListingWorkerThread(
  request: SessionCatalogRequest,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  let sessionManagerUrl: string;
  try {
    sessionManagerUrl = new URL(
      "./core/session-manager.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<SessionInfo[]>((resolve, reject) => {
    const worker = new Worker(SESSION_LIST_WORKER_SOURCE, {
      eval: true,
      workerData: { request, sessionManagerUrl },
    });
    console.error(`[dbg] listing worker started key=${JSON.stringify(requestKey(request))}`);
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerResult) => {
      console.error(`[dbg] listing worker message type=${message.type}`);
      finish(() => {
        if (message.type === "error") {
          reject(new Error(message.message));
          return;
        }
        resolve(message.sessions.map(restoreSessionDates));
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      console.error(`[dbg] listing worker exit code=${code}`);
      if (code !== 0)
        finish(() => reject(new Error(`Session listing worker exited with code ${code}`)));
    });
  });
}

async function runListingSubprocess(
  request: SessionCatalogRequest,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const compiled = process.argv[1]?.startsWith("/$bunfs/") === true;
  const args = compiled
    ? [SESSION_CATALOG_WORKER_ARG]
    : [process.argv[1]!, SESSION_CATALOG_WORKER_ARG];
  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...process.env,
      [SESSION_CATALOG_REQUEST_ENV]: Buffer.from(JSON.stringify(request)).toString("base64url"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    if (signal?.aborted) throw abortError();
    if (code !== 0) {
      throw new Error(stderr.trim() || `Session listing process exited with code ${code}`);
    }
    const message = JSON.parse(stdout) as WorkerResult;
    if (message.type === "error") throw new Error(message.message);
    return message.sessions.map(restoreSessionDates);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Start (once per root) a lightweight poll that invalidates the catalog cache
 * when session files in a root appear, disappear, or change size/mtime.
 * Listing requests start it lazily; the interval is injectable for tests.
 */
export function ensureSessionCatalogPoll(root: string, intervalMs = DEFAULT_CATALOG_POLL_INTERVAL_MS): void {
  if (rootSnapshots.has(root)) return;
  const entry: { timer: ReturnType<typeof setInterval>; names: string[] | undefined } = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    names: undefined,
  };
  rootSnapshots.set(root, entry);
  const poll = async () => {
    const names = await catalogRootSnapshot(root);
    if (!names) return; // Root may not exist yet; keep polling.
    const current = rootSnapshots.get(root);
    if (!current) return;
    // First snapshot only seeds the baseline; later changes invalidate.
    if (current.names === undefined) {
      current.names = names;
      return;
    }
    if (current.names.join("\0") !== names.join("\0")) {
      invalidateSessionCatalog(root);
      current.names = names;
    }
  };
  entry.timer = setInterval(poll, intervalMs);
  entry.timer.unref?.();
  void poll();
}

async function catalogRootSnapshot(root: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = (await fsPromises.readdir(root)).sort();
  } catch {
    return undefined;
  }
  const lines: string[] = [];
  for (const name of names) {
    try {
      const stat = await fsPromises.stat(path.join(root, name));
      lines.push(`${name}\0${stat.size}\0${stat.mtimeMs}`);
    } catch {
      lines.push(name);
    }
  }
  return lines;
}

function listingFromRootCache(request: SessionCatalogRequest): SessionInfo[] | undefined {
  if (request.mode === "current") return rootCache.get(request.sessionsRoot);
  const listings = request.sessionDirs.map((root) => rootCache.get(root));
  if (listings.some((sessions) => sessions === undefined)) return undefined;
  const seen = new Set<string>();
  const sessions = listings
    .flatMap((listing) => listing ?? [])
    .filter((session) => {
      if (seen.has(session.path)) return false;
      seen.add(session.path);
      return true;
    });
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}

function requestKey(request: SessionCatalogRequest): string {
  return request.mode === "current"
    ? `current\0${request.cwd}\0${request.sessionsRoot}`
    : `all\0${request.sessionDirs.join("\0")}`;
}

function requestRoots(request: SessionCatalogRequest): string[] {
  return request.mode === "current" ? [request.sessionsRoot] : request.sessionDirs;
}

function copySessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.map((session) => ({ ...session }));
}

function restoreSessionDates(session: SessionInfo): SessionInfo {
  return {
    ...session,
    created: new Date(session.created),
    modified: new Date(session.modified),
  };
}

function abortError(): Error {
  const error = new Error("Session listing cancelled");
  error.name = "AbortError";
  return error;
}
