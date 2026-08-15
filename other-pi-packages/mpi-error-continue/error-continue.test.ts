import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BASE_DELAY_MS,
  COMMAND_NAME,
  createErrorContinueExtension,
  delayForAttempt,
  endsWithThinkingOrToolCall,
  isEmptyResponse,
  isResumeMarker,
  lastAssistant,
  MAX_INVISIBLE,
  MAX_VISIBLE,
  MIDWORK_CONTINUE_TEXT,
  readEnabledFromBranch,
  RESUME_CUSTOM_TYPE,
  STATE_CUSTOM_TYPE,
  STATUS_KEY,
  STATUS_PREFIX,
  VISIBLE_CONTINUE_TEXT,
} from "./index.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function createHarness(
  options?: {
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    initialBranch?: unknown[];
  },
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const branch = [...(options?.initialBranch ?? [])];
  const sent: Array<{ kind: "message" | "user"; payload: any; options?: any }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const delays: number[] = [];

  const ctx = {
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    },
    sessionManager: {
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage: (message: any, options: any) =>
      sent.push({ kind: "message", payload: message, options }),
    sendUserMessage: (content: any, options: any) =>
      sent.push({ kind: "user", payload: content, options }),
    appendEntry: (customType: string, data?: any) => {
      entries.push({ customType, data });
      branch.push({ type: "custom", customType, data });
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as unknown as ExtensionAPI;

  const sleep =
    options?.sleep ??
    (async (ms: number, _signal: AbortSignal) => {
      delays.push(ms);
    });

  createErrorContinueExtension({ sleep })(pi);

  return {
    commands,
    sent,
    notices,
    statuses,
    entries,
    branch,
    delays,
    emit: async (event: string, payload: any = {}) => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(payload, ctx);
      }
      return result;
    },
    runCommand: async (args: string) => {
      const command = commands.get(COMMAND_NAME);
      assert.ok(command);
      await command.handler(args, ctx);
    },
  };
}

function assistantError(errorMessage = "upstream failed") {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
  };
}

function assistantStop(text = "ok") {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

function assistantThinking(thinking = "working...") {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "thinking", thinking }],
  };
}

function assistantToolCall(name = "bash") {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "toolCall", id: "tc-1", name, arguments: {} }],
  };
}

function assistantEmpty(stopReason = "stop", content: unknown[] = []) {
  return { role: "assistant", stopReason, content };
}

function stateEntry(enabled: boolean) {
  return {
    type: "custom",
    customType: STATE_CUSTOM_TYPE,
    data: { version: 1, enabled, at: Date.now() },
  };
}

async function errorSettle(harness: ReturnType<typeof createHarness>, errorMessage?: string) {
  await harness.emit("agent_end", { messages: [assistantError(errorMessage)] });
  await harness.emit("agent_settled");
}

async function stopSettle(harness: ReturnType<typeof createHarness>) {
  await harness.emit("agent_end", { messages: [assistantStop()] });
  await harness.emit("agent_settled");
}

async function midWorkSettle(harness: ReturnType<typeof createHarness>, message: unknown) {
  await harness.emit("agent_end", { messages: [message] });
  await harness.emit("agent_settled");
}

test("delayForAttempt uses exponential backoff from base", () => {
  assert.equal(delayForAttempt(0), 1000);
  assert.equal(delayForAttempt(1), 2000);
  assert.equal(delayForAttempt(2), 4000);
  assert.equal(delayForAttempt(0, 500), 500);
});

test("lastAssistant and isResumeMarker helpers", () => {
  assert.equal(lastAssistant([]), undefined);
  assert.equal(lastAssistant([{ role: "user" }, assistantError()])?.stopReason, "error");
  assert.equal(isResumeMarker({ role: "custom", customType: RESUME_CUSTOM_TYPE }), true);
  assert.equal(isResumeMarker({ role: "custom", customType: "other" }), false);
});

