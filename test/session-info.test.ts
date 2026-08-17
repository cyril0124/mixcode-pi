import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCacheWaste,
  getUsageCostBreakdown,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatSessionTokens, renderSessionInfoText } from "../src/ui/session-info.js";

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  costTotal: number,
  costParts: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }> = {},
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: costParts.input ?? 0,
      output: costParts.output ?? 0,
      cacheRead: costParts.cacheRead ?? 0,
      cacheWrite: costParts.cacheWrite ?? 0,
      total: costTotal,
    },
  };
}

test("renderSessionInfoText matches Pi prompt-volume Input and Tools line", () => {
  const text = renderSessionInfoText(
    { getSessionName: () => "Daily work" },
    {
      sessionFile: "/tmp/session.jsonl",
      sessionId: "abc123",
      userMessages: 3,
      assistantMessages: 11,
      toolCalls: 18,
      toolResults: 18,
      totalMessages: 32,
      tokens: {
        input: 24_152,
        output: 3_077,
        cacheRead: 148_736,
        cacheWrite: 0,
        total: 175_965,
      },
      cost: 1.23456,
    },
  );
  assert.match(text, /Tools: 18 calls, 18 results/);
  assert.match(text, /Input: 172,888/);
  assert.match(text, /Cached: 148,736 \(86\.0%\)/);
  assert.match(text, /Uncached: 24,152/);
  assert.match(text, /Total: \$1\.235/);
  assert.doesNotMatch(text, /\bContext\b/);
});

test("renderSessionInfoText shows multi-model cost breakdown and cache re-bill", () => {
  const entries = [
    {
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-a",
        timestamp: 1_000,
        // Prompt has cache activity so later zero-cache rebill counts as waste.
        usage: usage(100, 100, 0, 5_000, 0.5, { input: 0.1, cacheWrite: 0.4 }),
        content: [],
        stopReason: "stop",
        api: "openai",
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "a1",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-b",
        responseModel: "gpt-b-real",
        timestamp: 2_000,
        // Re-bills previous prompt volume with no cache reads.
        usage: usage(5_100, 50, 0, 0, 0.4, { input: 0.4 }),
        content: [],
        stopReason: "stop",
        api: "openai",
      },
    },
  ] as unknown as SessionEntry[];

  const breakdown = getUsageCostBreakdown(entries);
  assert.equal(breakdown.length, 2);
  assert.deepEqual(
    breakdown.map((e) => e.key),
    ["openai/gpt-a", "openai/gpt-b-real"],
  );

  const waste = computeCacheWaste(entries, { getModel: () => undefined });
  assert.ok(waste.missedTokens > 1024);
  assert.equal(waste.missCount, 1);

  const text = renderSessionInfoText(
    { getSessionName: () => undefined, getEntries: () => entries },
    {
      sessionFile: undefined,
      sessionId: "s1",
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 3,
      tokens: { input: 10_000, output: 150, cacheRead: 0, cacheWrite: 0, total: 10_150 },
      cost: 0.9,
    },
    { entries },
  );
  assert.match(text, /File: In-memory/);
  assert.match(text, /openai\/gpt-a: \$0\.500/);
  assert.match(text, /openai\/gpt-b-real: \$0\.400/);
  assert.match(text, /Cache Re-billed:/);
  assert.equal(formatSessionTokens(1500), "1.5k");
});

test("system-plain session dump uses bold headers and dim labels", async () => {
  const { renderChat } = await import("../src/ui/rendering/chat.js");
  const { MIXCODE_DARK_THEME } = await import("../src/ui/themes.js");
  const { renderWithTheme } = await import("../src/ui/rendering/context.js");
  const text = renderSessionInfoText(
    { getSessionName: () => "Daily work" },
    {
      sessionFile: "/tmp/session.jsonl",
      sessionId: "abc123",
      userMessages: 3,
      assistantMessages: 11,
      toolCalls: 18,
      toolResults: 18,
      totalMessages: 32,
      tokens: {
        input: 24_152,
        output: 3_077,
        cacheRead: 148_736,
        cacheWrite: 0,
        total: 175_965,
      },
      cost: 1.23456,
    },
  );
  const rendered = renderWithTheme(MIXCODE_DARK_THEME, () =>
    renderChat([{ role: "system", text, variant: "system-plain" }], 80).join("\n"),
  );
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Session Info"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Messages"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Tokens"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Cost"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("File:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Name:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Input:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Cached:"))));
  // Value text should not be forced dim-only: File path uses theme.text.
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.text("Daily work"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.text("/tmp/session.jsonl"))));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
