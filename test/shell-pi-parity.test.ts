import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  BashAlreadyRunningError,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  chatLinesForDisplay,
  createInitialState,
  createTab,
  handleSubmittedInput,
  isBashAlreadyRunningError,
  renderChat,
} from "../src/index.js";
import { renderConversation } from "../src/ui/rendering/chat.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function waitForRuntime(predicate: () => boolean, attempts = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      if (predicate()) return resolve();
      attempt += 1;
      if (attempt >= attempts) return reject(new Error("Timed out waiting for runtime condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "timer-test",
    provider: "timer-test",
    model: "timer-test-model",
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

const TIMER_MODEL: Model<string> = {
  ...MIXCODE_FAUX_MODEL,
  provider: "timer-test",
  api: "timer-test",
  id: "timer-test-model",
  contextWindow: 1000,
} as Model<string>;

test("BashAlreadyRunningError is recognizable for submit restore", () => {
  const error = new BashAlreadyRunningError();
  assert.equal(isBashAlreadyRunningError(error), true);
  assert.match(error.message, /already running/i);
  assert.match(error.message, /Esc to cancel/i);
});

test("concurrent !shell restores editor text and warns (Pi parity)", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bash-conflict-"));
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });

    let editorText = "";
    const editorActions = {
      setText: (value: string) => {
        editorText = value;
      },
    };
    const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

    const first = handleSubmittedInput(
      state,
      runtime,
      "!sh -c 'printf start; sleep 0.2; printf end'",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    );
    await Bun.sleep(20);
    await handleSubmittedInput(
      state,
      runtime,
      "!echo second",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    );
    assert.equal(editorText, "!echo second");
    const runtimeTab = runtime.getTab("s1");
    assert.ok(runtimeTab);
    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes("already running") &&
          line.text.includes("Esc to cancel"),
      ),
    );
    await first;
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("user-bash running status shows Esc cancel hint", () => {
  const rendered = stripAnsi(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          variant: "user-bash",
          status: "running",
          text: "",
          args: { command: "sleep 1" },
        },
      ],
      80,
    ).join("\n"),
  );
  assert.match(rendered, /Running\.\.\. \(Esc to cancel\)/);
});

test("pending user-bash rendering preserves original chat indices", () => {
  const chat = [
    { role: "user" as const, text: "before" },
    {
      role: "tool" as const,
      variant: "user-bash" as const,
      pendingBash: true,
      text: "shell",
    },
    { role: "assistant" as const, text: "after" },
  ];
  const indices: number[] = [];

  renderConversation(chat, 80, undefined, {
    blockOptions: (_line, index) => {
      indices.push(index);
      return undefined;
    },
  });

  assert.deepEqual(indices, [0, 2, 1]);
});

test("streaming-started user bash stays pending until agent_end", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bash-pending-"));
  try {
    let releaseRun!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => {
        const message = assistantText("slow answer");
        const stream = createAssistantMessageEventStream();
        void (async () => {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          await releaseRunPromise;
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "slow answer",
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message } as never);
          stream.end(message);
        })();
        return stream;
      },
    });
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: TIMER_MODEL.provider,
        modelId: TIMER_MODEL.id,
        displayName: `${TIMER_MODEL.provider}/${TIMER_MODEL.id}`,
        contextWindow: TIMER_MODEL.contextWindow,
      },
      contextLimit: 1000,
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });

    const promptDone = runtime.prompt("s1", "go");
    await waitForRuntime(() => runtimeTab.agentSession.isStreaming === true);

    await runtime.executeShellCommand("s1", "echo shell-ok");
    const pendingLine = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.variant === "user-bash",
    );
    assert.ok(pendingLine);
    assert.equal(pendingLine.pendingBash, true);
    assert.equal(pendingLine.status, "success");
    assert.match(pendingLine.text, /shell-ok/);

    // Display order: main chat first, pending bash last (Pi pending-area parity).
    const ordered = chatLinesForDisplay(runtimeTab.chat);
    const bashIndex = ordered.findIndex(
      (line) => line.role === "tool" && line.variant === "user-bash",
    );
    assert.equal(bashIndex, ordered.length - 1);

    releaseRun();
    await promptDone;
    await waitForRuntime(
      () =>
        runtimeTab.chat.find(
          (line) => line.role === "tool" && line.variant === "user-bash",
        )?.pendingBash !== true,
    );

    const after = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.variant === "user-bash",
    );
    assert.ok(after);
    assert.equal(after.pendingBash, undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
