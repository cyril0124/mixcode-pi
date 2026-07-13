import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import loopExtension from "./index.js";

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

test("mpi-loop counts the immediate first fire in RUNS", async () => {
  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlay: TestOverlay | undefined;
  const idleCtx: TestCommandContext = {
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
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;

  loopExtension(pi);
  assert.ok(commandHandler);
  await commandHandler("1h count-first-fire", idleCtx);

  const overlayCtx: TestCommandContext = {
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
    isIdle: () => true,
  };
  try {
    await commandHandler("", overlayCtx);
    assert.ok(overlay);
    const lines = overlay.render(100).join("\n");
    assert.match(lines, /1 fires/);
    assert.doesNotMatch(lines, /0 fires/);
  } finally {
    await shutdownHandler?.({}, idleCtx);
  }
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
  render: (width: number) => string[];
}

type TestOverlayFactory = (
  tui: { terminal: { rows: number }; requestRender: () => void },
  theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
  keybindings: object,
  done: () => void,
) => TestOverlay;
