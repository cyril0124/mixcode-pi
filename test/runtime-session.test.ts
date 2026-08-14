import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveRuntimeModelFromSession } from "../src/agent/runtime-model.js";
import { defaultPiSessionDir } from "../src/cli/bootstrap.js";
import { invalidateSessionCatalog } from "../src/core/session-catalog.js";
import {
  copySession,
  findSessionFileByName,
  listAllSessionsGlobal,
  listSessionsForCwd,
  materializeSessionFile,
  openOrCreateSession,
  reopenSessionInWorkdir,
} from "../src/agent/runtime-session.js";

test("resolveRuntimeModelFromSession falls back when the session model is unknown", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-unknown-model-"));
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_unknown-model.jsonl");
  try {
    await Bun.write(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "unknown-model",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      })}\n${JSON.stringify({
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "missing-provider",
        modelId: "missing-model",
      })}\n`,
    );
    const session = SessionManager.open(file, dir);
    const resolved = resolveRuntimeModelFromSession(session, undefined, undefined);
    assert.ok(resolved);
    assert.equal(resolved.provider, "faux");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reopenSessionInWorkdir persists cwd so resume without override keeps it", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-persist-"));
  const sessionsRoot = path.join(dir, "sessions");
  const oldCwd = path.join(dir, "old");
  const newCwd = path.join(dir, "new");
  try {
    await fsPromises.mkdir(oldCwd, { recursive: true });
    await fsPromises.mkdir(newCwd, { recursive: true });
    const source = SessionManager.create(oldCwd, sessionsRoot);
    source.newSession({ id: "persist-cwd" });
    source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    materializeSessionFile(source);
    const sessionFile = source.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(source.getHeader()?.cwd, oldCwd);

    const reopened = await reopenSessionInWorkdir(source, newCwd, sessionsRoot);
    assert.equal(reopened.getSessionFile(), sessionFile);
    assert.equal(reopened.getCwd(), newCwd);
    assert.equal(reopened.getHeader()?.cwd, newCwd);

    const resumed = SessionManager.open(sessionFile);
    assert.equal(resumed.getCwd(), newCwd);
    assert.equal(resumed.getHeader()?.cwd, newCwd);

    invalidateSessionCatalog(sessionsRoot);
    const inNew = await listSessionsForCwd(newCwd, sessionsRoot);
    const inOld = await listSessionsForCwd(oldCwd, sessionsRoot);
    assert.equal(inNew.length, 1);
    assert.equal(inNew[0]?.path, sessionFile);
    assert.equal(inOld.length, 0);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("session copies use Pi's current session format version", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-version-"));
  const sessionsRoot = path.join(dir, "sessions");
  const cwd = path.join(dir, "workspace");
  const nextCwd = path.join(dir, "next-workspace");
  try {
    await fsPromises.mkdir(cwd, { recursive: true });
    await fsPromises.mkdir(nextCwd, { recursive: true });

    const copied = await copySession(
      SessionManager.inMemory(cwd),
      cwd,
      "copied-session",
      sessionsRoot,
    );
    const replaced = await reopenSessionInWorkdir(
      SessionManager.inMemory(cwd),
      nextCwd,
      sessionsRoot,
    );

    assert.equal(copied.getHeader()?.version, CURRENT_SESSION_VERSION);
    assert.equal(replaced.getHeader()?.version, CURRENT_SESSION_VERSION);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("findSessionFileByName matches the full filename session id", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-file-id-"));
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, "2026-01-01T00-00-00-000Z_foo_s1.jsonl"), "", "utf8");

    assert.equal(findSessionFileByName(dir, "s1"), undefined);
    assert.equal(
      findSessionFileByName(dir, "foo_s1"),
      path.join(dir, "2026-01-01T00-00-00-000Z_foo_s1.jsonl"),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("openOrCreateSession opens filename match without listing every session", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-session-fast-path-"));
  const sessionsRoot = path.join(dir, "sessions");
  const cwd = path.join(dir, "workspace");
  const sessionId = "durable-tab-id";
  const sessionPath = path.join(sessionsRoot, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const originalList = SessionManager.list;

  await fsPromises.mkdir(sessionsRoot, { recursive: true });
  await fsPromises.mkdir(cwd, { recursive: true });
  await fsPromises.writeFile(
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("listSessionsForCwd reports Loading progress when onProgress is provided", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-progress-"));
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    for (const id of ["a", "b", "c"]) {
      await fsPromises.writeFile(
        path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("listAllSessionsGlobal scans Pi sessions/ sibling encoded-cwd directories", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-list-pi-"));
  const sessionsParent = path.join(dir, "sessions");
  const activeRoot = path.join(sessionsParent, "--active-cwd--");
  const otherRoot = path.join(sessionsParent, "--other-cwd--");
  try {
    await fsPromises.mkdir(activeRoot, { recursive: true });
    await fsPromises.mkdir(otherRoot, { recursive: true });
    await fsPromises.writeFile(
      path.join(activeRoot, "2026-01-01T00-00-00-000Z_active.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "active-pi",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/active",
      })}\n`,
      "utf8",
    );
    await fsPromises.writeFile(
      path.join(otherRoot, "2026-01-03T00-00-00-000Z_other.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "other-pi",
        timestamp: "2026-01-03T00:00:00.000Z",
        cwd: "/other",
      })}\n`,
      "utf8",
    );

    const sessions = await listAllSessionsGlobal(activeRoot);

    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      ["active-pi", "other-pi"],
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("listSessionsForCwd only reads the given session dir, not sibling cwd dirs", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-cwd-noscan-"));
  const sessionsParent = path.join(dir, "sessions");
  const dir1Root = path.join(sessionsParent, "--dir1--");
  const dir2Root = path.join(sessionsParent, "--dir2--");
  const dir2 = path.join(dir, "dir2");
  try {
    await fsPromises.mkdir(dir1Root, { recursive: true });
    await fsPromises.mkdir(dir2Root, { recursive: true });
    await fsPromises.writeFile(
      path.join(dir1Root, "2026-01-01T00-00-00-000Z_elsewhere.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "elsewhere",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir2,
      })}\n`,
      "utf8",
    );

    const current = await listSessionsForCwd(dir2, dir2Root);
    assert.equal(current.length, 0);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reopenSessionInWorkdir publishes a link so the new cwd's Current Folder can see it", async () => {
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-cwd-link-"));
  const dir1 = path.join(agentDir, "dir1");
  const dir2 = path.join(agentDir, "dir2");
  try {
    await fsPromises.mkdir(dir1, { recursive: true });
    await fsPromises.mkdir(dir2, { recursive: true });
    const dir1Root = defaultPiSessionDir(dir1, agentDir);
    const dir2Root = defaultPiSessionDir(dir2, agentDir);
    const source = SessionManager.create(dir1, dir1Root);
    source.newSession({ id: "moved-cwd" });
    source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    materializeSessionFile(source);
    const sessionFile = source.getSessionFile();
    assert.ok(sessionFile);

    await reopenSessionInWorkdir(source, dir2, dir1Root);

    const published = path.join(dir2Root, path.basename(sessionFile));
    assert.equal(await Bun.file(published).exists(), true);
    const listed = await listSessionsForCwd(dir2, dir2Root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.cwd, dir2);
    assert.equal(path.basename(listed[0]?.path ?? ""), path.basename(sessionFile));
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("listAllSessionsGlobal lists a /workdir session once", async () => {
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-cwd-all-once-"));
  const dir1 = path.join(agentDir, "dir1");
  const dir2 = path.join(agentDir, "dir2");
  try {
    await fsPromises.mkdir(dir1, { recursive: true });
    await fsPromises.mkdir(dir2, { recursive: true });
    const dir1Root = defaultPiSessionDir(dir1, agentDir);
    const source = SessionManager.create(dir1, dir1Root);
    source.newSession({ id: "moved-cwd-all" });
    source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    materializeSessionFile(source);
    await reopenSessionInWorkdir(source, dir2, dir1Root);

    const all = await listAllSessionsGlobal(dir1Root);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, "moved-cwd-all");
    assert.equal(all[0]?.cwd, dir2);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
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
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-list-worker-"));
  const sessionsRoot = path.join(dir, "sessions");
  const cwd = path.join(dir, "workspace");
  const sessionPath = path.join(sessionsRoot, "2026-01-01T00-00-00-000Z_searchable.jsonl");
  try {
    await fsPromises.mkdir(sessionsRoot, { recursive: true });
    await fsPromises.writeFile(
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

    await fsPromises.appendFile(
      sessionPath,
      `${JSON.stringify({ type: "session_info", id: "n1", name: "Renamed" })}\n`,
      "utf8",
    );
    invalidateSessionCatalog(sessionsRoot);
    const refreshed = await listSessionsForCwd(cwd, sessionsRoot);
    assert.equal(refreshed[0]?.name, "Renamed");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
