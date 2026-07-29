import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createMidTurnCompactExtension,
  EMPTY_COMPACT_RESUME_PROMPT,
  endsWithCompleteToolResultBatch,
  estimateContextTokensFromMessages,
  estimateTokensForNextCall,
  fitCompactionBudgetsToWindow,
  isBranchCompactable,
  isTinyLengthStall,
  lastAssistantUsageTokens,
  loadPrepareCompaction,
  resetPrepareCompactionLoaderForTests,
  resolveCompactionBudgets,
  shouldCompactForWindow,
  shouldResumeAfterNativeCompact,
  stillOverThresholdAfterCompact,
} from "./index.js";

const budgets = {
  enabled: true,
  reserveTokens: 10_000,
  keepRecentTokens: 20_000,
};

const prepareOk = () => ({
  messagesToSummarize: [{ role: "user" }],
  turnPrefixMessages: [],
});
const prepareEmpty = () => undefined;

/** Over-threshold batch for window=40k with disk reserve that fits (reserve < window). */
function overThresholdMessages(totalTokens = 37_000) {
  return [
    {
      role: "assistant",
      usage: { totalTokens },
      content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
    },
    { role: "toolResult", toolCallId: "a" },
  ];
}

describe("endsWithCompleteToolResultBatch", () => {
  it("accepts a matched assistant tool batch", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "read", arguments: {} },
          { type: "toolCall", id: "b", name: "bash", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "a" },
      { role: "toolResult", toolCallId: "b" },
    ];
    assert.equal(endsWithCompleteToolResultBatch(messages), true);
  });

  it("rejects incomplete or mismatched batches", () => {
    assert.equal(
      endsWithCompleteToolResultBatch([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
        },
      ]),
      false,
    );
    assert.equal(
      endsWithCompleteToolResultBatch([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "z" },
      ]),
      false,
    );
  });
});

describe("lastAssistantUsageTokens", () => {
  it("prefers totalTokens on the latest assistant", () => {
    const messages = [
      { role: "assistant", usage: { totalTokens: 100 } },
      { role: "toolResult", toolCallId: "a" },
      { role: "assistant", usage: { totalTokens: 2500 } },
      { role: "toolResult", toolCallId: "b" },
    ];
    assert.equal(lastAssistantUsageTokens(messages), 2500);
  });

  it("falls back to summing usage parts", () => {
    assert.equal(
      lastAssistantUsageTokens([
        {
          role: "assistant",
          usage: { input: 1000, output: 20, cacheRead: 5, cacheWrite: 5 },
        },
      ]),
      1030,
    );
  });
});

describe("shouldCompactForWindow / fitCompactionBudgetsToWindow", () => {
  it("triggers only above window - reserve (Pi absolute threshold)", () => {
    assert.equal(shouldCompactForWindow(900, 1000, 100), false);
    assert.equal(shouldCompactForWindow(901, 1000, 100), true);
  });

  it("fits oversize reserve to ~10% of window instead of disabling mid-turn", () => {
    // Disk default 16384 on a 1000 window used to hard-refuse; now scale reserve=100.
    assert.equal(shouldCompactForWindow(900, 1000, 16_384), false); // 900 > 1000-100?
    assert.equal(shouldCompactForWindow(901, 1000, 16_384), true);
    assert.deepEqual(
      fitCompactionBudgetsToWindow(
        { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        1000,
      ),
      { enabled: true, reserveTokens: 100, keepRecentTokens: 250 },
    );
  });

  it("keeps budgets that already fit the window", () => {
    assert.deepEqual(
      fitCompactionBudgetsToWindow(
        { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        128_000,
      ),
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    );
  });
});

describe("resolveCompactionBudgets", () => {
  it("merges absolute Pi settings: project over global, defaults 16384/20000", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpi-mid-turn-budgets-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "cwd");
    await mkdir(join(agentDir), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 5000, keepRecentTokens: 12_000 } }),
    );
    assert.deepEqual(resolveCompactionBudgets(cwd, agentDir), {
      enabled: true,
      reserveTokens: 5000,
      keepRecentTokens: 12_000,
    });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 800, keepRecentTokens: 4000 } }),
    );
    assert.deepEqual(resolveCompactionBudgets(cwd, agentDir), {
      enabled: true,
      reserveTokens: 800,
      keepRecentTokens: 4000,
    });
    await rm(join(cwd, ".pi", "settings.json"));
    await rm(join(agentDir, "settings.json"));
    // No fraction rewrite: defaults stay absolute even for small windows.
    assert.deepEqual(resolveCompactionBudgets(cwd, agentDir), {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
    await rm(root, { recursive: true, force: true });
  });
});

