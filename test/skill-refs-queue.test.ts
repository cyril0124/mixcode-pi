import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import skillRefsExtension from "../pi-packages/mpi-skill-refs/index.js";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  type RuntimeTab,
} from "./helpers/mixcode.js";

const SKILL_NAME = "queue-regression-skill";
const QUEUED_INPUT = `apply $${SKILL_NAME} after checking the diff`;
const SKILL_MARKER = `<skill name="${SKILL_NAME}">`;

function textOf(message: Context["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

interface ModelRequest {
  texts: string[];
  visibleUsers: string[];
  persistedUsers: string[];
  pending: string[];
}

async function withQueuedSkill(
  kind: "steer" | "followUp",
  beforeRelease: (runtime: MixCodeRuntime, runtimeTab: RuntimeTab) => Promise<void>,
  extraExtensions: ExtensionFactory[] = [],
): Promise<ModelRequest[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-skill-queue-"));
  const skillPath = path.join(dir, ".agents", "skills", SKILL_NAME, "SKILL.md");
  await Bun.write(
    skillPath,
    `---\nname: ${SKILL_NAME}\ndescription: Review queued changes.\n---\nRead the diff.\n`,
  );
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  let runtimeTab: RuntimeTab;
  const model = { ...MIXCODE_FAUX_MODEL, provider: "skill-queue-test", id: "skill-queue-test" };
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    extensionFactories: [skillRefsExtension, ...extraExtensions],
    streamFn: (_model, context) => {
      requests.push({
        texts: context.messages.map(textOf),
        visibleUsers: runtimeTab.chat
          .filter((line) => line.role === "user")
          .map((line) => line.text),
        persistedUsers: runtimeTab.session
          .getBranch()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "user"
              ? [textOf(entry.message)]
              : [],
          ),
        pending: [...runtimeTab.tab.pendingMessages, ...runtimeTab.tab.pendingFollowUps],
      });
      started.resolve();
      const stream = createAssistantMessageEventStream();
      void released.promise.then(() => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
  let running: Promise<void> | undefined;
  try {
    const tab = createTab(1, "skill-queue", dir);
    runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "Test queued skill delivery.",
      workdir: dir,
      model,
      thinkingLevel: "off",
    });
    runtimeTab.agentSession.setSteeringMode("one-at-a-time");
    runtimeTab.agentSession.setFollowUpMode("one-at-a-time");
    running = runtime.prompt(tab.sessionId, "busy");
    await Promise.race([
      started.promise,
      running.then(() => {
        throw new Error("Initial turn ended before the model request");
      }),
    ]);
    await runtime.prompt(tab.sessionId, QUEUED_INPUT, { streamingBehavior: kind });
    await beforeRelease(runtime, runtimeTab);
    released.resolve();
    await running;
    return requests;
  } finally {
    released.resolve();
    await running;
    await runtime.closeTab("skill-queue");
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const kind of ["steer", "followUp"] as const) {
  test(`${kind}: skill instructions reach the model only with a visible, persisted user message`, async () => {
    const requests = await withQueuedSkill(kind, async (_runtime, runtimeTab) => {
      const pending =
        kind === "steer" ? runtimeTab.tab.pendingMessages : runtimeTab.tab.pendingFollowUps;
      assert.deepEqual(pending, [QUEUED_INPUT]);
    });
    const skillRequests = requests.filter((request) =>
      request.texts.some((text) => text.includes(SKILL_MARKER)),
    );
    assert.equal(skillRequests.length, 1);
    const delivered = skillRequests[0]!;
    assert.ok(
      delivered.texts.includes(QUEUED_INPUT),
      "the original user input must accompany its skill instructions",
    );
    assert.ok(
      delivered.visibleUsers.includes(QUEUED_INPUT),
      "the chat must show the input before model execution",
    );
    assert.ok(
      delivered.persistedUsers.includes(QUEUED_INPUT),
      "session history must contain the input before model execution",
    );
    assert.deepEqual(delivered.pending, []);
    assert.equal(requests.length, 2, "skill metadata must not start an extra model turn");
  });

  test(`${kind}: withdrawing a queued skill leaves no hidden instruction to execute`, async () => {
    const requests = await withQueuedSkill(kind, async (runtime, runtimeTab) => {
      assert.equal(
        runtime.popPendingMessage(
          runtimeTab.tab.sessionId,
          kind === "steer" ? "steering" : "followUp",
        ),
        QUEUED_INPUT,
      );
    });
    assert.deepEqual(
      requests.map((request) => request.texts.at(-1)),
      ["busy"],
    );
  });
}

for (const action of ["handled", "transform"] as const) {
  test(`input ${action}: skill expansion uses only the accepted user input`, async () => {
    const requests = await withQueuedSkill("steer", async () => {}, [
      (pi) => {
        pi.on("input", (event) => {
          if (event.text !== QUEUED_INPUT) return;
          return action === "handled" ? { action } : { action, text: "replacement input" };
        });
      },
    ]);
    assert.equal(
      requests.some((request) => request.texts.some((text) => text.includes(SKILL_MARKER))),
      false,
    );
    assert.deepEqual(
      requests.map((request) => request.texts.at(-1)),
      action === "handled" ? ["busy"] : ["busy", "replacement input"],
    );
  });
}
