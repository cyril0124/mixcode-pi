import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workingTimer, { formatClockTime, formatElapsed, WORKING_TIMER_STATUS_KEY } from "./index.js";

/** Settled text, e.g. `✔ done 5s at 2026-10-03 15:39:00`. The stamp is local
 *  time, so only its shape is asserted here; digits are pinned by the
 *  formatClockTime case below, which builds its Date in local time. */
const DONE_TEXT = /^✔ done .+ at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface StatusWrite {
  key: string;
  text: string | undefined;
}

interface Harness {
  fire(event: string): void;
  /** Emit an event the package deliberately ignores (e.g. `agent_end`). */
  emit(event: string): void;
  writes: StatusWrite[];
  latest(): string | undefined;
  tick(): void;
  liveTickerCount(): number;
  advance(ms: number): void;
  dispose(): void;
}

/**
 * Registers the extension against a fake host: a controllable clock, an interval
 * registry, and a recording `setStatus`.
 */
function createHarness(startMs = 1_000_000): Harness {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const writes: StatusWrite[] = [];
  const tickers = new Map<number, () => void>();
  let nextTickerId = 1;
  let now = startMs;

  const realDateNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;

  Date.now = () => now;
  globalThis.setInterval = ((fn: () => void) => {
    const id = nextTickerId++;
    tickers.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    tickers.delete(id as number);
  }) as typeof clearInterval;

  const ctx = {
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        writes.push({ key, text });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  workingTimer(pi);

  return {
    fire: (event) => {
      const handler = handlers.get(event);
      assert.ok(handler, `no handler registered for ${event}`);
      handler({}, ctx);
    },
    emit: (event) => {
      handlers.get(event)?.({}, ctx);
    },
    writes,
    latest: () => writes.at(-1)?.text,
    tick: () => {
      for (const fn of [...tickers.values()]) fn();
    },
    liveTickerCount: () => tickers.size,
    advance: (ms) => {
      now += ms;
    },
    dispose: () => {
      Date.now = realDateNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

test("holds the running clock across agent loops and settles it once agent_settled arrives", () => {
  const harness = createHarness();
  try {
    harness.fire("session_start");
    assert.equal(harness.latest(), undefined);

    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 0s");

    harness.advance(3_000);
    harness.fire("tool_execution_start");
    assert.equal(harness.latest(), "⏱ 3s");

    // An auto-retry / compaction / continuation run ends one agent loop without
    // ending the run: the clock keeps counting into the next loop.
    harness.emit("agent_end");
    assert.equal(harness.latest(), "⏱ 3s");

    harness.advance(2_000);
    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 5s");

    harness.fire("agent_settled");
    assert.match(harness.latest() ?? "", DONE_TEXT);
    assert.ok(harness.latest()?.startsWith("✔ done 5s at "), harness.latest());
    assert.equal(harness.liveTickerCount(), 0);

    // The next run starts a fresh clock.
    harness.advance(1_000);
    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 0s");
  } finally {
    harness.dispose();
  }
});

test("keeps exactly one ticker per run and stops it on agent_settled", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);

    harness.advance(1_000);
    harness.tick();
    assert.equal(harness.latest(), "⏱ 1s");

    // A second agent_start in the same run replaces the ticker instead of stacking.
    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);

    harness.advance(4_000);
    harness.fire("agent_settled");
    assert.equal(harness.liveTickerCount(), 0);
    assert.ok(harness.latest()?.startsWith("✔ done 5s at "), harness.latest());

    // An idle session schedules no further renders.
    const writesAfterEnd = harness.writes.length;
    harness.advance(10_000);
    harness.tick();
    assert.equal(harness.writes.length, writesAfterEnd);
  } finally {
    harness.dispose();
  }
});

test("clears the footer entry and the ticker on session boundaries", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    harness.advance(2_000);
    harness.fire("agent_settled");
    assert.ok(harness.latest()?.startsWith("✔ done 2s at "), harness.latest());

    harness.fire("session_start");
    assert.equal(harness.latest(), undefined);

    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);
    harness.fire("session_shutdown");
    assert.equal(harness.latest(), undefined);
    assert.equal(harness.liveTickerCount(), 0);
  } finally {
    harness.dispose();
  }
});

test("writes every status under the documented key", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    harness.advance(61_000);
    harness.fire("tool_execution_end");
    harness.fire("agent_settled");
    assert.deepEqual(
      harness.writes.map((write) => write.key),
      [WORKING_TIMER_STATUS_KEY, WORKING_TIMER_STATUS_KEY, WORKING_TIMER_STATUS_KEY],
    );
    assert.ok(harness.latest()?.startsWith("✔ done 1m 01s at "), harness.latest());
  } finally {
    harness.dispose();
  }
});

test("formats the finish stamp as a local YYYY-MM-DD HH:MM:SS clock", () => {
  // Both the construction and the formatting use local time, so this holds in any TZ.
  assert.equal(formatClockTime(new Date(2026, 9, 3, 15, 39, 0).getTime()), "2026-10-03 15:39:00");
  assert.equal(formatClockTime(new Date(2026, 0, 9, 4, 5, 6).getTime()), "2026-01-09 04:05:06");
});

test("formats durations with mixed units", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(7_200_000), "2h 00m 00s");
});
