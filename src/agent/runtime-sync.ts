// Glue between MixCodeRuntime and the cross-process sync/lock primitives.
//
// Kept out of runtime.ts (already large) so the runtime only gains thin
// delegations. Holds the single per-process SessionSyncCoordinator and the
// per-session turn locks this instance currently owns.
import { acquireSessionTurnLock, type SessionLockHandle } from "../core/session-lock.js";
import { invalidateSessionCatalog } from "../core/session-catalog.js";
import { materializeSessionFile } from "./runtime-session.js";
import { SessionSyncCoordinator } from "./session-sync-coordinator.js";
import type { RuntimeTab } from "./runtime-types.js";

/**
 * Per-process sync state. Disabled by default: batch runs and unit tests that
 * spin up several runtimes over one sessionsRoot must not watch files or
 * contend on locks unless they opt in via MixCodeRuntime.enableSessionSync().
 */
export class RuntimeSyncManager {
  private coordinator?: SessionSyncCoordinator;
  // Reentrant per-session ownership: the file lock is held once, but this
  // process may acquire it multiple times for overlapping operations on the
  // same session (e.g. a queued-message flush fires while the aborting turn
  // still holds it). Re-acquiring the file lock would self-conflict (same live
  // PID), so we ref-count and only touch the file at 0<->1 transitions.
  private readonly ownedLocks = new Map<string, { handle: SessionLockHandle; count: number }>();

  constructor(
    private readonly sessionsRoot: string,
    private readonly onExternalChange: (sessionId: string) => boolean,
  ) {}

  enable(): void {
    if (this.coordinator) return;
    this.coordinator = new SessionSyncCoordinator({
      sessionsRoot: this.sessionsRoot,
      onExternalChange: this.onExternalChange,
    });
  }

  register(runtimeTab: RuntimeTab): void {
    // Peer tab discovery needs the JSONL present before the first assistant
    // reply; materialize regardless of whether content-sync is enabled so
    // openExistingAgentTab can find the file from another instance.
    materializeSessionFile(runtimeTab.session);
    const file = runtimeTab.session.getSessionFile();
    if (file) this.coordinator?.register(runtimeTab.tab.sessionId, file);
  }

  unregister(sessionId: string): void {
    this.coordinator?.unregister(sessionId);
  }

  /** Update the fingerprint so this instance's own write is not echoed back. */
  markLocalWrite(sessionId: string): void {
    invalidateSessionCatalog(this.sessionsRoot);
    this.coordinator?.markLocalWrite(sessionId);
  }

  /**
   * Acquire the cross-process turn lock for a session before a write. Returns
   * undefined when sync is disabled (no cross-process contention to guard).
   * Throws SessionLockConflictError when another live instance holds it.
   *
   * Reentrant: if THIS process already owns the lock for the session, this
   * bumps a ref-count and returns a fresh token instead of re-touching the
   * file. Each returned token releases exactly once; the underlying file lock
   * is freed only when the last token is released.
   */
  acquire(sessionId: string): SessionLockHandle | undefined {
    if (!this.coordinator) return undefined;
    const existing = this.ownedLocks.get(sessionId);
    if (existing) {
      existing.count += 1;
    } else {
      const handle = acquireSessionTurnLock(this.sessionsRoot, sessionId);
      this.ownedLocks.set(sessionId, { handle, count: 1 });
    }
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseOwned(sessionId);
      },
    };
  }

  private releaseOwned(sessionId: string): void {
    const owned = this.ownedLocks.get(sessionId);
    if (!owned) return;
    owned.count -= 1;
    if (owned.count <= 0) {
      owned.handle.release();
      this.ownedLocks.delete(sessionId);
    }
  }

  dispose(): void {
    for (const owned of this.ownedLocks.values()) owned.handle.release();
    this.ownedLocks.clear();
    this.coordinator?.dispose();
    this.coordinator = undefined;
  }
}
