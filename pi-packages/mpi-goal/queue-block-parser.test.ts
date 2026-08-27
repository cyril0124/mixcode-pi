import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueBlockItems } from "./src/queue/block-parser.js";
import { parseGoalTemplateInvocation } from "./src/templates/discover.js";

test("parseQueueBlockItems: keeps continuation lines and trims outer blanks", () => {
  const items = parseQueueBlockItems(
    ["1. first objective", "   detail line", "", "2. second objective"].join("\n"),
  );
  assert.deepEqual(items, [
    { objectiveInput: "first objective\n   detail line", marker: "1.", lineIndex: 0 },
    { objectiveInput: "second objective", marker: "2.", lineIndex: 3 },
  ]);
});

test("parseQueueBlockItems: rejects input without a marker list", () => {
  assert.equal(parseQueueBlockItems("just one line"), null);
  assert.equal(parseQueueBlockItems("plain text\nmore plain text"), null);
});

test("parseGoalTemplateInvocation: separates flags, boolean flags and -- args", () => {
  assert.deepEqual(
    parseGoalTemplateInvocation('review --scope "src/core" --strict -- check the parser'),
    {
      name: "review",
      flags: { scope: "src/core", strict: "true" },
      args: "check the parser",
    },
  );
});

test("parseGoalTemplateInvocation: supports --key=value and rejects empty input", () => {
  assert.deepEqual(parseGoalTemplateInvocation("review --scope=src"), {
    name: "review",
    flags: { scope: "src" },
    args: "",
  });
  assert.equal(parseGoalTemplateInvocation("   "), undefined);
});
