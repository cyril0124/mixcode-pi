// Contract: AgentSession summarization_retry_* events drive the same retry
// countdown UI MixCode already uses for auto_retry_* (tab.retryInfo → working
// loader). Pi interactive shows RetryStatusIndicator on scheduled, clears it on
// attempt_start / finished, and showError's the scheduled errorMessage.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MixCodeRuntime, createTab } from "../src/index.js";
import { retryStatusMessage } from "../src/core/tab-state.js";

test("summarization_retry_scheduled arms retryInfo countdown and surfaces error", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "sum-retry-1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };

  anyRuntime.applyEvent(runtimeTab, { type: "compaction_start", reason: "manual" });
  assert.equal(tab.status, "running");
  const startedAtBefore = tab.workingStartedAt;

  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 4000,
    errorMessage: "summarization stream dropped",
  });

  assert.ok(tab.retryInfo, "retryInfo must be set for the working-loader countdown");
  assert.equal(tab.retryInfo?.attempt, 1);
  assert.equal(tab.retryInfo?.maxAttempts, 3);
  assert.equal(tab.retryInfo?.delayMs, 4000);
  assert.equal(tab.status, "thinking");
  assert.equal(tab.workingStartedAt, startedAtBefore, "preserve compaction timer stamp");
  assert.ok(
    runtimeTab.chat.some((line) => line.text.includes("summarization stream dropped")),
    "scheduled errorMessage is shown in chat (Pi showError)",
  );
  assert.match(
    retryStatusMessage(tab, new Date(tab.retryInfo!.startedAt + 500)) ?? "",
    /Retrying \(1\/3\) in \d+s/,
  );
});

test("summarization_retry attempt_start and finished clear the countdown", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "sum-retry-2", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };

  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_scheduled",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "rate limited",
  });
  assert.ok(tab.retryInfo);

  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "manual",
  });
  assert.equal(tab.retryInfo, undefined, "attempt_start clears retry countdown");
  assert.equal(
    tab.status === "running" || tab.status === "thinking",
    true,
    "still working under compaction/branch-summary indicator",
  );

  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_scheduled",
    attempt: 3,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "still failing",
  });
  assert.ok(tab.retryInfo);

  anyRuntime.applyEvent(runtimeTab, { type: "summarization_retry_finished" });
  assert.equal(tab.retryInfo, undefined, "finished clears retry countdown");
});

test("summarization_retry_attempt_start for branchSummary also clears countdown", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "sum-retry-3", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };

  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 1000,
    errorMessage: "branch summary failed",
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "summarization_retry_attempt_start",
    source: "branchSummary",
  });
  assert.equal(tab.retryInfo, undefined);
});
