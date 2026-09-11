import assert from "node:assert/strict";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createWatchdogRegistry, createWatchdogSession } from "./stuck-guard.js";

/** Measure request cost after repeated parent/child lifecycle events using an offline provider.
 * Fail if model-list reads grow with lifecycle count or request P95 exceeds 10 ms.
 */
export async function benchmarkWatchdogLifecycle() {
  const fixture = await createWatchdogRegistry();
  const config = { providerIds: [fixture.providerId] };
  const parent = createWatchdogSession(fixture.registry, config);
  const checkpoints = [];
  let completedCycles = 0;
  let initialModelReads: number | undefined;
  try {
    await parent.emit("session_start");
    await fixture.runtime.refresh({ allowNetwork: false });
    for (const cycles of [1, 100, 1000]) {
      while (completedCycles < cycles) {
        await parent.emit("before_agent_start");
        const child = createWatchdogSession(new ModelRegistry(fixture.runtime), config);
        await child.emit("session_start");
        await child.emit("before_agent_start");
        await child.emit("session_shutdown");
        completedCycles++;
      }
      for (let warmup = 0; warmup < 20; warmup++)
        await fixture.request(parent.session.getSessionId());
      const samples = [];
      const readsBefore = fixture.modelReads;
      const requestsBefore = fixture.requests;
      const statsBefore = await parent.stats();
      for (let sample = 0; sample < 100; sample++) {
        const started = performance.now();
        const result = await fixture.request(parent.session.getSessionId());
        samples.push(performance.now() - started);
        assert.equal(result.stopReason, "stop");
      }
      const modelReads = fixture.modelReads - readsBefore;
      initialModelReads ??= modelReads;
      assert.ok(
        modelReads <= initialModelReads,
        "model enumeration must not grow with lifecycle count",
      );
      assert.equal(fixture.requests - requestsBefore, 100);
      const statsAfter = await parent.stats();
      assert.equal(statsAfter.providerAttempts - statsBefore.providerAttempts, 100);
      assert.equal(statsAfter.providerCompletions - statsBefore.providerCompletions, 100);
      samples.sort((left, right) => left - right);
      const p95Ms = samples[95]!;
      assert.ok(p95Ms <= 10, `local P95 budget exceeded at ${cycles} cycles: ${p95Ms}ms`);
      checkpoints.push({
        cycles,
        requests: 100,
        modelReads,
        medianMs: samples[50],
        p95Ms,
        maxMs: samples.at(-1),
      });
    }
    return { checkpoints, passed: true };
  } finally {
    await parent.emit("session_shutdown");
    await fixture.dispose();
  }
}

if (import.meta.main) {
  const report = await benchmarkWatchdogLifecycle();
  const json = JSON.stringify(report, null, 2);
  if (process.argv[2]) await Bun.write(process.argv[2], json);
  console.log(json);
}
