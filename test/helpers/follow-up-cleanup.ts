import * as fs from "node:fs/promises";
import type { MixCodeRuntime } from "../../src/agent/runtime.js";
import { waitForCompactionIdle } from "../../src/agent/runtime-follow-up.js";

/** Owns test-started work and gates; cleanup reports failures after disposing runtime resources. */
export class FollowUpCleanup {
  private readonly pending: Promise<void>[] = [];
  private readonly errors: unknown[] = [];

  constructor(
    private readonly runtime: MixCodeRuntime,
    private readonly dir: string,
    private readonly releaseGates: (() => void)[] = [],
  ) {}

  /** Observe immediately to prevent unhandled rejections; preserve failures for cleanup. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.push(
      promise.then(
        () => undefined,
        (error: unknown) => {
          this.errors.push(error);
        },
      ),
    );
    return promise;
  }

  async cleanup(): Promise<void> {
    const tabs = this.runtime.listTabs();
    // Pause before releasing gates so a failed assertion cannot dispatch queued work.
    for (const tab of tabs) {
      tab.tab.followUpsPaused = true;
      tab.agentSession.clearQueue();
    }
    for (const release of this.releaseGates) release();

    await Promise.all(this.pending);
    const settled = await Promise.allSettled(
      tabs.map(async (tab) => {
        await tab.agentSession.waitForIdle();
        await waitForCompactionIdle(tab.agentSession);
        await tab.followUpDrain;
        await tab.agentSession.waitForIdle();
      }),
    );
    for (const result of settled) {
      if (result.status === "rejected") this.errors.push(result.reason);
    }

    // closeAllTabs disposes sessions and unregisters buses even if a shutdown hook fails.
    try {
      await this.runtime.closeAllTabs();
    } catch (error) {
      this.errors.push(error);
    }
    this.runtime.beginShutdown();
    try {
      await fs.rm(this.dir, { recursive: true, force: true });
    } catch (error) {
      this.errors.push(error);
    }
    if (this.errors.length > 0) {
      throw new AggregateError(this.errors, "Follow-up fixture cleanup failed");
    }
  }
}
