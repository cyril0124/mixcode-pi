import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToChatLines } from "../src/agent/runtime-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { contentImages, userMessageText } from "../src/agent/runtime-tool-chat.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { activeRenderTheme } from "../src/ui/rendering/context.js";

function fakeRuntimeTab(): RuntimeTab {
  return {
    chat: [],
    session: { getBranch: () => [] },
    agentSession: {
      settingsManager: { getShowCacheMissNotices: () => false },
      extensionRunner: { getMessageRenderer: () => undefined },
    },
  } as unknown as RuntimeTab;
}

// 1x1 PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("userMessageText keeps only text blocks (Pi getUserMessageText)", () => {
  assert.equal(userMessageText("plain"), "plain");
  assert.equal(
    userMessageText([
      { type: "text", text: "hello" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: " world" },
    ]),
    "hello world",
  );
  assert.equal(
    userMessageText([{ type: "image", data: "abc", mimeType: "image/png" }]),
    "",
  );
});

test("contentImages extracts image blocks", () => {
  const images = contentImages([
    { type: "text", text: "look" },
    { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
    { type: "image", data: "nope", mimeType: "image/jpeg" },
  ]);
  assert.equal(images.length, 2);
  assert.equal(images[0]?.mimeType, "image/png");
  assert.equal(images[1]?.data, "nope");
});

test("user message renders markdown instead of plain wrap", () => {
  const plain = stripAnsi(
    renderChatBlock(
      { role: "user", text: "use **bold** and `code`" },
      60,
      undefined,
      activeRenderTheme,
    ).join("\n"),
  );
  assert.match(plain, /bold/);
  assert.match(plain, /code/);
  // Markdown bold/code should not leave raw markers as the only representation.
  assert.doesNotMatch(plain, /\*\*bold\*\*/);
});

test("user message with list markers preserves source numbering (Pi)", () => {
  const plain = stripAnsi(
    renderChatBlock(
      { role: "user", text: "1. first\n2. second" },
      40,
      undefined,
      activeRenderTheme,
    ).join("\n"),
  );
  assert.match(plain, /1\./);
  assert.match(plain, /2\./);
  assert.match(plain, /first/);
  assert.match(plain, /second/);
});

test("user message renders image fallback/protocol lines", () => {
  const lines = renderChatBlock(
    {
      role: "user",
      text: "see this",
      images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    },
    40,
    undefined,
    activeRenderTheme,
    { showImages: true, imageWidthCells: 20 },
  );
  const plain = stripAnsi(lines.join("\n"));
  assert.match(plain, /see this/);
  // Image component emits either protocol sequences or a text fallback like "[image/png ...]".
  assert.ok(
    lines.some((line) => line.includes("\x1b") && line !== lines[0]) ||
      /image\/png|\[image/i.test(plain) ||
      lines.length > 3,
    `expected image output, got: ${JSON.stringify(plain)}`,
  );
});

test("user message hides images when showImages is false", () => {
  const without = renderChatBlock(
    {
      role: "user",
      text: "see this",
      images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    },
    40,
    undefined,
    activeRenderTheme,
    { showImages: false },
  );
  const rendered = without.join("\n");
  assert.match(stripAnsi(rendered), /see this/);
  assert.doesNotMatch(rendered, /\x1b_G|\x1b\]1337|image\/png|\[image/i);
});

test("image-only user message still renders (no text body required)", () => {
  const lines = renderChatBlock(
    {
      role: "user",
      text: "",
      images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    },
    40,
    undefined,
    activeRenderTheme,
    { showImages: true },
  );
  const plain = stripAnsi(lines.join("\n"));
  assert.ok(
    lines.some((line) => line.includes("\x1b")) || /image\/png|\[image/i.test(plain),
    `expected image output, got: ${JSON.stringify(plain)}`,
  );
});

test("entriesToChatLines carries user images and text-only body", () => {
  const branch = [
    {
      type: "message",
      id: "u-img",
      parentId: null,
      timestamp: "2026-04-12T08:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        ],
        timestamp: 1_776_000_000_000,
      },
    },
  ] as never[];

  const lines = entriesToChatLines(branch, fakeRuntimeTab());
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.role, "user");
  assert.equal(lines[0]?.text, "caption");
  assert.equal(lines[0]?.images?.length, 1);
  assert.equal(lines[0]?.images?.[0]?.mimeType, "image/png");
  // Must not leak the old `[image]` placeholder into the text body.
  assert.doesNotMatch(lines[0]?.text ?? "", /\[image\]/);
});
