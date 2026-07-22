import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "../src/index.js";
import { __testReplaceHooks } from "../src/agent/runtime-lifecycle.js";

/**
 * Contract: concurrent replaceRuntimeTabSession on one tab must not bind a
 * disposed session. Without per-tab serialization, create→bind can race with a
 * second replace's dispose and session_start sees stale ctx
 * (pi-subagents: "Failed to start scheduler: ... stale after session replacement").
 *
 * Portable: inline extension reads ctx.sessionManager on session_start — same
 * assertActive boundary as pi-subagents startScheduler, no ~/.pi/agent required.
 */
test("concurrent replace on one tab does not stale session_start ctx", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-replace-lock-"));
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
  // Widen create→bind so a non-serialized second replace would win the race.
  __testReplaceHooks.bindDelayMs = 150;
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
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
    await new Promise((r) => setTimeout(r, 40));
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
    __testReplaceHooks.bindDelayMs = 0;
    await rm(dir, { recursive: true, force: true });
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
  const dir = await mkdtemp(join(tmpdir(), "mixcode-resume-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") });
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
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Preserve: a fork/new replacement (no persisted name) must NOT be forced to a
 * resumed name; it keeps the caller-provided title. Guards against the resume
 * title-restore leaking into other reasons.
 */
test("fork does not overwrite tab title from an inherited session name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-fork-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") });
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
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Contract: replace reuses the tab's ResourceLoader after dispose. Without a
 * reload, extensionsResult.runtime stays invalidated and session_start sees
 * stale ctx (same failure mode as concurrent replace, but on the serial path
 * when services are shared across the shutdown→create boundary).
 */
test("serial replace reloads reused services so session_start is not stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-replace-reload-"));
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
      sessionsRoot: join(dir, "sessions"),
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
    await rm(dir, { recursive: true, force: true });
  }
});
