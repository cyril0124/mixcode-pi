import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { listSessionsForCwd } from "../src/agent/runtime-session.js";
import {
  appendHistoryEntry,
  buildConversationHistoryPrompt,
  conversationHistoryPaths,
  ensureConversationHistoryState,
  HISTORY_LOCK_ID,
} from "./helpers/mixcode.js";
import { acquireSessionTurnLock } from "../src/core/session-lock.js";

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await fsPromises.readFile(path, "utf8");
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeSessionFixture(
  sessionsRoot: string,
  id: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  await fsPromises.mkdir(sessionsRoot, { recursive: true });
  const path = nodePath.join(sessionsRoot, `2026-06-20T00-00-00-000Z_${id}.jsonl`);
  await fsPromises.writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

test("conversation history paths live under the global state dir", () => {
  const paths = conversationHistoryPaths("/state");
  assert.equal(paths.settingsFile, "/state/mixcode_settings.json");
  assert.equal(paths.historyFile, "/state/history.jsonl");
  assert.equal(paths.sessionIndexFile, "/state/session_index.jsonl");
});

test("appendHistoryEntry writes strict Codex-compatible fields and trims oldest lines", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-append-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(file, { sessionId: "s1", text: "first", timestampSeconds: 10 }, { maxBytes: 95 });
    await appendHistoryEntry(file, { sessionId: "s1", text: "second", timestampSeconds: 11 }, { maxBytes: 95 });
    await appendHistoryEntry(file, { sessionId: "s2", text: "third", timestampSeconds: 12 }, { maxBytes: 95 });
    const records = await readJsonl(file);
    assert.deepEqual(records, [
      { session_id: "s1", ts: 11, text: "second" },
      { session_id: "s2", ts: 12, text: "third" },
    ]);
    assert.equal((await fsPromises.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry preserves raw submitted text", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-raw-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "!! echo hi  ", timestampSeconds: 10 },
      { maxBytes: 1024 },
    );
    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "!! echo hi  " },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry serializes concurrent appends", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-concurrent-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendHistoryEntry(
          file,
          { sessionId: "s1", text: `prompt-${index}`, timestampSeconds: index },
          { maxBytes: 1024 * 1024 },
        ),
      ),
    );
    const records = await readJsonl(file);
    records.sort((left, right) => Number(left.ts) - Number(right.ts));
    assert.deepEqual(
      records,
      Array.from({ length: 12 }, (_, index) => ({
        session_id: "s1",
        ts: index,
        text: `prompt-${index}`,
      })),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry reclaims a stale lock left by a crashed process", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-stale-lock-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    // Simulate a crashed holder: lock file owned by a dead PID, never released.
    acquireSessionTurnLock(dir, HISTORY_LOCK_ID, {
      pid: 999_999_999,
      processInfo: () => ({ alive: true }),
    });

    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after crash", timestampSeconds: 10 },
      { maxBytes: 1024 },
    );

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "after crash" },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry waits for a live history lock instead of stealing it", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-live-lock-"));
  const file = nodePath.join(dir, "history.jsonl");
  let held: ReturnType<typeof acquireSessionTurnLock> | undefined;
  try {
    held = acquireSessionTurnLock(dir, HISTORY_LOCK_ID);
    let settled = false;
    const append = appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after release", timestampSeconds: 10 },
      { maxBytes: 1024 },
    ).then(() => {
      settled = true;
    });

    await Bun.sleep(60);
    assert.equal(settled, false, "append must wait while the live lock is held");
    held.release();
    held = undefined;
    await append;

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "after release" },
    ]);
  } finally {
    held?.release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry reclaims a dead-PID lock without waiting for mtime stale", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-dead-pid-lock-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    acquireSessionTurnLock(dir, HISTORY_LOCK_ID, {
      pid: 999_999_998,
      processInfo: () => ({ alive: true }),
    });

    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "recovered", timestampSeconds: 10 },
      { maxBytes: 1024 },
    );

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "recovered" },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry skips invalid prompt-history entries", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-invalid-"));
  const file = nodePath.join(dir, "history.jsonl");
  try {
    assert.equal(await appendHistoryEntry(file, { sessionId: "", text: "ignored", timestampSeconds: 10 }, { maxBytes: 1024 }), false);
    assert.equal(await appendHistoryEntry(file, { sessionId: "s1", text: "   ", timestampSeconds: 10 }, { maxBytes: 1024 }), false);
    await assert.rejects(fsPromises.readFile(file, "utf8"), /ENOENT/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ensureConversationHistoryState deduplicates existing history entries", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-backfill-"));
  try {
    const sessionsRoot = nodePath.join(dir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "recent prompt" }], timestamp: Date.UTC(2026, 5, 20) } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.UTC(2026, 5, 20) } },
      { type: "message", id: "u2", message: { role: "user", content: "old prompt", timestamp: Date.UTC(2026, 3, 1) } },
    ]);
    const historyFile = nodePath.join(dir, "history.jsonl");
    await appendHistoryEntry(historyFile, { sessionId: "s1", text: "recent prompt", timestampSeconds: Date.UTC(2026, 5, 20) / 1000 }, { maxBytes: 1024 * 1024 });

    const result = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });

    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "recent prompt" },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ensureConversationHistoryState accepts entry timestamp strings", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-string-ts-"));
  try {
    const sessionsRoot = nodePath.join(dir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-06-20T01:02:03.000Z",
        message: { role: "user", content: "string timestamp prompt" },
      },
    ]);
    const result = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(nodePath.join(dir, "history.jsonl")), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20, 1, 2, 3) / 1000, text: "string timestamp prompt" },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ensureConversationHistoryState writes snapshot records with session name fallback", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-session-index-"));
  try {
    const sessionsRoot = nodePath.join(dir, "sessions");
    const namedPath = await writeSessionFixture(sessionsRoot, "named", [
      { type: "session", id: "named", cwd: "/repo", timestamp: "2026-06-19T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "first user prompt", timestamp: Date.UTC(2026, 5, 19) } },
      { type: "session_info", id: "n1", name: "Named Thread", timestamp: "2026-06-19T00:00:00.000Z" },
    ]);
    const unnamedPath = await writeSessionFixture(sessionsRoot, "unnamed", [
      { type: "session", id: "unnamed", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "fallback title that is reasonably long", timestamp: Date.UTC(2026, 5, 20) } },
    ]);

    const result = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.scannedSessions, 2);
    const indexFile = nodePath.join(dir, "session_index.jsonl");
    const records = await readJsonl(indexFile);
    assert.equal(records.length, 2);
    assert.ok(records.some((record) => record.id === "named" && record.title === "Named Thread" && record.path === namedPath && record.cwd === "/repo"));
    assert.ok(records.some((record) => record.id === "unnamed" && record.title === "fallback title that is reasonably long" && record.path === unnamedPath && record.cwd === "/repo"));
    assert.equal(records[0]?.id, "unnamed");
    assert.equal("thread_name" in records[0]!, false);
    assert.equal((await fsPromises.stat(indexFile)).mode & 0o777, 0o600);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ensureConversationHistoryState backfills history and builds stale index", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mixcode-history-ensure-"));
  try {
    const scoped = nodePath.join(dir, "workdirs", "repo", "sessions");
    const sessionPath = await writeSessionFixture(scoped, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "hello history", timestamp: Date.UTC(2026, 5, 20) } },
    ]);
    const result = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: scoped,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(nodePath.join(dir, "history.jsonl")), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "hello history" },
    ]);
    assert.equal((await readJsonl(nodePath.join(dir, "session_index.jsonl"))).length, 1);

    const catalogStartedAt = performance.now();
    const catalogSessions = await listSessionsForCwd("/repo", scoped);
    assert.ok(
      performance.now() - catalogStartedAt < 250,
      "history initialization must seed the resume catalog",
    );
    assert.equal(catalogSessions[0]?.allMessagesText, "hello history");

    const unchanged = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: scoped,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(unchanged.scannedSessions, 0);

    await Bun.sleep(20);
    await fsPromises.appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "u2",
        message: {
          role: "user",
          content: "new external prompt",
          timestamp: Date.UTC(2026, 5, 21),
        },
      })}\n`,
      "utf8",
    );
    const changed = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: scoped,
      now: () => new Date(Date.UTC(2026, 5, 21)),
    });
    assert.equal(changed.scannedSessions, 1);
    assert.deepEqual(await readJsonl(nodePath.join(dir, "history.jsonl")), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "hello history" },
      { session_id: "s1", ts: Date.UTC(2026, 5, 21) / 1000, text: "new external prompt" },
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("buildConversationHistoryPrompt exposes paths without injecting content", () => {
  const text = buildConversationHistoryPrompt({
    historyFile: "/state/history.jsonl",
    sessionIndexFile: "/state/session_index.jsonl",
  });
  assert.match(text, /Local conversation history:/);
  assert.match(text, /prompt recall log, not a full transcript/);
  assert.match(text, /\/state\/history\.jsonl/);
  assert.match(text, /\/state\/session_index\.jsonl/);
  assert.match(text, /each record has a `path` to the full session transcript/);
  assert.match(text, /explicitly asks/);
  assert.match(text, /untrusted background/);
  assert.doesNotMatch(text, /stores full session transcripts under/);
  assert.doesNotMatch(text, /workdirs/);
  assert.doesNotMatch(text, /recent prompt|hello history/);
});
