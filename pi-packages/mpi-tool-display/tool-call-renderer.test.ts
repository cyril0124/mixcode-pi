import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { wrapToolCallRenderer } from "./tool-call-renderer.js";
import type { CallRenderer } from "./tool-execution-adapter.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function context(lastComponent?: Component) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => undefined,
    lastComponent,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  } as never;
}

function render(component: Component): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("raw argument wrapper preserves native output and appends formatted JSON", () => {
  const selected = (() => new Text("native call", 0, 0)) as CallRenderer;
  const renderer = wrapToolCallRenderer("TaskUpdate", selected, true);
  const output = render(
    renderer(
      { taskId: "5", status: "in_progress" },
      theme,
      context(),
    ),
  );

  assert.match(output, /native call/);
  assert.match(output, /\{\n\s+"taskId": "5",\n\s+"status": "in_progress"\n\}/);
});

test("raw argument wrapper supplies the tool title when no call renderer exists", () => {
  const renderer = wrapToolCallRenderer("ask_user_question", undefined, true);
  const output = render(renderer({ questions: [] }, theme, context()));

  assert.match(output, /^ask_user_question/m);
  assert.match(output, /"questions": \[\]/);
});

test("disabled raw arguments do not serialize tool input", () => {
  const args = {
    toJSON(): never {
      throw new Error("serialized");
    },
  };
  const selected = (() => new Text("bash call", 0, 0)) as CallRenderer;
  const renderer = wrapToolCallRenderer("bash", selected, false);

  assert.equal(render(renderer(args, theme, context())).trim(), "bash call");
});

test("wrapper returns the selected renderer its own previous component", () => {
  const seen: Array<Component | undefined> = [];
  let generation = 0;
  const selected = ((_args, _theme, renderContext) => {
    seen.push(renderContext.lastComponent);
    generation += 1;
    return new Text(`inner-${generation}`, 0, 0);
  }) as CallRenderer;

  const firstRenderer = wrapToolCallRenderer("bash", selected, false);
  const firstOuter = firstRenderer({}, theme, context());
  const firstInner = seen[0];
  assert.equal(firstInner, undefined);

  const secondRenderer = wrapToolCallRenderer("bash", selected, true);
  secondRenderer({ command: "echo ok" }, theme, context(firstOuter));
  assert.ok(seen[1]);
  assert.notEqual(seen[1], firstOuter);
  assert.equal(render(seen[1]!).trim(), "inner-1");
});
