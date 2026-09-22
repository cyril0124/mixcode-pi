/**
 * Real-AgentSession e2e for the post-compaction continuation chain and the
 * settle-only continue dispatch. Uses a live AgentSession with the mpi-goal
 * extension, a tiny context window, and scripted assistant responses so
 * auto-compaction fires mid-run and the extension must keep the goal running.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE } from "./src/domain/constants.js";
import { replayGoalState } from "./src/persistence/goal-store.js";
import { wireMpiGoal } from "./src/app.js";

type SessionManagerLike = ReturnType<typeof SessionManager.inMemory>;
type BranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];
type StreamFn = (
  _model: unknown,
  _context: unknown,
  streamOptions?: { signal?: AbortSignal },
) => ReturnType<typeof streamAssistantMessage>;

const MODEL = {
  provider: "goal-e2e",
  api: "goal-e2e",
  id: "goal-e2e-model",
  reasoning: false,
  input: ["text"],
  contextWindow: 120,
  maxTokens: 64,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function streamAssistantMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    const first = message.content[0];
    if (first?.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: message });
    } else if (first?.type === "text") {
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({ type: "text_delta", contentIndex: 0, delta: first.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: first.text, partial: message });
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
}

function streamHangingMessage(message: AssistantMessage, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...message, content: [{ type: "text", text: "" }] },
    });
    // Stay open until the run is aborted, mirroring a mid-flight provider stream.
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    const aborted = {
      ...message,
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
  });
  return stream;
}

function withUsage(message: AssistantMessage, inputTokens: number): AssistantMessage {
  return {
    ...message,
    usage: {
      input: inputTokens,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function createGoalE2E(responses: AssistantMessage[], options: { hangAfterDrain?: boolean } = {}) {
  let compactCalls = 0;
  const sessionManagerHolder: { sessionManager?: SessionManagerLike } = {};
  const factory = (pi: Parameters<typeof wireMpiGoal>[0]) => {
    pi.on("session_before_compact", async (event) => {
      compactCalls += 1;
      if (compactCalls > 1) return { cancel: true };
      return {
        compaction: {
          summary: "auto summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
    wireMpiGoal(pi);
  };
  const streamFn = (
    _model: unknown,
    _context: unknown,
    streamOptions: { signal?: AbortSignal } = {},
  ) => {
    const next = responses.shift();
    if (next) return streamAssistantMessage(next);
    const fallback = fauxAssistantMessage("done");
    if (options.hangAfterDrain) return streamHangingMessage(fallback, streamOptions.signal);
    return streamAssistantMessage(fallback);
  };
  return { factory, streamFn: streamFn as StreamFn, sessionManagerHolder };
}

async function createSession(
  dir: string,
  sessionId: string,
  factory: ReturnType<typeof createGoalE2E>["factory"],
  streamFn: StreamFn,
) {
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      extensionFactories: [factory],
    },
  });
  // session.prompt runs an auth preflight against the model runtime; register
  // the test provider with a dummy key so the run reaches the scripted stream.
  services.modelRuntime.registerProvider("goal-e2e", {
    name: "goal-e2e",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "goal-e2e-key",
    api: "goal-e2e",
    models: [],
  } as never);
  const sessionManager = SessionManager.inMemory(dir, { id: sessionId });
  const { session } = await createAgentSessionFromServices({
    services,
    model: MODEL as never,
    sessionManager,
  });
  await session.bindExtensions({ mode: "print" });
  session.setActiveToolsByName(["create_goal"]);
  session.agent.streamFunction = streamFn as never;
  return { session, sessionManager };
}

function continuationEntries(branch: BranchEntry[]): BranchEntry[] {
  return branch.filter(
    (entry) =>
      entry.type === "custom_message" &&
      (entry as { customType?: string }).customType === CONTINUATION_MESSAGE_TYPE,
  );
}

function compactionIndex(branch: BranchEntry[]): number {
  return branch.findIndex((entry) => entry.type === "compaction");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeCompactionOverride(dir: string): Promise<void> {
  // Tiny per-model compaction overrides so a small session actually has a cut
  // point and crosses the threshold. Defaults (16384/20000 tokens) dwarf the
  // test transcript and would make prepareCompaction return undefined.
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      compaction: {
        modelOverrides: {
          "goal-e2e/goal-e2e-model": { reserveTokens: 10, keepRecentTokens: 8 },
        },
      },
    }),
  );
}

test("real session keeps an active goal running across auto-compaction", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-goal-e2e-compact-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeCompactionOverride(dir);
    const responses: AssistantMessage[] = [
      withUsage(
        fauxAssistantMessage(
          [fauxToolCall("create_goal", { objective: "finish the e2e compaction pass" })],
          { stopReason: "toolUse" },
        ),
        4,
      ),
      // Long first-turn text so the keep-recent accumulation crosses the budget
      // inside turn one and the cut point lands on the second user message.
      withUsage(fauxAssistantMessage("working ".repeat(30)), 4),
      // Second turn's response crosses the reserve threshold. Compaction needs
      // an earlier turn to summarize: cut points sit at turn boundaries, so a
      // single-turn session can never produce a non-empty summarize range.
      withUsage(fauxAssistantMessage("working more"), 115),
    ];
    const { factory, streamFn } = createGoalE2E(responses);
    const { session, sessionManager } = await createSession(
      dir,
      "goal-e2e-compact",
      factory,
      streamFn,
    );
    try {
      await session.prompt("start the goal");
      await session.prompt("keep going");

      const branch = sessionManager.getBranch();
      const compactAt = compactionIndex(branch);
      assert.ok(compactAt >= 0, "auto-compaction must have run");
      const continuations = continuationEntries(branch);
      assert.ok(continuations.length >= 1, "goal continuation message must be persisted");
      // Settle-time auto-continue also emits continuations before any compaction;
      // the compaction contract is that a continuation follows the compaction entry.
      assert.ok(
        continuations.some((entry) => branch.indexOf(entry) > compactAt),
        "a continuation must be appended after the compaction entry",
      );
      const assistantTurns = branch.filter(
        (entry) =>
          entry.type === "message" &&
          (entry as { message?: { role?: string } }).message?.role === "assistant",
      ).length;
      assert.ok(
        assistantTurns >= 3,
        "run must continue past the compaction turn (create_goal, working, post-compact)",
      );
      const state = replayGoalState({ sessionManager } as never);
      assert.ok(state.goal, "goal must survive the compaction chain");
      assert.ok(
        state.goal?.status === "active" || state.goal?.status === "paused",
        "repeated no-progress auto turns may pause the goal after compactions",
      );
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("aborted run settles once and pauses the goal without any continuation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-goal-e2e-abort-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeCompactionOverride(dir);
    const responses: AssistantMessage[] = [
      withUsage(
        fauxAssistantMessage(
          [fauxToolCall("create_goal", { objective: "goal that will be aborted" })],
          { stopReason: "toolUse" },
        ),
        4,
      ),
    ];
    const { factory, streamFn } = createGoalE2E(responses, { hangAfterDrain: true });
    const { session, sessionManager } = await createSession(
      dir,
      "goal-e2e-abort",
      factory,
      streamFn,
    );
    try {
      const run = session.prompt("start the goal");
      await sleep(150);
      session.abort();
      await run.catch(() => undefined);

      // Past the deleted 500ms fallback window: settle alone may dispatch,
      // and the aborted turn must have paused the goal instead.
      await sleep(700);
      const branch = sessionManager.getBranch();
      assert.equal(
        continuationEntries(branch).length,
        0,
        "aborted goal must not send a continuation",
      );
      const state = replayGoalState({ sessionManager } as never);
      assert.equal(state.goal?.status, "paused");
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
