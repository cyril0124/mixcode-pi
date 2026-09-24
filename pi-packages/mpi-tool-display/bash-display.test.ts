// Contract tests for the collapsed bash call row: its label, status meta, and width behavior.
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolDisplayRenderers } from "./index.js";
import { disposeAll } from "./disposable.js";
import { BASH_CALL_OUTCOME_STATE_KEY, type BashCallOutcome } from "./types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderLines(component: unknown, width: number): string[] {
  return (component as { render(width: number): string[] }).render(width).map(stripAnsi);
}

function renderCallRow(
  args: Record<string, unknown>,
  options: { width?: number; state?: Record<string, unknown>; expanded?: boolean } = {},
): string[] {
  const { bash } = createToolDisplayRenderers();
  return renderLines(
    bash.renderCall(args as never, theme, {
      state: options.state ?? {},
      expanded: options.expanded ?? false,
      executionStarted: true,
      isPartial: false,
    } as never),
    options.width ?? 200,
  );
}

function outcome(overrides: Partial<BashCallOutcome> = {}): BashCallOutcome {
  return { lineCount: 32, failed: false, timedOut: false, aborted: false, ...overrides };
}

test("the label is the description argument", () => {
  const row = renderCallRow({
    description: "Find callers of the parser",
    command: '# Find callers of the parser\nrg -n "parser" src | head -30 && echo done',
  })[0]!;
  assert.match(row, /^bash Find callers of the parser\s+ctrl\+o$/);

  // The label is the description as written, whatever the command happens to contain.
  const commented = renderCallRow({
    description: "Count rows in the fixture",
    command: "# Count rows in the fixture\ncd /tmp && seq 1 40 | wc -l",
  })[0]!;
  assert.match(commented, /^bash Count rows in the fixture\s+ctrl\+o$/);

  // A description is whitespace-collapsed and loses escape sequences.
  const messy = renderCallRow({
    description: "  Build   the suite\u001b[31m  ",
    command: "bun run check",
  })[0]!;
  assert.match(messy, /^bash Build the suite\s+ctrl\+o$/);
});

test("a call without a description falls back to its command text", () => {
  const row = renderCallRow({
    command: "# Find callers of the parser\nrg -n parser src | head -30",
  })[0]!;
  assert.match(row, /^bash # Find callers of the parser rg -n parser src \| head -30/);
});

test("a missing label renders as a placeholder instead of an empty row", () => {
  const lines = renderCallRow({});
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.trim(), /^bash \.\.\.\s+ctrl\+o$/);
});

test("collapsed call row is exactly one line at every width", () => {
  const args = {
    description: "Count every row in the fixture files and print a summary",
    command:
      'cd /home/user/project && rg -n "parser" src pi-packages | head -30 ; echo "---" ; ls node_modules | wc -l',
  };
  for (const width of [200, 80, 40, 12, 7, 6, 5, 3, 1]) {
    const lines = renderCallRow(args, { width });
    assert.equal(lines.length, 1, `width ${width} must stay one row`);
    assert.ok(
      visibleWidth(lines[0]!) <= width,
      `width ${width} must hold the row, got ${visibleWidth(lines[0]!)}`,
    );
  }
  const narrow = renderCallRow(args, { width: 40 })[0]!;
  assert.ok(narrow.includes("bash"), "the tool word survives elision");
  assert.ok(!narrow.includes("head -30"), "narrow rows elide the label");
});

