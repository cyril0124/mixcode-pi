/**
 * Headless-friendly TUI harness for dual-queue follow-up verification.
 * Launched under an isolated tmux socket by test/follow-up-tmux.test.ts.
 *
 * Env:
 *   MIXCODE_FOLLOWUP_HARNESS_DIR  - workdir/sessions root
 *   MIXCODE_FOLLOWUP_MARKER       - file written when dual queues are ready
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createInitialState,
  createMixCodeTui,
  createTab,
} from "./helpers/mixcode.js";

const root = process.env.MIXCODE_FOLLOWUP_HARNESS_DIR;
const marker = process.env.MIXCODE_FOLLOWUP_MARKER;
if (!root || !marker) {
  console.error("MIXCODE_FOLLOWUP_HARNESS_DIR and MIXCODE_FOLLOWUP_MARKER are required");
  process.exit(2);
}

fs.mkdirSync(root, { recursive: true });

let releaseTool!: () => void;
const toolReleased = new Promise<void>((resolve) => {
  releaseTool = resolve;
});
let toolStarted!: () => void;
const toolRunning = new Promise<void>((resolve) => {
  toolStarted = resolve;
});

function toolCallMessage(toolCall: ToolCall): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: "follow-up-tui",
    provider: "follow-up-tui",
    model: "follow-up-tui-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function textMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "follow-up-tui",
    provider: "follow-up-tui",
    model: "follow-up-tui-model",
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
}

function streamMessage(message: AssistantMessage, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      const aborted: AssistantMessage = {
        ...message,
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
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

function lastUserText(context: Context): string {
  const users = context.messages.filter((m) => m.role === "user");
  const last = users.at(-1);
  if (!last || !("content" in last)) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

const model: Model<string> = {
  ...MIXCODE_FAUX_MODEL,
  provider: "follow-up-tui",
  api: "follow-up-tui",
  id: "follow-up-tui-model",
};

const runtime = new MixCodeRuntime({
  sessionsRoot: path.join(root, "sessions"),
  streamFn: (_m, context, options) => {
    const text = lastUserText(context);
    if (text === "do work") {
      return streamMessage(
        toolCallMessage({ type: "toolCall", id: "tc-1", name: "slow_tool", arguments: {} }),
        options,
      );
    }
    return streamMessage(textMessage(`Echo: ${text}`), options);
  },
  extensionFactories: [
    (pi) => {
      pi.registerTool({
        name: "slow_tool",
        label: "Slow Tool",
        description: "Blocks until released.",
        parameters: Type.Object({}),
        execute: async () => {
          toolStarted();
          await toolReleased;
          return { content: [{ type: "text", text: "tool done" }], details: {} };
        },
      });
    },
  ],
});

const state = createInitialState(root);
const tab = createTab(1, "s1", root, {
  model: {
    provider: model.provider,
    modelId: model.id,
    displayName: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
  },
});
state.tabs = [tab];
state.activeTabId = "s1";

await runtime.createTab(tab, {
  systemPrompt: "system",
  thinkingLevel: "medium",
  workdir: root,
  model,
});

const tui = createMixCodeTui(state, runtime, { exitProcessOnQuit: false });
tui.start();

// Drive dual-queue scenario after the TUI is up.
void (async () => {
  await Bun.sleep(400);
  void runtime.prompt("s1", "do work");
  await toolRunning;
  await runtime.prompt("s1", "steer now");
  await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });

  // Wait until UI state has both queues.
  for (let i = 0; i < 100; i++) {
    if (tab.pendingMessages.includes("steer now") && tab.pendingFollowUps.includes("follow later")) {
      tui.requestRender();
      fs.writeFileSync(
        marker,
        JSON.stringify({
          pendingMessages: tab.pendingMessages,
          pendingFollowUps: tab.pendingFollowUps,
        }),
      );
      break;
    }
    await Bun.sleep(50);
  }
})();

// Poll for release signal file written by the tmux driver after Esc checks.
const releaseFile = path.join(root, "release");
void (async () => {
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(releaseFile)) {
      releaseTool();
      // Wait for follow-up delivery after idle.
      for (let j = 0; j < 100; j++) {
        if (tab.pendingFollowUps.length === 0 && !runtime.getTab("s1")?.agentSession.isStreaming) {
          fs.writeFileSync(
            path.join(root, "idle.json"),
            JSON.stringify({ pendingFollowUps: tab.pendingFollowUps }),
          );
          break;
        }
        await Bun.sleep(50);
      }
      try {
        tui.stop();
      } catch {
        // ignore
      }
      process.exit(0);
    }
    await Bun.sleep(100);
  }
})();

// Keep alive for tmux capture; release tool and exit on SIGTERM.
process.on("SIGTERM", () => {
  releaseTool();
  try {
    tui.stop();
  } catch {
    // ignore
  }
  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  releaseTool();
  try {
    tui.stop();
  } catch {
    // ignore
  }
  process.exit(0);
}, 60_000);
