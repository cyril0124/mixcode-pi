import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createLengthResumeExtension,
  fitReserveToWindow,
  isTinyLengthStall,
  resolveReserveTokens,
  shouldResumeAfterNativeCompact,
} from "./index.js";

describe("fitReserveToWindow", () => {
  it("scales an oversize reserve to ~10% of the window, keeps fitting reserves", () => {
    assert.equal(fitReserveToWindow(1000, 16_384), 100);
    assert.equal(fitReserveToWindow(128_000, 16_384), 16_384);
  });
});

describe("resolveReserveTokens", () => {
  it("merges absolute Pi settings: project over global, default 16384", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-length-resume-budgets-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "cwd");
    await fsPromises.mkdir(path.join(agentDir), { recursive: true });
    await fsPromises.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fsPromises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 5000 } }),
    );
    assert.equal(resolveReserveTokens(cwd, agentDir), 5000);
    await fsPromises.writeFile(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 800 } }),
    );
    assert.equal(resolveReserveTokens(cwd, agentDir), 800);
    await fsPromises.rm(path.join(cwd, ".pi", "settings.json"));
    await fsPromises.rm(path.join(agentDir, "settings.json"));
    // No fraction rewrite: the default stays absolute even for small windows.
    assert.equal(resolveReserveTokens(cwd, agentDir), 16_384);
    await fsPromises.rm(root, { recursive: true, force: true });
  });
});

describe("isTinyLengthStall", () => {
  it("detects tiny length stalls near the ceiling", () => {
    assert.equal(isTinyLengthStall(90, 37_000, 40_000), true);
    assert.equal(isTinyLengthStall(1200, 37_000, 40_000), false);
    assert.equal(isTinyLengthStall(90, 10_000, 40_000), false);
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

describe("resume after native compact", () => {
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

    createLengthResumeExtension({ enabled: true })(pi);

    handlers.get("message_end")?.(
      {
        message: { role: "assistant", stopReason: "length", usage: { totalTokens: 36048 } },
      },
      ctx,
    );

    handlers.get("session_compact")?.(
      {
        type: "session_compact",
        reason: "threshold",
        willRetry: false,
      },
      ctx,
    );

    // Snapshot first — narrowing resumeSent to undefined breaks CFA across await + closure assign.
    const resumeEmptyBeforeFlush = resumeSent === undefined;
    assert.ok(resumeEmptyBeforeFlush); // scheduled, not yet flushed
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumeSent?.customType, "mpi-length-resume");
    assert.equal(resumeSent?.display, false);
  });

  it("does not resume after a compact when the last answer completed normally", async () => {
    type Handler = (event: unknown, ctx: ExtensionContext) => void;
    const handlers = new Map<string, Handler>();
    let resumeSent = false;

    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendMessage() {
        resumeSent = true;
      },
      sendUserMessage() {
        resumeSent = true;
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 36_000 }),
    } as unknown as ExtensionContext;

    createLengthResumeExtension({ enabled: true })(pi);

    handlers.get("message_end")?.(
      { message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 36_000 } } },
      ctx,
    );
    handlers.get("session_compact")?.(
      { type: "session_compact", reason: "threshold", willRetry: false },
      ctx,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumeSent, false);
  });
});

describe("resume after settled length stop", () => {
  it("queues hidden resume when a run settles on length near the ceiling", async () => {
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

    // agentDir points at an empty tmpdir so disk settings fall back to defaults.
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-length-resume-settled-"));
    const ctx = {
      cwd: root,
      hasUI: false,
      model: { contextWindow: 40_000 },
      getContextUsage: () => ({ contextWindow: 40_000, tokens: 37_000 }),
    } as unknown as ExtensionContext;

    createLengthResumeExtension({ enabled: true, agentDir: root })(pi);

    handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "length",
          usage: { totalTokens: 37_000, output: 900 },
        },
      },
      ctx,
    );
    handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumeSent?.customType, "mpi-length-resume");
    assert.equal(resumeSent?.display, false);
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  it("does not resume when the settled context is comfortably below the window", async () => {
    type Handler = (event: unknown, ctx: ExtensionContext) => void;
    const handlers = new Map<string, Handler>();
    let resumeSent = false;

    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendMessage() {
        resumeSent = true;
      },
      sendUserMessage() {
        resumeSent = true;
      },
    } as unknown as ExtensionAPI;

    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-length-resume-settled-low-"));
    const ctx = {
      cwd: root,
      hasUI: false,
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ contextWindow: 200_000, tokens: 30_000 }),
    } as unknown as ExtensionContext;

    createLengthResumeExtension({ enabled: true, agentDir: root })(pi);

    handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "length",
          usage: { totalTokens: 30_000, output: 900 },
        },
      },
      ctx,
    );
    handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumeSent, false);
    await fsPromises.rm(root, { recursive: true, force: true });
  });
});
