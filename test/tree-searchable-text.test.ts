import assert from "node:assert/strict";
import { test } from "node:test";
import { getSearchableText } from "../src/core/tree-content.js";
import type { SessionTreeNode } from "../src/core/tree-selector.js";

function node(entry: SessionTreeNode["entry"], label?: string): SessionTreeNode {
  return { entry, children: [], ...(label !== undefined ? { label } : {}) } as SessionTreeNode;
}

test("message user with text includes role, text, and label", () => {
  const text = getSearchableText(
    node(
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-05-14T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello world" }] },
      } as SessionTreeNode["entry"],
      "my-label",
    ),
    new Map(),
  );
  assert.match(text, /user/);
  assert.match(text, /hello world/);
  assert.match(text, /my-label/);
});

test("toolResult includes tool name from toolCallMap", () => {
  const map = new Map([["tc-1", { name: "bash", arguments: {} }]]);
  const text = getSearchableText(
    node({
      type: "message",
      id: "m2",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-1",
        content: [{ type: "text", text: "ok" }],
      },
    } as SessionTreeNode["entry"]),
    map,
  );
  assert.match(text, /toolResult/);
  assert.match(text, /bash/);
});

test("bashExecution includes command", () => {
  const text = getSearchableText(
    node({
      type: "message",
      id: "m3",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      message: {
        role: "bashExecution",
        command: "ls -la",
        content: [{ type: "text", text: "out" }],
      },
    } as SessionTreeNode["entry"]),
    new Map(),
  );
  assert.match(text, /bashExecution/);
  assert.match(text, /ls -la/);
});

test("compaction/session_info/model_change/thinking_level_change keywords", () => {
  assert.match(
    getSearchableText(
      node({
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: "2026-05-14T00:00:00.000Z",
      } as SessionTreeNode["entry"]),
      new Map(),
    ),
    /compaction/,
  );

  const sessionInfo = getSearchableText(
    node({
      type: "session_info",
      id: "s1",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      name: "My Session",
    } as SessionTreeNode["entry"]),
    new Map(),
  );
  assert.match(sessionInfo, /title/);
  assert.match(sessionInfo, /My Session/);

  const model = getSearchableText(
    node({
      type: "model_change",
      id: "mc1",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      modelId: "gpt-4",
    } as SessionTreeNode["entry"]),
    new Map(),
  );
  assert.match(model, /model/);
  assert.match(model, /gpt-4/);

  const thinking = getSearchableText(
    node({
      type: "thinking_level_change",
      id: "tl1",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      thinkingLevel: "high",
    } as SessionTreeNode["entry"]),
    new Map(),
  );
  assert.match(thinking, /thinking/);
  assert.match(thinking, /high/);
});

test("custom_message includes customType and content", () => {
  const text = getSearchableText(
    node({
      type: "custom_message",
      id: "cm1",
      parentId: null,
      timestamp: "2026-05-14T00:00:00.000Z",
      customType: "notice",
      content: "hello custom",
    } as SessionTreeNode["entry"]),
    new Map(),
  );
  assert.match(text, /notice/);
  assert.match(text, /hello custom/);
});
