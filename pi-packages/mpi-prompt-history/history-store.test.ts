import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { test } from "node:test";
import {
  appendHistoryEntry,
  buildPromptHistoryPrompt,
  CONFIG_FILENAME,
  DEFAULT_HISTORY_MAX_BYTES,
  ensurePromptHistoryState,
  HISTORY_LOCK_ID,
  loadGlobalPromptItems,
  promptHistoryPaths,
  readHistoryMaxBytes,
} from "./history-store.js";
import { acquirePidLock } from "./pid-lock.js";

const MB = 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await fsPromises.readFile(path, "utf8");
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function tempDir(label: string): Promise<string> {
  return fsPromises.mkdtemp(nodePath.join(os.tmpdir(), `mpi-prompt-history-${label}-`));
}

async function writeSessionFixture(
  sessionsRoot: string,
  id: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  await fsPromises.mkdir(sessionsRoot, { recursive: true });
  const path = nodePath.join(sessionsRoot, `2026-06-20T00-00-00-000Z_${id}.jsonl`);
  await fsPromises.writeFile(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return path;
}

test("prompt history files and config are both package-owned", () => {
  const paths = promptHistoryPaths("/agent");
  assert.equal(paths.dataDir, "/agent/mpi-prompt-history");
  assert.equal(paths.historyFile, "/agent/mpi-prompt-history/history.jsonl");
  assert.equal(paths.sessionIndexFile, "/agent/mpi-prompt-history/session_index.jsonl");
  assert.equal(paths.configFile, "/agent/mpi-prompt-history.json");
});

test("maxBytes defaults to 15MB when the config file or key is absent", async () => {
  const dir = await tempDir("config-default");
  try {
    const file = nodePath.join(dir, CONFIG_FILENAME);
    assert.equal(DEFAULT_HISTORY_MAX_BYTES, 15 * MB);
    assert.equal(await readHistoryMaxBytes(file), 15 * MB);

    await fsPromises.writeFile(file, JSON.stringify({ $schema: "./x.json" }), "utf8");
    assert.equal(await readHistoryMaxBytes(file), 15 * MB);

    await fsPromises.writeFile(file, JSON.stringify({ maxBytes: 4096 }), "utf8");
    assert.equal(await readHistoryMaxBytes(file), 4096);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("a malformed config fails loud instead of falling back to the default", async () => {
  const dir = await tempDir("config-invalid");
  try {
    const file = nodePath.join(dir, CONFIG_FILENAME);
    const write = (body: string) => fsPromises.writeFile(file, body, "utf8");

    await write("{ not json");
    await assert.rejects(readHistoryMaxBytes(file), /Invalid JSON/);

    await write(JSON.stringify([1, 2]));
    await assert.rejects(readHistoryMaxBytes(file), /config root must be an object/);

    await write(JSON.stringify({ maxbytes: 4096 }));
    await assert.rejects(readHistoryMaxBytes(file), /unknown key "maxbytes"/);

    await write(JSON.stringify({ maxBytes: 0 }));
    await assert.rejects(readHistoryMaxBytes(file), /Invalid maxBytes/);

    await write(JSON.stringify({ maxBytes: "big" }));
    await assert.rejects(readHistoryMaxBytes(file), /Invalid maxBytes/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry writes strict Codex-compatible fields and trims oldest lines", async () => {
  const dir = await tempDir("append");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(file, { sessionId: "s1", text: "first", timestampSeconds: 10 }, 95);
    await appendHistoryEntry(file, { sessionId: "s1", text: "second", timestampSeconds: 11 }, 95);
    await appendHistoryEntry(file, { sessionId: "s2", text: "third", timestampSeconds: 12 }, 95);
    assert.deepEqual(await readJsonl(file), [
      { session_id: "s1", ts: 11, text: "second" },
      { session_id: "s2", ts: 12, text: "third" },
    ]);
    assert.equal((await fsPromises.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry preserves raw submitted text", async () => {
  const dir = await tempDir("raw");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "!! echo hi  ", timestampSeconds: 10 },
      1024,
    );
    assert.deepEqual(await readJsonl(file), [{ session_id: "s1", ts: 10, text: "!! echo hi  " }]);
    // Under budget the append path creates the file itself, so it owns the mode.
    assert.equal((await fsPromises.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry restores 0600 on a file whose mode was loosened", async () => {
  const dir = await tempDir("perm");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(file, { sessionId: "s1", text: "first", timestampSeconds: 10 }, MB);
    await fsPromises.chmod(file, 0o644);

    await appendHistoryEntry(file, { sessionId: "s1", text: "second", timestampSeconds: 11 }, MB);

    assert.equal((await fsPromises.stat(file)).mode & 0o777, 0o600);
    assert.equal((await readJsonl(file)).length, 2);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry skips entries with no session id or no text", async () => {
  const dir = await tempDir("invalid");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    assert.equal(
      await appendHistoryEntry(
        file,
        { sessionId: "", text: "ignored", timestampSeconds: 10 },
        1024,
      ),
      false,
    );
    assert.equal(
      await appendHistoryEntry(file, { sessionId: "s1", text: "   ", timestampSeconds: 10 }, 1024),
      false,
    );
    await assert.rejects(fsPromises.readFile(file, "utf8"), /ENOENT/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry serializes concurrent appends", async () => {
  const dir = await tempDir("concurrent");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendHistoryEntry(
          file,
          { sessionId: "s1", text: `prompt-${index}`, timestampSeconds: index },
          MB,
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

test("appendHistoryEntry reclaims a lock left by a dead process", async () => {
  const dir = await tempDir("stale-lock");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    // Simulate a crashed holder: lock published for a PID that is not running.
    acquirePidLock(dir, HISTORY_LOCK_ID, { pid: 999_999_999, processAlive: () => true });

    await appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after crash", timestampSeconds: 10 },
      1024,
    );

    assert.deepEqual(await readJsonl(file), [{ session_id: "s1", ts: 10, text: "after crash" }]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("appendHistoryEntry waits for a live lock instead of stealing it", async () => {
  const dir = await tempDir("live-lock");
  const file = nodePath.join(dir, "history.jsonl");
  let held: ReturnType<typeof acquirePidLock> | undefined;
  try {
    held = acquirePidLock(dir, HISTORY_LOCK_ID);
    let settled = false;
    const append = appendHistoryEntry(
      file,
      { sessionId: "s1", text: "after release", timestampSeconds: 10 },
      1024,
    ).then(() => {
      settled = true;
    });

    await sleep(60);
    assert.equal(settled, false, "append must wait while the live lock is held");
    held.release();
    held = undefined;
    await append;

    assert.deepEqual(await readJsonl(file), [{ session_id: "s1", ts: 10, text: "after release" }]);
  } finally {
    held?.release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ensurePromptHistoryState deduplicates against already-recorded prompts", async () => {
  const agentDir = await tempDir("dedup");
  try {
    const sessionsRoot = nodePath.join(agentDir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [{ type: "text", text: "recent prompt" }],
          timestamp: Date.UTC(2026, 5, 20),
        },
      },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply" }],
          timestamp: Date.UTC(2026, 5, 20),
        },
      },
      {
        type: "message",
        id: "u2",
        message: { role: "user", content: "old prompt", timestamp: Date.UTC(2026, 3, 1) },
      },
    ]);
    const paths = promptHistoryPaths(agentDir);
    await appendHistoryEntry(
      paths.historyFile,
      { sessionId: "s1", text: "recent prompt", timestampSeconds: Date.UTC(2026, 5, 20) / 1000 },
      MB,
    );

    const result = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.scannedSessions, 1);
    // "old prompt" is outside the 30-day window; "recent prompt" already exists.
    assert.deepEqual(await readJsonl(paths.historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "recent prompt" },
    ]);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("ensurePromptHistoryState accepts entry timestamp strings", async () => {
  const agentDir = await tempDir("string-ts");
  try {
    const sessionsRoot = nodePath.join(agentDir, "sessions");
    await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-06-20T01:02:03.000Z",
        message: { role: "user", content: "string timestamp prompt" },
      },
    ]);
    const result = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(promptHistoryPaths(agentDir).historyFile), [
      {
        session_id: "s1",
        ts: Date.UTC(2026, 5, 20, 1, 2, 3) / 1000,
        text: "string timestamp prompt",
      },
    ]);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("ensurePromptHistoryState writes index records with session name fallback", async () => {
  const agentDir = await tempDir("index");
  try {
    const sessionsRoot = nodePath.join(agentDir, "sessions");
    const namedPath = await writeSessionFixture(sessionsRoot, "named", [
      { type: "session", id: "named", cwd: "/repo", timestamp: "2026-06-19T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: "first user prompt", timestamp: Date.UTC(2026, 5, 19) },
      },
      {
        type: "session_info",
        id: "n1",
        name: "Named Thread",
        timestamp: "2026-06-19T00:00:00.000Z",
      },
    ]);
    const unnamedPath = await writeSessionFixture(sessionsRoot, "unnamed", [
      { type: "session", id: "unnamed", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: "fallback title that is reasonably long",
          timestamp: Date.UTC(2026, 5, 20),
        },
      },
    ]);

    const result = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(result.scannedSessions, 2);
    const indexFile = promptHistoryPaths(agentDir).sessionIndexFile;
    const records = await readJsonl(indexFile);
    assert.equal(records.length, 2);
    assert.ok(
      records.some(
        (record) =>
          record.id === "named" &&
          record.title === "Named Thread" &&
          record.path === namedPath &&
          record.cwd === "/repo",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.id === "unnamed" &&
          record.title === "fallback title that is reasonably long" &&
          record.path === unnamedPath,
      ),
    );
    // Newest first.
    assert.equal(records[0]?.id, "unnamed");
    assert.equal((await fsPromises.stat(indexFile)).mode & 0o777, 0o600);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("ensurePromptHistoryState backfills once and rescans only when a session changes", async () => {
  const agentDir = await tempDir("ensure");
  try {
    const sessionsRoot = nodePath.join(agentDir, "workdirs", "repo", "sessions");
    const sessionPath = await writeSessionFixture(sessionsRoot, "s1", [
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: "hello history", timestamp: Date.UTC(2026, 5, 20) },
      },
    ]);
    const paths = promptHistoryPaths(agentDir);

    const result = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(await readJsonl(paths.historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "hello history" },
    ]);
    assert.equal((await readJsonl(paths.sessionIndexFile)).length, 1);

    const unchanged = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 20)),
    });
    assert.equal(unchanged.scannedSessions, 0, "fresh index must not trigger a rescan");

    await sleep(20);
    await fsPromises.appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "u2",
        message: { role: "user", content: "new external prompt", timestamp: Date.UTC(2026, 5, 21) },
      })}\n`,
      "utf8",
    );
    const changed = await ensurePromptHistoryState({
      agentDir,
      sessionsRoot,
      now: () => new Date(Date.UTC(2026, 5, 21)),
    });
    assert.equal(changed.scannedSessions, 1);
    assert.deepEqual(await readJsonl(paths.historyFile), [
      { session_id: "s1", ts: Date.UTC(2026, 5, 20) / 1000, text: "hello history" },
      { session_id: "s1", ts: Date.UTC(2026, 5, 21) / 1000, text: "new external prompt" },
    ]);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("loadGlobalPromptItems keeps one entry per text at its newest time, oldest first", async () => {
  const dir = await tempDir("global");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    assert.deepEqual(await loadGlobalPromptItems(file), [], "missing file yields no items");

    await fsPromises.writeFile(
      file,
      [
        JSON.stringify({ session_id: "a", ts: 100, text: "repeated" }),
        JSON.stringify({ session_id: "b", ts: 200, text: "only once" }),
        "{ not json",
        JSON.stringify({ session_id: "c", ts: 300, text: "repeated" }),
        JSON.stringify({ session_id: "d", ts: 150, text: "repeated" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const items = await loadGlobalPromptItems(file);
    // Deduplicated, and ordered oldest first because the browser reverses input.
    assert.deepEqual(
      items.map((item) => item.text),
      ["only once", "repeated"],
    );
    // "repeated" collapses to ts 300, not 100 or 150.
    assert.equal(items[1]?.timestamp, new Date(300 * 1000).toISOString());
    assert.equal(items[0]?.timestamp, new Date(200 * 1000).toISOString());
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("loadGlobalPromptItems does not write or lock the history file", async () => {
  const dir = await tempDir("global-readonly");
  const file = nodePath.join(dir, "history.jsonl");
  try {
    await appendHistoryEntry(file, { sessionId: "s1", text: "row", timestampSeconds: 10 }, MB);
    const before = await fsPromises.stat(file);

    await loadGlobalPromptItems(file);

    const after = await fsPromises.stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs, "browsing must not rewrite history.jsonl");
    await assert.rejects(
      fsPromises.stat(nodePath.join(dir, ".locks", `${HISTORY_LOCK_ID}.lock`)),
      /ENOENT/,
      "browsing must not leave a lock behind",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("buildPromptHistoryPrompt exposes paths without injecting content", () => {
  const text = buildPromptHistoryPrompt({
    historyFile: "/agent/mpi-prompt-history/history.jsonl",
    sessionIndexFile: "/agent/mpi-prompt-history/session_index.jsonl",
  });
  assert.match(text, /Local conversation history:/);
  assert.match(text, /prompt recall log, not a full transcript/);
  assert.match(text, /\/agent\/mpi-prompt-history\/history\.jsonl/);
  assert.match(text, /\/agent\/mpi-prompt-history\/session_index\.jsonl/);
  assert.match(text, /each record has a `path` to the full session transcript/);
  assert.match(text, /explicitly asks/);
  assert.match(text, /untrusted background/);
  assert.doesNotMatch(text, /hello history/);
});
