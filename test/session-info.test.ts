import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  computeCacheWaste,
  createAgentSession,
  getUsageCostBreakdown,
  SessionManager,
  SettingsManager,
  type CacheWarmingStatus,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { formatSessionTokens, renderSessionInfoText } from "../src/ui/components/session-info.js";

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

const BASE_STATS = {
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
};

test("renderSessionInfoText always includes Tab and Workdir when provided", () => {
  const withName = renderSessionInfoText({ getSessionName: () => "Daily work" }, BASE_STATS, {
    tabTitle: "Agent-01",
    workdir: "/repo",
  });
  assert.match(
    withName,
    /^Session Info\n\nTab: Agent-01\nWorkdir: \/repo\nName: Daily work\nFile: \/tmp\/session\.jsonl/,
  );
  assert.doesNotMatch(withName, /\bContext\b/);

  const noName = renderSessionInfoText(
    { getSessionName: () => undefined },
    { ...BASE_STATS, sessionFile: undefined, sessionId: "s1" },
    { tabTitle: "Agent-01", workdir: "/repo" },
  );
  assert.match(noName, /^Session Info\n\nTab: Agent-01\nWorkdir: \/repo\nFile: In-memory/);
  assert.doesNotMatch(noName, /Name:/);
  assert.doesNotMatch(noName, /\bContext\b/);
});

test("renderSessionInfoText matches Pi prompt-volume Input and Tools line", () => {
  const text = renderSessionInfoText({ getSessionName: () => "Daily work" }, BASE_STATS);
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
  const { renderConversation } = await import("../src/ui/rendering/chat.js");
  const { MIXCODE_DARK_THEME } = await import("../src/ui/themes.js");
  const { renderWithTheme } = await import("../src/ui/rendering/context.js");
  const text = renderSessionInfoText({ getSessionName: () => "Daily work" }, BASE_STATS, {
    tabTitle: "Agent-01",
    workdir: "/repo",
    cacheWarming: { mode: "off", status: { state: "inactive", reason: "cache warming disabled" } },
  });
  const rendered = renderWithTheme(MIXCODE_DARK_THEME, () =>
    renderConversation([{ role: "system", text, variant: "system-plain" }], 80).join("\n"),
  );
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Session Info"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Messages"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Tokens"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Cost"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.bold("Cache Warming"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Tab:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Workdir:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("File:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Name:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Input:"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.dim("Cached:"))));
  // Value text should not be forced dim-only: File path uses theme.text.
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.text("Daily work"))));
  assert.match(rendered, new RegExp(escapeRegExp(MIXCODE_DARK_THEME.text("/tmp/session.jsonl"))));
});

test("session cache warming shows waiting and unavailable states without invented economics", () => {
  const waiting = renderSessionInfoText({}, BASE_STATS, {
    cacheWarming: {
      mode: "streaming",
      status: { state: "inactive", reason: "waiting for a request" },
    },
  });
  assert.match(
    waiting,
    /Cache Warming\nMode: streaming\nStatus: Inactive \(waiting for a request\)/,
  );
  assert.doesNotMatch(waiting, /Cache miss penalty:|Refresh cost:/);

  const unavailable = renderSessionInfoText({}, BASE_STATS, {
    cacheWarming: { mode: "idle" },
  });
  assert.match(unavailable, /Mode: idle\nStatus: Inactive \(cache warming unavailable\)/);
  assert.doesNotMatch(unavailable, /Cache miss penalty:|Refresh cost:/);
});

for (const state of ["scheduled", "refreshing"] as const) {
  test(`session cache warming shows ${state} economics with Pi status wording`, () => {
    const status: CacheWarmingStatus = {
      state,
      nextWarmAt: 0,
      decision: {
        phase: "streaming",
        warmCost: 0.125,
        missCost: 1.5,
        continuationProbability: 0.8,
        expectedSavings: 1.075,
        economicsAvailable: true,
        action: "warm",
      },
    };
    const text = renderSessionInfoText({}, BASE_STATS, {
      cacheWarming: { mode: "streaming", status },
    });
    assert.match(text, state === "scheduled" ? /Status: Decision now/ : /Status: Warming cache/);
    assert.match(text, /80% continuation probability while agent is running/);
    assert.match(text, /expected savings \$1\.075 >= \$0\.050 -> warm/);
    assert.match(text, /Cache miss penalty: \$1\.500\nRefresh cost: \$0\.125/);
  });
}

test("persisted cache warming usage survives reopen and remains included once with mode off", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-session-warming-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, path.join(dir, "sessions"));
  manager.appendMessage({
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: usage(100, 20, 0, 0, 0.5),
  });
  manager.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage(2, 1, 1000, 10, 0.125));
  manager.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage(3, 1, 2000, 20, 0.25));
  // Other billed work belongs in the total, but never in the warming subtotal.
  manager.appendUsage("helper", "anthropic", "claude-sonnet-4-5", usage(5, 2, 0, 0, 0.125));
  const file = manager.getSessionFile();
  assert.ok(file);
  const reopened = SessionManager.open(file);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: path.join(dir, "agent"),
    sessionManager: reopened,
    settingsManager: SettingsManager.inMemory({ packages: [], cacheWarming: "off" }),
    model: MIXCODE_FAUX_MODEL,
    noTools: "all",
  });
  t.after(() => session.dispose());
  const stats = session.getSessionStats();
  assert.deepEqual(stats.tokens, {
    input: 110,
    output: 24,
    cacheRead: 3000,
    cacheWrite: 30,
    total: 3164,
  });
  assert.equal(stats.cost, 1);
  const text = renderSessionInfoText(reopened, stats, {
    cacheWarming: {
      mode: session.settingsManager.getCacheWarmingMode(),
      status: session.cacheWarmingStatus,
    },
  });
  assert.match(text, /Mode: off/);
  assert.match(text, /Usage \(included in total\): 2 refreshes/);
  assert.match(
    text,
    / {2}Input: 5\n {2}Cache read: 3,000\n {2}Cache write: 30\n {2}Output: 2\n {2}Cost: \$0\.375/,
  );
  assert.match(text, /Tokens\nInput: 3,140/);
  assert.match(text, /Output: 24\nTotal: 3,164/);
  assert.match(text, /Cost\nTotal: \$1\.000/);
  assert.deepEqual(session.getSessionStats(), stats);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
