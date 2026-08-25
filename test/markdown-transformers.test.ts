import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMarkdownTransformers,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import type { ChatLine } from "../src/agent/runtime.js";
import { chatBlockRenderOptions } from "../src/ui/rendering/agent-surface-options.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { renderMarkdown } from "../src/ui/rendering/markdown.js";

const markToken: MarkdownTransformer = (md) => md.replaceAll("TOKEN", "AAA");
const markTokenB: MarkdownTransformer = (md) => md.replaceAll("TOKEN", "BBB");
const boom: MarkdownTransformer = () => {
  throw new Error("transformer boom");
};
const afterBoom: MarkdownTransformer = (md) => md.replaceAll("SAFE", "OK");

test("renderMarkdown applies extension transformers after mermaid", () => {
  const out = stripAnsi(
    renderMarkdown("hello TOKEN", 80, {
      messageType: "assistant",
      transformers: [markToken],
    }).join("\n"),
  );
  assert.match(out, /AAA/);
  assert.doesNotMatch(out, /TOKEN/);
});

test("renderMarkdown keeps current markdown when a transformer throws", () => {
  const out = stripAnsi(
    renderMarkdown("SAFE TOKEN", 80, {
      messageType: "user",
      transformers: [boom, afterBoom],
    }).join("\n"),
  );
  assert.match(out, /OK/);
  assert.match(out, /TOKEN/);
});

test("applyMarkdownTransformers matches Pi sequential / swallow-error contract", () => {
  const ctx = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };
  assert.equal(applyMarkdownTransformers("TOKEN", ctx, [markToken]), "AAA");
  assert.equal(applyMarkdownTransformers("SAFE", ctx, [boom, afterBoom]), "OK");
  assert.equal(applyMarkdownTransformers("x", ctx, [() => 1 as unknown as string]), "x");
});

test("renderChatBlock assistant path uses markdownTransformers", () => {
  const line: ChatLine = { role: "assistant", text: "see TOKEN here" };
  const out = stripAnsi(
    renderChatBlock(line, 80, undefined, undefined, {
      markdownTransformers: [markToken],
    }).join("\n"),
  );
  assert.match(out, /AAA/);
  assert.doesNotMatch(out, /TOKEN/);
});

test("renderChatBlock user path uses markdownTransformers", () => {
  const line: ChatLine = { role: "user", text: "user TOKEN" };
  const out = stripAnsi(
    renderChatBlock(line, 80, undefined, undefined, {
      markdownTransformers: [markToken],
    }).join("\n"),
  );
  assert.match(out, /AAA/);
});

test("renderChatBlock thinking path uses markdownTransformers", () => {
  const line: ChatLine = { role: "thinking", text: "think TOKEN" };
  const out = stripAnsi(
    renderChatBlock(line, 80, undefined, undefined, {
      markdownTransformers: [markToken],
    }).join("\n"),
  );
  assert.match(out, /AAA/);
});

test("chat line cache invalidates when transformers change", () => {
  const line: ChatLine = { role: "assistant", text: "cache TOKEN" };
  const first = stripAnsi(
    renderChatBlock(line, 80, undefined, undefined, {
      markdownTransformers: [markToken],
    }).join("\n"),
  );
  const second = stripAnsi(
    renderChatBlock(line, 80, undefined, undefined, {
      markdownTransformers: [markTokenB],
    }).join("\n"),
  );
  assert.match(first, /AAA/);
  assert.match(second, /BBB/);
  assert.notEqual(first, second);
});

test("chatBlockRenderOptions pulls getMarkdownTransformers from extensionRunner", () => {
  const transformers = [markToken];
  const runtimeTab = {
    chat: [{ role: "assistant", text: "x" }] as ChatLine[],
    agentSession: {
      extensionRunner: {
        getMarkdownTransformers: () => transformers,
      },
    },
  };
  const options = chatBlockRenderOptions(runtimeTab as never, 0, {});
  assert.ok(options?.markdownTransformers);
  assert.equal(options!.markdownTransformers, transformers);
});

test("skill expanded body does not receive extension transformers", () => {
  // Pi SkillInvocationMessageComponent uses plain Markdown (no transformers).
  const skillText = [
    '<skill name="demo" location="/tmp/demo">',
    "skill body TOKEN",
    "</skill>",
  ].join("\n");
  const line: ChatLine = { role: "user", text: skillText };
  const tab = {
    extensionUi: { toolsExpanded: true },
  };
  const out = stripAnsi(
    renderChatBlock(line, 80, tab as never, undefined, {
      markdownTransformers: [markToken],
    }).join("\n"),
  );
  assert.match(out, /TOKEN/);
  assert.doesNotMatch(out, /AAA/);
});
