import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  expandPromptTemplate,
  loadPromptTemplates,
  parseCommandArgs,
  substituteArgs,
  type PromptTemplate,
} from "../src/core/prompt-templates.js";
import { buildModelPrompt } from "../src/core/prompt-build.js";

test("parseCommandArgs splits on whitespace", () => {
  assert.deepEqual(parseCommandArgs("hello world"), ["hello", "world"]);
});

test("parseCommandArgs handles double quotes", () => {
  assert.deepEqual(parseCommandArgs('hello "world foo" bar'), ["hello", "world foo", "bar"]);
});

test("parseCommandArgs handles single quotes", () => {
  assert.deepEqual(parseCommandArgs("hello 'world foo' bar"), ["hello", "world foo", "bar"]);
});

test("parseCommandArgs handles empty string", () => {
  assert.deepEqual(parseCommandArgs(""), []);
});

test("substituteArgs replaces $1, $2 positional args", () => {
  assert.equal(substituteArgs("Hello $1 and $2", ["Alice", "Bob"]), "Hello Alice and Bob");
});

test("substituteArgs replaces $@ with all args", () => {
  assert.equal(substituteArgs("Review: $@", ["src/main.ts", "src/lib.ts"]), "Review: src/main.ts src/lib.ts");
});

test("substituteArgs replaces $ARGUMENTS with all args", () => {
  assert.equal(substituteArgs("Do: $ARGUMENTS", ["a", "b"]), "Do: a b");
});

test(`substituteArgs replaces ${"$" + "{@:N}"} with args from N onwards`, () => {
  assert.equal(
    substituteArgs(`First: $1, rest: ${"$" + "{@:2}"}`, ["a", "b", "c"]),
    "First: a, rest: b c",
  );
});

test(`substituteArgs replaces ${"$" + "{@:N:L}"} with L args from N`, () => {
  assert.equal(
    substituteArgs(`Slice: ${"$" + "{@:2:2}"}`, ["a", "b", "c", "d"]),
    "Slice: b c",
  );
});

test("substituteArgs handles missing positional args as empty string", () => {
  assert.equal(substituteArgs("$1 and $2", ["only"]), "only and ");
});

test("expandPromptTemplate returns original text when no template matches", () => {
  const templates: PromptTemplate[] = [
    { name: "review", description: "Review", content: "Review: $@", filePath: "/tmp/review.md" },
  ];
  assert.equal(expandPromptTemplate("hello world", templates), "hello world");
  assert.equal(expandPromptTemplate("/unknown foo", templates), "/unknown foo");
});

test("expandPromptTemplate expands matching template", () => {
  const templates: PromptTemplate[] = [
    { name: "review", description: "Review", content: "Review the following: $@", filePath: "/tmp/review.md" },
  ];
  assert.equal(expandPromptTemplate("/review src/main.ts", templates), "Review the following: src/main.ts");
});

test("expandPromptTemplate handles template without args", () => {
  const templates: PromptTemplate[] = [
    { name: "lint", description: "Lint", content: "Run linting on all files.", filePath: "/tmp/lint.md" },
  ];
  assert.equal(expandPromptTemplate("/lint", templates), "Run linting on all files.");
});

test("expandPromptTemplate does not expand non-slash text", () => {
  const templates: PromptTemplate[] = [
    { name: "review", description: "Review", content: "Review: $@", filePath: "/tmp/review.md" },
  ];
  assert.equal(expandPromptTemplate("review src/main.ts", templates), "review src/main.ts");
});

test("loadPromptTemplates loads .md files from directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  try {
    await writeFile(
      join(dir, "review.md"),
      "---\ndescription: Review code changes\nargument-hint: <files>\n---\nReview: $@",
      "utf8",
    );
    await writeFile(
      join(dir, "lint.md"),
      "Run linting on all files.",
      "utf8",
    );
    const templates = loadPromptTemplates([dir]);
    assert.equal(templates.length, 2);
    const review = templates.find((t) => t.name === "review");
    assert.ok(review);
    assert.equal(review.description, "Review code changes");
    assert.equal(review.argumentHint, "<files>");
    assert.equal(review.content, "Review: $@");
    const lint = templates.find((t) => t.name === "lint");
    assert.ok(lint);
    assert.equal(lint.content, "Run linting on all files.");
    // Description from first line when no frontmatter
    assert.equal(lint.description, "Run linting on all files.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadPromptTemplates deduplicates by name (first wins)", async () => {
  const dir1 = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  const dir2 = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  try {
    await writeFile(join(dir1, "review.md"), "First review template", "utf8");
    await writeFile(join(dir2, "review.md"), "Second review template", "utf8");
    const templates = loadPromptTemplates([dir1, dir2]);
    assert.equal(templates.length, 1);
    assert.equal(templates[0]!.content, "First review template");
  } finally {
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

test("loadPromptTemplates loads individual .md files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  try {
    const filePath = join(dir, "custom.md");
    await writeFile(filePath, "---\ndescription: Custom template\n---\nDo custom: $@", "utf8");
    const templates = loadPromptTemplates([filePath]);
    assert.equal(templates.length, 1);
    assert.equal(templates[0]!.name, "custom");
    assert.equal(templates[0]!.description, "Custom template");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildModelPrompt expands prompt template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  try {
    const promptTemplates: PromptTemplate[] = [
      { name: "review", description: "Review", content: "Review the code: $@", filePath: join(dir, "review.md") },
    ];
    const result = await buildModelPrompt("/review src/main.ts", dir, { promptTemplates });
    assert.equal(result, "Review the code: src/main.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildModelPrompt does not expand unknown template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-tpl-"));
  try {
    const promptTemplates: PromptTemplate[] = [
      { name: "review", description: "Review", content: "Review: $@", filePath: join(dir, "review.md") },
    ];
    // /unknown is not a template, not a skill — passes through
    const result = await buildModelPrompt("/unknown foo", dir, { promptTemplates });
    assert.equal(result, "/unknown foo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
