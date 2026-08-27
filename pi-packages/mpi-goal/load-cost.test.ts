/**
 * Cold-load budget for mpi-goal entry.
 *
 * Measures jiti.import of index.ts in-process with moduleCache:false.
 * Baseline before thin shell was ~550ms (full static app graph).
 * Success gate: cold index load must stay well under 200ms.
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import test from "node:test";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
const APP = fileURLToPath(new URL("./src/app.ts", import.meta.url));

/** Hard ceiling for cold shell load (ms). Plan gate: ≤200ms (baseline was ~550ms). */
const COLD_INDEX_MAX_MS = 200;

async function coldImportMsAsync(path: string): Promise<number> {
  const jiti = createJiti(`${import.meta.url}-${path}-${Math.random()}`, {
    moduleCache: false,
  });
  const t0 = performance.now();
  await jiti.import(path);
  return performance.now() - t0;
}

test("cold jiti load of index stays under budget (thin shell)", async () => {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await coldImportMsAsync(INDEX));
  }
  samples.sort((a, b) => a - b);
  const median = samples[1]!;
  assert.ok(
    median <= COLD_INDEX_MAX_MS,
    `cold index median ${median.toFixed(0)}ms exceeds ${COLD_INDEX_MAX_MS}ms (samples=${samples.map((s) => s.toFixed(0)).join(",")})`,
  );
});

test("full app graph remains loadable (features not deleted)", async () => {
  const mod = await createJiti(`${import.meta.url}-app-check`, { moduleCache: true }).import(APP);
  assert.equal(typeof (mod as { wireMpiGoal?: unknown }).wireMpiGoal, "function");
});
