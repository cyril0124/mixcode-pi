// Tests for the console → TUI bridge (src/cli/console-tui-bridge.ts).
//
// The bridge overrides global console methods so their output is queued (before
// the TUI exists) and later flushed to a sink in arrival order, each line tagged
// with a `[console.<method>]:` prefix and formatted exactly like console. These
// tests follow that lifecycle in one sequence because the bridge keeps
// process-global state (the overridden console + the pending queue), and restore
// the original console afterward so other test files are unaffected.

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { installConsoleTuiBridge, wireConsoleSink } from "../src/cli/console-tui-bridge.js";
import { closeAppOverlay, getActiveNotice, showNoticeTextOverlay } from "../src/ui/app-overlays.js";

test("console bridge queues before wiring, then flushes in order with prefixes", () => {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  try {
    installConsoleTuiBridge();

    // Before the sink is wired, these queue rather than hit the (absent) TUI.
    console.log("hello", 42, { a: 1 });
    console.info("info-line");
    console.debug("debug-line");
    console.warn("warn-line");

    const captured: string[] = [];
    // Wiring flushes the backlog in arrival order.
    wireConsoleSink((text) => captured.push(text));

    assert.deepEqual(captured, [
      "[console.log]: hello 42 { a: 1 }", // node:util.format renders args like console
      "[console.info]: info-line",
      "[console.debug]: debug-line",
      "[console.warn]: warn-line",
    ]);

    // After wiring, calls go straight to the sink (no queueing).
    console.error("boom");
    assert.equal(captured.at(-1), "[console.error]: boom");
  } finally {
    Object.assign(console, original);
  }
});

test("console history counts multiline calls once and caps at 1000 entries", () => {
  const bridgePath = path.join(import.meta.dir, "..", "src", "cli", "console-tui-bridge.ts");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { getConsoleHistory, installConsoleTuiBridge } from ${JSON.stringify(bridgePath)};
const fresh = getConsoleHistory();
installConsoleTuiBridge();
console.log("multi\\nline");
for (let index = 0; index < 999; index++) console.debug(\`history-\${index}\`);
const exactlyFull = getConsoleHistory();
for (let index = 0; index <= 1000; index++) console.debug(\`history-\${index}\`);
const capped = getConsoleHistory();
process.stdout.write(JSON.stringify({ fresh, exactlyFull, capped }));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const output = JSON.parse(result.stdout.toString()) as {
    fresh: string[];
    exactlyFull: string[];
    capped: string[];
  };
  assert.deepEqual(output.fresh, []);
  assert.equal(output.exactlyFull.length, 1_000);
  assert.equal(output.exactlyFull[0], "[console.log]: multi\nline");
  assert.equal(output.capped.length, 1_000);
  assert.equal(output.capped[0], "[console.debug]: history-1");
  assert.equal(output.capped.at(-1), "[console.debug]: history-1000");
});

test("notice overlay appends consecutive console lines instead of replacing", () => {
  // #12: rapid console.* used to leave only the last Notice because each sink
  // call closed the previous overlay.
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  showNoticeTextOverlay(tui, "[console.warn]: first");
  showNoticeTextOverlay(tui, "[console.log]: second");
  const notice = getActiveNotice();
  assert.ok(notice);
  assert.match(notice!.text, /\[console\.warn\]: first/);
  assert.match(notice!.text, /\[console\.log\]: second/);
  closeAppOverlay(tui);
});
