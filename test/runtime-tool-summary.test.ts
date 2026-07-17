import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatToolPreview,
  normalizeToolResult,
  summarizeToolContent,
  summarizeToolResult,
  summarizeUnknown,
} from "../src/agent/runtime-tool-chat.js";

test("summarizeToolContent uses ok/error lead and prefixes non-empty text", () => {
  assert.equal(summarizeToolContent("", false), "ok");
  assert.equal(summarizeToolContent("   ", true), "error");
  assert.equal(summarizeToolContent("done", false), "ok done");
  assert.equal(summarizeToolContent("boom", true), "error boom");
  assert.equal(
    summarizeToolContent([{ type: "text", text: "from blocks" }], false),
    "ok from blocks",
  );
});

test("formatToolPreview first line is tool status then blank then content", () => {
  assert.equal(formatToolPreview("bash", "stdout", false), "tool bash: ok\n\nstdout");
  assert.equal(
    formatToolPreview("read", [{ type: "text", text: "file body" }], true),
    "tool read: error\n\nfile body",
  );
});

test("normalizeToolResult only accepts agent-like content results", () => {
  assert.equal(normalizeToolResult("plain string", false), undefined);
  assert.equal(normalizeToolResult(42, true), undefined);
  assert.equal(normalizeToolResult(null, false), undefined);

  const content = [{ type: "text", text: "hi" }];
  assert.deepEqual(normalizeToolResult({ content }, false), {
    content,
    details: undefined,
    isError: false,
  });
  assert.deepEqual(
    normalizeToolResult({ content, details: { exitCode: 1 }, isError: true }, true),
    {
      content,
      details: { exitCode: 1 },
      isError: true,
    },
  );
});

test("summarizeToolResult prefers content summary for agent results", () => {
  assert.equal(
    summarizeToolResult({ content: [{ type: "text", text: "agent ok" }] }, false),
    "ok agent ok",
  );
  assert.equal(
    summarizeToolResult({ content: [{ type: "text", text: "agent fail" }] }, true),
    "error agent fail",
  );
  assert.equal(summarizeToolResult("plain string result", false), "plain string result");
});

test("summarizeUnknown keeps 4 lines / 480 chars and appends hidden counts", () => {
  const long = Array.from({ length: 12 }, (_, i) => `line-${i}-${"x".repeat(80)}`).join("\n");
  assert.equal(
    summarizeUnknown(long),
    [
      `line-0-${"x".repeat(80)}`,
      `line-1-${"x".repeat(80)}`,
      `line-2-${"x".repeat(80)}`,
      `line-3-${"x".repeat(80)}`,
      "[truncated 8 lines, 706 chars]",
    ].join("\n"),
  );
});
