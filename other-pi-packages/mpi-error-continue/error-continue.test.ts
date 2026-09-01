import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  COMMAND_NAME,
  confirmContinueGate,
  confirmDelayForAttempt,
  type ContinueDecision,
  type ContinueGate,
  createErrorContinueExtension,
  delayForAttempt,
  endsWithThinkingOrToolCall,
  isEmptyResponse,
  isResumeMarker,
  lastAssistant,
  MAX_INVISIBLE,
  MAX_VISIBLE,
  MIDWORK_CONTINUE_TEXT,
  MIN_CONFIRM_MS,
  readEnabledFromBranch,
  RESUME_CUSTOM_TYPE,
  STATE_CUSTOM_TYPE,
  STATUS_KEY,
  STATUS_PREFIX,
  VISIBLE_CONTINUE_TEXT,
} from "./index.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function statusText(total: number, phase?: string) {
  return `${STATUS_PREFIX}${phase ? ` · ${phase}` : ""} · total ${total}`;
}

function createHarness(options?: { gate?: ContinueGate; initialBranch?: unknown[] }) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const branch = [...(options?.initialBranch ?? [])];
  const sent: Array<{ kind: "message" | "user"; payload: any; options?: any }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const delays: number[] = [];
  let abortController = new AbortController();

  const ctx = {
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    },
    sessionManager: {
      getBranch: () => branch,
    },
    get signal() {
      return abortController.signal;
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

  // Default gate stands in for "dialog timed out": record the window, continue.
  const gate: ContinueGate = async (params) => {
    delays.push(params.delayMs);
    return options?.gate ? await options.gate(params) : "continue";
  };

  createErrorContinueExtension({ gate })(pi);

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
    abort: () => abortController.abort(),
    resetSignal: () => {
      abortController = new AbortController();
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

test("confirmDelayForAttempt floors short backoffs but keeps the long ones", () => {
  assert.equal(confirmDelayForAttempt(0), MIN_CONFIRM_MS);
  assert.equal(confirmDelayForAttempt(2), MIN_CONFIRM_MS);
  assert.equal(confirmDelayForAttempt(3), 8000);
  assert.equal(confirmDelayForAttempt(4), 16000);
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
    text: statusText(0),
  });
  await harness.emit("session_shutdown");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: undefined,
  });
});

test("error settle sends one invisible continue with confirm window and status (1)", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
  assert.equal(harness.sent[0]?.payload.customType, RESUME_CUSTOM_TYPE);
  assert.equal(harness.sent[0]?.payload.display, false);
  assert.deepEqual(harness.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
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
  assert.deepEqual(harness.delays, [5000, 5000, 5000]);

  await errorSettle(harness, "err-vis-0");
  assert.equal(harness.sent.length, MAX_INVISIBLE + 1);
  assert.equal(harness.sent.at(-1)?.kind, "user");
  assert.equal(harness.sent.at(-1)?.payload, VISIBLE_CONTINUE_TEXT);
  assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "followUp" });
  assert.deepEqual(harness.delays, [5000, 5000, 5000, 5000]);
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
  assert.deepEqual(harness.delays, [5000, 5000, 5000, 5000, 5000, 5000, 8000, 16000]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(MAX_INVISIBLE + MAX_VISIBLE, "visible 5/5"),
  });

  const before = harness.sent.length;
  await errorSettle(harness, "err-extra");
  assert.equal(harness.sent.length, before);
  assert.ok(harness.notices.some((n) => /exhausted/i.test(n.message) && n.level === "error"));
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(MAX_INVISIBLE + MAX_VISIBLE),
  });
});

test("successful settle resets phase counters but keeps cumulative status count", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness, "first");
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
  });
  await stopSettle(harness);
  await errorSettle(harness, "after-success");
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent.at(-1)?.kind, "message");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(2, "invisible 1/3"),
  });
  assert.deepEqual(harness.delays, [5000, 5000]);
});

test("endsWithThinkingOrToolCall helper", () => {
  assert.equal(
    endsWithThinkingOrToolCall({ content: [{ type: "thinking", thinking: "t" }] }),
    true,
  );
  assert.equal(
    endsWithThinkingOrToolCall({
      content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }],
    }),
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

test("run abort signal does not continue even when last assistant looks mid-work", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  harness.abort();
  await midWorkSettle(harness, assistantThinking());
  await midWorkSettle(harness, assistantToolCall());
  assert.equal(harness.sent.length, 0);
});

test("run abort signal does not continue on error or empty settle", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  harness.abort();
  await errorSettle(harness);
  await harness.emit("agent_end", { messages: [assistantEmpty()] });
  await harness.emit("agent_settled");
  assert.equal(harness.sent.length, 0);
});

test("user abort resets phase counters but keeps session retry count", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness);
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
  });

  harness.abort();
  await harness.emit("agent_end", { messages: [assistantError("aborted-run")] });
  await harness.emit("agent_settled");
  assert.equal(harness.sent.length, 1);

  harness.resetSignal();
  await errorSettle(harness, "after-abort");
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS, MIN_CONFIRM_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(2, "invisible 1/3"),
  });
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
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
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
  assert.deepEqual(harness.delays, [5000, 5000, 5000, 5000]);
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
    text: statusText(1, "mid-work"),
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
  await midWorkSettle(harness, {
    ...assistantThinking(),
    stopReason: "error",
    errorMessage: "boom",
  });

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
    text: statusText(2, "mid-work"),
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
    text: statusText(0),
  });
  await errorSettle(harness, "after-on");
  assert.equal(harness.sent.length, 1);
});

