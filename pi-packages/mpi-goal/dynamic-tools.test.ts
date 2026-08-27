import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mpiGoal from "./index.js";
import { wireMpiGoal } from "./src/app.js";
import {
  disableGoalTools,
  enableGoalTools,
  isGoalToolsActive,
} from "./src/surface/tools/dynamic.js";
import { GOAL_TOOL_NAMES } from "./src/surface/tools/names.js";

function createFakePi(initialActive: string[] = ["bash", "read"]) {
  const tools = new Map<string, { name: string; description?: string; parameters?: unknown }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const active = new Set(initialActive);
  const events: Array<{ name: string }> = [];

  const pi = {
    registerTool(tool: { name: string; description?: string; parameters?: unknown }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def);
    },
    getActiveTools() {
      return [...active];
    },
    getAllTools() {
      // Match Pi getAllTools metadata shape (name + description + ...)
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: {},
        sourceInfo: {
          path: `mpi-goal:${tool.name}`,
          source: "extension",
          scope: "temporary",
          origin: "top-level",
        },
      }));
    },
    setActiveTools(names: string[]) {
      active.clear();
      for (const name of names) active.add(name);
    },
    on(name: string) {
      events.push({ name });
    },
    appendEntry() {},
    sendMessage() {},
    events: { on() {}, emit() {} },
  };

  return { pi: pi as unknown as ExtensionAPI, tools, commands, active, events };
}

test("factory load does not call setActiveTools (runtime unbound)", () => {
  const tools = new Map<string, { name: string }>();
  const commands = new Map<string, unknown>();
  let setActiveCalls = 0;
  const pi = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, def: unknown) {
      commands.set(name, def);
    },
    getActiveTools() {
      throw new Error(
        "Extension runtime not initialized. Action methods cannot be called during extension loading.",
      );
    },
    getAllTools() {
      throw new Error(
        "Extension runtime not initialized. Action methods cannot be called during extension loading.",
      );
    },
    setActiveTools() {
      setActiveCalls += 1;
      throw new Error(
        "Extension runtime not initialized. Action methods cannot be called during extension loading.",
      );
    },
    on() {},
    appendEntry() {},
    sendMessage() {},
    events: { on() {}, emit() {} },
  } as unknown as ExtensionAPI;

  mpiGoal(pi);
  assert.equal(setActiveCalls, 0);
  // Cold shell: command only; tools arrive when the command loads the full app.
  assert.equal(tools.size, 0);
  assert.ok(commands.has("goal"));
  assert.equal(commands.has("goal-tools"), false);
});

test("goal creation schemas expose actions without the removed context alias", () => {
  const { pi, tools } = createFakePi();
  wireMpiGoal(pi);
  for (const name of ["create_goal", "create_goal_from_template", "enqueue_goal"]) {
    const schema = tools.get(name)?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    assert.ok(schema?.properties?.post_completion_actions, `${name} must expose actions`);
    assert.equal("post_completion_context" in (schema?.properties ?? {}), false);
  }
});

test("registers all goal tools but leaves them inactive by default", () => {
  const { pi, tools, active } = createFakePi();
  wireMpiGoal(pi);

  for (const name of GOAL_TOOL_NAMES) {
    assert.ok(tools.has(name), `expected registered tool ${name}`);
    assert.equal(active.has(name), false, `expected ${name} inactive at load`);
  }
  assert.equal(active.has("bash"), true);
  assert.equal(isGoalToolsActive(pi), false);
});

test("enableGoalTools is additive and keeps existing tools", () => {
  const { pi, active } = createFakePi(["bash", "read", "edit"]);
  wireMpiGoal(pi);

  const added = enableGoalTools(pi);
  assert.equal(added.length, GOAL_TOOL_NAMES.length);
  assert.equal(active.has("bash"), true);
  assert.equal(active.has("edit"), true);
  assert.equal(isGoalToolsActive(pi), true);

  const again = enableGoalTools(pi);
  assert.deepEqual(again, []);
});

test("/goal command enables tools", async () => {
  const { pi, tools, commands, active } = createFakePi();
  mpiGoal(pi);
  const command = commands.get("goal");
  assert.ok(command);
  assert.equal(tools.size, 0);

  const ctx = {
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      custom: async () => undefined,
    },
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test",
      getLeafId: () => "leaf",
    },
  };

  assert.equal(active.has("get_goal"), false);
  await command.handler("", ctx);
  assert.equal(tools.size, GOAL_TOOL_NAMES.length);
  assert.equal(active.has("get_goal"), true);
  assert.equal(isGoalToolsActive(pi), true);
});

test("/goal tools activates the full goal tool set", async () => {
  const { pi, commands, active } = createFakePi();
  mpiGoal(pi);
  const goalCmd = commands.get("goal");
  assert.ok(goalCmd);
  assert.equal(commands.has("goal-tools"), false);

  const notifications: string[] = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
      custom: async () => undefined,
    },
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test",
      getLeafId: () => "leaf",
    },
  };

  assert.equal(active.has("get_goal"), false);
  await goalCmd.handler("tools", ctx);
  assert.equal(isGoalToolsActive(pi), true);
  for (const name of GOAL_TOOL_NAMES) assert.equal(active.has(name), true);
  assert.match(notifications.at(-1) ?? "", /Activated|already active/i);
});

test("disableGoalTools removes only goal tools", () => {
  const { pi, active } = createFakePi();
  wireMpiGoal(pi);
  enableGoalTools(pi);
  disableGoalTools(pi);
  assert.equal(active.has("bash"), true);
  assert.equal(active.has("get_goal"), false);
  assert.equal(isGoalToolsActive(pi), false);
});
