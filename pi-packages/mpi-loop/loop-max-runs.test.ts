import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import loopExtension from "./index.js";

interface TestOverlay {
  handleInput(data: string): void;
  render(width: number): string[];
}

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

function setup(t: TestContext) {
  const timers = new Map<number, () => void>();
  const timeouts = new Set<number>();
  const sent: string[] = [];
  const notices: string[] = [];
  let nextTimerId = 1;
  let command: CommandOptions | undefined;
  let shutdown: (() => void) | undefined;
  let settle: (() => void) | undefined;
  let overlay: TestOverlay | undefined;
  let idle = true;
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  let now = 1_700_000_000_000;
  Date.now = () => now;
  globalThis.setInterval = ((fn: () => void) => {
    const id = nextTimerId++;
    timers.set(id, fn);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => timers.delete(id)) as unknown as typeof clearInterval;
  globalThis.setTimeout = (() => {
    const id = nextTimerId++;
    timeouts.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => timeouts.delete(id)) as unknown as typeof clearTimeout;

  const ctx = {
    isIdle: () => idle,
    ui: {
      notify: (message: string) => notices.push(message),
      custom: async (factory: (...args: unknown[]) => TestOverlay) => {
        overlay = factory(
          { terminal: { rows: 30 }, requestRender: () => {} },
          {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
          },
          {},
          () => {},
        );
      },
    },
  } as unknown as ExtensionCommandContext;

  t.after(() => {
    try {
      shutdown?.();
    } finally {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  loopExtension({
    registerCommand: (_name: string, options: CommandOptions) => {
      command = options;
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) => {
      if (event === "session_shutdown") shutdown = () => handler({}, ctx);
      if (event === "agent_settled") settle = () => handler({}, ctx);
    },
    events: { emit: () => {}, on: () => () => {} },
    sendUserMessage: (prompt: string) => sent.push(prompt),
  } as unknown as ExtensionAPI);
  assert.ok(command);
  const registered = command;

  return {
    sent,
    notices,
    timers,
    timeouts,
    advance: (ms: number) => {
      now += ms;
    },
    run: (args: string) => registered.handler(args, ctx),
    completions: (prefix: string) => registered.getArgumentCompletions?.(prefix) ?? null,
    tick: () => {
      for (const fn of [...timers.values()]) fn();
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    settle: () => settle?.(),
    detail: async () => {
      await registered.handler("", ctx);
      assert.ok(overlay);
      overlay.handleInput("\r");
      return overlay;
    },
  };
}

for (const limit of [1, 3]) {
  test(`creation with max-runs ${limit} stops at the total including the immediate run`, async (t) => {
    const h = setup(t);
    await h.run(`2h --max-runs ${limit} first\nsecond`);
    assert.deepEqual(h.sent, ["first\nsecond"]);
    for (let i = 1; i < limit; i++) h.tick();
    assert.deepEqual(
      h.sent,
      Array.from({ length: limit }, () => "first\nsecond"),
    );
    assert.equal(h.timers.size, 0);
    assert.equal(h.timeouts.size, 0);
    h.tick();
    assert.equal(h.sent.length, limit);
  });
}

test("max-runs updates by id and name without firing, resetting runs, or rescheduling", async (t) => {
  const h = setup(t);
  await h.run("2h review");
  h.tick();
  const timersBefore = [...h.timers.keys()];
  h.advance(60_000);
  await h.run("max-runs 1 4");
  const byId = await h.detail();
  assert.match(byId.render(100).join("\n"), /Interval: 2h\s+Next: in 1h59m\s+Runs: 2\/4/);
  await h.run("max-runs review 3");
  assert.equal(h.sent.length, 2);
  assert.deepEqual([...h.timers.keys()], timersBefore);
  h.tick();
  assert.deepEqual(h.sent, ["review", "review", "review"]);
  assert.equal(h.timers.size, 0);
});

test("unlimited removes a limit and the UI can set it again", async (t) => {
  const h = setup(t);
  await h.run("--max-runs 2 review");
  await h.run("max-runs 1 unlimited");
  h.tick();
  h.tick();
  assert.equal(h.sent.length, 3);
  const view = await h.detail();
  assert.match(view.render(100).join("\n"), /Runs: 3\s/);
  view.handleInput("c");
  view.handleInput("4");
  view.handleInput("\r");
  assert.match(view.render(100).join("\n"), /Runs: 3\/4/);
  h.tick();
  assert.equal(h.sent.length, 4);
  assert.equal(h.timers.size, 0);
});

test("setting the total to executed runs cancels pending delivery", async (t) => {
  const h = setup(t);
  await h.run("--max-runs 3 review");
  h.setIdle(false);
  h.tick();
  await h.run("max-runs 1 1");
  h.setIdle(true);
  h.settle();
  assert.deepEqual(h.sent, ["review"]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test("deferred ticks still count once toward a command-configured limit", async (t) => {
  const h = setup(t);
  await h.run("--max-runs 2 review");
  h.setIdle(false);
  h.tick();
  h.tick();
  assert.deepEqual(h.sent, ["review"]);
  h.setIdle(true);
  h.settle();
  h.settle();
  assert.deepEqual(h.sent, ["review", "review"]);
  assert.equal(h.timers.size, 0);
});

test("invalid max-runs commands leave the running loop unchanged", async (t) => {
  const h = setup(t);
  await h.run("--max-runs 4 review");
  h.tick();
  for (const args of [
    "max-runs",
    "max-runs 1",
    "max-runs 1 3 extra",
    "max-runs missing 3",
    "max-runs 1 0",
    "max-runs 1 -1",
    "max-runs 1 1.5",
    "max-runs 1 9007199254740992",
    "max-runs 1 1",
  ]) {
    await h.run(args);
    assert.match(h.notices.at(-1) ?? "", /^Error:/, args);
  }
  assert.deepEqual(h.sent, ["review", "review"]);
  const view = await h.detail();
  assert.match(view.render(100).join("\n"), /Runs: 2\/4/);
  h.tick();
  h.tick();
  assert.equal(h.sent.length, 4);
  assert.equal(h.timers.size, 0);
});

test("invalid creation options report errors without creating timers or delivering prompts", async (t) => {
  const h = setup(t);
  for (const args of [
    "--max-runs",
    "--max-runs 0 review",
    "--max-runs 3 --max-runs 4 review",
    "--max-runs 3",
  ]) {
    await h.run(args);
    assert.match(h.notices.at(-1) ?? "", /^Error:/);
  }
  assert.deepEqual(h.sent, []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test("max-runs completion offers tasks and leaves count entry free", async (t) => {
  const h = setup(t);
  await h.run("10m review");
  assert.ok((await h.completions(""))?.some((item) => item.value === "max-runs "));
  assert.deepEqual(
    (await h.completions("max-runs "))?.map((item) => item.value),
    ["max-runs 1 "],
  );
  assert.deepEqual(
    (await h.completions("max-runs rev"))?.map((item) => item.value),
    ["max-runs 1 "],
  );
  assert.equal(await h.completions("max-runs 1 3"), null);
});
