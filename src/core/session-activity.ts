import * as fs from "node:fs/promises";
import { getDefaultSessionDirPath } from "@earendil-works/pi-coding-agent";

/**
 * Resolve the last-activity time of one session from its transcript file.
 *
 * The transcript (`<sessionsDir>/<encoded-cwd>/<createdAt>_<sessionId>.jsonl`) is
 * an append-only log: its mtime advances exactly when a turn, tool call, or
 * session-info change is written, so it is the session's own activity clock.
 * The instance-registry snapshot cannot answer this — its `updatedAt` is a 5s
 * heartbeat that keeps ticking on an idle instance.
 *
 * Reads are cached per (sessions dir, sessionId) for the process lifetime of one
 * status run: `mpi status` resolves every tab of every live instance at once, and
 * tabs commonly share a sessions directory. Missing transcript (never created,
 * or deleted) resolves to `undefined` rather than an error — an unknown activity
 * time is normal for a tab whose session has no file on this host.
 */
export function createSessionActivityReader(
  agentDir: string,
): (sessionId: string, workdir: string) => Promise<Date | undefined> {
  const sessionsDirCache = new Map<string, Promise<string[]>>();
  const activityCache = new Map<string, Promise<Date | undefined>>();

  const listSessionsDir = (sessionsDir: string): Promise<string[]> => {
    const cached = sessionsDirCache.get(sessionsDir);
    if (cached) return cached;
    const listing = fs.readdir(sessionsDir).catch((error: NodeJS.ErrnoException) => {
      // ENOENT/ENOTDIR: the session was never persisted in this agent dir.
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    sessionsDirCache.set(sessionsDir, listing);
    return listing;
  };

  return (sessionId, workdir) => {
    const cacheKey = `${workdir}\0${sessionId}`;
    const cached = activityCache.get(cacheKey);
    if (cached) return cached;
    const lookup = (async (): Promise<Date | undefined> => {
      const sessionsDir = getDefaultSessionDirPath(workdir, agentDir);
      // The file name is `<session creation timestamp>_<sessionId>.jsonl`; the
      // timestamp prefix is not recoverable from the id, so match by suffix.
      const suffix = `_${sessionId}.jsonl`;
      const fileName = (await listSessionsDir(sessionsDir)).find((name) => name.endsWith(suffix));
      if (!fileName) return undefined;
      try {
        return (await fs.stat(`${sessionsDir}/${fileName}`)).mtime;
      } catch (error) {
        // The transcript can disappear between readdir and stat (deleted
        // session); treat it as unknown activity instead of failing the report.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    })();
    activityCache.set(cacheKey, lookup);
    return lookup;
  };
}
