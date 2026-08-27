import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createDiffViewerComponent, type ReviewEditor } from "./diff-viewer.js";
import type { ReviewDraft } from "./review.js";
import type { DiffFile, DiffRow, SessionDiff } from "./session-diff.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

const addedRowBgPattern = "\\x1b\\[48;2;12;39;5m";
const removedRowBgPattern = "\\x1b\\[48;2;57;5;4m";
const addedHighlightBgPattern = "\\x1b\\[48;2;40;94;23m";
const removedHighlightBgPattern = "\\x1b\\[48;2;132;31;26m";

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

function styledSpans(output: string, open: string, close: string): string[] {
  const pattern = new RegExp(`${open}(.*?)${close}`, "g");
  return Array.from(output.matchAll(pattern), (match) => stripTerminalSequences(match[1]!));
}

function createEditor(): ReviewEditor {
  let text = "";
  return {
    getText: () => text,
    setText: (value) => {
      text = value;
    },
    handleInput: (data) => {
      if (data === "\x7f") text = text.slice(0, -1);
      else text += data;
    },
    render: () => [text],
  };
}

function createViewer(
  diff = fixture(),
  columns = 120,
  rows = 28,
  highlight: (text: string, path: string) => string = (text) => text,
) {
  let closed = 0;
  let renders = 0;
  const submissions: ReviewDraft[] = [];
  const component = createDiffViewerComponent({
    tui: {
      terminal: { columns, rows },
      requestRender: () => renders++,
    },
    theme: theme as never,
    diff,
    done: (result) => {
      closed++;
      if (result) submissions.push(result);
    },
    highlight,
    editor: createEditor(),
  });
  return { component, closed: () => closed, renders: () => renders, submissions };
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

  component.handleInput("v");
  const output = component.render(120).join("\n");

  assert.deepEqual(styledSpans(output, removedHighlightBgPattern, removedRowBgPattern), [
    "abc123xyz",
  ]);
  assert.deepEqual(styledSpans(output, addedHighlightBgPattern, addedRowBgPattern), ["abc923xyq"]);
  assert.doesNotMatch(output, /\x1b\[(?:1;)?7m/);
  assert.match(output, /\x1b\[36m/);
  assert.ok(styledSpans(output, "\\x1b\\[4m", "\\x1b\\[24m").includes("src/changed.ts"));

  const oldLine = stripTerminalSequences(
    output.split("\n").find((line) => line.includes("abc123xyz")) ?? "",
  );
  const newLine = stripTerminalSequences(
    output.split("\n").find((line) => line.includes("abc923xyq")) ?? "",
  );
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

  assert.deepEqual(styledSpans(output, removedHighlightBgPattern, removedRowBgPattern), [
    "alpha beta",
  ]);
  assert.deepEqual(styledSpans(output, addedHighlightBgPattern, addedRowBgPattern), [
    "gamma delta",
  ]);
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

  assert.deepEqual(styledSpans(output, removedHighlightBgPattern, removedRowBgPattern), ["世"]);
  assert.deepEqual(styledSpans(output, addedHighlightBgPattern, addedRowBgPattern), ["视"]);
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
  assert.match(lines.at(-1) ?? "", /j\/k tree|j\/k files/);
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

test("compact chrome puts the selected path on the title and starts the diff immediately", () => {
  const { component } = createViewer();
  const lines = component.render(120);
  const output = stripTerminalSequences(lines.join("\n"));

  assert.match(
    stripTerminalSequences(lines[0] ?? ""),
    /SESSION DIFF\s+src\/alpha\.ts\s+\+1\s+-1\s+2 files\s+1 hunk\b/,
  );
  assert.match(lines[1] ?? "", /┌.*┬.*┐/);
  assert.doesNotMatch(output, /Navigator/);
  assert.doesNotMatch(output, /Diff \(/);
  assert.doesNotMatch(output, /side-by-side • rows|unified • rows/);

  const body = stripTerminalSequences(lines[2] ?? "");
  assert.match(body, / \//);
  assert.match(body, /Deleted \/ Old/);
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

  assert.match(stripTerminalSequences(component.render(120).join("\n")), /src\/beta\.ts/);
});

test("j/k walk every tree node and n/p skip directories", () => {
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

  // Tree order: / → src → a.ts → c.ts → test → b.ts. Start on first file a.ts.
  component.handleInput("j");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /src\/c\.ts/);
  component.handleInput("j");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), / test|│ test/);
  component.handleInput("n");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /test\/b\.ts/);
  component.handleInput("p");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /src\/c\.ts/);
});

