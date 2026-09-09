import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LoopManagementView, type LoopViewEntry } from "./loop-management-view.js";

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
    fireCount: 3,
    maxFireCount: null,
    nextRunAt: Date.now() + 60_000,
    mode: "defer",
    pending: false,
    ...overrides,
  };
}

function createView(entries: LoopViewEntry[], maxHeight = 16) {
  return new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => maxHeight,
    {
      getLoops: () => entries,
      fire: () => {},
      setMode: (id, mode) => {
        const entry = entries.find((item) => item.id === id);
        if (entry) {
          entry.mode = mode;
          if (mode === "skip") entry.pending = false;
        }
      },
      setMaxFireCount: (id, maxFireCount) => {
        const entry = entries.find((item) => item.id === id);
        if (entry) entry.maxFireCount = maxFireCount;
      },
      remove: () => {},
      clear: () => {},
    },
  );
}

test("list keeps short summaries above run metadata and separates complete tasks", () => {
  const entries = [
    loop({ prompt: "部署检查：".repeat(30), pending: true, maxFireCount: 5 }),
    loop({ id: "2", prompt: "second task", pending: true, maxFireCount: 5 }),
  ];
  for (const height of [9, 10, 16]) {
    for (const width of [20, 40, 64, 100]) {
      const lines = createView(entries, height).render(width);
      const first = lines.findIndex((line) => line.includes("#1"));
      const second = lines.findIndex((line) => line.includes("#2"));
      assert.ok(first >= 0 && second >= 0);
      assert.match(lines[first + 1]!, /Runs: 3\/5/);
      assert.match(lines[second + 1]!, /Runs: 3\/5/);
      assert.match(lines[first]!, /waiting +│$/);
      assert.match(lines[second]!, /waiting +│$/);
      const summary = lines[first]!.match(/#1 (.*?) +waiting/)!;
      assert.ok(visibleWidth(summary[1]!) <= 24);
      const shouldSeparate = height >= 16;
      assert.equal(second - first, shouldSeparate ? 3 : 2);
      if (shouldSeparate) assert.match(lines[first + 2]!, /^│ +│$/);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      assert.ok(lines.length <= height);
    }
  }
});

test("detail limits metadata to two lines and separates it from the complete prompt", () => {
  for (const width of [40, 64, 100]) {
    const view = createView([loop({ pending: true, maxFireCount: 5 })]);
    view.handleInput(ENTER);
    const lines = view.render(width);
    const promptIndex = lines.findIndex((line) => /Prompt +Lines/.test(line));
    const metadata = lines.slice(1, promptIndex).filter((line) => !/^│ +│$/.test(line));
    assert.equal(metadata.length, 2);
    assert.match(metadata[0]!, /Next: waiting.*Runs: 3\/5/);
    assert.match(metadata[1]!, /Interval: 10m.*When busy: defer/);
    assert.match(lines[promptIndex - 1]!, /^│ +│$/);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.ok(lines.length <= 16);
  }
});

test("list reserves countdown and count space for a long multilingual prompt", () => {
  const view = createView(
    [loop({ prompt: "部署检查：".repeat(30), pending: true, maxFireCount: 5 })],
    12,
  );
  for (const width of [20, 40, 64, 100]) {
    const lines = view.render(width);
    assert.match(lines.join("\n"), /waiting/);
    assert.match(lines.join("\n"), /3\/5/);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.length <= 12);
  }
});

test("detail fits its total height budget after resizing and still reaches the last prompt line", () => {
  const view = createView(
    [loop({ prompt: Array.from({ length: 30 }, (_, i) => `ROW-${i + 1}`).join("\n") })],
    12,
  );
  view.handleInput(ENTER);
  for (const width of [20, 40, 64, 100]) {
    view.render(width);
    view.handleInput("G");
    const lines = view.render(width);
    assert.ok(lines.length <= 12);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /ROW-30/);
    assert.match(lines.join("\n"), /q close/);
  }
});

test("any non-y key cancels inline removal without hiding the list", () => {
  let removed = 0;
  const entry = loop({ prompt: "keep this prompt" });
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => 12,
    {
      getLoops: () => [entry],
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {
        removed++;
      },
      clear: () => {},
    },
  );
  view.handleInput("x");
  assert.match(view.render(80).join("\n"), /keep this prompt/);
  view.handleInput("z");
  view.handleInput("y");
  assert.equal(removed, 0);
  assert.doesNotMatch(view.render(80).join("\n"), /Remove loop/);
});

