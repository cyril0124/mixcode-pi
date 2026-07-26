import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { invalidateSessionCatalog } from "../src/core/session-catalog.js";
import {
  findSessionFileByName,
  listAllSessionsGlobal,
  listSessionsForCwd,
  openOrCreateSession,
} from "../src/agent/runtime-session.js";

test("findSessionFileByName matches the full filename session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-file-id-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-01-01T00-00-00-000Z_foo_s1.jsonl"), "", "utf8");

    assert.equal(findSessionFileByName(dir, "s1"), undefined);
    assert.equal(
      findSessionFileByName(dir, "foo_s1"),
      join(dir, "2026-01-01T00-00-00-000Z_foo_s1.jsonl"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openOrCreateSession opens filename match without listing every session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-session-fast-path-"));
  const sessionsRoot = join(dir, "sessions");
  const cwd = join(dir, "workspace");
  const sessionId = "durable-tab-id";
  const sessionPath = join(sessionsRoot, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const originalList = SessionManager.list;

  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "header-id-can-differ",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    })}\n`,
    "utf8",
  );

  (SessionManager as unknown as { list: typeof originalList }).list = async () => {
    throw new Error("SessionManager.list should not be called for filename matches");
  };

  try {
    const session = await openOrCreateSession(sessionId, cwd, sessionsRoot);
    assert.equal(session.getSessionFile(), sessionPath);
  } finally {
    (SessionManager as unknown as { list: typeof originalList }).list = originalList;
    await rm(dir, { recursive: true, force: true });
  }
});

test("listAllSessionsGlobal returns sessions from every workdir in recent order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-list-all-"));
  const activeRoot = join(dir, "active-sessions");
  const otherRoot = join(dir, "state", "workdirs", "other", "sessions");
  try {
    await mkdir(activeRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    await writeFile(
      join(activeRoot, "2026-01-01T00-00-00-000Z_active.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "active",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/active",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(otherRoot, "2026-01-02T00-00-00-000Z_other.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "other",
        timestamp: "2026-01-02T00:00:00.000Z",
        cwd: "/other",
      })}\n`,
      "utf8",
    );

    const sessions = await listAllSessionsGlobal(activeRoot, join(dir, "state"));

    assert.deepEqual(
      sessions.map((session) => session.id),
      ["other", "active"],
    );
    assert.ok(sessions.every((session) => session.created instanceof Date));
    assert.ok(sessions.every((session) => session.modified instanceof Date));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSessionsForCwd reports Loading progress when onProgress is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-progress-"));
  try {
    await mkdir(dir, { recursive: true });
    for (const id of ["a", "b", "c"]) {
      await writeFile(
        join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
        `${JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/repo",
        })}\n`,
        "utf8",
      );
    }
    const ticks: Array<[number, number]> = [];
    const sessions = await listSessionsForCwd("/repo", dir, undefined, (loaded, total) => {
      ticks.push([loaded, total]);
    });
    assert.equal(sessions.length, 3);
    assert.ok(ticks.length > 0, "expected progress callbacks");
    assert.equal(ticks[ticks.length - 1]![1], 3);
    assert.ok(ticks.some(([loaded, total]) => loaded > 0 && loaded <= total));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listAllSessionsGlobal scans Pi sessions/ sibling encoded-cwd directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-list-pi-"));
  const sessionsParent = join(dir, "sessions");
  const activeRoot = join(sessionsParent, "--active-cwd--");
  const otherRoot = join(sessionsParent, "--other-cwd--");
  try {
    await mkdir(activeRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    await writeFile(
      join(activeRoot, "2026-01-01T00-00-00-000Z_active.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "active-pi",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/active",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(otherRoot, "2026-01-03T00-00-00-000Z_other.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "other-pi",
        timestamp: "2026-01-03T00:00:00.000Z",
        cwd: "/other",
      })}\n`,
      "utf8",
    );

    // No rootStateDir: pure Pi agent/sessions/--cwd-- layout.
    const sessions = await listAllSessionsGlobal(activeRoot);

    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      ["active-pi", "other-pi"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSessionsForCwd rejects a cancelled background listing", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    listSessionsForCwd("/repo", "/sessions", controller.signal),
    (error: Error) => error.name === "AbortError",
  );
});

test("listSessionsForCwd preserves complete searchable session metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-session-list-worker-"));
  const sessionsRoot = join(dir, "sessions");
  const cwd = join(dir, "workspace");
  const sessionPath = join(sessionsRoot, "2026-01-01T00-00-00-000Z_searchable.jsonl");
  try {
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "searchable",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          timestamp: "2026-01-02T00:00:00.000Z",
          message: { role: "user", content: "first prompt", timestamp: Date.UTC(2026, 0, 2) },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          timestamp: "2026-01-03T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "searchable answer body" }],
            timestamp: Date.UTC(2026, 0, 3),
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const sessions = await listSessionsForCwd(cwd, sessionsRoot);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.path, sessionPath);
    assert.equal(sessions[0]?.firstMessage, "first prompt");
    assert.equal(sessions[0]?.allMessagesText, "first prompt searchable answer body");
    assert.equal(sessions[0]?.messageCount, 2);
    assert.ok(sessions[0]?.created instanceof Date);
    assert.ok(sessions[0]?.modified instanceof Date);
    assert.equal(sessions[0]?.modified.toISOString(), "2026-01-03T00:00:00.000Z");

    const cachedStartedAt = performance.now();
    const cached = await listSessionsForCwd(cwd, sessionsRoot);
    assert.ok(performance.now() - cachedStartedAt < 250, "unchanged sessions must reuse the catalog");
    assert.equal(cached[0]?.allMessagesText, sessions[0]?.allMessagesText);

    await appendFile(
      sessionPath,
      `${JSON.stringify({ type: "session_info", id: "n1", name: "Renamed" })}\n`,
      "utf8",
    );
    invalidateSessionCatalog(sessionsRoot);
    const refreshed = await listSessionsForCwd(cwd, sessionsRoot);
    assert.equal(refreshed[0]?.name, "Renamed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
