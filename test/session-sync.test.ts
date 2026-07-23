import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  SessionLockConflictError,
  acquireSessionTurnLock,
  createTab,
} from "../src/index.js";

// A run that stays open with no visible output until `release` resolves, so a
// mid-flight turn can be retracted (double-Esc undo) before it produces text.
function pendingStream(release: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message = {
      role: "assistant" as const,
      content: [],
      api: "retract-test",
      provider: "retract-test",
      model: "retract-test-model",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const aborted = { ...message, stopReason: "aborted" as const, errorMessage: "aborted" };
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    options?.signal?.addEventListener?.(
      "abort",
      () => {
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      },
      { once: true },
    );
    await release;
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

// A custom-provider model so the injected streamFn is used (provider "faux"
// routes to the built-in echo stream and would bypass pendingStream).
function retractModel() {
  return { ...MIXCODE_FAUX_MODEL, provider: "retract-test", api: "retract-test", id: "retract-test-model" };
}

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

// Count only conversation (user/assistant/toolResult) entries on the branch.
// A fresh session carries initial metadata entries (model_change,
// thinking_level_change) that are NOT wiped by a first-prompt reload, so a
// retract leaves those in place while removing the conversation turn. Asserting
// on conversation entries captures the real "turn was retracted" invariant
// without depending on those metadata rows.
function conversationEntryCount(runtime: MixCodeRuntime, sessionId: string): number {
  const branch = runtime.getTab(sessionId)?.session.getBranch() ?? [];
  return branch.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" ||
        entry.message.role === "assistant" ||
        entry.message.role === "toolResult"),
  ).length;
}

test("sync on a fresh session preserves the session id exposed to extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-fresh-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") });
  try {
    const rt = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });

    // createTab materializes the session header so peer instances can discover
    // the file before the first assistant reply. A disk reload must not mint a
    // new session id (that would orphan per-session extension state).
    const sessionId = rt.session.getSessionId();
    assert.ok(rt.session.getSessionFile());
    runtime.syncSessionFromDisk("s1");
    assert.equal(rt.session.getSessionId(), sessionId);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("reload status survives the local session writes performed by reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-reload-status-"));
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
    await runtime.prompt("s1", "create persisted conversation");
    await waitFor(() => runtime.getTab("s1")?.agentSession.isStreaming === false);

    // Matches the /reload command order: rebuild Pi resources, reconcile the
    // active model (both persist metadata), then append the transient status.
    await runtime.extensionReload("s1");
    await runtime.updateTabModel("s1", MIXCODE_FAUX_MODEL);
    runtime.appendSystemMessage("s1", "Reloaded keybindings, extensions, skills, prompts, and themes");

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.match(chatText(runtime, "s1"), /Reloaded keybindings/);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new prompt keeps the previous turn's extension info notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-extension-info-"));
  const sessionsRoot = join(dir, "sessions");
  let turn = 0;
  const extension: ExtensionFactory = (pi) => {
    pi.on("turn_end", (_event, ctx) => {
      turn += 1;
      pi.appendEntry("telemetry", { turn });
      ctx.ui.notify(`TPS turn ${turn}`, "info");
    });
  };
  const runtime = new MixCodeRuntime({ sessionsRoot, extensionFactories: [extension] });
  try {
    await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    runtime.enableSessionSync();

    await runtime.prompt("s1", "first");
    await waitFor(() => runtime.getTab("s1")?.agentSession.isStreaming === false);
    assert.match(chatText(runtime, "s1"), /TPS turn 1/);

    await runtime.prompt("s1", "second");
    await waitFor(() => runtime.getTab("s1")?.agentSession.isStreaming === false);
    assert.match(chatText(runtime, "s1"), /TPS turn 1/);
    assert.match(chatText(runtime, "s1"), /TPS turn 2/);
  } finally {
    await runtime.closeAllTabs();
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

// Large synthetic JSONL: reload materializes every conversation message into chat.
test("large-session reload materializes every conversation entry into chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-perf-"));
  const sessionsRoot = join(dir, "sessions");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(sessionsRoot, { recursive: true });

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
    assert.equal(runtime.syncSessionFromDisk(sessionId), true);
    const chat = runtime.getTab(sessionId)?.chat ?? [];
    assert.equal(chat.filter((l) => l.role === "user" || l.role === "assistant").length, ENTRY_COUNT);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: a reload after a local retract must NOT resurrect the retracted