test("collapsed call row right-aligns status meta and reports outcomes", () => {
  const row = renderCallRow(
    { description: "Build the suite", command: "bun run check" },
    { width: 80, state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome() } },
  )[0]!;
  assert.match(row, /^bash Build the suite +ok · 32 lines · ctrl\+o$/);
  assert.equal(row.length, 80);
  assert.ok(row.endsWith("ctrl+o"), "meta is right-aligned to the row width");

  const failed = renderCallRow(
    { description: "Run the tests", command: "cargo test" },
    {
      width: 80,
      state: {
        [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ failed: true, exitCode: 2, lineCount: 3 }),
      },
    },
  )[0]!;
  assert.match(failed, /^bash Run the tests\s+!! exit 2 · 3 lines · ctrl\+o$/);

  const timedOut = renderCallRow(
    { description: "Run the slow tests", command: "pytest -k slow" },
    {
      width: 80,
      state: {
        [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ failed: true, timedOut: true, lineCount: 0 }),
      },
    },
  )[0]!;
  assert.match(timedOut, /!! timed out · 0 lines · ctrl\+o$/);

  const silent = renderCallRow(
    { description: "Make the build directory", command: "mkdir -p /tmp/x" },
    { width: 80, state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ lineCount: 1 }) } },
  )[0]!;
  assert.match(silent, /^bash Make the build directory\s+ok · 1 line · ctrl\+o$/);
});

test("remaining status variants and the shell meta render on the row", () => {
  const failed = renderCallRow(
    { description: "Run the tests", command: "cargo test" },
    { width: 90, state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ failed: true }) } },
  )[0]!;
  assert.match(failed, /!! failed · 32 lines · ctrl\+o$/);

  const single = renderCallRow(
    { description: "Check the option", command: "ls", timeout: 0 },
    {
      width: 90,
      state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ failed: true, lineCount: 1 }) },
    },
  )[0]!;
  assert.match(single, /!! failed · 1 line · ctrl\+o$/, "a single line is not pluralized");

  const aborted = renderCallRow(
    { description: "Stream ticks", command: "sleep 30" },
    {
      width: 90,
      state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome({ failed: true, aborted: true }) },
    },
  )[0]!;
  assert.match(aborted, /!! aborted · 32 lines · ctrl\+o$/);

  const nonDefaultShell = renderCallRow(
    { description: "List files", command: "ls", shellPath: "/opt/zsh/bin/zsh" },
    { width: 90, state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome() } },
  )[0]!;
  assert.match(nonDefaultShell, /ok · 32 lines · shell \/opt\/zsh\/bin\/zsh · ctrl\+o$/);

  const defaultShell = renderCallRow(
    { description: "List files", command: "ls", shellPath: "/bin/bash" },
    { width: 90, state: { [BASH_CALL_OUTCOME_STATE_KEY]: outcome() } },
  )[0]!;
  assert.ok(!defaultShell.includes("shell"), "the default shell is not part of the row");
});

test("expanded call row keeps the full command instead of the label", () => {
  const command = "# Build the suite\nbun run check --all";
  const lines = renderCallRow({ description: "Build the suite", command }, { expanded: true });
  assert.ok(lines.length > 1);
  const joined = lines.join("\n");
  assert.ok(joined.includes("bun run check --all"));
  assert.ok(!joined.includes("ctrl+o"));
});

test("a reused call row follows streaming args, status and expansion", () => {
  const { bash } = createToolDisplayRenderers();
  const state: Record<string, unknown> = {};
  const context = (overrides: Record<string, unknown>) =>
    ({ state, executionStarted: true, isPartial: true, ...overrides }) as never;

  // First paint: args still streaming, so the label is a placeholder.
  let component = bash.renderCall({} as never, theme, context({}));
  assert.match(renderLines(component, 120)[0]!.trim(), /^⠋ bash \.\.\./);

  // The same component instance is reused once Pi has the args.
  const args = {
    description: "Find callers of the parser",
    command: "rg -n parser src | head -40",
  };
  component = bash.renderCall(
    args as never,
    theme,
    context({ lastComponent: component, isPartial: false }),
  );
  const finished = renderLines(component, 120)[0]!.trim();
  assert.match(finished, /^bash Find callers of the parser +ctrl\+o$/);

  // ctrl+o arrives on a later render of the same instance.
  component = bash.renderCall(
    args as never,
    theme,
    context({ lastComponent: component, isPartial: false, expanded: true }),
  );
  assert.ok(renderLines(component, 120).join("\n").includes("rg -n parser src"));
  disposeAll();
});

