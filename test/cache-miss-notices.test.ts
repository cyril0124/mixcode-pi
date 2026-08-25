import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  appendEmptyRunNotice,
  entriesToChatLines,
  maybeAppendCacheMissNotice,
} from "../src/agent/runtime-chat.js";
import { applyEvent } from "../src/agent/runtime-events.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";

const START = Date.UTC(2026, 0, 1);

function assistant(options: {
  text: string;
  timestamp: number;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputCost?: number;
  stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage {
  const input = options.input ?? 0;
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  const inputCost = options.inputCost ?? 0;
  return {
    role: "assistant",
    content: [{ type: "text", text: options.text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: options.model ?? "claude-sonnet-4-5",
    usage: {
      input,
      output: 1,
      cacheRead,
      cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + 1,
      cost: {
        input: inputCost,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: inputCost,
      },
    },
    stopReason: options.stopReason ?? "stop",
    timestamp: options.timestamp,
  };
}

function messageEntry(
  id: string,
  message: AssistantMessage,
  parentId: string | null,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function runtimeTab(entries: SessionEntry[], enabled: boolean): RuntimeTab {
  return {
    chat: [],
    tab: createTab(1, "s1", "/repo"),
    session: { getEntries: () => entries },
    agentSession: {
      settingsManager: { getShowCacheMissNotices: () => enabled },
      modelRuntime: {
        getModel: () => ({ cost: { cacheRead: 1 } }),
      },
      extensionRunner: { getMessageRenderer: () => undefined },
    },
  } as unknown as RuntimeTab;
}

function significantMiss(options?: {
  idleMs?: number;
  model?: string;
  stopReason?: AssistantMessage["stopReason"];
}): { entries: SessionEntry[]; previous: AssistantMessage; message: AssistantMessage } {
  const previous = assistant({
    text: "first",
    timestamp: START,
    cacheWrite: 50_000,
  });
  const message = assistant({
    text: "second",
    timestamp: START + (options?.idleMs ?? 60_000),
    model: options?.model,
    input: 51_000,
    inputCost: 0.51,
    stopReason: options?.stopReason,
  });
  return {
    previous,
    message,
    entries: [messageEntry("e1", previous, null), messageEntry("e2", message, "e1")],
  };
}

test("live assistant completion appends the Pi-compatible model-switch cache warning", () => {
  const { previous, message } = significantMiss({ model: "claude-opus-4-1" });
  const tab = runtimeTab([messageEntry("e1", previous, null)], true);

  applyEvent(tab, { type: "message_end", message }, () => undefined);

  assert.equal(tab.chat.at(-1)?.variant, "system-warning");
  assert.equal(
    tab.chat.at(-1)?.text,
    "Cache miss after model switch: 50k tokens re-billed (~$0.45)",
  );
});

test("cache warnings do not suppress the empty-run notice", () => {
  const { previous, message } = significantMiss();
  const emptyMessage: AssistantMessage = { ...message, content: [] };
  const tab = runtimeTab([messageEntry("e1", previous, null)], true);
  tab.currentRunChatStartIndex = 0;

  maybeAppendCacheMissNotice(tab, emptyMessage);
  appendEmptyRunNotice(tab);

  assert.equal(tab.chat.at(-1)?.text, "Agent finished without a response.");
});

test("rebuilt transcript re-derives an idle cache warning after the assistant message", () => {
  const { entries } = significantMiss({ idleMs: 7 * 60_000 });

  const chat = entriesToChatLines(entries, runtimeTab(entries, true));

  assert.deepEqual(
    chat.map(({ role, text, variant }) => ({ role, text, variant })),
    [
      { role: "assistant", text: "first", variant: undefined },
      { role: "assistant", text: "second", variant: undefined },
      {
        role: "system",
        text: "Cache miss after 7m idle: 50k tokens re-billed (~$0.45)",
        variant: "system-warning",
      },
    ],
  );
});

test("rebuilt transcript derives notices from the full session like Pi", () => {
  const { entries } = significantMiss();
  const renderedEntries = [entries[1]!];

  const chat = entriesToChatLines(renderedEntries, runtimeTab(entries, true));

  assert.deepEqual(
    chat.map(({ role, text, variant }) => ({ role, text, variant })),
    [
      { role: "assistant", text: "second", variant: undefined },
      {
        role: "system",
        text: "Cache miss: 50k tokens re-billed (~$0.45)",
        variant: "system-warning",
      },
    ],
  );
});

test("disabled cache notices leave rebuilt transcripts unchanged", () => {
  const { entries } = significantMiss();
  const tab = runtimeTab(entries, false);
  (tab.agentSession as unknown as { modelRuntime: unknown }).modelRuntime = {
    getModel: () => {
      throw new Error("disabled notices must not scan cache stats");
    },
  };

  const chat = entriesToChatLines(entries, tab);

  assert.deepEqual(
    chat.map(({ role, text }) => ({ role, text })),
    [
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second" },
    ],
  );
});

test("runtime cache notice setting updates open tabs without overriding project settings", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-cache-notice-setting-"));
  let runtime: MixCodeRuntime | undefined;
  try {
    const agentDir = path.join(dir, "agent");
    const projectDir = path.join(dir, "project-override");
    await Bun.write(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ showCacheMissNotices: false }),
    );
    const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: true });
    runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir,
      settingsManager,
    });
    const config = {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium" as const,
    };
    const tabA = await runtime.createTab(createTab(1, "sA", dir), {
      ...config,
      workdir: dir,
    });
    const tabB = await runtime.createTab(createTab(2, "sB", projectDir), {
      ...config,
      workdir: projectDir,
    });

    assert.notEqual(tabA.agentSession.settingsManager, settingsManager);
    assert.notEqual(tabB.agentSession.settingsManager, settingsManager);
    assert.notEqual(tabA.agentSession.settingsManager, tabB.agentSession.settingsManager);
    assert.equal(tabB.agentSession.settingsManager.getProjectSettings().showCacheMissNotices, false);
    const miss = significantMiss();
    tabA.session.appendMessage(miss.previous);
    tabA.session.appendMessage(miss.message);
    tabB.session.appendMessage(miss.previous);
    tabB.session.appendMessage(miss.message);
    runtime.rebuildChatFromSession("sA");
    runtime.rebuildChatFromSession("sB");
    assert.equal(tabA.chat.some((line) => line.variant === "system-warning"), false);
    assert.equal(tabB.chat.some((line) => line.variant === "system-warning"), false);
    const compaction = tabA.agentSession.settingsManager.getCompactionSettings();
    tabA.agentSession.settingsManager.applyOverrides({
      compaction: { ...compaction, reserveTokens: compaction.reserveTokens + 1 },
    });
    const overriddenCompaction = tabA.agentSession.settingsManager.getCompactionSettings();

    await runtime.setShowCacheMissNotices(true);

    assert.equal(settingsManager.getShowCacheMissNotices(), true);
    assert.equal(tabA.agentSession.settingsManager.getShowCacheMissNotices(), true);
    assert.equal(tabB.agentSession.settingsManager.getShowCacheMissNotices(), false);
    assert.equal(tabA.chat.at(-1)?.variant, "system-warning");
    assert.equal(tabB.chat.some((line) => line.variant === "system-warning"), false);
    assert.deepEqual(
      tabA.agentSession.settingsManager.getCompactionSettings(),
      overriddenCompaction,
    );
    let persisted = await Bun.file(path.join(agentDir, "settings.json")).json();
    assert.equal(persisted.showCacheMissNotices, true);

    await runtime.setShowCacheMissNotices(false);

    assert.equal(settingsManager.getShowCacheMissNotices(), false);
    assert.equal(tabA.agentSession.settingsManager.getShowCacheMissNotices(), false);
    assert.equal(tabA.chat.some((line) => line.variant === "system-warning"), false);
    persisted = await Bun.file(path.join(agentDir, "settings.json")).json();
    assert.equal(persisted.showCacheMissNotices, false);
  } finally {
    runtime?.beginShutdown();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("token threshold alone shows a cache notice", () => {
  const previous = assistant({ text: "first", timestamp: START, cacheWrite: 20_000 });
  const message = assistant({
    text: "second",
    timestamp: START + 60_000,
    input: 20_000,
    inputCost: 0.005,
  });
  const entries = [messageEntry("e1", previous, null), messageEntry("e2", message, "e1")];

  const warning = entriesToChatLines(entries, runtimeTab(entries, true)).at(-1);

  assert.equal(warning?.text, "Cache miss: 20k tokens re-billed");
});

test("cost threshold alone shows a cache notice", () => {
  const previous = assistant({ text: "first", timestamp: START, cacheWrite: 10_000 });
  const message = assistant({
    text: "second",
    timestamp: START + 60_000,
    input: 10_000,
    inputCost: 0.12,
  });
  const entries = [messageEntry("e1", previous, null), messageEntry("e2", message, "e1")];

  const warning = entriesToChatLines(entries, runtimeTab(entries, true)).at(-1);

  assert.equal(warning?.text, "Cache miss: 10k tokens re-billed (~$0.11)");
});

test("small cache misses do not add notices", () => {
  const previous = assistant({ text: "first", timestamp: START, cacheWrite: 10_000 });
  const message = assistant({ text: "second", timestamp: START + 60_000, input: 11_000 });
  const entries = [messageEntry("e1", previous, null), messageEntry("e2", message, "e1")];

  const chat = entriesToChatLines(entries, runtimeTab(entries, true));

  assert.equal(
    chat.some((line) => line.variant === "system-warning"),
    false,
  );
});

test("aborted assistant messages do not add cache notices", () => {
  const aborted = significantMiss({ stopReason: "aborted" });

  const chat = entriesToChatLines(aborted.entries, runtimeTab(aborted.entries, true));

  assert.equal(
    chat.some((line) => line.variant === "system-warning"),
    false,
  );
});