test("readEnabledFromBranch defaults on and uses latest state entry", () => {
  assert.equal(readEnabledFromBranch([]), true);
  assert.equal(readEnabledFromBranch([stateEntry(false)]), false);
  assert.equal(readEnabledFromBranch([stateEntry(false), stateEntry(true)]), true);
  assert.equal(
    readEnabledFromBranch([
      { type: "custom", customType: RESUME_CUSTOM_TYPE, data: {} },
      stateEntry(false),
    ]),
    false,
  );
});

test("session_start shows status (0); shutdown clears it", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (0)`,
  });
  await harness.emit("session_shutdown");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: undefined,
  });
});

test("error settle sends one invisible continue with base delay and status (1)", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
  assert.equal(harness.sent[0]?.payload.customType, RESUME_CUSTOM_TYPE);
  assert.equal(harness.sent[0]?.payload.display, false);
  assert.deepEqual(harness.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(harness.delays, [BASE_DELAY_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (1)`,
  });
});

test("three invisible continues use progressive delays then switch to visible", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  for (let i = 0; i < MAX_INVISIBLE; i++) {
    await errorSettle(harness, `err-inv-${i}`);
  }
  assert.equal(harness.sent.length, MAX_INVISIBLE);
  assert.ok(harness.sent.every((item) => item.kind === "message"));
  assert.deepEqual(harness.delays, [1000, 2000, 4000]);

  await errorSettle(harness, "err-vis-0");
  assert.equal(harness.sent.length, MAX_INVISIBLE + 1);
  assert.equal(harness.sent.at(-1)?.kind, "user");
  assert.equal(harness.sent.at(-1)?.payload, VISIBLE_CONTINUE_TEXT);
  assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "followUp" });
  assert.deepEqual(harness.delays, [1000, 2000, 4000, 1000]);
});

test("MAX_INVISIBLE + MAX_VISIBLE error settles send all continues; extra sends nothing", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  for (let i = 0; i < MAX_INVISIBLE + MAX_VISIBLE; i++) {
    await errorSettle(harness, `err-${i}`);
  }
  assert.equal(harness.sent.length, MAX_INVISIBLE + MAX_VISIBLE);
  assert.equal(harness.sent.filter((s) => s.kind === "message").length, MAX_INVISIBLE);
  assert.equal(harness.sent.filter((s) => s.kind === "user").length, MAX_VISIBLE);
  assert.deepEqual(harness.delays, [1000, 2000, 4000, 1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (${MAX_INVISIBLE + MAX_VISIBLE})`,
  });

  const before = harness.sent.length;
  await errorSettle(harness, "err-extra");
  assert.equal(harness.sent.length, before);
  assert.ok(harness.notices.some((n) => /exhausted/i.test(n.message) && n.level === "error"));
});

test("successful settle resets phase counters but keeps cumulative status count", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness, "first");
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (1)`,
  });

  await stopSettle(harness);
  await errorSettle(harness, "after-success");
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent.at(-1)?.kind, "message");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (2)`,
  });
  assert.deepEqual(harness.delays, [1000, 1000]);
});

test("endsWithThinkingOrToolCall helper", () => {
  assert.equal(
    endsWithThinkingOrToolCall({ content: [{ type: "thinking", thinking: "t" }] }),
    true,
  );
  assert.equal(
    endsWithThinkingOrToolCall({ content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] }),
    true,
  );
  assert.equal(endsWithThinkingOrToolCall({ content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(endsWithThinkingOrToolCall({ content: [] }), false);
  assert.equal(endsWithThinkingOrToolCall({}), false);
  assert.equal(endsWithThinkingOrToolCall({ content: "plain string" }), false);
});

test("stop or aborted settle does not send", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await stopSettle(harness);
  await harness.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
  });
  await harness.emit("agent_settled");
  assert.equal(harness.sent.length, 0);
});

test("aborted settle ending in thinking or tool call does not send", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await midWorkSettle(harness, { ...assistantThinking(), stopReason: "aborted" });
  await midWorkSettle(harness, { ...assistantToolCall(), stopReason: "aborted" });
  assert.equal(harness.sent.length, 0);
});

test("isEmptyResponse helper", () => {
  assert.equal(isEmptyResponse({ content: [] }), true);
  assert.equal(isEmptyResponse({ content: [{ type: "text", text: "" }] }), true);
  assert.equal(isEmptyResponse({ content: [{ type: "text", text: "  " }] }), true);
  assert.equal(isEmptyResponse({ content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(isEmptyResponse({ content: [{ type: "thinking", thinking: "t" }] }), false);
  assert.equal(
    isEmptyResponse({ content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] }),
    false,
  );
  assert.equal(isEmptyResponse({}), true);
});

test("empty response settle (stop, no content) sends invisible continue", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.emit("agent_end", { messages: [assistantEmpty()] });
  await harness.emit("agent_settled");

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
  assert.equal(harness.sent[0]?.payload.customType, RESUME_CUSTOM_TYPE);
  assert.deepEqual(harness.delays, [BASE_DELAY_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (1)`,
  });
});