test("a finished row reports the duration the run measured", () => {
  const { bash } = createToolDisplayRenderers();
  const args = { description: "Build the suite", command: "bun run check" };
  const state: Record<string, unknown> = { [BASH_CALL_OUTCOME_STATE_KEY]: outcome() };
  const context = (overrides: Record<string, unknown>) =>
    ({ state, executionStarted: true, isPartial: true, ...overrides }) as never;

  const running = bash.renderCall(args as never, theme, context({}));
  assert.match(renderLines(running, 120)[0]!.trim(), /~ 0s · ctrl\+o$/);

  const finished = bash.renderCall(
    args as never,
    theme,
    context({ lastComponent: running, isPartial: false }),
  );
  assert.match(renderLines(finished, 120)[0]!.trim(), /ok · 32 lines · 0s · ctrl\+o$/);
  disposeAll();
});

test("compactBashCallRow off restores the full command and the returned-lines row", () => {
  const { bash } = createToolDisplayRenderers(new Map(), () => false);
  const args = { description: "Build the suite", command: "# run the checks\nbun run check" };
  const state: Record<string, unknown> = {};

  const callRow = renderLines(
    bash.renderCall(args as never, theme, {
      state,
      executionStarted: true,
      isPartial: false,
    } as never),
    120,
  );
  assert.equal(callRow.length, 2, "the full command wraps instead of collapsing to a label");
  assert.ok(callRow.join("\n").includes("# run the checks"));
  assert.ok(!callRow.join("\n").includes("ctrl+o"));

  const result = renderLines(
    bash.renderResult(
      {
        content: [
          { type: "text", text: Array.from({ length: 30 }, (_v, i) => `line-${i + 1}`).join("\n") },
        ],
      } as never,
      { expanded: false, isPartial: false } as never,
      theme,
      { state, args, isError: false } as never,
    ),
    200,
  );
  assert.equal(result.length, 1);
  assert.match(result[0]!.trim(), /^↳ 30 lines returned • Ctrl\+O to expand$/);

  const failed = renderLines(
    bash.renderResult(
      {
        content: [{ type: "text", text: "e1\ne2\ne3\ne4\ne5\n\ne6\n\nCommand exited with code 2" }],
      } as never,
      { expanded: false, isPartial: false } as never,
      theme,
      { state, args, isError: true } as never,
    ),
    200,
  );
  const failedText = failed.map((line) => line.trim()).join("\n");
  assert.match(failedText, /^↳ command failed$/m);
  assert.match(failedText, /e1/, "the non-compact failure keeps a head preview");
  assert.match(failedText, /Ctrl\+O to expand/);
});

test("compactBashCallRow toggles on later renders of the same row", () => {
  let compact = true;
  const { bash } = createToolDisplayRenderers(new Map(), () => compact);
  const args = { description: "Build the suite", command: "bun run check" };
  const state: Record<string, unknown> = { [BASH_CALL_OUTCOME_STATE_KEY]: outcome() };
  const context = (overrides: Record<string, unknown>) =>
    ({ state, executionStarted: true, isPartial: false, ...overrides }) as never;

  const first = bash.renderCall(args as never, theme, context({}));
  assert.match(renderLines(first, 100)[0]!.trim(), /ok · 32 lines · ctrl\+o$/);

  compact = false;
  const toggled = bash.renderCall(args as never, theme, context({ lastComponent: first }));
  assert.equal(renderLines(toggled, 100)[0]!.trim(), "$ bun run check");
});

test("row rendering cost does not grow with the command length", () => {
  const { bash } = createToolDisplayRenderers();
  const render = (command: string): number => {
    const component = bash.renderCall({ command } as never, theme, {
      state: {},
      executionStarted: true,
      isPartial: false,
    } as never);
    const started = performance.now();
    for (let index = 0; index < 500; index++) {
      (component as { render(width: number): string[] }).render(120);
    }
    return performance.now() - started;
  };
  const small = render("ls -la");
  const huge = render(`ls -la\n${"x".repeat(2_000_000)}`);
  assert.ok(huge < Math.max(small * 4 + 50, 250), `huge ${huge}ms vs small ${small}ms`);
});
