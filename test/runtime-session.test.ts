import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findSessionFileByName, openOrCreateSession } from "../src/agent/runtime-session.js";

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
