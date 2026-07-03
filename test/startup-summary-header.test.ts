// Regression tests: the startup resource summary ([Context]/[Skills]/[Extensions])
// lives on tab.startupSummary (a tab-level field, Pi's loadedResourcesContainer
// analogue) instead of inside the chat array. Chat rebuilds from session entries
// (retract, tree navigation, compaction) therefore can never clear it.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab } from "../src/index.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// Stream that stays open until aborted or released, so a run is genuinely
// mid-flight with zero visible output when retracted.
function pendingStream(release: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "hdr-test",
      provider: "hdr-test",
      model: "hdr-test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    const aborted = {
      ...message,
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

test("startup summary survives retractCurrentTurn (double-Esc undo)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-hdr-retract-"));
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_m: Model<unknown>, _c: Context, options?: SimpleStreamOptions) =>
        pendingStream(released, options),
    });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: { ...MIXCODE_FAUX_MODEL, provider: "hdr-test", api: "hdr-test", id: "hdr-test-model" },
    });
    const summaryBefore = runtimeTab.tab.startupSummary;
    assert.ok(summaryBefore, "startup summary is set on tab after createTab");
    assert.match(summaryBefore, /\[Context\]/);

    const pending = runtime.prompt("s1", "please retract me");
    await waitFor(() => runtimeTab.agent.state.isStreaming === true);
    const result = await runtime.retractCurrentTurn("s1");
    release();
    await pending.catch(() => undefined);

    assert.equal(result?.editorText, "please retract me");
    assert.equal(runtimeTab.tab.startupSummary, summaryBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup summary survives extension tree navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-hdr-tree-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: MIXCODE_FAUX_MODEL,
    });
    const summaryBefore = runtimeTab.tab.startupSummary;
    assert.ok(summaryBefore);

    await runtime.prompt("s1", "first message");
    await waitFor(() => runtimeTab.agent.state.isStreaming === false);
    const userEntry = runtimeTab.session
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "user");
    assert.ok(userEntry);

    await runtime.extensionNavigateTree("s1", userEntry.id);
    assert.equal(runtimeTab.tab.startupSummary, summaryBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup summary renders at the top of the agent surface and contains resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-hdr-render-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: MIXCODE_FAUX_MODEL,
    });
    assert.ok(runtimeTab.tab.startupSummary);
    // Chat is now a pure projection of session entries plus runtime notices:
    // the startup summary itself never appears as a chat line.
    assert.equal(
      runtimeTab.chat.some((line) => line.text.includes("[Context]")),
      false,
    );

    // Tall viewport so the whole summary fits without scrolling.
    const lines = renderAgentSurface(runtimeTab.tab, runtimeTab, 100, 400).map(stripAnsi);
    const joined = lines.join("\n");
    assert.match(joined, /\[Context\]/);
    assert.match(joined, /\[Extensions\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extension load errors land in the startup summary diagnostics section", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-hdr-diag-"));
  const extensionPath = join(dir, "missing-extension.ts");
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      additionalExtensionPaths: [extensionPath],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.ok(runtimeTab.extensionsResult.errors.some((error) => error.path === extensionPath));
    assert.match(runtimeTab.tab.startupSummary ?? "", /\[Diagnostics\]/);
    assert.match(runtimeTab.tab.startupSummary ?? "", /Extension load error/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
