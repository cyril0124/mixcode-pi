import assert from "node:assert/strict";
import { test } from "node:test";
import { distillToolSchema, wireSchemaHint } from "./schema-hint.js";
import { DEFAULT_STUCK_GUARD_CONFIG, type StuckGuardConfigLoad } from "./config.js";

// ─── distillToolSchema ───────────────────────────────────────────────────────

test("distill: edit-shaped schema renders required and optional fields", () => {
  const schema = {
    type: "object",
    required: ["path", "edits"],
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          required: ["oldText", "newText"],
          properties: { oldText: { type: "string" }, newText: { type: "string" } },
        },
      },
    },
  };
  assert.equal(
    distillToolSchema("edit", schema),
    [
      "[edit parameter contract]",
      "path: string",
      "edits: array<object>",
      "edits.oldText: string",
      "edits.newText: string",
    ].join("\n"),
  );
});

test("distill: enum and anyOf fold into a|b signatures", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      target: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  };
  const out = distillToolSchema("t", schema);
  assert.match(out, /mode: fast\|slow \(optional\)/);
  assert.match(out, /target: string\|number \(optional\)/);
});

test("distill: caps output at 15 property lines", () => {
  const properties: Record<string, { type: "string" }> = {};
  for (let i = 0; i < 30; i++) properties[`field${i}`] = { type: "string" };
  const out = distillToolSchema("big", { type: "object", properties });
  const lines = out.split("\n");
  assert.equal(lines.length, 15 + 1); // header + 15 property lines
});

test("distill: depth stops after two levels", () => {
  const schema = {
    type: "object",
    properties: {
      outer: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { leaf: { type: "string" } },
          },
        },
      },
    },
  };
  const out = distillToolSchema("t", schema);
  assert.match(out, /outer: object/);
  assert.match(out, /outer\.inner: object/);
  assert.ok(!out.includes("leaf"), "third level must not be rendered");
});

test("distill: missing schema degrades to header only", () => {
  assert.equal(distillToolSchema("t", undefined), "[t parameter contract]\n");
});

// ─── wireSchemaHint ──────────────────────────────────────────────────────────

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  options?: { deliverAs?: string };
}

interface HarnessConfig {
  schemaHintFailureThreshold?: number;
}

function makeHarness(
  tools: Array<{ name: string; parameters: unknown }>,
  config: HarnessConfig = {},
) {
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const sent: SentMessage[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const loadConfig: () => StuckGuardConfigLoad = () => ({
    ok: true as const,
    config: {
      ...DEFAULT_STUCK_GUARD_CONFIG,
      schemaHintFailureThreshold: config.schemaHintFailureThreshold ?? 2,
    },
    path: "test",
  });
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getAllTools: () => tools,
    sendMessage: (message: Omit<SentMessage, "options">, options?: SentMessage["options"]) => {
      sent.push({ ...message, options });
    },
  };
  const ctx = {
    ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
  };
  async function emit(event: string, payload: unknown): Promise<void> {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  }
  return { pi, sent, notifications, emit, loadConfig };
}

function validationEnd(toolName: string, message = 'Validation failed for tool "x": bad') {
  return {
    type: "tool_execution_end",
    toolName,
    isError: true,
    result: { content: [{ type: "text", text: message }] },
  };
}

test("hint: fires exactly once on the second consecutive validation failure", async () => {
  const harness = makeHarness([
    {
      name: "read",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  ]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]!.options?.deliverAs, "steer");
  assert.equal(harness.sent[0]!.display, false);
  assert.match(harness.sent[0]!.content, /\[read parameter contract\]/);
  assert.match(harness.sent[0]!.content, /failed parameter validation 2 times/);
  assert.equal(harness.notifications.length, 1);
});

test("hint: success resets the streak and re-arms the hint", async () => {
  const harness = makeHarness([{ name: "read", parameters: { type: "object", properties: {} } }]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
  });
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 0);
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 1);
});

test("hint: non-validation errors do not trigger", async () => {
  const harness = makeHarness([{ name: "read", parameters: { type: "object", properties: {} } }]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit(
    "tool_execution_end",
    validationEnd("read", "Tool call read was not executed: output limit"),
  );
  await harness.emit("tool_execution_end", validationEnd("read", "Some other tool error"));
  assert.equal(harness.sent.length, 0);
});

test("hint: tools are tracked independently", async () => {
  const harness = makeHarness([
    { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "edit", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("edit"));
  await harness.emit("tool_execution_end", validationEnd("edit"));
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.content, /\[edit parameter contract\]/);
});

test("hint: unknown tool name sends nothing", async () => {
  const harness = makeHarness([]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("ghost"));
  await harness.emit("tool_execution_end", validationEnd("ghost"));
  assert.equal(harness.sent.length, 0);
});

test("hint: session_start clears counters", async () => {
  const harness = makeHarness([{ name: "read", parameters: { type: "object", properties: {} } }]);
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("session_start", {});
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 0);
});

test("hint: configured threshold of 3 delays the hint to the third failure", async () => {
  const harness = makeHarness(
    [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    { schemaHintFailureThreshold: 3 },
  );
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 0);
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.content, /failed parameter validation 3 times/);
});

test("hint: before_agent_start reloads the threshold from config", async () => {
  const harness = makeHarness([{ name: "read", parameters: { type: "object", properties: {} } }], {
    schemaHintFailureThreshold: 4,
  });
  let threshold = 4;
  harness.loadConfig = () => ({
    ok: true as const,
    config: { ...DEFAULT_STUCK_GUARD_CONFIG, schemaHintFailureThreshold: threshold },
    path: "test",
  });
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 0, "initial threshold 4 not reached");
  threshold = 2;
  await harness.emit("before_agent_start", {});
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(
    harness.sent.length,
    1,
    "lowered threshold applies to the ongoing streak immediately",
  );
});

test("hint: broken config falls back to default threshold", async () => {
  const harness = makeHarness([{ name: "read", parameters: { type: "object", properties: {} } }]);
  harness.loadConfig = () => ({ ok: false as const, path: "test", error: "bad" });
  wireSchemaHint(harness.pi as never, harness.loadConfig);
  await harness.emit("tool_execution_end", validationEnd("read"));
  await harness.emit("tool_execution_end", validationEnd("read"));
  assert.equal(harness.sent.length, 1); // default threshold 2
});
