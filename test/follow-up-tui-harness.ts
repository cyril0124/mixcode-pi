/**
 * Headless-friendly TUI harness for dual-queue follow-up verification.
 * Launched under an isolated tmux socket by test/follow-up-tmux.test.ts.
 *
 * Env:
 *   MIXCODE_FOLLOWUP_HARNESS_DIR  - workdir/sessions root
 *   MIXCODE_FOLLOWUP_MARKER       - file written when the scenario is ready
 *   MIXCODE_FOLLOWUP_BATCH        - leave input queues empty for interactive /batch testing
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createInitialState,
  createMixCodeTui,
  createTab,
  type MixCodeModel,
} from "./helpers/mixcode.js";

const root = process.env.MIXCODE_FOLLOWUP_HARNESS_DIR;
const marker = process.env.MIXCODE_FOLLOWUP_MARKER;
const batchScenario = process.env.MIXCODE_FOLLOWUP_BATCH === "1";
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

function userMessages(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    });
}

let modelUserMessages: string[] = [];

const model: MixCodeModel = {
  ...MIXCODE_FAUX_MODEL,
  provider: "follow-up-tui",
  api: "follow-up-tui",
  id: "follow-up-tui-model",
};

const runtime = new MixCodeRuntime({
  agentDir: path.join(root, "agent"),
  settingsManager: SettingsManager.inMemory({ packages: [] }),
  sessionsRoot: path.join(root, "sessions"),
  streamFn: (_m, context, options) => {
    modelUserMessages = userMessages(context);
    const text = modelUserMessages.at(-1) ?? "";
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
  if (!batchScenario) {
    await runtime.prompt("s1", "steer now");
    await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });
  }

  // Batch verification submits its script through the real editor after startup.
  for (let i = 0; i < 100; i++) {
    if (
      batchScenario ||
      (tab.pendingMessages.includes("steer now") && tab.pendingFollowUps.includes("follow later"))
    ) {
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

// Keep the terminal alive after release so the driver can verify paused idle,
// explicitly resume through the editor, and observe the resulting model input.
const releaseFile = path.join(root, "release");
void (async () => {
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(releaseFile)) {
      releaseTool();
      const snapshot = JSON.stringify({
        isIdle: runtime.getTab("s1")?.agentSession.isIdle ?? false,
        pendingFollowUps: tab.pendingFollowUps,
        followUpsPaused: tab.followUpsPaused,
        color: tab.color,
        modelUserMessages,
      });
      // Atomic replacement prevents the driver from observing partial JSON.
      await Bun.write(path.join(root, "idle.json.tmp"), snapshot);
      await fs.promises.rename(path.join(root, "idle.json.tmp"), path.join(root, "idle.json"));
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
