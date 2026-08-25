import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToChatLines } from "../src/agent/runtime-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { renderConversation } from "../src/ui/rendering/chat.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function expectedClock(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

test("user message puts local send time on the first body line", () => {
  const timestamp = Date.UTC(2026, 7, 9, 9, 7, 0);
  const clock = expectedClock(timestamp);
  const plain = renderConversation(
    [{ role: "user", text: "hello there", timestamp }],
    40,
  ).map(stripAnsi);

  // Blank top spacing preserved; first body line holds text + right-aligned clock.
  assert.equal((plain[0] ?? "").trim(), "");
  assert.match(
    plain[1] ?? "",
    new RegExp(`hello there\\s+${escapeRegExp(clock)}\\s*$`),
  );
});

test("user message without timestamp keeps a blank top pad", () => {
  const plain = renderConversation([{ role: "user", text: "hello there" }], 40).map(stripAnsi);
  assert.equal((plain[0] ?? "").trim(), "");
  assert.match(plain.join("\n"), /hello there/);
  assert.doesNotMatch(plain[1] ?? "", /\d{1,2}:\d{2}/);
});

test("narrow width still renders without overflowing the clock", () => {
  const timestamp = Date.UTC(2026, 7, 9, 21, 45, 0);
  const clock = expectedClock(timestamp);
  const width = 12;
  const plain = renderConversation(
    [{ role: "user", text: "hi", timestamp }],
    width,
  ).map(stripAnsi);

  for (const line of plain) {
    assert.ok(line.length <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
  }
  // Clock may be ellipsis-truncated; require a locale-stable prefix fragment.
  const fragment = clock.slice(0, Math.min(3, clock.length));
  assert.match(plain.join("\n"), new RegExp(escapeRegExp(fragment)));
});

test("entriesToChatLines carries message timestamp for user rows", () => {
  const messageTimestamp = 1_776_000_000_000;
  const branch = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-04-12T08:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "reload me" }],
        timestamp: messageTimestamp,
      },
    },
  ] as never[];

  const lines = entriesToChatLines(branch, fakeRuntimeTab());
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.role, "user");
  assert.equal(lines[0]?.text, "reload me");
  assert.equal(lines[0]?.timestamp, messageTimestamp);
  assert.equal(lines[0]?.entryId, "u1");
});

test("entriesToChatLines falls back to entry timestamp when message timestamp is missing", () => {
  const branch = [
    {
      type: "message",
      id: "u2",
      parentId: null,
      timestamp: "2026-04-12T15:30:00.000Z",
      message: {
        role: "user",
        content: "fallback clock",
      },
    },
  ] as never[];

  const lines = entriesToChatLines(branch, fakeRuntimeTab());
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.timestamp, Date.parse("2026-04-12T15:30:00.000Z"));
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
