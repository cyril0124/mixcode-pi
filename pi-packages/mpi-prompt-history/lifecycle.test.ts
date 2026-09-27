import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionShutdownEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { promptHistoryPaths, type SessionIndexRecord } from "./history-store.js";
import historyExtension from "./index.js";

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-history-lifecycle-"));
  const agentDir = path.join(dir, "agent");
  const sessionsRoot = path.join(dir, "sessions");
  const paths = promptHistoryPaths(agentDir);
  const previousEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MIXCODE: process.env.MIXCODE,
    MIXCODE_PID: process.env.MIXCODE_PID,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.MIXCODE = "1";
  process.env.MIXCODE_PID = String(process.pid);
  const runners = new Set<ExtensionRunner>();
  t.after(async () => {
    for (const runner of runners) {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      runner.invalidate();
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models"),
    refreshOnCreate: false,
  });
  async function createSession(id: string) {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories: [historyExtension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const manager = SessionManager.create(dir, sessionsRoot, { id });
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      manager,
      new ModelRegistry(modelRuntime),
    );
    const notifications: string[] = [];
    runner.setUIContext(
      { ...runner.getUIContext(), notify: (message) => notifications.push(message) },
      "tui",
    );
    runners.add(runner);
    return { runner, manager, notifications };
  }

  async function retire(runner: ExtensionRunner, reason: SessionShutdownEvent["reason"]) {
    await runner.emit({ type: "session_shutdown", reason });
    runner.invalidate();
    runners.delete(runner);
  }

  return { dir, paths, createSession, retire };
}

async function readRecords<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T)
    : [];
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "history writes did not finish within 3 seconds");
    await sleep(10);
  }
}

for (const reason of ["new", "reload"] as const) {
  test(`startup backfill retains both session indexes after ${reason}`, async (t) => {
    const { dir, paths, createSession, retire } = await fixture(t);
    const original = await createSession("original");
    // Invalidate before filesystem I/O resumes, using the SDK's real ctx guards.
    const started = original.runner.emit({ type: "session_start", reason: "startup" });
    await retire(original.runner, reason);
    await started;
    const replacement = await createSession("replacement");
    await replacement.runner.emit({ type: "session_start", reason });
    await waitFor(
      async () => (await readRecords<SessionIndexRecord>(paths.sessionIndexFile)).length === 2,
    );
    const records = await readRecords<SessionIndexRecord>(paths.sessionIndexFile);
    assert.deepEqual(records.map((record) => record.id).sort(), ["original", "replacement"]);
    assert.ok(records.every((record) => record.cwd === dir));
    assert.deepEqual(original.notifications, []);
    assert.deepEqual(replacement.notifications, []);
  });
}

test("a retired scan reports its warning only to a live waiter and does not poison shared startup", async (t) => {
  const { paths, createSession, retire } = await fixture(t);
  const original = await createSession("original");
  await fs.writeFile(paths.configFile, JSON.stringify({ maxBytes: -1 }));
  const started = original.runner.emit({ type: "session_start", reason: "startup" });
  await retire(original.runner, "reload");
  await started;
  const replacement = await createSession("replacement");
  await replacement.runner.emit({ type: "session_start", reason: "reload" });
  await waitFor(
    async () => (await readRecords<SessionIndexRecord>(paths.sessionIndexFile)).length === 2,
  );
  assert.deepEqual(original.notifications, []);
  assert.ok(replacement.notifications.some((message) => message.includes("Invalid maxBytes")));
  assert.ok(replacement.notifications.every((message) => !message.includes("stale")));
});

test("queued prompt writes retain their original session after replacement", async (t) => {
  const { paths, createSession, retire } = await fixture(t);
  const original = await createSession("original");
  const input = original.runner.emitInput("original prompt", undefined, "interactive");
  await retire(original.runner, "resume");
  await input;
  const replacement = await createSession("replacement");
  await replacement.runner.emitInput("replacement prompt", undefined, "interactive");
  type PromptRecord = { session_id: string; text: string };
  await waitFor(async () => (await readRecords<PromptRecord>(paths.historyFile)).length === 2);
  const records = await readRecords<PromptRecord>(paths.historyFile);
  assert.deepEqual(
    records
      .map(({ session_id, text }) => ({ session_id, text }))
      .sort((a, b) => a.session_id.localeCompare(b.session_id)),
    [
      { session_id: "original", text: "original prompt" },
      { session_id: "replacement", text: "replacement prompt" },
    ],
  );
  assert.deepEqual(original.notifications, []);
  assert.deepEqual(replacement.notifications, []);
});

test("a failed queued prompt write does not notify a retired session", async (t) => {
  const { paths, createSession, retire } = await fixture(t);
  const original = await createSession("original");
  await fs.writeFile(paths.configFile, JSON.stringify({ maxBytes: -1 }));
  const input = original.runner.emitInput("original prompt", undefined, "interactive");
  await retire(original.runner, "fork");
  await input;
  const replacement = await createSession("replacement");
  await replacement.runner.emitInput("replacement prompt", undefined, "interactive");
  await waitFor(async () =>
    replacement.notifications.some((message) => message.includes("Invalid maxBytes")),
  );
  assert.deepEqual(original.notifications, []);
  assert.deepEqual(await readRecords(paths.historyFile), []);
});
