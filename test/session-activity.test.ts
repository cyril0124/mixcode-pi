import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { createSessionActivityReader } from "../src/core/session-activity.js";

/** Encoded session directory name Pi uses for a cwd (see getDefaultSessionDirPath). */
function sessionDirName(cwd: string): string {
  return `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

async function makeAgentDir(): Promise<string> {
  return await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-activity-"));
}

async function writeTranscript(
  agentDir: string,
  workdir: string,
  fileName: string,
  mtime: Date,
): Promise<string> {
  const dir = path.join(agentDir, "sessions", sessionDirName(workdir));
  await fsPromises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fsPromises.writeFile(filePath, `${JSON.stringify({ type: "session" })}\n`, "utf8");
  await fsPromises.utimes(filePath, mtime, mtime);
  return filePath;
}

test("createSessionActivityReader resolves a session's transcript mtime", async () => {
  const agentDir = await makeAgentDir();
  const workdir = path.join(agentDir, "repo");
  const mtime = new Date("2026-06-06T00:00:00.000Z");
  try {
    // The file name is `<createdAt>_<sessionId>.jsonl`, so the id alone cannot
    // reconstruct the path: the reader must match by suffix.
    await writeTranscript(agentDir, workdir, "2026-05-01T10-00-00-000Z_sess-aaaa1111.jsonl", mtime);
    const readActivity = createSessionActivityReader(agentDir);

    const resolved = await readActivity("sess-aaaa1111", workdir);
    assert.equal(resolved?.toISOString(), mtime.toISOString());
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("createSessionActivityReader returns undefined for unknown sessions and workdirs", async () => {
  const agentDir = await makeAgentDir();
  const workdir = path.join(agentDir, "repo");
  try {
    await writeTranscript(
      agentDir,
      workdir,
      "2026-05-01T10-00-00-000Z_sess-aaaa1111.jsonl",
      new Date(),
    );
    const readActivity = createSessionActivityReader(agentDir);

    // Different session id in an existing directory.
    assert.equal(await readActivity("sess-missing", workdir), undefined);
    // Directory that was never created, and a workdir with no session dir at all.
    assert.equal(await readActivity("sess-aaaa1111", path.join(agentDir, "elsewhere")), undefined);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

test("createSessionActivityReader ignores transcripts belonging to another session", async () => {
  const agentDir = await makeAgentDir();
  const workdir = path.join(agentDir, "repo");
  try {
    // Same directory, two sessions: each id must resolve to its own file, not to
    // whichever file was listed first.
    const older = new Date("2026-06-01T00:00:00.000Z");
    const newer = new Date("2026-06-02T00:00:00.000Z");
    await writeTranscript(agentDir, workdir, "2026-05-01T10-00-00-000Z_sess-aaaa1111.jsonl", older);
    await writeTranscript(agentDir, workdir, "2026-05-02T10-00-00-000Z_sess-bbbb2222.jsonl", newer);
    const readActivity = createSessionActivityReader(agentDir);

    assert.equal(
      (await readActivity("sess-aaaa1111", workdir))?.toISOString(),
      older.toISOString(),
    );
    assert.equal(
      (await readActivity("sess-bbbb2222", workdir))?.toISOString(),
      newer.toISOString(),
    );
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});
