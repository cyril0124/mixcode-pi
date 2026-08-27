// Manual compact after a finished assistant(stop) turn must succeed without
// wrapping an assistant-continue refusal as "Compaction failed".

import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  type MixCodeModel,
} from "./helpers/mixcode.js";

function waitForRuntime(predicate: () => boolean, attempts = 80): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      attempt += 1;
      if (attempt >= attempts) {
        reject(new Error("Timed out waiting for runtime condition"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function runtimeAssistantMessage(text: string, totalTokens = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "compact-test",
    provider: "compact-test",
    model: "compact-test-model",
    usage: {
      input: Math.max(1, totalTokens - 1),
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function runtimeToolCallMessage(toolCall: ToolCall, totalTokens = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: "compact-test",
    provider: "compact-test",
    model: "compact-test-model",
    usage: {
      input: Math.max(1, totalTokens - 1),
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function streamAssistantMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
}

test("manual compact after assistant stop does not report continue failure", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-auto-compact-guard-"));
  const agentDir = path.join(dir, "agent");
  try {
    let turn = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir,
      streamFn: (_model: MixCodeModel, context: Context) => {
        if (context.messages.some((message) => message.role === "toolResult")) {
          return streamAssistantMessage(runtimeAssistantMessage("FINAL_ANSWER", 900));
        }
        turn += 1;
        if (turn <= 3) {
          return streamAssistantMessage(
            runtimeToolCallMessage(
              {
                type: "toolCall",
                id: `tc-${turn}`,
                name: "echo",
                arguments: { n: turn },
              },
              400 + turn * 40,
            ),
          );
        }
        return streamAssistantMessage(runtimeAssistantMessage(`mid-${turn}`, 500 + turn));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "echo",
            label: "Echo",
            description: "Echo for compact guard fixture.",
            parameters: Type.Object({ n: Type.Number() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `echo:${params.n} ${"z".repeat(200)}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "## Goal\nguard fixture summary\n",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { readFiles: [], modifiedFiles: [] },
            },
          }));
        },
      ],
    });

    const model: MixCodeModel = {
      ...MIXCODE_FAUX_MODEL,
      provider: "compact-test",
      api: "compact-test",
      id: "compact-test-model",
      contextWindow: 2000,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 2000,
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });

    for (const prompt of ["a", "b", "c", "d"]) {
      await runtime.prompt("s1", prompt);
      await waitForRuntime(
        () => tab.status === "idle" || tab.status === "done" || tab.status === "error",
      );
    }

    assert.equal(runtimeTab.agentSession.agent.state.messages.at(-1)?.role, "assistant");
    await runtime.compactSession("s1");
    assert.equal(
      runtimeTab.session.getBranch().at(-1)?.type,
      "compaction",
      `compact must succeed; last chat=${JSON.stringify(runtimeTab.chat.slice(-3).map((l) => l.text.slice(0, 80)))}`,
    );
    assert.equal(runtimeTab.agentSession.agent.state.messages.at(-1)?.role, "assistant");

    const continueFailure = runtimeTab.chat.some((line) =>
      /Compaction failed:.*Cannot continue from message role: assistant/i.test(line.text),
    );
    assert.equal(continueFailure, false);
    assert.equal(tab.status, "idle");
    assert.equal(runtimeTab.session.getBranch().at(-1)?.type, "compaction");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
