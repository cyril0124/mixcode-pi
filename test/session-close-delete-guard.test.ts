import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MixCodeRuntime, createTab } from "../src/index.js";

// Mirrors compact-regression.test.ts's technique: create a real runtime tab,
// flip the private streaming flag directly (no need to actually pump a live
// stream), then assert the guarded method rejects. Covers the new
// isStreaming/isCompacting guard added to closeTab/deleteTab so a stray click
// on the tab-bar [ - ]/[ x ] buttons (or /close-session, /delete-session
// themselves) can never yank a session out from under an in-flight turn.
test("runtime rejects closing a session while the agent is streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-close-streaming-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const mutableAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
    mutableAgent._state.isStreaming = true;
    try {
      await assert.rejects(
        () => runtime.closeTab("s1"),
        /Cannot close a session while the agent is streaming/,
      );
    } finally {
      mutableAgent._state.isStreaming = false;
    }
    // The tab must still be there: the guard must fire before any teardown.
    assert.ok(runtime.getTab("s1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects deleting a session while the agent is streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-delete-streaming-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const sessionFile = runtimeTab.session.getSessionFile();
    assert.ok(sessionFile, "expected a session file on disk");
    // Persist at least one turn so the session file actually exists on disk
    // before the guard is exercised (a freshly created tab hasn't written its
    // .jsonl yet, which would make the "file still there" assertion below pass
    // for the wrong reason).
    await runtime.prompt("s1", "hello");
    const mutableAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
    mutableAgent._state.isStreaming = true;
    try {
      await assert.rejects(
        () => runtime.deleteTab("s1"),
        /Cannot delete a session while the agent is streaming/,
      );
    } finally {
      mutableAgent._state.isStreaming = false;
    }
    // Guard must fire before the session file is removed.
    await assert.doesNotReject(() => access(sessionFile!));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