test("j/k wrap around the navigator tree", () => {
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

  // Tree: / → src → a.ts → c.ts → test → b.ts. Start on a.ts.
  component.handleInput("k");
  component.handleInput("k");
  let output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /a-before/);
  assert.match(output, /b-before/);
  assert.match(output, /c-before/);

  component.handleInput("k");
  output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /test\/b\.ts/);
  assert.match(output, /b-before/);
  assert.doesNotMatch(output, /a-before/);

  component.handleInput("j");
  output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /a-before/);
  assert.match(output, /b-before/);
  assert.match(output, /c-before/);
});

test("Enter collapses and expands a navigator folder", () => {
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

  component.handleInput("k");
  let output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, / a\.ts/);
  assert.match(output, / c\.ts/);

  component.handleInput("\r");
  output = stripTerminalSequences(component.render(120).join("\n"));
  assert.doesNotMatch(output, / a\.ts/);
  assert.doesNotMatch(output, / c\.ts/);
  assert.match(output, / src/);
  assert.match(output, /src\/a\.ts/);
  assert.match(output, /src\/c\.ts/);
  assert.match(output, / b\.ts/);

  component.handleInput("\r");
  output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, / a\.ts/);
  assert.match(output, / c\.ts/);
  assert.match(output, / src/);
});

test("selecting a directory shows every descendant file diff with path headers", () => {
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

  // From a.ts, k moves to the parent src directory.
  component.handleInput("k");
  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /src\/a\.ts/);
  assert.match(output, /src\/c\.ts/);
  assert.match(output, /a-before/);
  assert.match(output, /c-before/);
  assert.doesNotMatch(output, /b-before/);
});

test("comment mode saves a DISCUSS comment on the selected changed line by default", () => {
  const { component } = createViewer();

  component.handleInput("c");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Comment mode.*deleted 1/);
  component.handleInput("\r");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Edit DISCUSS comment/);
  for (const character of "Handle null input.") component.handleInput(character);
  component.handleInput("\r");

  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /alpha\.ts\s+1●/);
  assert.match(output, /●.*const value = 1/);
});

test("V creates a same-side range and Review lists its DISCUSS comment", () => {
  const ranged = file("src/range.ts", [
    { kind: "insert", newLineNumber: 10, oldText: "", newText: "first();" },
    { kind: "insert", newLineNumber: 11, oldText: "", newText: "second();" },
  ]);
  const { component } = createViewer({
    files: [ranged],
    additions: 2,
    deletions: 0,
    trackedFiles: 1,
  });

  component.handleInput("c");
  component.handleInput("V");
  component.handleInput("j");
  component.handleInput("\r");
  for (const character of "Can these be combined?") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("\x1b");
  component.handleInput("r");

  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /Review comments/);
  assert.match(output, /DISCUSS.*src\/range\.ts:10-11 \(added\)/);
  assert.match(output, /Can these be combined\?/);
});

test("side-by-side arrows select the added side of the same changed row", () => {
  const { component } = createViewer();

  component.handleInput("c");
  component.handleInput("\x1b[C");

  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Comment mode.*added 1/);
});

