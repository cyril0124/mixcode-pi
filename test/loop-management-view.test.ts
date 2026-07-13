import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopManagementView, type LoopViewEntry } from "../pi-packages/mpi-loop/loop-management-view.js";

const ESCAPE = "\x1b";
const ENTER = "\r";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

function loop(overrides: Partial<LoopViewEntry> = {}): LoopViewEntry {
  return {
    id: "1",
    name: "review",
    prompt: "First line\nSecond line with 中文 and a long suffix that wraps.",
    intervalLabel: "10m",
    createdAt: new Date("2026-07-13T00:00:00Z"),
    fireCount: 3,
    nextRunAt: Date.now() + 60_000,
    ...overrides,
  };
}

function createView(entries: LoopViewEntry[]) {
  return new LoopManagementView(theme, () => {}, () => {}, () => 12, {
    getLoops: () => entries,
    fire: () => {},
    remove: () => {},
    clear: () => {},
  });
}

test("Enter opens a detail view that preserves the complete multiline prompt", () => {
  const view = createView([loop()]);

  view.handleInput(ENTER);
  const rendered = view.render(50).join("\n");

  assert.match(rendered, /┌ Loop 1 /);
  assert.match(rendered, /First line/);
  assert.match(rendered, /Second line with 中文/);
  assert.match(rendered, /long suffix that/);
  assert.match(rendered, /wraps\./);
  assert.doesNotMatch(rendered, /First line…/);
});

test("detail scrolling reaches every part of a long prompt", () => {
  const prompt = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n");
  const view = new LoopManagementView(theme, () => {}, () => {}, () => 8, {
    getLoops: () => [loop({ prompt })],
    fire: () => {},
    remove: () => {},
    clear: () => {},
  });

  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /Lines 1-5\/20/);

  view.handleInput(DOWN);
  assert.match(view.render(60).join("\n"), /Lines 2-6\/20/);

  view.handleInput(END);
  const atEnd = view.render(60).join("\n");
  assert.match(atEnd, /Line 20/);
  assert.match(atEnd, /Lines 16-20\/20/);

  view.handleInput(UP);
  assert.match(view.render(60).join("\n"), /Lines 15-19\/20/);

  view.handleInput(HOME);
  view.handleInput(PAGE_DOWN);
  assert.match(view.render(60).join("\n"), /Lines 6-10\/20/);
  view.handleInput(PAGE_UP);
  assert.match(view.render(60).join("\n"), /Lines 1-5\/20/);
});

test("Enter opens details and f fires the prompt then closes", () => {
  const fired: string[] = [];
  let closed = 0;
  const entry = loop();
  const view = new LoopManagementView(theme, () => {}, () => closed++, () => 12, {
    getLoops: () => [entry],
    fire: (prompt) => fired.push(prompt),
    remove: () => {},
    clear: () => {},
  });

  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /┌ Loop 1 /);
  assert.deepEqual(fired, []);
  assert.equal(closed, 0);

  view.handleInput("f");
  assert.deepEqual(fired, [entry.prompt]);
  assert.equal(closed, 1);
});

test("f fires directly from the list", () => {
  const fired: string[] = [];
  let closed = 0;
  const entry = loop();
  const view = new LoopManagementView(theme, () => {}, () => closed++, () => 12, {
    getLoops: () => [entry],
    fire: (prompt) => fired.push(prompt),
    remove: () => {},
    clear: () => {},
  });

  view.handleInput("f");

  assert.deepEqual(fired, [entry.prompt]);
  assert.equal(closed, 1);
});

test("v remains a search character and right has no action", () => {
  const view = createView([loop({ name: "review" })]);

  view.handleInput("v");
  assert.match(view.render(60).join("\n"), /> v/);
  assert.doesNotMatch(view.render(60).join("\n"), /┌ Loop 1 /);

  view.handleInput(RIGHT);
  assert.doesNotMatch(view.render(60).join("\n"), /┌ Loop 1 /);
});

test("left returns to the same filtered list selection", () => {
  const view = createView([
    loop({ id: "1", name: "alpha", prompt: "alpha prompt" }),
    loop({ id: "2", name: "beta", prompt: "beta prompt" }),
  ]);

  for (const character of "bet") view.handleInput(character);
  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /┌ Loop 2 /);

  view.handleInput(LEFT);
  const list = view.render(60).join("\n");
  assert.match(list, /> bet/);
  assert.match(list, /› 2 {2}beta/);
  assert.doesNotMatch(list, /1 {2}alpha/);

  view.handleInput(ENTER);
  view.handleInput(ESCAPE);
  assert.match(view.render(60).join("\n"), /> bet/);
});

test("deleting from details returns to the neighboring loop", () => {
  let entries = [
    loop({ id: "1", name: "alpha", prompt: "alpha prompt" }),
    loop({ id: "2", name: "beta", prompt: "beta prompt" }),
    loop({ id: "3", name: "gamma", prompt: "gamma prompt" }),
  ];
  const view = new LoopManagementView(theme, () => {}, () => {}, () => 12, {
    getLoops: () => entries,
    fire: () => {},
    remove: (id) => {
      entries = entries.filter((entry) => entry.id !== id);
    },
    clear: () => {},
  });

  view.handleInput(DOWN);
  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /┌ Loop 2 /);
  view.handleInput("x");
  assert.match(view.render(60).join("\n"), /Remove loop "beta"/);

  view.handleInput("y");
  const list = view.render(60).join("\n");
  assert.match(list, /┌ Loops /);
  assert.match(list, /› 3 {2}gamma/);
  assert.doesNotMatch(list, /2 {2}beta/);
});
