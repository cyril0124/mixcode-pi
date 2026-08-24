import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import loopExtension from "./index.js";

test("mpi-loop stops after the configured total fire count", async () => {
  const sent: string[] = [];
  const intervalFns: Array<() => void> = [];
  const clearedIntervals: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((fn: () => void) => {
    intervalFns.push(fn);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id) => {
    clearedIntervals.push(id);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((() => 2) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

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

  try {
    loopExtension(pi);
    assert.ok(commandHandler);

    await commandHandler("10m bounded prompt", ctx);
    assert.deepEqual(sent, ["bounded prompt"], "immediate first fire counts toward the total");
    assert.equal(intervalFns.length, 1);

    await commandHandler("", ctx);
    assert.ok(overlay);
    overlay.handleInput("\r");
    overlay.handleInput("c");
    overlay.handleInput("2");
    overlay.handleInput("\r");
    assert.match(overlay.render(100).join("\n"), /Runs: 1\/2/);

    intervalFns[0]!();
    assert.deepEqual(sent, ["bounded prompt", "bounded prompt"]);
    assert.deepEqual(clearedIntervals, [1], "timer must stop at the configured total");

    intervalFns[0]!();
    assert.equal(sent.length, 2, "ticks after the total must not deliver more prompts");

    await commandHandler("", ctx);
    assert.ok(overlay);
    assert.match(overlay.render(100).join("\n"), /No matching loops/);
  } finally {
    await shutdownHandler?.({}, ctx);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
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
    {
      prompt: "busy prompt",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);

  sent.length = 0;
  await commandHandler("", ctx);
  assert.ok(overlay);
  overlay.handleInput("f");
  await shutdownHandler?.({}, ctx);

  assert.deepEqual(sent, [
    {
      prompt: "busy prompt",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
});

test("mpi-loop defer coalesces busy ticks and flushes once on agent_settled", async () => {
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
  let agentSettledHandler: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  // Match real Pi: isIdle stays false through agent_end; true only after settle.
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
      if (event === "agent_settled") agentSettledHandler = handler as typeof agentSettledHandler;
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string, options?: unknown) => sent.push({ prompt, options }),
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(commandHandler);
    assert.ok(agentSettledHandler);

    await commandHandler("10m defer prompt", ctx);
    assert.equal(sent.length, 1, "immediate fire still delivers while busy");
    assert.equal(intervalFns.length, 1);

    sent.length = 0;
    intervalFns[0]!();
    intervalFns[0]!();
    intervalFns[0]!();
    assert.deepEqual(sent, [], "busy defer ticks must not stack sends");

    // Real Pi agent_end: still not idle — must not flush here.
    idle = false;
    sent.length = 0;

    idle = true;
    await agentSettledHandler?.({ type: "agent_settled" }, ctx);
    assert.deepEqual(sent, [
      { prompt: "defer prompt", options: { expandPromptTemplates: true } },
    ]);

    sent.length = 0;
    await agentSettledHandler?.({ type: "agent_settled" }, ctx);
    assert.deepEqual(sent, [], "second agent_settled must not re-fire without a new tick");
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
  let agentSettledHandler: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
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
      if (event === "agent_settled") agentSettledHandler = handler as typeof agentSettledHandler;
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
    await agentSettledHandler?.({ type: "agent_settled" }, ctx);
    assert.deepEqual(sent, [], "skip must not flush dropped ticks on agent_settled");
  } finally {
    await shutdownHandler?.({}, ctx);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("mpi-loop interval completion leaves the interval token free-form", async () => {
  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let getArgumentCompletions:
    | ((prefix: string) => Array<{ label: string; value: string }> | null)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const ctx: TestCommandContext = {
    ui: { notify: () => {} },
    isIdle: () => true,
  };
  const pi = {
    registerCommand: (
      _name: string,
      options: {
        handler: typeof commandHandler;
        getArgumentCompletions?: typeof getArgumentCompletions;
      },
    ) => {
      commandHandler = options.handler;
      getArgumentCompletions = options.getArgumentCompletions;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(commandHandler);
    assert.ok(getArgumentCompletions);
    await commandHandler("10m free-interval", ctx);

    // After id + free-typed interval, completions must stop (no preset force-fill).
    assert.equal(getArgumentCompletions("interval 1 2h"), null);

    const idSuggestions = getArgumentCompletions("interval ") ?? [];
    assert.deepEqual(
      idSuggestions.map((s) => s.value),
      ["interval 1 "],
    );
  } finally {
    await shutdownHandler?.({}, ctx);
  }
});

test("mpi-loop reschedules an existing loop interval without re-firing", async () => {
  const sent: string[] = [];
  const intervalCalls: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTimerId = 1;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervalCalls.push({ fn, ms: ms ?? 0 });
    return nextTimerId++ as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id) => {
    cleared.push(id);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((() => 1) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlay: TestOverlay | undefined;
  const notifies: Array<{ message: string; level: string }> = [];
  const ctx: TestCommandContext = {
    ui: {
      notify: (message, level) => notifies.push({ message, level }),
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

  try {
    loopExtension(pi);
    assert.ok(commandHandler);

    await commandHandler("10m reschedule-me", ctx);
    assert.deepEqual(sent, ["reschedule-me"]);
    assert.equal(intervalCalls.length, 1);
    assert.equal(intervalCalls[0]!.ms, 10 * 60_000);
    const originalTimerId = 1;

    sent.length = 0;
    await commandHandler("interval 1 30s", ctx);
    assert.deepEqual(sent, [], "reschedule must not fire immediately");
    assert.ok(cleared.includes(originalTimerId), "old timer must be cleared");
    assert.equal(intervalCalls.length, 2, "new timer must be scheduled");
    assert.equal(intervalCalls[1]!.ms, 30_000);
    assert.match(
      notifies.at(-1)?.message ?? "",
      /30s/,
      "notify should report the new interval",
    );

    await commandHandler("", ctx);
    assert.ok(overlay);
    const list = overlay.render(100).join("\n");
    assert.match(list, /30s/);
    assert.doesNotMatch(list, /\b10m\b/);
  } finally {
    await shutdownHandler?.({}, ctx);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("mpi-loop updates an existing loop prompt without re-firing", async () => {
  const sent: string[] = [];
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
  let getArgumentCompletions:
    | ((prefix: string) => Array<{ label: string; value: string }> | null)
    | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlay: TestOverlay | undefined;
  const notifies: Array<{ message: string; level: string }> = [];
  const ctx: TestCommandContext = {
    ui: {
      notify: (message, level) => notifies.push({ message, level }),
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
  const pi = {
    registerCommand: (
      _name: string,
      options: {
        handler: typeof commandHandler;
        getArgumentCompletions?: typeof getArgumentCompletions;
      },
    ) => {
      commandHandler = options.handler;
      getArgumentCompletions = options.getArgumentCompletions;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string) => sent.push(prompt),
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(commandHandler);
    assert.ok(getArgumentCompletions);

    await commandHandler("10m old prompt", ctx);
    assert.deepEqual(sent, ["old prompt"]);

    sent.length = 0;
    await commandHandler("prompt 1 new prompt\nline two", ctx);
    assert.deepEqual(sent, [], "prompt update must not fire immediately");
    assert.match(
      notifies.at(-1)?.message ?? "",
      /new prompt/,
      "notify should report the new prompt",
    );

    await commandHandler("", ctx);
    assert.ok(overlay);
    const list = overlay.render(100).join("\n");
    assert.match(list, /new prompt/);
    assert.doesNotMatch(list, /old prompt/);

    sent.length = 0;
    assert.equal(intervalFns.length, 1);
    intervalFns[0]!();
    assert.deepEqual(sent, ["new prompt\nline two"], "next fire must use updated prompt");

    assert.deepEqual(
      (getArgumentCompletions("prompt ") ?? []).map((s) => s.value),
      ["prompt 1 "],
    );

    const emptyNotifiesBefore = notifies.length;
    await commandHandler("prompt 1", ctx);
    assert.equal(notifies.length, emptyNotifiesBefore + 1);
    assert.equal(notifies.at(-1)?.level, "warning");

    const missingNotifiesBefore = notifies.length;
    await commandHandler("prompt missing brand-new", ctx);
    assert.equal(notifies.length, missingNotifiesBefore + 1);
    assert.equal(notifies.at(-1)?.level, "warning");
    assert.deepEqual(sent, ["new prompt\nline two"], "failed updates must not create or fire a loop");
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

test("mpi-loop isolates loops across extension instances (tabs)", async () => {
  const sentA: string[] = [];
  const sentB: string[] = [];
  let handlerA: ((args: string, ctx: TestCommandContext) => Promise<void>) | undefined;
  let handlerB: ((args: string, ctx: TestCommandContext) => Promise<void>) | undefined;
  let startA: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let startB: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let shutdownA: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let shutdownB: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let overlayB: TestOverlay | undefined;

  const makePi = (
    sent: string[],
    setHandler: (h: typeof handlerA) => void,
    setStart: (h: typeof startA) => void,
    setShutdown: (h: typeof shutdownA) => void,
  ) =>
    ({
      registerCommand: (_name: string, options: { handler: typeof handlerA }) => {
        setHandler(options.handler);
      },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") setStart(handler as typeof startA);
        if (event === "session_shutdown") setShutdown(handler);
      },
      events: { emit: () => {}, on: () => () => {} },
      sendUserMessage: (prompt: string) => sent.push(prompt),
    }) as unknown as ExtensionAPI;

  const idleCtx = (): TestCommandContext => ({
    ui: { notify: () => {}, setWidget: () => {} },
    isIdle: () => true,
  });

  loopExtension(
    makePi(
      sentA,
      (h) => {
        handlerA = h;
      },
      (h) => {
        startA = h;
      },
      (h) => {
        shutdownA = h;
      },
    ),
  );
  loopExtension(
    makePi(
      sentB,
      (h) => {
        handlerB = h;
      },
      (h) => {
        startB = h;
      },
      (h) => {
        shutdownB = h;
      },
    ),
  );

  assert.ok(handlerA && handlerB && startA && startB && shutdownA && shutdownB);

  const ctxA = idleCtx();
  const ctxB = idleCtx();
  try {
    await startA!({ type: "session_start" }, ctxA);
    await startB!({ type: "session_start" }, ctxB);

    await handlerA!("10m only-on-A", ctxA);
    assert.deepEqual(sentA, ["only-on-A"]);
    assert.deepEqual(sentB, [], "tab B must not receive tab A's loop fires");

    // B's management overlay should not list A's loop.
    const overlayCtxB: TestCommandContext = {
      ui: {
        notify: () => {},
        custom: async (factory) => {
          overlayB = factory(
            { terminal: { rows: 30 }, requestRender: () => {} },
            { fg: (_c, t) => t, bg: (_c, t) => t },
            {},
            () => {},
          );
        },
      },
      isIdle: () => true,
    };
    await handlerB!("", overlayCtxB);
    assert.ok(overlayB);
    const listB = overlayB.render(100).join("\n");
    assert.doesNotMatch(listB, /only-on-A/);
    assert.match(listB, /No matching loops/);

    // Shutting down A must not kill loops that B creates afterward.
    await shutdownA!({}, ctxA);
    shutdownA = undefined;
    await handlerB!("10m only-on-B", ctxB);
    assert.deepEqual(sentB, ["only-on-B"]);
  } finally {
    await shutdownA?.({}, ctxA);
    await shutdownB?.({}, ctxB);
  }
});

test("mpi-loop refresh and timer tolerate stale ctx after session replacement", async () => {
  const STALE = "This extension ctx is stale after session replacement or reload.";
  const intervalFns: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const clearedIntervals: unknown[] = [];
  globalThis.setInterval = ((fn: () => void) => {
    intervalFns.push(fn);
    return intervalFns.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id) => {
    clearedIntervals.push(id);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((() => 1) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  let commandHandler:
    | ((args: string, ctx: TestCommandContext) => Promise<void>)
    | undefined;
  let sessionStartHandler: ((event: unknown, ctx: TestCommandContext) => unknown) | undefined;
  let shutdownHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const changeListeners: Array<() => void> = [];
  let stale = false;
  let setWidgetCalls = 0;
  const sent: string[] = [];

  const makeCtx = (): TestCommandContext => ({
    ui: {
      notify: () => {},
      setWidget: () => {
        if (stale) throw new Error(STALE);
        setWidgetCalls++;
      },
      custom: async (factory) => {
        factory(
          { terminal: { rows: 30 }, requestRender: () => {} },
          { fg: (_color, text) => text, bg: (_color, text) => text },
          {},
          () => {},
        );
      },
    },
    isIdle: () => {
      if (stale) throw new Error(STALE);
      return true;
    },
  });

  const pi = {
    registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
      commandHandler = options.handler;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_start") sessionStartHandler = handler as typeof sessionStartHandler;
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    events: {
      emit: (event: string) => {
        if (event === "loop:change") for (const listener of [...changeListeners]) listener();
      },
      on: (_event: string, listener: () => void) => {
        changeListeners.push(listener);
        return () => {
          const i = changeListeners.indexOf(listener);
          if (i >= 0) changeListeners.splice(i, 1);
        };
      },
    },
    sendUserMessage: (prompt: string) => {
      if (stale) throw new Error(STALE);
      sent.push(prompt);
    },
  } as unknown as ExtensionAPI;

  try {
    loopExtension(pi);
    assert.ok(sessionStartHandler);
    assert.ok(commandHandler);

    const ctx = makeCtx();
    await sessionStartHandler?.({ type: "session_start" }, ctx);
    await commandHandler("10m stale-probe", ctx);
    assert.deepEqual(sent, ["stale-probe"]);
    assert.ok(setWidgetCalls > 0, "widget should register while ctx is live");
    assert.equal(changeListeners.length, 1, "widget should subscribe to loop:change");
    const listenersBeforeStale = changeListeners.length;
    const widgetsBeforeStale = setWidgetCalls;
    const loopTimerCount = intervalFns.length;
    assert.ok(loopTimerCount >= 1, "loop timer should be registered");

    // Session replacement invalidates the captured command/session ctx.
    stale = true;
    // loop:change refresh hits setWidget with stale ctx → destroy unsubscribes.
    for (const listener of [...changeListeners]) listener();
    assert.equal(
      changeListeners.length,
      listenersBeforeStale - 1,
      "stale refresh must destroy the widget subscription",
    );
    assert.equal(setWidgetCalls, widgetsBeforeStale, "stale refresh must not re-register the widget");

    // Timer tick with stale isIdle cancels the loop instead of firing.
    sent.length = 0;
    for (const tick of [...intervalFns]) tick();
    assert.deepEqual(sent, [], "stale timer tick must not deliver the prompt");

    // Live ctx management overlay should show the loop was cancelled.
    // Re-declare so TS does not keep the prior `overlay = undefined` assignment.
    stale = false;
    let managementOverlay: TestOverlay | undefined;
    await commandHandler("", {
      ...makeCtx(),
      ui: {
        ...makeCtx().ui,
        custom: async (factory) => {
          managementOverlay = factory(
            { terminal: { rows: 30 }, requestRender: () => {} },
            { fg: (_color, text) => text, bg: (_color, text) => text },
            {},
            () => {},
          );
        },
      },
    });
    if (!managementOverlay) throw new Error("management overlay should open");
    assert.match(managementOverlay.render(100).join("\n"), /No matching loops/);

    // Fresh session_start must not resurrect the cancelled loop's widget.
    const widgetsBeforeRestart = setWidgetCalls;
    await sessionStartHandler?.({ type: "session_start" }, makeCtx());
    assert.equal(
      setWidgetCalls,
      widgetsBeforeRestart,
      "session_start with no loops must not show the widget",
    );
  } finally {
    stale = false;
    await shutdownHandler?.({}, makeCtx());
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

interface TestCommandContext {
  ui: {
    notify: (message: string, level: string) => void;
    setWidget?: (...args: unknown[]) => void;
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