// message. The retract rewinds the in-memory leaf, but the append-only file
// still holds the entry; reload must preserve the rewound leaf when the file
// gained no genuinely new entries.
test("reload after retract does not resurrect the retracted message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-retract-reload-"));
  const sessionsRoot = join(dir, "sessions");
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const runtime = new MixCodeRuntime({
    sessionsRoot,
    streamFn: (_m, _c, o) => pendingStream(released, o),
  });
  try {
    const rt = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: retractModel(),
    });
    runtime.enableSessionSync();
    const pending = runtime.prompt("s1", "MSG-A-retract-me");
    await waitFor(() => rt.agentSession.isStreaming === true);
    const res = await runtime.retractCurrentTurn("s1");
    release();
    await pending.catch(() => undefined);
    await waitFor(() => conversationEntryCount(runtime, "s1") === 0);
    assert.equal(res?.editorText, "MSG-A-retract-me");
    assert.equal(chatText(runtime, "s1").includes("MSG-A"), false);

    // A direct reload (what prompt()'s pre-send path and the watcher do) must
    // not bring MSG-A back.
    runtime.syncSessionFromDisk("s1");
    assert.equal(chatText(runtime, "s1").includes("MSG-A"), false);
    assert.equal(conversationEntryCount(runtime, "s1"), 0);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: while a turn is streaming (its turn lock held by THIS process), a
// queued-message flush (the Esc path) must not self-conflict on the lock. The
// lock is reentrant within one process; only other instances are blocked.
test("queued-message flush during a streaming turn does not self-conflict on the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-flush-lock-"));
  const sessionsRoot = join(dir, "sessions");
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const runtime = new MixCodeRuntime({
    sessionsRoot,
    streamFn: (_m, _c, o) => pendingStream(released, o),
  });
  try {
    const rt = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: retractModel(),
    });
    runtime.enableSessionSync();
    // MSG-1 starts streaming and holds the turn lock.
    const p1 = runtime.prompt("s1", "MSG-1");
    await waitFor(() => rt.agentSession.isStreaming === true);
    // MSG-2 is queued while streaming.
    await runtime.prompt("s1", "MSG-2-queued");
    assert.equal(rt.tab.pendingMessages.includes("MSG-2-queued"), true);
    // Esc path: abort the active turn, then flush the queued message. This must
    // not throw SessionLockConflictError even though MSG-1's turn still holds
    // the lock as it unwinds.
    runtime.abortTab("s1");
    const flush = runtime.flushPendingMessage("s1");
    release();
    await p1.catch(() => undefined);
    await flush; // must resolve, not reject with a lock conflict
    await waitFor(() => rt.agentSession.isStreaming === false);
    assert.equal(chatText(runtime, "s1").includes("MSG-2-queued"), true);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: after retracting MSG-A and sending a NEW message MSG-B, only MSG-B
