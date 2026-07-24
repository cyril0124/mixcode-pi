import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDiffViewerComponent } from "./diff-viewer.js";
import type { DiffFile, DiffRow, SessionDiff } from "./session-diff.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  getBgAnsi: (color: string) => (color === "toolErrorBg" ? "\x1b[48;5;52m" : "\x1b[48;5;22m"),
};

function file(path: string, rows: DiffRow[], status: DiffFile["status"] = "modified"): DiffFile {
  const additions = rows.filter((row) => row.kind === "insert" || row.kind === "replace").length;
  const deletions = rows.filter((row) => row.kind === "delete" || row.kind === "replace").length;
  return {
    path,
    status,
    additions,
    deletions,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        rows,
      },
    ],
  };
}

function fixture(): SessionDiff {
  const alpha = file("src/alpha.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: "const value = 1;",
      newText: "const value = 2;",
    },
    {
      kind: "equal",
      oldLineNumber: 2,
      newLineNumber: 2,
      oldText: "keep();",
      newText: "keep();",
    },
  ]);
  const beta = file(
    "src/beta.ts",
    [
      {
        kind: "insert",
        newLineNumber: 1,
        oldText: "",
        newText: "export const beta = true;",
      },
    ],
    "added",
  );
  return { files: [alpha, beta], additions: 2, deletions: 1, trackedFiles: 2 };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function styledSpans(output: string, open: string, close: string): string[] {
  const pattern = new RegExp(`${open}(.*?)${close}`, "g");
  return Array.from(output.matchAll(pattern), (match) => stripAnsi(match[1]!));
}

function createViewer(
  diff = fixture(),
  columns = 120,
  rows = 28,
  highlight: (text: string, path: string) => string = (text) => text,
) {
  let closed = 0;
  let renders = 0;
  const component = createDiffViewerComponent({
    tui: {
      terminal: { columns, rows },
      requestRender: () => renders++,
    },
    theme: theme as never,
    diff,
    done: () => closed++,
    highlight,
  });
  return { component, closed: () => closed, renders: () => renders };
}

