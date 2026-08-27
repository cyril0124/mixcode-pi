// Real-pipeline scroll-freeze regression: drive the actual MixCodeRuntime event
// flow (message_update/message_end/agent_end) with a paced streaming fn and
// render through MixCodeRoot so viewport height changes (working loader) happen
// for real. Contract: after PageUp mid-stream, the top visible line stays
// identical across continued growth and run completion.
import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  MixCodeRoot,
  MixCodeRuntime,
  MIXCODE_FAUX_MODEL,
  createInitialState,
  createTab,
  scrollChat,
} from "./helpers/mixcode.js";

const bigText = [
  "# Long streaming answer",
  "",
  ...Array.from({ length: 210 }, (_, index) => {
    if (index === 60) return "```ts";
    if (index === 120) return "```";
    if (index % 25 === 0) return "";
    return `MDLINE-${String(index).padStart(3, "0")} word content wraps around ${index}`;
  }),
].join("\n");
const thinkingText = "pondering the answer before writing it out in full detail";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "scroll-freeze-runtime",
    provider: "scroll-freeze-runtime",
    model: "scroll-freeze-runtime-model",
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

function lastUserText(context: Context): string {
  const last = context.messages.at(-1);
  if (typeof last?.content === "string") return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return "";
}

function pacedStream(context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const userText = lastUserText(context);
    const isHistory = /^h\d+$/.test(userText);
    const isBig = userText === "go";
    const base = isBig
      ? assistantMessage([
          { type: "thinking", thinking: thinkingText },
          { type: "text", text: bigText },
        ])
      : assistantMessage([
          {
            type: "text",
            text: isHistory ? `history answer ${userText}` : "compacted summary of earlier turns",
          },
        ]);
    if (options?.signal?.aborted) {
      const aborted = {
        ...base,
        content: [],
        stopReason: "aborted" as const,
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "start", partial: { ...base, content: [] } });
    if (userText === "go") {
      stream.push({ type: "thinking_start", contentIndex: 0, partial: { ...base, content: [] } });
      stream.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: thinkingText,
        partial: { ...base, content: [{ type: "thinking", thinking: thinkingText }] },
      });
      stream.push({
        type: "thinking_end",
        contentIndex: 0,
        content: thinkingText,
        partial: { ...base, content: [{ type: "thinking", thinking: thinkingText }] },
      });
    }
    const textIndex = isBig ? 1 : 0;
    const fullText = isBig
      ? bigText
      : base.content.at(-1)!.type === "text"
        ? (base.content.at(-1) as { text: string }).text
        : "";
    stream.push({
      type: "text_start",
      contentIndex: textIndex,
      partial: { ...base, content: [{ type: "text", text: "" }] },
    });
    const chunks = fullText.match(/[\s\S]{1,300}/g) ?? [""];
    let acc = "";
    for (const chunk of chunks) {
      if (options?.signal?.aborted) return;
      await Bun.sleep(isBig ? 80 : 0);
      acc += chunk;
      const partial = {
        ...base,
        content: [{ type: "text", text: acc }] as AssistantMessage["content"],
      };
      stream.push({ type: "text_delta", contentIndex: textIndex, delta: chunk, partial });
    }
    stream.push({ type: "text_end", contentIndex: textIndex, content: fullText, partial: base });
    stream.push({ type: "done", reason: "stop", message: base });
    stream.end(base);
  });
  return stream;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(15);
  }
}

test("real runtime keeps a PageUp anchor across streaming growth and completion", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-scroll-rt-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model, context, options) => pacedStream(context, options),
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: {
        ...MIXCODE_FAUX_MODEL,
        provider: "scroll-rt",
        id: "local",
        api: "openai-completions",
      },
    });
    const tab = runtimeTab.tab;
    const state = createInitialState(process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const root = new MixCodeRoot(
      state,
      runtime,
      () => 30,
      () => 2,
    );

    for (let i = 0; i < 12; i++) {
      await runtime.prompt("s1", `h${i}`);
    }

    const done = runtime.prompt("s1", "go");
    await waitFor(() => {
      const last = runtimeTab.chat.at(-1);
      return (
        (tab.status === "running" || tab.status === "thinking") &&
        last?.role === "assistant" &&
        last.text.length > 6_000
      );
    });

    scrollChat(tab, 10);
    const before = root.render(100).map(stripAnsi);
    const anchorRow = before.findIndex((line) => /MDLINE-\d{3}/.test(line));
    const anchor = before[anchorRow];
    assert.ok(anchor, "expected the PageUp viewport inside the streaming markdown");

    const lastLine = runtimeTab.chat.at(-1)!;
    const beforeLen = lastLine.text.length;
    await waitFor(
      () => runtimeTab.chat.at(-1) !== lastLine || runtimeTab.chat.at(-1)!.text.length > beforeLen,
    );
    assert.equal(
      tab.status === "running" || tab.status === "thinking",
      true,
      "expected still streaming on the second frozen frame",
    );
    const mid = root.render(100).map(stripAnsi);
    assert.equal(mid[anchorRow], anchor, "anchor must not move while streaming continues");

    await done;
    await waitFor(() => tab.status === "idle");
    const after = root.render(100).map(stripAnsi);
    assert.equal(after[anchorRow], anchor, "anchor must survive message_end + agent_end");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