test("comment cursor keeps the selected changed line visible", () => {
  const rows = Array.from(
    { length: 30 },
    (_, index): DiffRow => ({
      kind: "insert",
      newLineNumber: index + 1,
      oldText: "",
      newText: `target-${index + 1}`,
    }),
  );
  const longFile = file("src/long.ts", rows, "added");
  const { component } = createViewer(
    { files: [longFile], additions: 30, deletions: 0, trackedFiles: 1 },
    100,
    16,
  );

  component.handleInput("c");
  for (let index = 0; index < 20; index++) component.handleInput("j");
  const output = stripTerminalSequences(component.render(100).join("\n"));

  assert.match(output, /Comment mode.*added 21/);
  assert.match(output, /target-21/);
  assert.doesNotMatch(output, /target-1\b/);
});

test("comment selection skips context lines and ranges cannot cross hunks", () => {
  const twoHunks: DiffFile = {
    path: "src/hunks.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@ first",
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        rows: [
          { kind: "insert", newLineNumber: 1, oldText: "", newText: "first();" },
          {
            kind: "equal",
            oldLineNumber: 1,
            newLineNumber: 2,
            oldText: "keep();",
            newText: "keep();",
          },
        ],
      },
      {
        header: "@@ -9,1 +10,2 @@ second",
        oldStart: 9,
        oldCount: 1,
        newStart: 10,
        newCount: 2,
        rows: [{ kind: "insert", newLineNumber: 10, oldText: "", newText: "second();" }],
      },
    ],
  };
  const { component } = createViewer({
    files: [twoHunks],
    additions: 2,
    deletions: 0,
    trackedFiles: 1,
  });

  component.handleInput("c");
  component.handleInput("V");
  component.handleInput("j");

  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Comment mode.*added 1/);
});

test("Review x deletes the selected comment and clears its markers", () => {
  const { component } = createViewer();

  component.handleInput("l");
  for (const character of "Remove this later.") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("r");
  component.handleInput("x");

  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /No comments yet\./);
  assert.doesNotMatch(output, /alpha\.ts\s+1●/);
});

test("file and entire-diff comments require confirmation before discard", () => {
  const { component, closed } = createViewer();

  component.handleInput("l");
  for (const character of "Keep this module small.") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("a");
  for (const character of "Preserve the public API.") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("q");

  assert.equal(closed(), 0);
  assert.match(
    stripTerminalSequences(component.render(120).join("\n")),
    /Discard 2 review comments/,
  );
  component.handleInput("\r");
  assert.equal(closed(), 0);
  component.handleInput("q");
  component.handleInput("d");
  assert.equal(closed(), 1);
});

test("v switches between side-by-side and unified diff", () => {
  const { component } = createViewer();

  component.handleInput("v");
  const output = component.render(120).join("\n");

  assert.match(output, /@@ -1,2 \+1,2 @@/);
  assert.doesNotMatch(output, /Deleted \/ Old/);
});

test("s submits the complete review draft", () => {
  const { component, submissions, closed } = createViewer();

  component.handleInput("c");
  component.handleInput("\x1b[C");
  component.handleInput("\r");
  for (const character of "Use the parsed value.") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("s");

  assert.equal(closed(), 1);
  assert.deepEqual(submissions, [
    {
      comments: [
        {
          target: {
            kind: "line",
            path: "src/alpha.ts",
            side: "new",
            startLine: 1,
            endLine: 1,
            code: ["const value = 2;"],
          },
          intent: "discuss",
          body: "Use the parsed value.",
        },
      ],
    },
  ]);
});

test("Shift+Enter inserts a newline in the embedded comment editor", () => {
  const { component, submissions } = createViewer();

  component.handleInput("l");
  for (const character of "First line") component.handleInput(character);
  component.handleInput("\x1b[13;2u");
  for (const character of "Second line") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("s");

  assert.equal(submissions[0]?.comments[0]?.body, "First line\nSecond line");
});

test("e hides the navigator and gives the diff the full width", () => {
  const { component } = createViewer();

  component.handleInput("e");
  const output = component.render(120).join("\n");

  assert.doesNotMatch(output, /Navigator/);
  assert.match(stripTerminalSequences(output), /src\/alpha\.ts/);
});