test("wide view opens side-by-side and every rendered row fits", () => {
  const { component } = createViewer();

  const lines = component.render(120);
  const output = lines.join("\n");
  assert.match(output, /SESSION DIFF/);
  assert.match(output, /Deleted \/ Old/);
  assert.match(output, /Added \/ New/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("replace rows highlight English identifiers as whole words", () => {
  const changed = file("src/changed.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: 'const code = "abc123xyz";',
      newText: 'const code = "abc923xyq";',
    },
  ]);
  const { component } = createViewer(
    { files: [changed], additions: 1, deletions: 1, trackedFiles: 1 },
    120,
    28,
    (text) => `\x1b[36m${text}\x1b[39m`,
  );

  component.handleInput("s");
  const output = component.render(120).join("\n");

  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;88m", "\\x1b\\[48;5;52m"), ["abc123xyz"]);
  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;28m", "\\x1b\\[48;5;22m"), ["abc923xyq"]);
  assert.doesNotMatch(output, /\x1b\[(?:1;)?7m/);
  assert.match(output, /\x1b\[36m/);
  assert.ok(styledSpans(output, "\\x1b\\[4m", "\\x1b\\[24m").includes("src/changed.ts"));

  const oldLine = stripAnsi(output.split("\n").find((line) => line.includes("abc123xyz")) ?? "");
  const newLine = stripAnsi(output.split("\n").find((line) => line.includes("abc923xyq")) ?? "");
  assert.match(oldLine, /\s+1\s+:\s+│ const code/);
  assert.match(newLine, /\s+:\s+1\s+│ const code/);
  assert.doesNotMatch(oldLine, /\s-\s/);
  assert.doesNotMatch(newLine, /\s\+\s/);
});

test("adjacent changed words include connecting whitespace in one delta block", () => {
  const changed = file("src/words.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: "return alpha beta;",
      newText: "return gamma delta;",
    },
  ]);
  const { component } = createViewer({
    files: [changed],
    additions: 1,
    deletions: 1,
    trackedFiles: 1,
  });

  const output = component.render(120).join("\n");

  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;88m", "\\x1b\\[48;5;52m"), ["alpha beta"]);
  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;28m", "\\x1b\\[48;5;22m"), ["gamma delta"]);
});

test("replace rows highlight Chinese text one grapheme at a time", () => {
  const changed = file("src/unicode.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: 'const label = "你好世界";',
      newText: 'const label = "你好视界";',
    },
  ]);
  const { component } = createViewer({
    files: [changed],
    additions: 1,
    deletions: 1,
    trackedFiles: 1,
  });

  const output = component.render(120).join("\n");

  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;88m", "\\x1b\\[48;5;52m"), ["世"]);
  assert.deepEqual(styledSpans(output, "\\x1b\\[48;5;28m", "\\x1b\\[48;5;22m"), ["视"]);
});

test("cold files batch syntax highlighting once per side", () => {
  const rows = Array.from(
    { length: 40 },
    (_, index): DiffRow => ({
      kind: "replace",
      oldLineNumber: index + 1,
      newLineNumber: index + 1,
      oldText: `old-${index + 1}`,
      newText: `new-${index + 1}`,
    }),
  );
  const large = file("src/large.ts", rows);
  const batches: string[] = [];
  const { component } = createViewer(
    { files: [large], additions: 40, deletions: 40, trackedFiles: 1 },
    120,
    28,
    (text) => {
      batches.push(text);
      return text;
    },
  );

  component.render(120);

  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches.map((batch) => batch.split("\n").length),
    [40, 40],
  );
});

test("idle prewarm prepares the next file before the previous file", async () => {
  const makeRows = (name: string): DiffRow[] => [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: `${name}-old`,
      newText: `${name}-new`,
    },
  ];
  const diff: SessionDiff = {
    files: [
      file("src/a.ts", makeRows("a")),
      file("src/b.ts", makeRows("b")),
      file("src/c.ts", makeRows("c")),
    ],
    additions: 3,
    deletions: 3,
    trackedFiles: 3,
  };
  const highlightedPaths: string[] = [];
  const { component } = createViewer(diff, 120, 28, (text, path) => {
    highlightedPaths.push(path);
    return text;
  });

  component.handleInput("j");
  component.render(120);
  assert.deepEqual(highlightedPaths, ["src/b.ts", "src/b.ts"]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(highlightedPaths, ["src/b.ts", "src/b.ts", "src/c.ts", "src/c.ts"]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(highlightedPaths, [
    "src/b.ts",
    "src/b.ts",
    "src/c.ts",
    "src/c.ts",
    "src/a.ts",
    "src/a.ts",
  ]);

  component.handleInput("j");
  component.render(120);
  component.handleInput("k");
  component.handleInput("k");
  component.render(120);
  assert.equal(highlightedPaths.length, 6);
});

test("footer stays within the runtime-provided overlay row budget", () => {
  const { component } = createViewer(fixture(), 80, 18);

  const lines = component.render(80);

  assert.equal(lines.length, 18);
  assert.match(lines.at(-1) ?? "", /j\/k files/);
});

test("navigator renders changed files as a compact diffnav-style tree", () => {
  const diff = fixture();
  diff.files[0]!.path = "src/features/diff/alpha.ts";
  diff.files[1]!.path = "src/features/diff/beta.ts";
  const { component } = createViewer(diff);

  const output = component.render(120).join("\n");
  assert.match(output, / \//);
  assert.match(output, /│ src\/features\/diff/);
  assert.match(output, /││ alpha\.ts .*\+1.*-1/);
  assert.match(output, /││ beta\.ts .*\+1/);
  assert.doesNotMatch(output, / src\/features\/diff\/alpha\.ts/);
});

test("Tab is ignored instead of switching pane focus", () => {
  const { component, renders } = createViewer();
  const before = component.render(120);

  component.handleInput("\t");

  assert.equal(renders(), 0);
  assert.deepEqual(component.render(120), before);
});

test("n selects the next changed file", () => {
  const { component } = createViewer();

  component.handleInput("n");

  assert.match(stripAnsi(component.render(120).join("\n")), /src\/beta\.ts/);
});

test("j/k follow the rendered tree order when input paths are interleaved", () => {
  const a = file("src/a.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: "a-before",
      newText: "a-after",
    },
  ]);
  const b = file("test/b.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: "b-before",
      newText: "b-after",
    },
  ]);
  const c = file("src/c.ts", [
    {
      kind: "replace",
      oldLineNumber: 1,
      newLineNumber: 1,
      oldText: "c-before",
      newText: "c-after",
    },
  ]);
  const { component } = createViewer({
    files: [a, b, c],
    additions: 3,
    deletions: 3,
    trackedFiles: 3,
  });

  const tree = component.render(120).join("\n");
  assert.ok(tree.indexOf("a.ts") < tree.indexOf("c.ts"));
  assert.ok(tree.indexOf("c.ts") < tree.indexOf("b.ts"));

  component.handleInput("j");
  assert.match(stripAnsi(component.render(120).join("\n")), /src\/c\.ts/);
  component.handleInput("j");
  assert.match(stripAnsi(component.render(120).join("\n")), /test\/b\.ts/);
  component.handleInput("k");
  assert.match(stripAnsi(component.render(120).join("\n")), /src\/c\.ts/);
});

test("s switches between side-by-side and unified diff", () => {
  const { component } = createViewer();

  component.handleInput("s");
  const output = component.render(120).join("\n");

  assert.match(output, /unified/);
  assert.doesNotMatch(output, /Deleted \/ Old/);
});

test("e hides the navigator and gives the diff the full width", () => {
  const { component } = createViewer();

  component.handleInput("e");
  const output = component.render(120).join("\n");

  assert.doesNotMatch(output, /Navigator/);
  assert.match(stripAnsi(output), /src\/alpha\.ts/);
});

test("t filters files and keeps the selected match", () => {
  const { component } = createViewer();

  component.handleInput("t");
  for (const character of "beta") component.handleInput(character);
  component.handleInput("\r");

  const output = component.render(120).join("\n");
  assert.match(output, /Filter: beta/);
  assert.match(stripAnsi(output), /src\/beta\.ts/);
  assert.doesNotMatch(output, /src\/alpha\.ts/);
});

test("Ctrl+D and Ctrl+U scroll the diff viewport by half a page", () => {
  const rows = Array.from(
    { length: 40 },
    (_, index): DiffRow => ({
      kind: "insert",
      newLineNumber: index + 1,
      oldText: "",
      newText: `added-line-${index + 1}`,
    }),
  );
  const large = file("large.ts", rows, "added");
  const { component } = createViewer(
    { files: [large], additions: 40, deletions: 0, trackedFiles: 1 },
    100,
    20,
  );

  assert.match(component.render(100).join("\n"), /added-line-1\b/);
  component.handleInput("\x04");
  const after = component.render(100).join("\n");

  assert.doesNotMatch(after, /added-line-1\b/);
  assert.match(after, /added-line-8\b/);

  component.handleInput("\x15");
  assert.match(component.render(100).join("\n"), /added-line-1\b/);
});

test("help closes independently and q exits the viewer", () => {
  const { component, closed } = createViewer();

  component.handleInput("?");
  assert.match(component.render(120).join("\n"), /Ctrl\+D\/U/);
  component.handleInput("\x1b");
  assert.equal(closed(), 0);
  component.handleInput("q");

  assert.equal(closed(), 1);
});
