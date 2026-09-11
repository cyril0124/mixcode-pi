import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  entriesForRestoredChat,
  RESTORED_CHAT_ENTRY_LIMIT,
} from "../src/agent/runtime-lifecycle.js";

test("restored chat keeps the newest entries within the UI window", () => {
  const entries = Array.from({ length: RESTORED_CHAT_ENTRY_LIMIT + 3 }, (_, index) => ({
    type: "custom",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(0).toISOString(),
    customType: "fixture",
    data: { index },
  })) as unknown as SessionEntry[];

  const restored = entriesForRestoredChat(entries);

  assert.equal(restored.length, RESTORED_CHAT_ENTRY_LIMIT);
  assert.equal((restored[0] as { data: { index: number } }).data.index, 3);
  assert.equal(
    (restored.at(-1) as { data: { index: number } }).data.index,
    RESTORED_CHAT_ENTRY_LIMIT + 2,
  );
});

test("small restored chats keep their original entries", () => {
  const entries = [] as SessionEntry[];
  assert.strictEqual(entriesForRestoredChat(entries), entries);
});
