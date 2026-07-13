import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import loopExtension from "../pi-packages/mpi-loop/index.js";
import { createTab } from "../src/core/defaults.js";
import { submitAgentInput } from "../src/ui/agent-tab-actions.js";
import type { MixCodeSubmitRuntime } from "../src/ui/app-types.js";

const MULTILINE_COMMAND = "/loop 10m first line\nsecond line\nthird line";

test("MixCode forwards multiline extension commands without rebuilding whitespace", async () => {
  const forwarded: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      forwarded.push(text);
    },
    getExtensionCommands: () => [{ name: "loop" }],
  } as unknown as MixCodeSubmitRuntime;

  const handled = await submitAgentInput(
    createTab(1, "session-1", "/tmp"),
    runtime,
    MULTILINE_COMMAND,
  );

  assert.equal(handled, true);
  assert.deepEqual(forwarded, [MULTILINE_COMMAND]);
});

test("mpi-loop preserves multiline prompt text after a leading interval", async () => {
  const sent: string[] = [];
  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const ctx: TestCommandContext = {
    ui: { notify: () => {} },
    isIdle: () => true,
  };
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
      commandHandler = options.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string) => sent.push(prompt),
  } as unknown as ExtensionAPI;

  loopExtension(pi);
  assert.ok(commandHandler);
  await commandHandler("10m first line\nsecond line\nthird line", ctx);
  await shutdownHandler?.({}, ctx);

  assert.deepEqual(sent, ["first line\nsecond line\nthird line"]);
});

test("mpi-loop queues immediate and overlay fires when the agent is busy", async () => {
  const sent: Array<{ prompt: string; options: unknown }> = [];
  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlay: TestOverlay | undefined;
  const ctx: TestCommandContext = {
    ui: {
      notify: () => {},
      custom: async (factory) => {
        overlay = factory(
          { terminal: { rows: 30 }, requestRender: () => {} },
          { fg: (_color, text) => text, bg: (_color, text) => text },
          {},
          () => {},
        );
      },
    },
    isIdle: () => false,
  };
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
      commandHandler = options.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string, options?: unknown) => sent.push({ prompt, options }),
  } as unknown as ExtensionAPI;

  loopExtension(pi);
  assert.ok(commandHandler);
  await commandHandler("10m busy prompt", ctx);
  assert.deepEqual(sent, [
    { prompt: "busy prompt", options: { deliverAs: "followUp" } },
  ]);

  sent.length = 0;
  await commandHandler("", ctx);
  assert.ok(overlay);
  overlay.handleInput("f");
  await shutdownHandler?.({}, ctx);

  assert.deepEqual(sent, [
    { prompt: "busy prompt", options: { deliverAs: "followUp" } },
  ]);
});

interface TestCommandContext {
  ui: {
    notify: (message: string, level: string) => void;
    custom?: (factory: TestOverlayFactory) => Promise<void>;
  };
  isIdle: () => boolean;
}

interface TestOverlay {
  handleInput: (data: string) => void;
}

type TestOverlayFactory = (
  tui: { terminal: { rows: number }; requestRender: () => void },
  theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
  keybindings: object,
  done: () => void,
) => TestOverlay;