test("empty response with blank text block also continues", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.emit("agent_end", {
    messages: [assistantEmpty("stop", [{ type: "text", text: " " }])],
  });
  await harness.emit("agent_settled");

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
});

test("empty settles escalate from invisible to visible continues", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  for (let i = 0; i < MAX_INVISIBLE; i++) {
    await harness.emit("agent_end", { messages: [assistantEmpty("length")] });
    await harness.emit("agent_settled");
  }
  assert.equal(harness.sent.length, MAX_INVISIBLE);
  assert.ok(harness.sent.every((item) => item.kind === "message"));

  await harness.emit("agent_end", { messages: [assistantEmpty()] });
  await harness.emit("agent_settled");
  assert.equal(harness.sent.length, MAX_INVISIBLE + 1);
  assert.equal(harness.sent.at(-1)?.kind, "user");
  assert.equal(harness.sent.at(-1)?.payload, VISIBLE_CONTINUE_TEXT);
  assert.deepEqual(harness.delays, [1000, 2000, 4000, 1000]);
});

test("mid-work stop ending in thinking sends continue $simple-plan", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await midWorkSettle(harness, assistantThinking());

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "user");
  assert.equal(harness.sent[0]?.payload, MIDWORK_CONTINUE_TEXT);
  assert.deepEqual(harness.sent[0]?.options, { deliverAs: "followUp" });
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (1)`,
  });
});

test("mid-work stop ending in tool call sends continue $simple-plan", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await midWorkSettle(harness, assistantToolCall());

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "user");
  assert.equal(harness.sent[0]?.payload, MIDWORK_CONTINUE_TEXT);
  assert.deepEqual(harness.sent[0]?.options, { deliverAs: "followUp" });
});

test("error stop ending in thinking uses error flow, not continue $simple-plan", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await midWorkSettle(harness, { ...assistantThinking(), stopReason: "error", errorMessage: "boom" });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
  assert.equal(harness.sent[0]?.payload.customType, RESUME_CUSTOM_TYPE);
});

test("mid-work continue respects /error-continue off", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.runCommand("off");
  await midWorkSettle(harness, assistantThinking());
  assert.equal(harness.sent.length, 0);

  await harness.runCommand("on");
  await midWorkSettle(harness, assistantThinking());
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent.at(-1)?.payload, MIDWORK_CONTINUE_TEXT);
});

test("each mid-work stop sends its own continue and counts status", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await midWorkSettle(harness, assistantThinking());
  await midWorkSettle(harness, assistantToolCall());

  assert.equal(harness.sent.length, 2);
  assert.ok(harness.sent.every((s) => s.kind === "user" && s.payload === MIDWORK_CONTINUE_TEXT));
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (2)`,
  });
});

