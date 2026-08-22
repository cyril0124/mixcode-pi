// Child scenario for test/git-branch-render.test.ts. Runs in a separate bun
// process whose PATH points at the test's fake slow git, so the PATH swap
// never leaks into the shared `bun test --test-worker` process where up to
// `--max-concurrency` other test files run concurrently and also spawn git.
//
// Contract: argv[2] is the workdir. Measures the first synchronous
// renderInputMeta paint (must not await git) and the post-refresh paint, then
// prints one JSON line { firstMs, painted } to stdout and exits 0. Any
// non-zero exit or unparsable stdout means the scenario itself failed.
import assert from "node:assert/strict";
import { createTab } from "../../src/core/defaults.js";
import { renderInputMeta } from "../../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const workdir = process.argv[2];
assert.ok(workdir, "scenario requires a workdir argument");

const tab = createTab(1, "s1", workdir);
const t0 = performance.now();
renderInputMeta(tab, 120);
const firstMs = performance.now() - t0;

// Footer branch refresh is async (stat-poll + debounce); wait for it.
await Bun.sleep(600);
const painted = stripAnsi(renderInputMeta(tab, 120).join("\n"));

process.stdout.write(JSON.stringify({ firstMs, painted }));
