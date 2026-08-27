import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureSessionCatalogPoll, listSessionsInBackground } from "../src/core/session-catalog.js";

const POLL_MS = 5;
const WAIT_MS = 2_000;

async function waitForSessions(
  request: Parameters<typeof listSessionsInBackground>[0],
  check: (sessions: Awaited<ReturnType<typeof listSessionsInBackground>>) => boolean,
) {
  const deadline = Date.now() + WAIT_MS;
  let sessions = await listSessionsInBackground(request);
  while (!check(sessions) && Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    sessions = await listSessionsInBackground(request);
  }
  return sessions;
}

function sessionHeader(cwd: string, id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  });
}

test("catalog poll invalidates the cache when session files appear in the root", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-catalog-poll-"));
  try {
    ensureSessionCatalogPoll(dir, POLL_MS);
    const request = { mode: "current" as const, cwd: dir, sessionsRoot: dir };

    // Empty root: first listing caches an empty result.
    const before = await listSessionsInBackground(request);
    assert.deepEqual(before, []);

    // Another instance drops a session file in; the poll must invalidate.
    await fsPromises.writeFile(
      path.join(dir, "new-session.jsonl"),
      sessionHeader(dir, "catalog-poll-session"),
      "utf8",
    );

    const after = await waitForSessions(request, (sessions) => sessions.length === 1);
    assert.equal(after.length, 1, "new external session must appear in the listing");
    assert.equal(after[0]?.id, "catalog-poll-session");
    assert.equal(after[0]?.cwd, dir);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("catalog all mode deduplicates paths and sorts newest first", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-catalog-all-"));
  try {
    await fsPromises.writeFile(
      path.join(dir, "old.jsonl"),
      `${sessionHeader(dir, "old")}\n`,
      "utf8",
    );
    await Bun.sleep(20);
    await fsPromises.writeFile(
      path.join(dir, "new.jsonl"),
      `${sessionHeader(dir, "new")}\n`,
      "utf8",
    );

    const sessions = await listSessionsInBackground({
      mode: "all",
      sessionDirs: [dir, dir],
    });
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["new", "old"],
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("catalog poll invalidates the cache when an existing session file grows", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-catalog-append-"));
  const file = path.join(dir, "live.jsonl");
  try {
    await fsPromises.writeFile(file, `${sessionHeader(dir, "live")}\n`, "utf8");
    ensureSessionCatalogPoll(dir, POLL_MS);
    const request = { mode: "current" as const, cwd: dir, sessionsRoot: dir };
    const before = await listSessionsInBackground(request);
    assert.equal(before.length, 1);
    assert.equal(before[0]?.messageCount, 0);

    await fsPromises.appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: Date.now(),
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from peer" }],
          timestamp: Date.now(),
        },
      })}\n`,
    );

    const after = await waitForSessions(request, (sessions) => sessions[0]?.messageCount === 1);
    assert.equal(after[0]?.messageCount, 1);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
