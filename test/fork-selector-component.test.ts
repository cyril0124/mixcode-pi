import assert from "node:assert/strict";
import { test } from "node:test";
import { ForkSelector } from "../src/ui/components/fork-selector.js";
import { themeForId } from "../src/ui/themes.js";

const ITEMS = [
  { entryId: "e1", text: "first message" },
  { entryId: "e2", text: "second\n  message   with spaces" },
  { entryId: "e3", text: "third message" },
];

const UP = "\u001b[A";
const ENTER = "\r";
const ESCAPE = "\u001b";

function makeSelector(events: string[]) {
  return new ForkSelector(ITEMS, () => themeForId("dark"), {
    onSelect: (entryId) => events.push(`select:${entryId}`),
    onCancel: () => events.push("cancel"),
  });
}

test("fork selector defaults to the newest message and confirms it on enter", () => {
  const events: string[] = [];
  const selector = makeSelector(events);
  selector.handleInput(ENTER);
  assert.deepEqual(events, ["select:e3"]);
});

test("fork selector navigates with arrows and vim keys", () => {
  const events: string[] = [];
  const selector = makeSelector(events);
  selector.handleInput(UP); // e2
  selector.handleInput("k"); // e1
  selector.handleInput("j"); // e2
  selector.handleInput(ENTER);
  assert.deepEqual(events, ["select:e2"]);
});

test("fork selector cancels on escape without selecting", () => {
  const events: string[] = [];
  const selector = makeSelector(events);
  selector.handleInput(ESCAPE);
  assert.deepEqual(events, ["cancel"]);
});

test("fork selector renders a titled panel with collapsed message previews", () => {
  const selector = makeSelector([]);
  const plain = selector
    .render(60)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.match(plain, /Fork from User Message/);
  // Newlines and runs of spaces collapse into single spaces in the preview.
  assert.match(plain, /second message with spaces/);
  assert.match(plain, /third message/);
});