describe("stillOverThresholdAfterCompact / isTinyLengthStall", () => {
  it("detects post-compact thrash and tiny length stalls", () => {
    assert.equal(stillOverThresholdAfterCompact(35_000, 40_000, 10_000), true);
    assert.equal(stillOverThresholdAfterCompact(20_000, 40_000, 10_000), false);
    assert.equal(stillOverThresholdAfterCompact(undefined, 40_000, 10_000), false);
    assert.equal(isTinyLengthStall(90, 37_000, 40_000), true);
    assert.equal(isTinyLengthStall(1200, 37_000, 40_000), false);
    assert.equal(isTinyLengthStall(90, 10_000, 40_000), false);
  });
});

describe("isBranchCompactable", () => {
  it("requires non-empty preparation", () => {
    assert.equal(isBranchCompactable([{ type: "message" }], budgets, prepareOk), true);
    assert.equal(isBranchCompactable([{ type: "message" }], budgets, prepareEmpty), false);
    assert.equal(isBranchCompactable([], budgets, prepareOk), false);
  });
});

describe("single compact attempt", () => {
  it("does not re-enter ctx.compact after a non-benign failure", async () => {
    // Pi already retries summarization inside one compact(); outer 2s/5s loops
    // open an idle gap where queued turns can race. One attempt only.
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let compactCalls = 0;
    const notifies: Array<{ message: string; type?: string }> = [];

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage() {
        throw new Error("must not resume after hard compact failure");
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      ui: {
        notify(message: string, type?: string) {
          notifies.push({ message, type });
        },
      },
      abort() {},
      compact(options?: { onError?: (error: Error) => void }) {
        compactCalls += 1;
        options?.onError?.(new Error("Summarization failed: boom"));
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      prepareCompaction: prepareOk,
    })(pi);

    await contextHandler!({ type: "context", messages: overThresholdMessages() }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(compactCalls, 1);
    assert.ok(
      notifies.some((n) => /Mid-turn compact failed/i.test(n.message) && n.type === "error"),
    );
  });
});

describe("loadPrepareCompaction", () => {
  it("loads Pi prepareCompaction via package entry (not package.json exports)", async () => {
    resetPrepareCompactionLoaderForTests();
    const prepare = await loadPrepareCompaction();
    assert.equal(typeof prepare, "function");
  });
});

describe("estimateContextTokensFromMessages", () => {
  it("adds trailing message estimates on top of last valid assistant usage", () => {
    const messages = [
      {
        role: "assistant",
        usage: { totalTokens: 1000 },
        content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "a", content: "x".repeat(400) },
    ];
    // Pi: usage 1000 + estimateTokens(toolResult) = 1000 + ceil(400/4) = 1100
    const estimate = estimateContextTokensFromMessages(messages);
    assert.equal(estimate.usageTokens, 1000);
    assert.equal(estimate.trailingTokens, 100);
    assert.equal(estimate.tokens, 1100);
    assert.equal(estimateTokensForNextCall(messages), 1100);
  });

  it("skips aborted assistant usage and falls back to earlier valid usage", () => {
    const messages = [
      { role: "assistant", usage: { totalTokens: 500 }, content: [{ type: "text", text: "ok" }] },
      {
        role: "assistant",
        stopReason: "aborted",
        usage: { totalTokens: 9000 },
        content: [{ type: "text", text: "partial" }],
      },
      { role: "toolResult", toolCallId: "a", content: "y".repeat(40) },
    ];
    const estimate = estimateContextTokensFromMessages(messages);
    // Last valid usage index is the first assistant (500); trailing includes aborted msg + toolResult.
    assert.equal(estimate.usageTokens, 500);
    assert.equal(estimate.lastUsageIndex, 0);
    assert.ok(estimate.tokens > 500);
    assert.ok(estimate.tokens < 9000); // must not use aborted 9000 as base
  });
});

describe("shouldResumeAfterNativeCompact", () => {
  it("resumes only threshold/overflow after length-truncated answers", () => {
    assert.equal(
      shouldResumeAfterNativeCompact({
        reason: "threshold",
        willRetry: false,
        lastAssistantStopReason: "length",
      }),
      true,
    );
    assert.equal(
      shouldResumeAfterNativeCompact({
        reason: "manual",
        willRetry: false,
        lastAssistantStopReason: "length",
      }),
      false,
    );
    assert.equal(
      shouldResumeAfterNativeCompact({
        reason: "threshold",
        willRetry: true,
        lastAssistantStopReason: "length",
      }),
      false,
    );
    assert.equal(
      shouldResumeAfterNativeCompact({
        reason: "threshold",
        willRetry: false,
        lastAssistantStopReason: "stop",
      }),
      false,
    );
  });
});

describe("context handler non-blocking compact", () => {
  it("returns before compact settles so emitContext cannot deadlock", async () => {
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let compactStarted = false;
    let compactSettled = false;
    let resumeSent: { customType?: string; display?: boolean; content?: unknown } | undefined;
    let resolveCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => {
      resolveCompact = resolve;
    });

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage(message: { customType?: string; display?: boolean; content?: unknown }) {
        resumeSent = message;
      },
      sendUserMessage() {
        throw new Error("resume must use hidden sendMessage, not sendUserMessage");
      },
    } as unknown as ExtensionAPI;

    // Absolute Pi default reserve=16384 needs window > reserve and tokens > window-reserve.
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      abort() {},
      compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }) {
        compactStarted = true;
        void compactGate.then(() => {
          compactSettled = true;
          options?.onComplete?.();
        });
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      prepareCompaction: prepareOk,
    })(pi);

    assert.ok(contextHandler, "context handler registered");

    // Handler may be async for prepare precheck, but must not await compact.
    await contextHandler!({ type: "context", messages: overThresholdMessages() }, ctx);
    assert.equal(compactSettled, false);

    // Compact is scheduled on the next macrotask after the handler returns.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compactStarted, true);
    assert.equal(compactSettled, false);
    assert.equal(resumeSent, undefined);

    resolveCompact();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compactSettled, true);
    assert.equal(resumeSent?.customType, "mpi-mid-turn-resume");
    assert.equal(resumeSent?.display, false);
  });

  it("still attempts compact when prepareCompaction cannot be loaded", async () => {
    // prepare === null is a precheck outage, not "nothing to compact".
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let aborted = false;
    let compactCalled = false;

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage() {},
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      abort() {
        aborted = true;
      },
      compact(options?: { onComplete?: () => void }) {
        compactCalled = true;
        options?.onComplete?.();
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      prepareCompaction: null,
    })(pi);

    await contextHandler!({ type: "context", messages: overThresholdMessages() }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(compactCalled, true);
  });

  it("prechecks prepare with disk keep, not fitted keep (matches Pi compact)", async () => {
    // Fitted keep (e.g. 250 on a 1k window) can look compactable while Pi compact still
    // uses disk keep=20000 and returns nothing — must not abort on that optimistic precheck.
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let aborted = false;
    let seenKeep: number | undefined;

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage() {},
    } as unknown as ExtensionAPI;

    const agentDir = await mkdtemp(join(tmpdir(), "mpi-mid-turn-disk-keep-"));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
      }),
    );

    const ctx = {
      cwd: agentDir,
      hasUI: false,
      model: { contextWindow: 1000 },
      getContextUsage: () => ({ contextWindow: 1000, tokens: 950 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      abort() {
        aborted = true;
      },
      compact() {
        throw new Error("must not compact when disk keep precheck is empty");
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      agentDir,
      prepareCompaction: (_entries, settings) => {
        seenKeep = settings.keepRecentTokens;
        // Fitted keep (~250) would pass; disk keep (20000) must fail like Pi.
        if (settings.keepRecentTokens >= 1000) return undefined;
        return { messagesToSummarize: [{ role: "user" }], turnPrefixMessages: [] };
      },
    })(pi);

    await contextHandler!({
      type: "context",
      messages: [
        {
          role: "assistant",
          usage: { totalTokens: 950 },
          content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "a" },
      ],
    }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(seenKeep, 20_000);
    assert.equal(aborted, false);
    await rm(agentDir, { recursive: true, force: true });
  });

  it("does not abort when prepareCompaction says nothing to compact", async () => {
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let aborted = false;
    let compactCalled = false;

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage() {},
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      abort() {
        aborted = true;
      },
      compact() {
        compactCalled = true;
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      prepareCompaction: prepareEmpty,
    })(pi);

    await contextHandler!({ type: "context", messages: overThresholdMessages() }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborted, false);
    assert.equal(compactCalled, false);
  });

  it("resumes and suppresses mid-turn when compact race says session too small", async () => {
    type ContextHandler = (
      event: { type: "context"; messages: unknown[] },
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let contextHandler: ContextHandler | undefined;
    let resumeSent: { customType?: string; content?: unknown } | undefined;

    const pi = {
      on(event: string, handler: ContextHandler) {
        if (event === "context") contextHandler = handler;
      },
      sendMessage(message: { customType?: string; content?: unknown }) {
        resumeSent = message;
      },
      sendUserMessage() {
        throw new Error("must use hidden sendMessage");
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
      sessionManager: { getBranch: () => [{ type: "message", id: "1" }] },
      abort() {},
      compact(options?: { onError?: (error: Error) => void }) {
        options?.onError?.(new Error("Nothing to compact (session too small)"));
      },
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({
      enabled: true,
      prepareCompaction: prepareOk,
    })(pi);

    const messages = overThresholdMessages();
    await contextHandler!({ type: "context", messages }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resumeSent?.customType, "mpi-mid-turn-resume");
    assert.equal(resumeSent?.content, EMPTY_COMPACT_RESUME_PROMPT);

    resumeSent = undefined;
    let aborted = false;
    const ctx2 = {
      ...ctx,
      abort() {
        aborted = true;
      },
    } as unknown as ExtensionContext;
    await contextHandler!({ type: "context", messages }, ctx2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborted, false);
    assert.equal(resumeSent, undefined);
  });

  it("queues hidden resume after native threshold compact on length-truncated answer", async () => {
    type Handler = (event: unknown, ctx: ExtensionContext) => void;
    const handlers = new Map<string, Handler>();
    let resumeSent: { customType?: string; display?: boolean } | undefined;

    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendMessage(message: { customType?: string; display?: boolean }) {
        resumeSent = message;
      },
      sendUserMessage() {
        throw new Error("resume must use hidden sendMessage, not sendUserMessage");
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 36_000 }),
      abort() {},
      compact() {},
    } as unknown as ExtensionContext;

    createMidTurnCompactExtension({ enabled: true })(pi);

    handlers.get("message_end")?.({
      message: { role: "assistant", stopReason: "length", usage: { totalTokens: 36048 } },
    }, ctx);

    handlers.get("session_compact")?.({
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
    }, ctx);

    assert.equal(resumeSent, undefined); // scheduled, not yet flushed
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumeSent?.customType, "mpi-mid-turn-resume");
    assert.equal(resumeSent?.display, false);
  });
});
