import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  clearExtensionCache,
  loadExtensions,
  loadExtensionsCached,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/**
 * Contract: concurrent cache-token loads with the same cwd share in-flight
 * module imports (single-flight), so N racing loaders evaluate each extension
 * module once. loadExtensions() (no cache token) keeps upstream fresh-eval
 * semantics and never joins. clearExtensionCache() invalidates both the
 * factory cache and the in-flight joins.
 */

async function makeCounterExtension(dir: string): Promise<string> {
  const extDir = path.join(dir, "counter-ext");
  await fsPromises.mkdir(extDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(extDir, "index.ts"),
    [
      'const g = globalThis as Record<string, unknown>;',
      'g.__singleFlightEvalCount = ((g.__singleFlightEvalCount as number) ?? 0) + 1;',
      "export default function counter() {}",
      "",
    ].join("\n"),
    "utf8",
  );
  return path.join(extDir, "index.ts");
}

function evalCount(): number {
  return ((globalThis as Record<string, unknown>).__singleFlightEvalCount as number) ?? 0;
}

test("concurrent same-cwd loads evaluate an extension module exactly once", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "single-flight-"));
  try {
    const extPath = await makeCounterExtension(dir);
    clearExtensionCache();
    (globalThis as Record<string, unknown>).__singleFlightEvalCount = 0;

    const results = await Promise.all([
      loadExtensionsCached([extPath], dir),
      loadExtensionsCached([extPath], dir),
      loadExtensionsCached([extPath], dir),
    ]);
    const uncached = await loadExtensions([extPath], dir);

    assert.equal(results.every((r) => r.extensions.length === 1), true);
    assert.equal(uncached.extensions.length, 1);
    // Cached racers share one evaluation; the uncached call re-evaluates.
    assert.equal(evalCount(), 2);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("sequential cached loads after completion hit the factory cache", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "single-flight-seq-"));
  try {
    const extPath = await makeCounterExtension(dir);
    clearExtensionCache();
    (globalThis as Record<string, unknown>).__singleFlightEvalCount = 0;

    await loadExtensionsCached([extPath], dir);
    await loadExtensionsCached([extPath], dir);
    assert.equal(evalCount(), 1);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("clearExtensionCache forces a fresh evaluation on the next load", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "single-flight-clear-"));
  try {
    const extPath = await makeCounterExtension(dir);
    clearExtensionCache();
    (globalThis as Record<string, unknown>).__singleFlightEvalCount = 0;

    await loadExtensionsCached([extPath], dir);
    assert.equal(evalCount(), 1);

    clearExtensionCache();
    await loadExtensionsCached([extPath], dir);
    assert.equal(evalCount(), 2);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