test("detail supports vim scrolling, half pages and q close", () => {
  let closed = false;
  const entry = loop({ prompt: Array.from({ length: 40 }, (_, i) => `ROW-${i + 1}`).join("\n") });
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {
      closed = true;
    },
    () => 16,
    {
      getLoops: () => [entry],
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );
  view.handleInput(ENTER);
  view.render(80);
  view.handleInput("j");
  assert.match(view.render(80).join("\n"), /Lines 2-/);
  view.handleInput("k");
  assert.match(view.render(80).join("\n"), /Lines 1-/);
  view.handleInput("\x04");
  assert.match(view.render(80).join("\n"), /Lines 4-/);
  view.handleInput("\x15");
  assert.match(view.render(80).join("\n"), /Lines 1-/);
  view.handleInput("G");
  assert.match(view.render(80).join("\n"), /ROW-40/);
  view.handleInput("g");
  assert.match(view.render(80).join("\n"), /Lines 1-/);
  view.handleInput("q");
  assert.equal(closed, true);
});

test("a selected task keeps both highlighted rows visible after a height change", () => {
  const entries = Array.from({ length: 20 }, (_, i) =>
    loop({
      id: String(i + 1),
      prompt: `TASK-${i + 1}`,
      maxFireCount: 5,
    }),
  );
  let maxHeight = 16;
  const selectionTheme = {
    ...theme,
    bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  };
  const view = new LoopManagementView(
    selectionTheme,
    () => {},
    () => {},
    () => maxHeight,
    {
      getLoops: () => entries,
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );
  for (let i = 1; i < entries.length; i++) view.handleInput(DOWN);
  for (const height of [16, 8, 12]) {
    maxHeight = height;
    const lines = view.render(64);
    const selected = lines.findIndex((line) => line.includes("› #20 TASK-20"));
    assert.ok(selected >= 0);
    assert.match(lines[selected]!, /\x1b\[44m/);
    assert.match(lines[selected + 1]!, /\x1b\[44m.*Runs: 3\/5/);
    assert.ok(lines.length <= height);
  }
});

test("search keeps vim letters as query text and Ctrl+U clears the query", () => {
  const view = createView([loop({ prompt: "jkgG" })]);
  for (const key of "jkgG") view.handleInput(key);
  assert.match(view.render(60).join("\n"), /Search: jkgG/);
  view.handleInput("\x15");
  assert.match(view.render(60).join("\n"), /Search: _/);
});

test("inline clear requires y and otherwise preserves all tasks", () => {
  let entries = [loop({ prompt: "keep first" }), loop({ id: "2", prompt: "keep second" })];
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => 16,
    {
      getLoops: () => entries,
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {
        entries = [];
      },
    },
  );
  view.handleInput("c");
  assert.match(view.render(80).join("\n"), /keep second/);
  view.handleInput("q");
  assert.equal(entries.length, 2);
  view.handleInput("c");
  view.handleInput("y");
  assert.deepEqual(entries, []);
  assert.match(view.render(80).join("\n"), /No matching loops/);
});

test("Enter opens a detail view that preserves the complete multiline prompt", () => {
  const view = createView([loop()]);

  view.handleInput(ENTER);
  const rendered = view.render(50).join("\n");

  assert.match(rendered, /┌ Loop 1 /);
  assert.match(rendered, /First line/);
  assert.match(rendered, /Second line with 中文/);
  assert.match(rendered, /long suffix/);
  assert.match(rendered, /that wraps/);
  assert.doesNotMatch(rendered, /First line…/);
});

test("detail scrolling reaches every part of a long prompt", () => {
  const prompt = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n");
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => 15,
    {
      getLoops: () => [loop({ prompt })],
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );

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
  const view = new LoopManagementView(
    theme,
    () => {},
    () => closed++,
    () => 12,
    {
      getLoops: () => [entry],
      fire: (prompt) => fired.push(prompt),
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );

  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /┌ Loop 1 /);
  assert.deepEqual(fired, []);
  assert.equal(closed, 0);

  view.handleInput("f");
  assert.deepEqual(fired, [entry.prompt]);
  assert.equal(closed, 1);
});

test("m toggles conflict mode in detail and clears pending on skip", () => {
  const entry = loop({ mode: "defer", pending: true });
  const modes: string[] = [];
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => 12,
    {
      getLoops: () => [entry],
      fire: () => {},
      setMode: (id, mode) => {
        modes.push(`${id}:${mode}`);
        entry.mode = mode;
        if (mode === "skip") entry.pending = false;
      },
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );

  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /When busy: defer/);
  assert.match(view.render(60).join("\n"), /Next: waiting/);

  view.handleInput("m");
  assert.deepEqual(modes, ["1:skip"]);
  const afterSkip = view.render(60).join("\n");
  assert.match(afterSkip, /When busy: skip/);
  assert.doesNotMatch(afterSkip, /pending/);
  assert.doesNotMatch(afterSkip, /waiting/);

  view.handleInput("m");
  assert.deepEqual(modes, ["1:skip", "1:defer"]);
  assert.match(view.render(60).join("\n"), /When busy: defer/);
});

test("c edits the total run count from loop details", () => {
  const entry = loop({ fireCount: 1 });
  const view = createView([entry]);

  view.handleInput(ENTER);
  view.handleInput("c");
  assert.match(view.render(60).join("\n"), /Total runs \(blank = unlimited\)/);

  view.handleInput("3");
  view.handleInput(ENTER);

  assert.equal(entry.maxFireCount, 3);
  assert.match(view.render(60).join("\n"), /Runs: 1\/3/);
});

test("blank total run input removes the limit", () => {
  const entry = loop({ maxFireCount: 5 });
  const view = createView([entry]);
  view.handleInput(ENTER);
  view.handleInput("c");
  view.handleInput(ENTER);
  assert.equal(entry.maxFireCount, null);
  assert.match(view.render(60).join("\n"), /Runs: 3\/unlimited/);
});

for (const value of ["0", "2", "1.5", "9007199254740992"]) {
  test(`total run input rejects ${value} without changing the limit`, () => {
    const entry = loop({ fireCount: 3, maxFireCount: 5 });
    const view = createView([entry]);
    view.handleInput(ENTER);
    view.handleInput("c");
    view.handleInput(value);
    view.handleInput(ENTER);
    assert.match(view.render(100).join("\n"), /Error:/);
    assert.equal(entry.maxFireCount, 5);
  });
}

test("f fires directly from the list", () => {
  const fired: string[] = [];
  let closed = 0;
  const entry = loop();
  const view = new LoopManagementView(
    theme,
    () => {},
    () => closed++,
    () => 12,
    {
      getLoops: () => [entry],
      fire: (prompt) => fired.push(prompt),
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {},
      clear: () => {},
    },
  );

  view.handleInput("f");

  assert.deepEqual(fired, [entry.prompt]);
  assert.equal(closed, 1);
});

test("v remains a search character and right has no action", () => {
  const view = createView([loop({ name: "review" })]);

  view.handleInput("v");
  assert.match(view.render(60).join("\n"), /Search: v/);
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
  assert.match(list, /Search: bet/);
  assert.match(list, /› #2 beta prompt/);
  assert.doesNotMatch(list, /#1 alpha prompt/);

  view.handleInput(ENTER);
  view.handleInput(ESCAPE);
  assert.match(view.render(60).join("\n"), /Search: bet/);
});

test("deleting from details returns to the neighboring loop", () => {
  let entries = [
    loop({ id: "1", name: "alpha", prompt: "alpha prompt" }),
    loop({ id: "2", name: "beta", prompt: "beta prompt" }),
    loop({ id: "3", name: "gamma", prompt: "gamma prompt" }),
  ];
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {},
    () => 12,
    {
      getLoops: () => entries,
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: (id) => {
        entries = entries.filter((entry) => entry.id !== id);
      },
      clear: () => {},
    },
  );

  view.handleInput(DOWN);
  view.handleInput(ENTER);
  assert.match(view.render(60).join("\n"), /┌ Loop 2 /);
  view.handleInput("x");
  assert.match(view.render(60).join("\n"), /Remove loop "beta"/);

  view.handleInput("y");
  const list = view.render(60).join("\n");
  assert.match(list, /┌ Loops \(2\)/);
  assert.match(list, /› #3 gamma prompt/);
  assert.doesNotMatch(list, /#2 beta prompt/);
});

test("Esc on remove confirm cancels back to the list instead of closing", () => {
  let closed = false;
  const entries = [loop({ id: "1", name: "alpha" }), loop({ id: "2", name: "beta" })];
  const view = new LoopManagementView(
    theme,
    () => {},
    () => {
      closed = true;
    },
    () => 12,
    {
      getLoops: () => entries,
      fire: () => {},
      setMode: () => {},
      setMaxFireCount: () => {},
      remove: () => {
        throw new Error("remove should not run on Esc cancel");
      },
      clear: () => {},
    },
  );

  view.handleInput("x");
  assert.match(view.render(60).join("\n"), /Remove loop "alpha"/);

  view.handleInput(ESCAPE);
  const list = view.render(60).join("\n");
  assert.equal(closed, false);
  assert.doesNotMatch(list, /Remove loop/);
  assert.match(list, /┌ Loops \(2\)/);
  assert.match(list, /First line/);
});
