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

test("mpi-loop defer coalesces busy timer ticks and flushes once on agent_end", async () => {
  const sent: Array<{ prompt: string; options: unknown }> = [];
  const intervalFns: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((fn: () => void) => {
    intervalFns.push(fn);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  globalThis.setTimeout = ((() => 1) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let agentEndHandler: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let idle = false;
  const ctx: TestCommandContext = {
    ui: { notify: () => {} },
    isIdle: () => idle,
  };
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
      commandHandler = options.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "agent_end") agentEndHandler = handler as typeof agentEndHandler;
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string, options?: unknown) => sent.push({ prompt, options }),
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(commandHandler);
    assert.ok(agentEndHandler);

    await commandHandler("10m defer prompt", ctx);
    assert.equal(sent.length, 1, "immediate fire still delivers while busy");
    assert.equal(intervalFns.length, 1);

    sent.length = 0;
    intervalFns[0]!();
    intervalFns[0]!();
    intervalFns[0]!();
    assert.deepEqual(sent, [], "busy defer ticks must not stack sends");

    idle = true;
    await agentEndHandler?.({ type: "agent_end" }, ctx);
    assert.deepEqual(sent, [{ prompt: "defer prompt", options: undefined }]);

    sent.length = 0;
    await agentEndHandler?.({ type: "agent_end" }, ctx);
    assert.deepEqual(sent, [], "second agent_end must not re-fire without a new tick");
  } finally {
    await shutdownHandler?.({}, ctx);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("mpi-loop skip drops busy timer ticks and never flushes them", async () => {
  const sent: Array<{ prompt: string; options: unknown }> = [];
  const intervalFns: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((fn: () => void) => {
    intervalFns.push(fn);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  globalThis.setTimeout = ((() => 1) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let agentEndHandler: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlay: TestOverlay | undefined;
  let idle = false;
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
    isIdle: () => idle,
  };
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
      commandHandler = options.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "agent_end") agentEndHandler = handler as typeof agentEndHandler;
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string, options?: unknown) => sent.push({ prompt, options }),
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(commandHandler);
    await commandHandler("10m skip prompt", ctx);
    assert.equal(sent.length, 1);

    // Switch default defer → skip via detail `m`.
    await commandHandler("", ctx);
    assert.ok(overlay);
    overlay.handleInput("\r"); // enter detail
    overlay.handleInput("m"); // defer → skip, clears any pending

    sent.length = 0;
    intervalFns[0]!();
    intervalFns[0]!();
    assert.deepEqual(sent, [], "skip must drop busy timer ticks");

    idle = true;
    await agentEndHandler?.({ type: "agent_end" }, ctx);
    assert.deepEqual(sent, [], "skip must not flush dropped ticks on agent_end");
  } finally {
    await shutdownHandler?.({}, ctx);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
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