test("file filtering accepts s characters while review comments exist", () => {
  const { component, closed, submissions } = createViewer();

  component.handleInput("l");
  for (const character of "Keep this file.") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("t");
  for (const character of "session") component.handleInput(character);

  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.match(output, /Filter: session_/);
  assert.equal(closed(), 0);
  assert.deepEqual(submissions, []);
});

test("t filters files and keeps the selected match", () => {
  const { component } = createViewer();

  component.handleInput("t");
  for (const character of "beta") component.handleInput(character);
  component.handleInput("\r");

  const output = component.render(120).join("\n");
  assert.match(output, /Filter: beta/);
  assert.match(stripTerminalSequences(output), /src\/beta\.ts/);
  assert.doesNotMatch(output, /src\/alpha\.ts/);
});

test("file filtering ranks tighter fuzzy matches first", () => {
  const rows: DiffRow[] = [{ kind: "insert", newLineNumber: 1, oldText: "", newText: "changed" }];
  const weak = file("b-e-t-a.ts", rows);
  const strong = file("beta.ts", rows);
  const { component } = createViewer({
    files: [weak, strong],
    additions: 2,
    deletions: 0,
    trackedFiles: 2,
  });

  component.handleInput("t");
  for (const character of "beta") component.handleInput(character);
  component.handleInput("\r");

  const output = stripTerminalSequences(component.render(120).join("\n"));
  assert.ok(output.indexOf("beta.ts") < output.indexOf("b-e-t-a.ts"));
});

test("comment mode Ctrl+D/U jumps the selected changed line by half a page", () => {
  const rows = Array.from(
    { length: 30 },
    (_, index): DiffRow => ({
      kind: "insert",
      newLineNumber: index + 1,
      oldText: "",
      newText: `target-${index + 1}`,
    }),
  );
  const longFile = file("src/long.ts", rows, "added");
  const { component } = createViewer(
    { files: [longFile], additions: 30, deletions: 0, trackedFiles: 1 },
    100,
    16,
  );

  component.handleInput("c");
  assert.match(stripTerminalSequences(component.render(100).join("\n")), /Comment mode.*added 1/);
  component.handleInput("\x04");
  assert.match(
    stripTerminalSequences(component.render(100).join("\n")),
    /Comment mode.*added (?:[5-9]|1[0-9])/,
  );
  component.handleInput("\x15");
  assert.match(stripTerminalSequences(component.render(100).join("\n")), /Comment mode.*added 1/);
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

test("comment mode Enter/x reuse a covering range comment", () => {
  const ranged = file("src/range.ts", [
    { kind: "insert", newLineNumber: 10, oldText: "", newText: "first();" },
    { kind: "insert", newLineNumber: 11, oldText: "", newText: "second();" },
  ]);
  const { component } = createViewer({
    files: [ranged],
    additions: 2,
    deletions: 0,
    trackedFiles: 1,
  });

  component.handleInput("c");
  component.handleInput("V");
  component.handleInput("j");
  component.handleInput("\r");
  for (const character of "Can these be combined?") component.handleInput(character);
  component.handleInput("\r");

  // Leave the range anchor, move to the first covered line, and reopen the same comment.
  component.handleInput("k");
  component.handleInput("\r");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Edit DISCUSS comment/);
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Can these be combined\?/);
  for (const character of "!") component.handleInput(character);
  component.handleInput("\r");

  component.handleInput("x");
  assert.doesNotMatch(stripTerminalSequences(component.render(120).join("\n")), /●/);
  component.handleInput("\x1b");
  component.handleInput("r");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /No comments yet\./);
});

test("help yields to comment editor instead of trapping input", () => {
  const { component } = createViewer();
  component.handleInput("?");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /j\/k or/);
  component.handleInput("l");
  assert.match(stripTerminalSequences(component.render(120).join("\n")), /Edit DISCUSS comment/);
});
