// Glue between MixCodeRuntime and the cross-process sync/lock primitives.
//
// Kept out of runtime.ts (already large) so the runtime only gains thin
// delegations. Holds the single per-process SessionSyncCoordinator and the
// per-session turn locks this instance currently owns.
import {
  acquireSessionTurnLock,
  type SessionLockHandle,
} from "../core/session-lock.js";
import { SessionSyncCoordinator } from "./session-sync-coordinator.js";
import type { RuntimeTab } from "./runtime-types.js";

/**
 * Per-process sync state. Disabled by default: batch runs and unit tests that
 * spin up several runtimes over one sessionsRoot must not watch files or
 * contend on locks unless they opt in via MixCodeRuntime.enableSessionSync().
 */
export class RuntimeSyncManager {
  private coordinator?: SessionSyncCoordinator;
  private readonly ownedLocks = new Map<string, SessionLockHandle>();

  constructor(
    private readonly sessionsRoot: string,
    private readonly onExternalChange: (sessionId: string) => void,
    private readonly onError?: (error: unknown) => void,
  ) {}

  get enabled(): boolean {
    return this.coordinator !== undefined;
  }

  enable(): void {
    if (this.coordinator) return;
    this.coordinator = new SessionSyncCoordinator({
      sessionsRoot: this.sessionsRoot,
      onExternalChange: this.onExternalChange,
      onError: this.onError,
    });
  }

  register(runtimeTab: RuntimeTab): void {
    const file = runtimeTab.session.getSessionFile();
    if (file) this.coordinator?.register(runtimeTab.tab.sessionId, file);
  }

  unregister(sessionId: string): void {
    this.coordinator?.unregister(sessionId);
  }

  /** Update the fingerprint so this instance's own write is not echoed back. */
  markLocalWrite(sessionId: string): void {
    this.coordinator?.markLocalWrite(sessionId);
  }

  /**
   * Acquire the cross-process turn lock for a session before a write. Returns
   * undefined when sync is disabled (no cross-process contention to guard).
   * Throws SessionLockConflictError when another live instance holds it.
   */
  acquire(sessionId: string): SessionLockHandle | undefined {
    if (!this.coordinator) return undefined;
    const handle = acquireSessionTurnLock(this.sessionsRoot, sessionId);
    this.ownedLocks.set(sessionId, handle);
    return handle;
  }

  release(sessionId: string, handle: SessionLockHandle | undefined): void {
    if (!handle) return;
    handle.release();
    if (this.ownedLocks.get(sessionId) === handle) this.ownedLocks.delete(sessionId);
  }

  dispose(): void {
    for (const handle of this.ownedLocks.values()) handle.release();
    this.ownedLocks.clear();
    this.coordinator?.dispose();
    this.coordinator = undefined;
  }
}
