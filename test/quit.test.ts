import assert from "node:assert/strict";
import { test } from "node:test";
import { quitMixCode, shutdownRuntimeAndStopTui } from "../src/ui/quit.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("shutdownRuntimeAndStopTui aborts work and stops the TUI before awaiting runtime cleanup", async () => {
  const events: string[] = [];
  let releaseClose!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const task = shutdownRuntimeAndStopTui(
    {
      abortAllTabs: () => events.push("abort"),
      closeAllTabs: async () => {
        events.push("close-start");
        await closeStarted;
        events.push("close-done");
      },
    },
    {
      stop: () => events.push("stop"),
      requestRender: () => events.push("render"),
      showOverlay: () => ({}) as never,
    },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["abort", "stop", "close-start"]);

  releaseClose();
  await task;
  assert.deepEqual(events, ["abort", "stop", "close-start", "close-done"]);
});

test("quitMixCode schedules process exit if runtime cleanup hangs", async () => {
  const events: string[] = [];
  void quitMixCode(
    {
      abortAllTabs: () => events.push("abort"),
      closeAllTabs: () => new Promise<void>(() => undefined),
    },
    {
      stop: () => events.push("stop"),
      requestRender: () => events.push("render"),
      showOverlay: () => ({}) as never,
    },
    {
      exitProcess: true,
      exitTimeoutMs: 5,
      exitScheduler: (code) => events.push(`exit:${code}`),
    },
  );

  await sleep(30);
  assert.deepEqual(events, ["abort", "stop", "exit:0"]);
});

test("quitMixCode exits immediately after successful cleanup", async () => {
  const events: string[] = [];
  await quitMixCode(
    {
      abortAllTabs: () => events.push("abort"),
      closeAllTabs: async () => events.push("close"),
    },
    {
      stop: () => events.push("stop"),
      requestRender: () => events.push("render"),
      showOverlay: () => ({}) as never,
    },
    {
      exitProcess: true,
      exitTimeoutMs: 1_000,
      exitScheduler: (code) => events.push(`exit:${code}`),
    },
  );

  assert.deepEqual(events, ["abort", "stop", "close", "render", "exit:0"]);
});
