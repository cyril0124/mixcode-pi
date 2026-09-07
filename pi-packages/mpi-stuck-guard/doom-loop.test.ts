import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { parseStuckGuardConfig } from "./config.js";
import stuckGuardExtension from "./index.js";
import schema from "./mpi-stuck-guard.schema.json" with { type: "json" };

const command = "printf 'run\\n' >> executions.txt";
const hint = "Change the input.\n请勿原样重试。";

test("doomLoop configuration accepts effects and rejects invalid or unknown fields", () => {
  for (const doomLoop of [
    { action: "allow" },
    { action: "ask", message: "" },
    { action: "deny", message: hint },
  ]) {
    const raw = { doomLoop };
    assert.equal(Value.Check(schema, raw), true);
    const result = parseStuckGuardConfig(raw);
    assert.ok(result.ok);
    assert.deepEqual(result.config.doomLoop, doomLoop);
  }
  for (const doomLoop of [
    "deny",
    null,
    [],
    {},
    { action: "off" },
    { action: "deny", message: 1 },
    { action: "deny", threshold: 3 },
  ]) {
    const raw = { doomLoop };
    assert.equal(Value.Check(schema, raw), false);
    const result = parseStuckGuardConfig(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /doomLoop/);
  }
});

async function withSessions(
  config: unknown,
  run: (fixture: {
    dir: string;
    session: AgentSession;
    createSession: () => Promise<AgentSession>;
    call: (
      session: AgentSession,
      input?: Record<string, unknown>,
      tool?: string,
    ) => Promise<{ isError: boolean; text: string }>;
    configure: (value: unknown) => Promise<void>;
    executions: () => Promise<string>;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stuck-doom-loop-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const sessions: AgentSession[] = [];
  try {
    const configure = (value: unknown) =>
      fs.writeFile(path.join(dir, "mpi-stuck-guard.json"), JSON.stringify(value));
    await configure(config);
    await fs.writeFile(path.join(dir, "executions.txt"), "");
    const faux = fauxProvider({ provider: "doom-loop-test", models: [{ id: "local" }] });
    const createSession = async () => {
      // Each live session owns its ResourceLoader and extension closures.
      const services = await createAgentSessionServices({
        cwd: dir,
        agentDir: dir,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          extensionFactories: [stuckGuardExtension],
        },
      });
      services.modelRuntime.registerNativeProvider(faux.provider);
      const { session } = await createAgentSessionFromServices({
        services,
        model: faux.getModel(),
        sessionManager: SessionManager.inMemory(dir),
      });
      sessions.push(session);
      await session.bindExtensions({ mode: "print" });
      return session;
    };
    const session = await createSession();
    let callId = 0;
    await run({
      dir,
      session,
      createSession,
      configure,
      executions: () => fs.readFile(path.join(dir, "executions.txt"), "utf8"),
      call: async (target, input = { command }, tool = "bash") => {
        const id = `call-${++callId}`;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall(tool, input, { id }), { stopReason: "toolUse" }),
          fauxAssistantMessage("Done."),
        ]);
        await target.prompt("Run the requested tool.");
        const result = target.messages.find(
          (entry) => entry.role === "toolResult" && entry.toolCallId === id,
        );
        assert.ok(result && result.role === "toolResult", "real tool result must be present");
        return {
          isError: result.isError,
          text: result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        };
      },
    });
  } finally {
    for (const session of sessions) session.dispose();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const denyConfig = { streamWatchdogEnabled: false, doomLoop: { action: "deny", message: hint } };

test("third and fourth identical calls are blocked without executing, across user turns", async () => {
  await withSessions(denyConfig, async ({ session, call, executions }) => {
    assert.equal((await call(session)).isError, false);
    assert.equal((await call(session)).isError, false);
    for (let count = 3; count <= 4; count++) {
      const result = await call(session);
      assert.equal(result.isError, true);
      assert.match(result.text, /stuck-guard: doom_loop/);
      assert.ok(result.text.endsWith(`\n${hint}`));
    }
    assert.equal(await executions(), "run\nrun\n");
    assert.equal((await call(session, { command: "printf different" })).isError, false);
    assert.equal((await call(session)).isError, false);
    assert.equal(await executions(), "run\nrun\nrun\n");
    await call(session);
    await call(session, { path: "executions.txt" }, "read");
    assert.equal((await call(session)).isError, false);
  });
});

test("sessions count independently and enabling after allow starts a fresh streak", async () => {
  await withSessions(denyConfig, async ({ session, call, createSession, configure }) => {
    await call(session);
    await call(session);
    const other = await createSession();
    assert.equal((await call(other)).isError, false);
    assert.equal((await call(session)).isError, true);
    await configure({ streamWatchdogEnabled: false });
    for (let i = 0; i < 4; i++) assert.equal((await call(session)).isError, false);
    await configure(denyConfig);
    assert.equal((await call(session)).isError, false);
    assert.equal((await call(session)).isError, false);
    assert.equal((await call(session)).isError, true);
  });
});

test("ask without UI denies and does not emit the deny-only message", async () => {
  await withSessions(
    { ...denyConfig, doomLoop: { action: "ask", message: hint } },
    async ({ session, call, executions }) => {
      await call(session);
      await call(session);
      const result = await call(session);
      assert.equal(result.isError, true);
      assert.match(result.text, /no interactive UI/);
      assert.equal(result.text.includes(hint), false);
      assert.equal(await executions(), "run\nrun\n");
    },
  );
});

test("ask grants once, prompts again on the fourth call, and cancels closed", async () => {
  await withSessions(
    { ...denyConfig, doomLoop: { action: "ask", message: hint } },
    async ({ session, call, executions }) => {
      const optionsSeen: string[][] = [];
      const choices = ["Allow once", undefined];
      const ui: ExtensionUIContext = {
        ...session.extensionRunner.getUIContext(),
        select: async (_title, options) => {
          optionsSeen.push(options);
          return choices.shift();
        },
      };
      session.extensionRunner.setUIContext(ui, "tui");
      await call(session);
      await call(session);
      assert.equal((await call(session)).isError, false);
      const cancelled = await call(session);
      assert.equal(cancelled.isError, true);
      assert.match(cancelled.text, /rejected by user/);
      assert.equal(cancelled.text.includes(hint), false);
      assert.deepEqual(optionsSeen, [
        ["Allow once", "Reject"],
        ["Allow once", "Reject"],
      ]);
      assert.equal(await executions(), "run\nrun\nrun\n");
    },
  );
});

test("invalid configuration blocks tools until a valid config is reloaded", async () => {
  await withSessions(
    { doomLoop: { action: "deny", message: false } },
    async ({ session, call, executions, configure }) => {
      const result = await call(session);
      assert.equal(result.isError, true);
      assert.match(result.text, /config invalid.*doomLoop/s);
      assert.equal(await executions(), "");
      await configure(denyConfig);
      assert.equal((await call(session)).isError, false);
    },
  );
});