test("reset clears retry counters without disabling the extension", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await errorSettle(harness, "before-reset");
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
  });

  await harness.runCommand("reset");
  assert.deepEqual(harness.statuses.at(-1), { key: STATUS_KEY, text: statusText(0) });
  assert.equal(harness.notices.at(-1)?.message, "Error continue counters reset.");

  await errorSettle(harness, "after-reset");
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(1, "invisible 1/3"),
  });
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

test("shutdown aborts the in-flight wait and does not send", async () => {
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();

  const harness = createHarness({
    gate: ({ signal }) =>
      new Promise<ContinueDecision>((resolve) => {
        markStarted();
        if (signal.aborted) {
          resolve("aborted");
          return;
        }
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      }),
  });

  await harness.emit("session_start");

  const settlePromise = errorSettle(harness, "during-wait");
  await started;
  await harness.emit("session_shutdown");
  await settlePromise;

  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: undefined,
  });
});

test("cancelling a retry stops the loop but keeps error-continue enabled", async () => {
  let decision: ContinueDecision = "cancel";
  const harness = createHarness({ gate: async () => decision });
  await harness.emit("session_start");

  await errorSettle(harness, "cancelled");
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(0),
  });
  assert.ok(harness.notices.some((n) => /cancelled/i.test(n.message)));

  // Still enabled: the next error restarts the phase at invisible 1/3.
  decision = "continue";
  await errorSettle(harness, "after-cancel");
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.kind, "message");
  assert.equal(harness.sent[0]?.payload.customType, RESUME_CUSTOM_TYPE);
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS, MIN_CONFIRM_MS]);
});

test("cancelling a visible retry resets the phase back to invisible", async () => {
  let decision: ContinueDecision = "continue";
  const harness = createHarness({ gate: async () => decision });
  await harness.emit("session_start");

  for (let i = 0; i < MAX_INVISIBLE; i++) await errorSettle(harness, `inv-${i}`);
  decision = "cancel";
  await errorSettle(harness, "vis-cancelled");
  assert.equal(harness.sent.length, MAX_INVISIBLE);

  decision = "continue";
  await errorSettle(harness, "after-cancel");
  assert.equal(harness.sent.at(-1)?.kind, "message");
});

test("external abort during the wait sends nothing and reports no cancel", async () => {
  const harness = createHarness({ gate: async () => "aborted" });
  await harness.emit("session_start");
  await errorSettle(harness, "externally-aborted");

  assert.equal(harness.sent.length, 0);
  assert.equal(
    harness.notices.some((n) => /cancelled/i.test(n.message)),
    false,
  );
});

test("cancelling the mid-work wait does not send continue $simple-plan", async () => {
  const harness = createHarness({ gate: async () => "cancel" });
  await harness.emit("session_start");
  await midWorkSettle(harness, assistantToolCall());

  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.delays, [MIN_CONFIRM_MS]);
  assert.deepEqual(harness.statuses.at(-1), {
    key: STATUS_KEY,
    text: statusText(0),
  });
});

function dialogCtx(options: {
  hasUI?: boolean;
  confirm?: (signal?: AbortSignal) => Promise<boolean>;
}) {
  let confirmCalls = 0;
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: async (_title: string, _message: string, opts?: { signal?: AbortSignal }) => {
        confirmCalls++;
        return options.confirm ? await options.confirm(opts?.signal) : false;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, confirmCalls: () => confirmCalls };
}

/** Dialog that only resolves when its own dismiss signal fires (timeout / external). */
const dismissOnly = (signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    signal?.addEventListener("abort", () => resolve(false), { once: true });
  });

function gateParams(ctx: ExtensionContext, delayMs: number, signal: AbortSignal) {
  return { ctx, title: "t", message: "m", delayMs, signal };
}

test("confirmContinueGate maps Esc, No, Yes, timeout, and external abort apart", async () => {
  // confirm() resolves false for Esc, "No", and timeout alike; only the
  // timeout/external markers can tell them apart.
  const esc = dialogCtx({ confirm: async () => false });
  assert.equal(
    await confirmContinueGate(gateParams(esc.ctx, 60_000, new AbortController().signal)),
    "cancel",
  );

  const yes = dialogCtx({ confirm: async () => true });
  assert.equal(
    await confirmContinueGate(gateParams(yes.ctx, 60_000, new AbortController().signal)),
    "continue",
  );

  const timeout = dialogCtx({ confirm: dismissOnly });
  assert.equal(
    await confirmContinueGate(gateParams(timeout.ctx, 5, new AbortController().signal)),
    "continue",
  );

  const external = new AbortController();
  const pending = dialogCtx({ confirm: dismissOnly });
  const decision = confirmContinueGate(gateParams(pending.ctx, 60_000, external.signal));
  external.abort();
  assert.equal(await decision, "aborted");
});

test("confirmContinueGate never calls confirm without a UI surface", async () => {
  // The no-op UI context resolves confirm() to false; reading that as a cancel
  // would silently disable auto-recovery in print/JSON mode.
  const headless = dialogCtx({ hasUI: false });
  assert.equal(
    await confirmContinueGate(gateParams(headless.ctx, 5, new AbortController().signal)),
    "continue",
  );
  assert.equal(headless.confirmCalls(), 0);

  const external = new AbortController();
  const aborted = dialogCtx({ hasUI: false });
  const decision = confirmContinueGate(gateParams(aborted.ctx, 60_000, external.signal));
  external.abort();
  assert.equal(await decision, "aborted");
});
