import assert from "node:assert/strict";
import { test } from "node:test";
import { extractContent, formatToolCall, hasTextContent } from "../src/core/tree-content.js";

test("hasTextContent: non-empty string true, whitespace-only false", () => {
  assert.equal(hasTextContent("hello"), true);
  assert.equal(hasTextContent("  hello  "), true);
  assert.equal(hasTextContent(""), false);
  assert.equal(hasTextContent("   "), false);
  assert.equal(hasTextContent("\n\t"), false);
});

test("hasTextContent: text blocks with text true; empty array / non-text false", () => {
  assert.equal(hasTextContent([{ type: "text", text: "hi" }]), true);
  assert.equal(hasTextContent([{ type: "text", text: "  ok  " }]), true);
  assert.equal(hasTextContent([]), false);
  assert.equal(hasTextContent([{ type: "text", text: "" }]), false);
  assert.equal(hasTextContent([{ type: "text", text: "   " }]), false);
  assert.equal(hasTextContent([{ type: "image", url: "x" }]), false);
  assert.equal(hasTextContent(null), false);
  assert.equal(hasTextContent(42), false);
});

test("extractContent: truncates long strings to 200 chars", () => {
  const long = "a".repeat(250);
  assert.equal(extractContent(long).length, 200);
  assert.equal(extractContent(long), "a".repeat(200));
  assert.equal(extractContent("short"), "short");
});

test("extractContent: joins text blocks; empty for non-content", () => {
  assert.equal(
    extractContent([
      { type: "text", text: "foo" },
      { type: "image", url: "x" },
      { type: "text", text: "bar" },
    ]),
    "foobar",
  );
  const longBlocks = [
    { type: "text", text: "x".repeat(150) },
    { type: "text", text: "y".repeat(100) },
  ];
  assert.equal(extractContent(longBlocks).length, 200);
  assert.equal(extractContent([]), "");
  assert.equal(extractContent([{ type: "image", url: "x" }]), "");
  assert.equal(extractContent(null), "");
  assert.equal(extractContent({ type: "text", text: "nope" }), "");
});

test("formatToolCall: read with path/offset/limit", () => {
  assert.equal(
    formatToolCall("read", { path: "/tmp/a.ts", offset: 10, limit: 5 }),
    "[read: /tmp/a.ts:10-14]",
  );
  assert.equal(formatToolCall("read", { path: "/tmp/a.ts", offset: 3 }), "[read: /tmp/a.ts:3]");
  assert.equal(formatToolCall("read", { path: "/tmp/a.ts", limit: 2 }), "[read: /tmp/a.ts:1-2]");
  assert.equal(formatToolCall("read", { file_path: "/tmp/b.ts" }), "[read: /tmp/b.ts]");
});

test("formatToolCall: write/edit/bash/grep/find/ls known shapes", () => {
  assert.equal(formatToolCall("write", { path: "/tmp/w.ts" }), "[write: /tmp/w.ts]");
  assert.equal(formatToolCall("edit", { file_path: "/tmp/e.ts" }), "[edit: /tmp/e.ts]");
  assert.equal(formatToolCall("bash", { command: "ls -la" }), "[bash: ls -la]");
  assert.equal(formatToolCall("grep", { pattern: "foo", path: "src" }), "[grep: /foo/ in src]");
  assert.equal(formatToolCall("find", { pattern: "*.ts", path: "test" }), "[find: *.ts in test]");
  assert.equal(formatToolCall("ls", { path: "src" }), "[ls: src]");
  assert.equal(formatToolCall("grep", { pattern: "x" }), "[grep: /x/ in .]");
  assert.equal(formatToolCall("find", { pattern: "*" }), "[find: * in .]");
  assert.equal(formatToolCall("ls", {}), "[ls: .]");
});

test("formatToolCall: bash truncates command at 50 chars with ...", () => {
  const longCmd = "echo " + "x".repeat(60);
  const out = formatToolCall("bash", { command: longCmd });
  assert.equal(out, `[bash: ${longCmd.slice(0, 50)}...]`);
  assert.ok(out.endsWith("...]"));
  assert.equal(formatToolCall("bash", { command: "a".repeat(50) }), `[bash: ${"a".repeat(50)}]`);
});

test("formatToolCall: HOME path shortening to ~ when HOME set", () => {
  const home = process.env.HOME;
  assert.ok(home, "HOME must be set for this contract");
  assert.equal(formatToolCall("read", { path: `${home}/proj/a.ts` }), "[read: ~/proj/a.ts]");
  assert.equal(formatToolCall("write", { path: `${home}/x` }), "[write: ~/x]");
  assert.equal(formatToolCall("edit", { path: `${home}/x` }), "[edit: ~/x]");
  assert.equal(formatToolCall("ls", { path: home }), "[ls: ~]");
  assert.equal(formatToolCall("grep", { pattern: "a", path: `${home}/src` }), "[grep: /a/ in ~/src]");
  assert.equal(formatToolCall("find", { pattern: "*", path: `${home}/src` }), "[find: * in ~/src]");
});

test("formatToolCall: default tool JSON-truncates args at 40", () => {
  const short = formatToolCall("unknown", { a: 1 });
  assert.equal(short, `[unknown: ${JSON.stringify({ a: 1 })}]`);
  assert.ok(!short.includes("..."));

  const args = { value: "x".repeat(50) };
  const json = JSON.stringify(args);
  const long = formatToolCall("custom_tool", args);
  assert.equal(long, `[custom_tool: ${json.slice(0, 40)}...]`);
  assert.ok(long.endsWith("...]"));
});
