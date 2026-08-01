import * as fs from "node:fs";
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

const SESSION_LIST_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";

try {
  const { SessionManager } = await import(workerData.sessionManagerUrl);
  const request = workerData.request;
  let sessions;
  if (request.mode === "current") {
    sessions = await SessionManager.list(request.cwd, request.sessionsRoot);
  } else {
    const seen = new Set();
    sessions = [];
    for (const dir of request.sessionDirs) {
      const listed = await SessionManager.listAll(dir);
      for (const session of listed) {
        if (seen.has(session.path)) continue;
        seen.add(session.path);
        sessions.push(session);
      }
    }
    sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  }
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
const watchers = new Map<string, fs.FSWatcher | null>();

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
  const cacheable = roots.every(ensureRootWatcher);
  const listing = runBackgroundListing(request, signal).then((sessions) => {
    if (cacheable) cache.set(key, { roots, sessions });
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

export function seedSessionCatalogRoot(root: string, sessions: SessionInfo[]): void {
  if (!ensureRootWatcher(root)) return;
  invalidateSessionCatalog(root);
  rootCache.set(root, sessions.map(restoreSessionDates));
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
  if (request.mode === "current") {
    return SessionManager.list(request.cwd, request.sessionsRoot);
  }
  const seen = new Set<string>();
  const sessions: SessionInfo[] = [];
  for (const dir of request.sessionDirs) {
    const listed = await SessionManager.listAll(dir);
    for (const session of listed) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      sessions.push(session);
    }
  }
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}

function runBackgroundListing(
  request: SessionCatalogRequest,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  return process.versions.bun
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

function ensureRootWatcher(root: string): boolean {
  const existing = watchers.get(root);
  if (existing !== undefined) return existing !== null;
  try {
    const watcher = fs.watch(root, { persistent: false }, () => invalidateSessionCatalog(root));
    watcher.on("error", () => {
      invalidateSessionCatalog(root);
      watcher.close();
      watchers.set(root, null);
    });
    watchers.set(root, watcher);
    return true;
  } catch {
    watchers.set(root, null);
    return false;
  }
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
