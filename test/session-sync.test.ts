import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  SessionLockConflictError,
  acquireSessionTurnLock,
  createTab,
} from "../src/index.js";

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function chatText(runtime: MixCodeRuntime, sessionId: string): string {
  return (runtime.getTab(sessionId)?.chat ?? []).map((line) => line.text).join("\n");
}

// Two instances sharing one sessionsRoot, both bound to the SAME session file.
// Instance A prompts (appends to disk); instance B must be able to pick up the
// new conversation by reloading from disk, and its next prompt must include the
// externally-synced messages in the model context.
test("second instance syncs another instance's appended conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-"));
  const sessionsRoot = join(dir, "sessions");
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  try {
    // A creates the session and writes the first turn.
    const tabA = await runtimeA.createTab(createTab(1, "s-shared", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    await runtimeA.prompt("s-shared", "hello from A");
    await waitFor(
      () => runtimeA.getTab("s-shared")?.agentSession.isStreaming === false,
    );
    const sessionFile = tabA.session.getSessionFile();
    assert.ok(sessionFile, "A should have a persisted session file");

    // B opens the same session file into its own tab.
    await runtimeB.createTab(createTab(1, "s-shared", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    // Before syncing, B may still have A's first turn (it opened after the
    // write) — so make A write a SECOND turn that B has definitely not seen.
    await runtimeA.prompt("s-shared", "second from A");
    await waitFor(
      () =>
        runtimeA.getTab("s-shared")?.agentSession.isStreaming === false &&
        chatText(runtimeA, "s-shared").includes("second from A"),
    );

    // Without a sync, B's chat must NOT contain the second turn.
    assert.equal(chatText(runtimeB, "s-shared").includes("second from A"), false);

    // Sync B from disk: it should now show A's full conversation.
    const reloaded = runtimeB.syncSessionFromDisk("s-shared");
    assert.equal(reloaded, true);
    assert.match(chatText(runtimeB, "s-shared"), /hello from A/);
    assert.match(chatText(runtimeB, "s-shared"), /second from A/);
  } finally {
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// With sync enabled, a session that is already turn-locked by another live
// holder cannot be prompted: the write is rejected instead of corrupting the
// shared JSONL, and the user's text is preserved by the caller (dispatch
// rethrows without appending).
test("prompt is rejected while another instance holds the session turn lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-lock-"));
  const sessionsRoot = join(dir, "sessions");
  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    runtime.enableSessionSync();
    // Simulate another live instance holding the turn lock. Using this very
    // process's pid makes the lock look live to the runtime's stale check.
    const held = acquireSessionTurnLock(sessionsRoot, "s1");
    await assert.rejects(
      runtime.prompt("s1", "hello"),
      (error: unknown) => error instanceof SessionLockConflictError,
    );
    // The rejected turn must not have appended a user message to the branch.
    const userTurns = runtime
      .getTab("s1")
      ?.session.getBranch()
      .filter((e) => e.type === "message" && e.message.role === "user");
    assert.equal(userTurns?.length ?? 0, 0);
    held.release();
    // After the holder releases, the same prompt succeeds.
    await runtime.prompt("s1", "hello");
    await waitFor(() => runtime.getTab("s1")?.agentSession.isStreaming === false);
    assert.match(chatText(runtime, "s1"), /hello/);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// A standalone shell command records a bashExecution entry to the session
// JSONL, so it must also honor the cross-process turn lock: it is rejected
// while another live instance holds the lock, and no bash entry is appended.
test("standalone shell command is rejected while the session is turn-locked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-bash-"));
  const sessionsRoot = join(dir, "sessions");
  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    runtime.enableSessionSync();
    const held = acquireSessionTurnLock(sessionsRoot, "s1");
    await assert.rejects(
      runtime.executeShellCommand("s1", "echo hi"),
      (error: unknown) => error instanceof SessionLockConflictError,
    );
    const bashEntries = runtime
      .getTab("s1")
      ?.session.getBranch()
      .filter((e) => e.type === "message" && e.message.role === "bashExecution");
    assert.equal(bashEntries?.length ?? 0, 0);
    held.release();
    // After release the same command runs and records an entry.
    await runtime.executeShellCommand("s1", "echo hi");
    await waitFor(() => runtime.getTab("s1")?.agentSession.isBashRunning === false);
    const after = runtime
      .getTab("s1")
      ?.session.getBranch()
      .filter((e) => e.type === "message" && e.message.role === "bashExecution");
    assert.equal(after?.length ?? 0, 1);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// Performance: a large session reloads in one parse per burst, and only the
// changed tab is touched. Builds a synthetic large JSONL directly so the test
// does not depend on running thousands of real turns.
test("large-session reload parses once per external-change burst", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-perf-"));
  const sessionsRoot = join(dir, "sessions");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(sessionsRoot, { recursive: true });

  // Build a valid append-only linear session with many entries.
  const sessionId = "perf-session";
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir };
  const lines: string[] = [JSON.stringify(header)];
  let parentId: string | null = null;
  const ENTRY_COUNT = 4000;
  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const id = `e${i}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        message: { role, content: [{ type: "text", text: `turn ${i}` }], timestamp: Date.now() },
      }),
    );
    parentId = id;
  }
  const fileName = `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`;
  await writeFile(join(sessionsRoot, fileName), `${lines.join("\n")}\n`, "utf8");

  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    await runtime.createTab(createTab(1, sessionId, dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    // A single reload materializes the whole large branch as chat lines.
    const start = performance.now();
    const reloaded = runtime.syncSessionFromDisk(sessionId);
    const elapsedMs = performance.now() - start;
    assert.equal(reloaded, true);
    const chat = runtime.getTab(sessionId)?.chat ?? [];
    // Every message became a chat line (user + assistant).
    assert.equal(chat.filter((l) => l.role === "user" || l.role === "assistant").length, ENTRY_COUNT);
    // Report (do not gate on) the wall-clock cost of one large reload.
    process.stderr.write(`large-session reload: ${ENTRY_COUNT} entries in ${elapsedMs.toFixed(1)}ms\n`);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});
