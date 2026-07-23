import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import {
  appendHistoryEntry,
  backfillHistoryFromSessions,
  buildConversationHistoryPrompt,
  buildSessionIndex,
  conversationHistoryPaths,
  ensureConversationHistoryState,
  shouldRebuildSessionIndex,
} from "../src/index.js";

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
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
  await mkdir(sessionsRoot, { recursive: true });
  const path = join(sessionsRoot, `2026-06-20T00-00-00-000Z_${id}.jsonl`);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

test("conversation history paths live under the global state dir", () => {
  const paths = conversationHistoryPaths("/state");
  assert.equal(paths.settingsFile, "/state/mixcode_settings.json");
  assert.equal(paths.historyFile, "/state/history.jsonl");
  assert.equal(paths.sessionIndexFile, "/state/session_index.jsonl");
});

test("appendHistoryEntry writes strict Codex-compatible fields and trims oldest lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-append-"));
  const file = join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(file, { sessionId: "s1", text: "first", timestampSeconds: 10 }, { maxBytes: 95 });
    await appendHistoryEntry(file, { sessionId: "s1", text: "second", timestampSeconds: 11 }, { maxBytes: 95 });
    await appendHistoryEntry(file, { sessionId: "s2", text: "third", timestampSeconds: 12 }, { maxBytes: 95 });
    const records = await readJsonl(file);
    assert.deepEqual(records, [
      { session_id: "s1", ts: 11, text: "second" },
      { session_id: "s2", ts: 12, text: "third" },
    ]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry preserves raw submitted text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-raw-"));
  const file = join(dir, "history.jsonl");
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
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry serializes concurrent appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-concurrent-"));
  const file = join(dir, "history.jsonl");
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
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry reclaims a stale lock left by a crashed process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-stale-lock-"));
  const file = join(dir, "history.jsonl");
  const lockDir = `${file}.lock`;
  try {
    await mkdir(lockDir);
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockDir, staleAt, staleAt);

    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after crash", timestampSeconds: 10 },
      { maxBytes: 1024 },
    );

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "after crash" },
    ]);
    await assert.rejects(stat(lockDir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry waits for a live history lock instead of stealing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-live-lock-"));
  const file = join(dir, "history.jsonl");
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
    });
    let settled = false;
    const append = appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after release", timestampSeconds: 10 },
      { maxBytes: 1024 },
    ).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, "append must wait while the live lock is held");
    await release();
    release = undefined;
    await append;

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "after release" },
    ]);
  } finally {
    await release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry keeps retrying when a fresh crash lock becomes stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-fresh-crash-lock-"));
  const file = join(dir, "history.jsonl");
  const lockDir = `${file}.lock`;
  try {
    await mkdir(lockDir);
    let settled = false;
    const append = appendHistoryEntry(
      file,
      { sessionId: "s1", text: "recovered", timestampSeconds: 10 },
      { maxBytes: 1024 },
    ).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, "fresh crash lock must initially remain valid");
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockDir, staleAt, staleAt);
    await append;

    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 10, text: "recovered" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry skips invalid prompt-history entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-invalid-"));
  const file = join(dir, "history.jsonl");
  try {
    assert.equal(await appendHistoryEntry(file, { sessionId: "", text: "ignored", timestampSeconds: 10 }, { maxBytes: 1024 }), false);
    assert.equal(await appendHistoryEntry(file, { sessionId: "s1", text: "   ", timestampSeconds: 10 }, { maxBytes: 1024 }), false);
    await assert.rejects(readFile(file, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfillHistoryFromSessions imports recent user messages and deduplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-backfill-"));
  try {
    const sessionsRoot = join(dir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "recent prompt" }], timestamp: Date.UTC(2026, 5, 20) } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.UTC(2026, 5, 20) } },
      { type: "message", id: "u2", message: { role: "user", content: "old prompt", timestamp: Date.UTC(2026, 3, 1) } },
    ]);
    const historyFile = join(dir, "history.jsonl");
    await appendHistoryEntry(historyFile, { sessionId: "s1", text: "recent prompt", timestampSeconds: Date.UTC(2026, 5, 20) / 1000 }, { maxBytes: 1024 * 1024 });

    const result = await backfillHistoryFromSessions({
      historyFile,
      sessionsRoots: [sessionsRoot],
      since: new Date(Date.UTC(2026, 4, 21)),
      settings: { maxBytes: 1024 * 1024 },
    });

    assert.equal(result.imported, 0);
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "recent prompt" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfillHistoryFromSessions accepts entry timestamp strings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-string-ts-"));
  try {
    const sessionsRoot = join(dir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-06-20T01:02:03.000Z",
        message: { role: "user", content: "string timestamp prompt" },
      },
    ]);
    const historyFile = join(dir, "history.jsonl");
    const result = await backfillHistoryFromSessions({
      historyFile,
      sessionsRoots: [sessionsRoot],
      since: new Date(Date.UTC(2026, 4, 21)),
      settings: { maxBytes: 1024 * 1024 },
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(await readJsonl(historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20, 1, 2, 3) / 1000, text: "string timestamp prompt" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildSessionIndex writes snapshot records with session name fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-index-"));
  try {
    const sessionsRoot = join(dir, "sessions");
    const namedPath = await writeSessionFixture(sessionsRoot, "named", [
      { type: "session", id: "named", cwd: "/repo", timestamp: "2026-06-19T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "first user prompt", timestamp: Date.UTC(2026, 5, 19) } },
      { type: "session_info", id: "n1", name: "Named Thread", timestamp: "2026-06-19T00:00:00.000Z" },
    ]);
    const unnamedPath = await writeSessionFixture(sessionsRoot, "unnamed", [
      { type: "session", id: "unnamed", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "fallback title that is reasonably long", timestamp: Date.UTC(2026, 5, 20) } },
    ]);

    const indexFile = join(dir, "session_index.jsonl");
    const result = await buildSessionIndex({ indexFile, sessionsRoots: [sessionsRoot] });
    assert.equal(result.indexed, 2);
    const records = await readJsonl(indexFile);
    assert.equal(records.length, 2);
    assert.ok(records.some((record) => record.id === "named" && record.title === "Named Thread" && record.path === namedPath && record.cwd === "/repo"));
    assert.ok(records.some((record) => record.id === "unnamed" && record.title === "fallback title that is reasonably long" && record.path === unnamedPath && record.cwd === "/repo"));
    assert.equal(records[0]?.id, "unnamed");
    assert.equal("thread_name" in records[0]!, false);
    assert.equal((await stat(indexFile)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shouldRebuildSessionIndex compares sessions mtime with index mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-stale-"));
  try {
    const sessionsRoot = join(dir, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const sessionFile = join(sessionsRoot, "s.jsonl");
    const indexFile = join(dir, "session_index.jsonl");
    await writeFile(sessionFile, "{}\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(indexFile, "{}\n", "utf8");
    assert.equal(await shouldRebuildSessionIndex(indexFile, [sessionsRoot]), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(sessionFile, "{}\n{}\n", "utf8");
    assert.equal(await shouldRebuildSessionIndex(indexFile, [sessionsRoot]), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureConversationHistoryState backfills history and builds stale index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-ensure-"));
  try {
    const scoped = join(dir, "workdirs", "repo", "sessions");
    await writeSessionFixture(scoped, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      { type: "message", id: "u1", message: { role: "user", content: "hello history", timestamp: Date.UTC(2026, 5, 20) } },
    ]);
    const result = await ensureConversationHistoryState({
      rootStateDir: dir,
      activeSessionsRoot: scoped,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(await readJsonl(join(dir, "history.jsonl")), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "hello history" },
    ]);
    assert.equal((await readJsonl(join(dir, "session_index.jsonl"))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