// remains — prompt()'s pre-send reload must not resurrect MSG-A. This is the
// exact user-reported "extra message after double-Esc undo" flow.
test("sending a new message after retract keeps only the new message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-retract-newmsg-"));
  const sessionsRoot = join(dir, "sessions");
  let release!: () => void;
  let released = new Promise<void>((r) => { release = r; });
  const runtime = new MixCodeRuntime({
    sessionsRoot,
    streamFn: (_m, _c, o) => pendingStream(released, o),
  });
  try {
    const rt = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: retractModel(),
    });
    runtime.enableSessionSync();
    // Turn 1: send MSG-A, then retract it mid-flight.
    const p1 = runtime.prompt("s1", "MSG-A-retract-me");
    await waitFor(() => rt.agentSession.isStreaming === true);
    await runtime.retractCurrentTurn("s1");
    release();
    await p1.catch(() => undefined);
    await waitFor(() => conversationEntryCount(runtime, "s1") === 0);
    assert.equal(chatText(runtime, "s1").includes("MSG-A"), false);

    // Turn 2: send a fresh message; let it complete immediately.
    released = new Promise<void>((r) => { release = r; });
    release();
    await runtime.prompt("s1", "MSG-B-new");
    await waitFor(() => rt.agentSession.isStreaming === false);
    assert.equal(chatText(runtime, "s1").includes("MSG-B"), true);
    assert.equal(chatText(runtime, "s1").includes("MSG-A"), false);
  } finally {
    await runtime.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

// compactSession must reload after taking the turn lock, same as prompt().
// Without that, B can compact a stale leaf and orphan A's newer turn as a
// sibling of the compaction entry (multi-instance history loss).
test("compactSession reloads remote turns before rewriting the branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-sync-compact-"));
  const sessionsRoot = join(dir, "sessions");
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  const MARKER = "UNIQUE_MARKER_FROM_A_BEFORE_COMPACT";
  try {
    const tabA = await runtimeA.createTab(createTab(1, "s-shared", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    runtimeA.enableSessionSync();

    await runtimeA.prompt("s-shared", "seed turn 1");
    await waitFor(() => runtimeA.getTab("s-shared")?.agentSession.isStreaming === false);
    await runtimeA.prompt("s-shared", "seed turn 2");
    await waitFor(() => runtimeA.getTab("s-shared")?.agentSession.isStreaming === false);
    assert.ok(tabA.session.getSessionFile(), "A must persist a session file");

    // B opens the shared file (sees seed turns only).
    const tabB = await runtimeB.createTab(createTab(1, "s-shared", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    runtimeB.enableSessionSync();

    // A appends a turn B has not reloaded.
    await runtimeA.prompt("s-shared", MARKER);
    await waitFor(() => runtimeA.getTab("s-shared")?.agentSession.isStreaming === false);
    assert.equal(
      tabB.session.getBranch().some((e) => {
        if (e.type !== "message" || e.message?.role !== "user") return false;
        const content = e.message.content;
        const text = Array.isArray(content)
          ? content.map((c) => ("text" in c ? c.text : "")).join("")
          : String(content ?? "");
        return text.includes(MARKER);
      }),
      false,
      "B must still be stale before compact",
    );

    // Force compact to run under SDK 0.80+ keep-recent refusal rules.
    tabB.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    await runtimeB.compactSession("s-shared", "sync compact");

    // Re-read from disk: MARKER's assistant must be an ancestor of the
    // compaction leaf, not a sibling orphaned by a stale compact.
    runtimeA.syncSessionFromDisk("s-shared");
    const entries = tabA.session.getEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const compaction = [...entries].reverse().find((e) => e.type === "compaction");
    assert.ok(compaction, "compact must write a compaction entry");

    const markerAssistant = entries.find((e) => {
      if (e.type !== "message" || e.message?.role !== "assistant") return false;
      // Faux model echoes the user text; walk back to the user parent.
      const parent = e.parentId ? byId.get(e.parentId) : undefined;
      if (parent?.type !== "message" || parent.message?.role !== "user") return false;
      const content = parent.message.content;
      const text = Array.isArray(content)
        ? content.map((c) => ("text" in c ? c.text : "")).join("")
        : String(content ?? "");
      return text.includes(MARKER);
    });
    assert.ok(markerAssistant, "MARKER assistant must exist in the file tree");

    const ancestors = new Set<string>();
    let cur: (typeof entries)[number] | undefined = compaction;
    while (cur) {
      ancestors.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    assert.equal(
      ancestors.has(markerAssistant.id),
      true,
      "MARKER assistant must be on the compaction leaf path (not a sibling orphan)",
    );
  } finally {
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});
