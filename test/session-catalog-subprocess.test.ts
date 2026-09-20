import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  listSessionsInBackground,
  SESSION_CATALOG_WORKER_ARG,
} from "../src/core/session-catalog.js";
import { readSessionCatalogProcess } from "../src/core/session-catalog-stream.js";

const helper = path.join(import.meta.dir, "helpers/session-catalog-subprocess.ts");

test("subprocess completion rejects a nonzero exit even after a complete stream", async () => {
  const child = Bun.spawn([process.execPath, helper, SESSION_CATALOG_WORKER_ARG], {
    env: { ...process.env, CATALOG_TEST_MODE: "late-failure" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await assert.rejects(readSessionCatalogProcess(child), /catalog worker failed after output/);
  assert.equal(child.exitCode, 7);
});

test("truncated and malformed subprocess output rejects and reaps a producer left open", async () => {
  for (const [mode, error] of [
    ["truncated", /truncated frame/],
    ["malformed-open", /invalid JSONL/],
  ] as const) {
    const child = Bun.spawn([process.execPath, helper, SESSION_CATALOG_WORKER_ARG], {
      env: { ...process.env, CATALOG_TEST_MODE: mode },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await assert.rejects(readSessionCatalogProcess(child), error);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  }
});

test("cancellation reaps a catalog subprocess that ignores SIGTERM", async () => {
  const child = Bun.spawn([process.execPath, helper, SESSION_CATALOG_WORKER_ARG], {
    env: { ...process.env, CATALOG_TEST_MODE: "ignore-term" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for real output so SIGTERM handling is installed before aborting.
  const stream = child.stdout as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const first = await reader.read();
  reader.releaseLock();
  assert.equal(Buffer.from(first.value!).toString(), '{"type":"done","count":0}\n');
  const abort = new AbortController();
  const result = readSessionCatalogProcess(child, abort.signal);
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});

test("compiled subprocess preserves complete metadata through successful, cancelled and failed loads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-compiled-"));
  try {
    const sessionsRoot = path.join(dir, "sessions");
    const file = path.join(sessionsRoot, "large.jsonl");
    const text = "full searchable 中文 content ".repeat(20000);
    await Bun.write(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "compiled-session",
          cwd: dir,
          parentSession: "/parent.jsonl",
          timestamp: "2026-09-01T00:00:00Z",
        }),
        JSON.stringify({ type: "session_info", name: "named session" }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-02T00:00:00Z",
          message: { role: "user", content: text },
        }),
      ].join("\n") + "\n",
    );
    const binary = path.join(dir, "catalog-helper");
    const build = await Bun.build({
      entrypoints: [helper],
      target: "bun",
      compile: { outfile: binary },
    });
    assert.equal(build.success, true, build.logs.map(String).join("\n"));
    const request = { mode: "current" as const, cwd: dir, sessionsRoot };
    const expected = await listSessionsInBackground(request);
    for (const extraEnv of [
      {},
      { CATALOG_TEST_ABORT_RETRY: "1" },
      { CATALOG_TEST_FAIL_RETRY: "1" },
    ]) {
      const child = Bun.spawn([binary, JSON.stringify(request)], {
        env: { ...process.env, ...extraEnv },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), JSON.parse(JSON.stringify(expected)));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog subprocess emits complete session frames followed by a counted completion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-protocol-"));
  try {
    for (const [id, date] of [
      ["older", "2026-09-01"],
      ["newer", "2026-09-02"],
    ]) {
      await Bun.write(
        path.join(dir, `${id}.jsonl`),
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id,
            cwd: dir,
            timestamp: `${date}T00:00:00Z`,
          }),
          JSON.stringify({ type: "session_info", name: `会话 ${id}` }),
          JSON.stringify({
            type: "message",
            timestamp: `${date}T00:00:00Z`,
            message: { role: "user", content: `中文\nquoted "${id}"` },
          }),
        ].join("\n") + "\n",
      );
    }
    const request = { mode: "current", cwd: dir, sessionsRoot: dir };
    const child = Bun.spawn([process.execPath, helper, SESSION_CATALOG_WORKER_ARG], {
      env: {
        ...process.env,
        MIXCODE_SESSION_CATALOG_REQUEST: Buffer.from(JSON.stringify(request)).toString("base64url"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    const frames = Bun.JSONL.parse(stdout) as Array<{
      type: string;
      session?: unknown;
      count?: number;
    }>;
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["session", "session", "done"],
    );
    assert.equal(frames.at(-1)?.count, 2);
    const expected = await SessionManager.list(dir, dir);
    assert.deepEqual(
      frames.slice(0, -1).map((frame) => frame.session),
      JSON.parse(JSON.stringify(expected)),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
