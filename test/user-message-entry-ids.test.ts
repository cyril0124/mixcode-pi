import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { userMessageEntryIdsInBranch } from "../src/ui/chat-scroll-target.js";

function entry(
  id: string,
  type: string,
  role?: string,
): SessionEntry {
  if (type !== "message") {
    return { type, id } as unknown as SessionEntry;
  }
  return {
    type: "message",
    id,
    message: { role },
  } as unknown as SessionEntry;
}

test("userMessageEntryIdsInBranch returns only user message entry ids in order", () => {
  const branch = [
    entry("u1", "message", "user"),
    entry("a1", "message", "assistant"),
    entry("t1", "message", "toolResult"),
    entry("comp1", "compaction"),
    entry("u2", "message", "user"),
    entry("a2", "message", "assistant"),
    entry("u3", "message", "user"),
  ];

  assert.deepEqual(userMessageEntryIdsInBranch(branch), ["u1", "u2", "u3"]);
});

test("userMessageEntryIdsInBranch returns empty array when no user messages", () => {
  const branch = [
    entry("a1", "message", "assistant"),
    entry("t1", "message", "toolResult"),
    entry("comp1", "compaction"),
  ];

  assert.deepEqual(userMessageEntryIdsInBranch(branch), []);
});