test("real user message disarms mid-work continue", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.emit("agent_end", { messages: [assistantThinking()] });
  await harness.emit("message_start", { message: { role: "user", content: "manual input" } });
  await harness.emit("agent_settled");
  assert.equal(harness.sent.length, 0);
});

test("auto visible continue does not reset phase; other user text does", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  for (let i = 0; i < MAX_INVISIBLE; i++) {
    await errorSettle(harness, `inv-${i}`);
  }
  await errorSettle(harness, "vis-1");
  assert.equal(harness.sent.at(-1)?.kind, "user");

  await harness.emit("message_start", {
    message: { role: "user", content: [{ type: "text", text: VISIBLE_CONTINUE_TEXT }] },
  });
  await errorSettle(harness, "vis-2");
  assert.equal(harness.sent.filter((s) => s.kind === "user").length, 2);

  await harness.emit("message_start", {
    message: { role: "user", content: [{ type: "text", text: "please fix auth" }] },
  });
  await errorSettle(harness, "after-user");
  assert.equal(harness.sent.at(-1)?.kind, "message");
});

test("context hook strips resume markers", async () => {
  const harness = createHarness();
  const result = (await harness.emit("context", {
    messages: [
      { role: "user", content: "hi" },
      { role: "custom", customType: RESUME_CUSTOM_TYPE, content: [] },
      assistantError(),
    ],
  })) as { messages: unknown[] };

  assert.equal(result.messages.length, 2);
  assert.equal(
    result.messages.some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { customType?: string }).customType === RESUME_CUSTOM_TYPE,
    ),
    false,
  );
});

test("slash command on/off persists state, toggles status, and blocks sends when off", async () => {
  const harness = createHarness();
  const command = harness.commands.get(COMMAND_NAME);
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions("o"), [
    { label: "on", value: "on", description: "Enable automatic error-settle continues" },
    { label: "off", value: "off", description: "Disable automatic error-settle continues" },
  ]);

  await harness.emit("session_start");
  await harness.runCommand("off");
  assert.equal(harness.entries.at(-1)?.customType, STATE_CUSTOM_TYPE);
  assert.equal(harness.entries.at(-1)?.data.enabled, false);
  assert.deepEqual(harness.statuses.at(-1), { key: STATUS_KEY, text: undefined });

  await errorSettle(harness, "while-off");
  assert.equal(harness.sent.length, 0);

  await harness.runCommand("on");
  assert.equal(harness.entries.at(-1)?.data.enabled, true);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: `${STATUS_PREFIX} (0)`,
  });
  await errorSettle(harness, "after-on");
  assert.equal(harness.sent.length, 1);
});

test("session_start restores enabled=false from branch state", async () => {
  const harness = createHarness({ initialBranch: [stateEntry(false)] });
  await harness.emit("session_start");
  assert.deepEqual(harness.statuses.at(-1), { key: STATUS_KEY, text: undefined });
  await errorSettle(harness, "restored-off");
  assert.equal(harness.sent.length, 0);
});

test("off overwrites state so later resume stays off", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.runCommand("on");
  await harness.runCommand("off");
  assert.equal(harness.entries.at(-1)?.data.enabled, false);

  const resumed = createHarness({ initialBranch: harness.branch });
  await resumed.emit("session_start");
  await errorSettle(resumed, "after-off-resume");
  assert.equal(resumed.sent.length, 0);
  assert.deepEqual(resumed.statuses.at(-1), { key: STATUS_KEY, text: undefined });
});

test("shutdown aborts in-flight sleep and does not send", async () => {
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const harness = createHarness({
    sleep: (_ms, signal) =>
      new Promise((_resolve, reject) => {
        resolveStarted?.();
        const onAbort = () => {
          const err = new Error("Aborted");
          err.name = "SleepAbortError";
          reject(err);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  });

  await harness.emit("session_start");

  const settlePromise = errorSettle(harness, "during-sleep");
  await started;
  await harness.emit("session_shutdown");
  await settlePromise;

  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: undefined,
  });
});
