import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "./helpers/mixcode.js";

/**
 * Contract: concurrent replaceRuntimeTabSession on one tab must not bind a
 * disposed session. Without per-tab serialization, create→bind can race with a
 * second replace's dispose and session_start sees stale ctx
 * (pi-subagents: "Failed to start scheduler: ... stale after session replacement").
 *
 * Portable: inline extension reads ctx.sessionManager on session_start — same
 * assertActive boundary as pi-subagents startScheduler, no ~/.pi/agent required.
 * Slow session_start widens the race window via the real bind path (no test hooks).
 */
test("concurrent replace on one tab does not stale session_start ctx", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-replace-lock-"));
  const starts: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      // Hold bind open so a non-serialized second replace could dispose mid-handler.
      await Bun.sleep(150);
      try {
        starts.push(`ok:${ctx.sessionManager.getSessionId()}`);
      } catch (error) {
        starts.push(`err:${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      extensionFactories: [extension],
    });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const f1 = (await runtime.forkSession("s1", "a")).getSessionFile()!;
    const f2 = (await runtime.forkSession("s1", "b")).getSessionFile()!;

    starts.length = 0;
    const p1 = runtime.extensionSwitchSession("s1", f1);
    await Bun.sleep(40);
    // First replace may already have moved the tab id; use current map key.
    const id = runtime.listTabs()[0]!.tab.sessionId;
    const p2 = runtime.extensionSwitchSession(id, f2);
    const settled = await Promise.allSettled([p1, p2]);
    assert.equal(
      settled.filter((s) => s.status === "fulfilled").length,
      2,
      `both replaces should finish: ${JSON.stringify(
        settled.map((s) => (s.status === "fulfilled" ? s.value : String(s.reason))),
      )}`,
    );

    const staleStarts = starts.filter((s) => /stale after session replacement/.test(s));
    assert.equal(
      staleStarts.length,
      0,
      `session_start must not see stale ctx; starts=${JSON.stringify(starts)}`,
    );
    assert.ok(
      starts.some((s) => s.startsWith("ok:")),
      `expected successful session_start; starts=${JSON.stringify(starts)}`,
    );
    assert.equal(runtime.listTabs()[0]!.tab.sessionId, "b");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Contract: resuming (extensionSwitchSession) into a session with a persisted
 * name must restore the tab title from that name, not leave the ephemeral
 * "Agent-NN" default. Regression: the runtime layer previously relied on the UI
 * caller to set the title, so any missing/stale sessionName reverted the tab to
 * a plain "Agent-NN".
 */
test("resume restores tab title from the resumed session's persisted name", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-resume-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions") });
    const seed = await runtime.createTab(createTab(1, "seed", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtime.renameSession("seed", "My Important Session");
    const seedFile = seed.session.getSessionFile()!;

    const ephemeral = createTab(2, "ephemeral", process.cwd());
    assert.equal(ephemeral.title, "Agent-02");
    await runtime.createTab(ephemeral, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.extensionSwitchSession("ephemeral", seedFile);

    const resumed = runtime.listTabs().find((t) => t.session.getSessionFile() === seedFile)!;
    assert.equal(resumed.session.getSessionName(), "My Important Session");
    assert.equal(
      resumed.tab.title,
      "My Important Session",
      `resume must restore persisted name; got "${resumed.tab.title}"`,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("resume keeps a session-start turn visibly running", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-resume-running-"));
  const stream = createAssistantMessageEventStream();
  let releaseContext!: () => void;
  let markContextEntered!: () => void;
  let contextWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve;
  });
  const contextEntered = new Promise<void>((resolve) => {
    markContextEntered = resolve;
  });
  const events: string[] = [];
  let runtime: MixCodeRuntime | undefined;
  try {
    runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      streamFn: () => stream,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", async (event, ctx) => {
            if (!ctx.hasUI || event.reason !== "resume") return;
            pi.sendMessage(
              { customType: "resume-running", content: "continue", display: false },
              { triggerTurn: true, deliverAs: "followUp" },
            );
            await Bun.sleep(20);
          });
          pi.on("context", async (event) => {
            markContextEntered();
            await contextGate;
            return { messages: event.messages };
          });
        },
      ],
    });
    const initial = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const target = (await runtime.forkSession("s1", "target")).getSessionFile();
    assert.ok(target);
    runtime.onChange((event) => events.push(event.type));

    await runtime.extensionSwitchSession("s1", target);
    await Promise.race([
      contextEntered,
      new Promise<never>((_, reject) => {
        contextWaitTimer = setTimeout(
          () => reject(new Error("resume context event was not observed")),
          10_000,
        );
      }),
    ]);
    clearTimeout(contextWaitTimer);
    contextWaitTimer = undefined;

    const resumed = runtime.listTabs()[0]!;
    assert.equal(resumed.agentSession.isStreaming, true);
    assert.ok(resumed.tab.status === "running" || resumed.tab.status === "thinking");
    assert.ok(resumed.tab.workingStartedAt);
    assert.ok(events.includes("agent_start"));
  } finally {
    if (contextWaitTimer) clearTimeout(contextWaitTimer);
    const resumed = runtime?.listTabs()[0];
    releaseContext();
    resumed?.agentSession.agent.abort();
    stream.end({
      role: "assistant",
      content: [],
      api: "resume-running-test",
      provider: "resume-running-test",
      model: "resume-running-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      timestamp: Date.now(),
    } satisfies AssistantMessage);
    await resumed?.agentSession.waitForIdle();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Preserve: a fork/new replacement (no persisted name) must NOT be forced to a
 * resumed name; it keeps the caller-provided title. Guards against the resume
 * title-restore leaking into other reasons.
 */
test("fork does not overwrite tab title from an inherited session name", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-fork-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions") });
    const src = await runtime.createTab(createTab(1, "src", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtime.renameSession("src", "Named Source");
    src.tab.title = "Named Source";
    await runtime.prompt("src", "hello");
    const userId = src.session
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "user")?.id;
    assert.ok(userId);

    await runtime.extensionFork("src", userId);
    const forked = runtime.listTabs()[0]!;
    // Fork keeps the tab's existing title; it is not driven by resume restore.
    assert.equal(forked.tab.title, "Named Source");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Contract: replace reuses the tab's ResourceLoader after dispose. Without a
 * reload, extensionsResult.runtime stays invalidated and session_start sees
 * stale ctx (same failure mode as concurrent replace, but on the serial path
 * when services are shared across the shutdown→create boundary).
 */
test("serial replace reloads reused services so session_start is not stale", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-replace-reload-"));
  const starts: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      try {
        starts.push(`ok:${ctx.sessionManager.getSessionId()}`);
      } catch (error) {
        starts.push(`err:${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      extensionFactories: [extension],
    });
    const seed = await runtime.createTab(createTab(1, "seed", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtime.renameSession("seed", "Named Session");
    const seedFile = seed.session.getSessionFile()!;
    const servicesBefore = seed.services;

    starts.length = 0;
    await runtime.extensionSwitchSession("seed", seedFile);

    const resumed = runtime.listTabs()[0]!;
    assert.equal(resumed.services, servicesBefore, "replace should reuse tab services");
    assert.equal(resumed.tab.title, "Named Session");
    const staleStarts = starts.filter((s) => /stale after session replacement/.test(s));
    assert.equal(
      staleStarts.length,
      0,
      `session_start must not see stale ctx; starts=${JSON.stringify(starts)}`,
    );
    assert.ok(
      starts.some((s) => s.startsWith("ok:")),
      `expected successful session_start; starts=${JSON.stringify(starts)}`,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
