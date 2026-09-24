import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadToolDisplayRuntimeConfig, writeToolDisplayRuntimeConfig } from "./config.js";
import { disposeAll, registerCleanup, resetDisposed } from "./disposable.js";
import toolDisplayExtension, { createToolDisplayRenderers } from "./index.js";

type RenderResult = { render(width: number): string[] };

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

let workDir: string;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-display-work-"));
});
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function renderLines(component: unknown, width: number): string[] {
  return (component as RenderResult).render(width).map(stripAnsi);
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details } as never;
}

const collapsed = { expanded: false, isPartial: false } as never;
const expanded = { expanded: true, isPartial: false } as never;

function renderContext(overrides: Record<string, unknown> = {}) {
  return { state: {}, isError: false, ...overrides } as never;
}

test("extension never registers or replaces tools", () => {
  let registerToolCalls = 0;
  let registeredCommand:
    | {
        name: string;
        description: string;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
      }
    | undefined;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = workDir;
  const pi = {
    registerTool: () => {
      registerToolCalls += 1;
    },
    registerCommand: (
      name: string,
      definition: {
        description: string;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
      },
    ) => {
      registeredCommand = { name, ...definition };
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;

  try {
    toolDisplayExtension(pi);
    assert.equal(registerToolCalls, 0);
    assert.equal(registeredCommand?.name, "mpi-tool-display");
    assert.match(registeredCommand?.description ?? "", /^\[global\]/);
    assert.deepEqual(registeredCommand?.getArgumentCompletions?.("con"), [
      {
        value: "config",
        label: "config",
        description: "Open tool display settings",
      },
    ]);

    for (const handler of handlers.get("session_shutdown") ?? []) {
      void handler({ reason: "reload" }, {});
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("reload race: stale disposeAll after resetDisposed does not kill new-epoch callbacks", () => {
  // Simulate the reload sequence:
  //   1. Old extension instance was active and captured its epoch.
  //   2. New extension instance activates and calls resetDisposed(), advancing the epoch.
  //   3. Old instance's session_shutdown fires disposeAll(staleEpoch) — must be a no-op.
  const staleEpoch = resetDisposed(); // old instance activates
  resetDisposed(); // new instance activates — epoch advances past staleEpoch

  let staleKilled = false;
  registerCleanup(() => {
    staleKilled = true;
  });

  // Stale old-instance shutdown arrives with the old epoch token.
  disposeAll(staleEpoch);

  assert.equal(
    staleKilled,
    false,
    "stale disposeAll must not run callbacks registered in the new epoch",
  );

  // Subsequent registerCleanup calls must queue, not execute immediately.
  let immediatelyKilled = false;
  registerCleanup(() => {
    immediatelyKilled = true;
  });
  assert.equal(
    immediatelyKilled,
    false,
    "registerCleanup after stale disposeAll must queue, not execute immediately",
  );

  disposeAll(); // proper teardown for the current epoch
});

test("bash spinner matches spinner running-state contract", () => {
  resetDisposed();
  const { bash } = createToolDisplayRenderers();
  const state: Record<string, unknown> = {};
  const component = bash.renderCall(
    { command: "sleep 5", timeout: 30 } as never,
    theme,
    renderContext({
      toolCallId: "spinner-call",
      state,
      executionStarted: true,
      isPartial: true,
      invalidate: () => {},
    }),
  );
  const rendered = renderLines(component, 200).join("\n").trim();
  assert.match(rendered, /^⠋ bash sleep 5\s+~ 0s · timeout 30s · ctrl\+o$/);

  // Rendering the completed state clears the timer and stops the spinner.
  const completed = bash.renderCall(
    { command: "sleep 5", timeout: 30 } as never,
    theme,
    renderContext({
      toolCallId: "spinner-call",
      state,
      executionStarted: true,
      isPartial: false,
      invalidate: () => {},
    }),
  );
  const completedLines = renderLines(completed, 200);
  assert.equal(completedLines.length, 1);
  assert.match(completedLines[0]!.trim(), /^bash sleep 5\s/);
  assert.ok(!completedLines[0]!.includes("⠋"));
  disposeAll();
});

test("bash result stays expanded while partial and collapses only when complete", () => {
  const { bash } = createToolDisplayRenderers();
  const result = textResult("live-one\nlive-two");
  const context = renderContext({ args: { command: "build" } });
  const partial = renderLines(
    bash.renderResult(result, { expanded: false, isPartial: true } as never, theme, context),
    200,
  ).join("\n");
  assert.match(partial, /live-one[\s\S]*live-two/);

  const complete = bash.renderResult(result, collapsed, theme, context);
  assert.deepEqual(renderLines(complete, 200), []);
});

test("bash collapsed result leaves the single row to the call renderer", () => {
  const { bash } = createToolDisplayRenderers();
  const state: Record<string, unknown> = {};
  const outputLines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  const args = { command: "printf demo" };
  const resultRow = renderLines(
    bash.renderResult(
      textResult(outputLines.join("\n")),
      collapsed,
      theme,
      renderContext({ state, args }),
    ),
    200,
  );
  assert.deepEqual(resultRow, []);

  const callRow = renderLines(
    bash.renderCall(
      args as never,
      theme,
      renderContext({ state, executionStarted: true, isPartial: false }),
    ),
    200,
  );
  assert.equal(callRow.length, 1);
  assert.match(callRow[0]!, /^bash printf demo\s+ok · 30 lines · ctrl\+o$/);
  assert.ok(!callRow[0]!.includes("line-30"));
});

test("bash call row keeps one line and reports failure status", () => {
  const { bash } = createToolDisplayRenderers();
  const state: Record<string, unknown> = {};
  const errorText = "boom\nbroken pipe\n\nCommand exited with code 2";
  const errorTail = renderLines(
    bash.renderResult(
      textResult(errorText),
      collapsed,
      theme,
      renderContext({ state, isError: true, args: { command: "false" } }),
    ),
    200,
  );
  assert.deepEqual(
    errorTail.map((line) => line.trim()),
    ["boom", "broken pipe", "Command exited with code 2"],
  );

  const callRow = renderLines(
    bash.renderCall(
      { command: "false" } as never,
      theme,
      renderContext({ state, executionStarted: true, isPartial: false }),
    ),
    200,
  );
  assert.equal(callRow.length, 1);
  assert.match(callRow[0]!, /^bash false\s+!! exit 2 · 4 lines · ctrl\+o$/);

  const withTimeout = renderLines(
    bash.renderCall(
      { command: "echo hi", timeout: 30 } as never,
      theme,
      renderContext({ executionStarted: false, isPartial: false }),
    ),
    200,
  );
  assert.equal(withTimeout.length, 1);
  assert.match(withTimeout[0]!, /^bash echo hi\s+timeout 30s · ctrl\+o$/);
});

test("a failure without Pi's status line keeps the head of the output", () => {
  const { bash } = createToolDisplayRenderers();
  const validation = [
    "- description: must have required properties description",
    "",
    "Received arguments:",
    "{",
    '  "command": "ls"',
    "}",
  ].join("\n");
  const rows = renderLines(
    bash.renderResult(
      textResult(validation),
      collapsed,
      theme,
      renderContext({ isError: true, args: { command: "ls" } }),
    ),
    200,
  ).map((line) => line.trim());
  assert.deepEqual(rows, [
    "- description: must have required properties description",
    "Received arguments:",
    "{",
  ]);
});

test("bash failure status is read from the last result line only", () => {
  const { bash } = createToolDisplayRenderers();
  const state: Record<string, unknown> = {};
  const forged = "Command exited with code 7\n\nCommand timed out after 5 seconds";
  renderLines(
    bash.renderResult(
      textResult(forged),
      collapsed,
      theme,
      renderContext({ state, isError: true, args: { command: "sleep 100" } }),
    ),
    200,
  );
  const timedOutRow = renderLines(
    bash.renderCall(
      { command: "sleep 100" } as never,
      theme,
      renderContext({ state, executionStarted: true, isPartial: false }),
    ),
    200,
  )[0]!;
  assert.match(timedOutRow, /!! timed out · 3 lines · ctrl\+o$/);

  const second: Record<string, unknown> = {};
  renderLines(
    bash.renderResult(
      textResult("Command exited with code 7\n\nCommand exited with code 2"),
      collapsed,
      theme,
      renderContext({ second: true, state: second, isError: true, args: { command: "false" } }),
    ),
    200,
  );
  const exitRow = renderLines(
    bash.renderCall(
      { command: "false" } as never,
      theme,
      renderContext({ state: second, executionStarted: true, isPartial: false }),
    ),
    200,
  )[0]!;
  assert.match(exitRow, /!! exit 2 · 3 lines · ctrl\+o$/);
});

test("bash collapsed failure keeps at most the configured tail", () => {
  const { bash } = createToolDisplayRenderers();
  const output = Array.from({ length: 9 }, (_, index) => `row-${index + 1}`).join("\n");
  const tail = renderLines(
    bash.renderResult(
      textResult(`${output}\n\nCommand exited with code 1`),
      collapsed,
      theme,
      renderContext({ isError: true, args: { command: "false" } }),
    ),
    200,
  );
  assert.deepEqual(
    tail.map((line) => line.trim()),
    ["row-8", "row-9", "Command exited with code 1"],
  );
});

test("bash expanded render shows the full preview", () => {
  const { bash } = createToolDisplayRenderers();
  const outputLines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  const rendered = renderLines(
    bash.renderResult(
      textResult(outputLines.join("\n")),
      expanded,
      theme,
      renderContext({ args: { command: "printf demo" } }),
    ),
    200,
  ).join("\n");
  assert.ok(rendered.includes("line-1"));
  assert.ok(rendered.includes("line-30"));
});

test("read result and tool calls use configured summaries", () => {
  const { read, edit, write } = createToolDisplayRenderers();
  const readResult = renderLines(
    read.renderResult(
      textResult("a\nb\nc\nd\ne"),
      collapsed,
      theme,
      renderContext({ args: { path: "src/foo.ts" } }),
    ),
    200,
  );
  assert.equal(readResult.length, 1);
  assert.ok(readResult[0]!.includes("↳ loaded 5 lines"));

  const ctx = renderContext({ executionStarted: false, isPartial: false, argsComplete: true });
  const readCall = renderLines(
    read.renderCall({ path: "src/foo.ts", offset: 10, limit: 5 } as never, theme, ctx),
    200,
  ).join("");
  assert.ok(readCall.includes("read src/foo.ts:10-14"));
  const editCall = renderLines(
    edit.renderCall({ path: "src/foo.ts", oldText: "a", newText: "x\ny" } as never, theme, ctx),
    200,
  ).join("");
  assert.ok(editCall.includes("edit src/foo.ts (2 lines)"));
  const writeCall = renderLines(
    write.renderCall({ path: "src/foo.ts", content: "a\nb\n" } as never, theme, ctx),
    200,
  ).join("");
  assert.ok(writeCall.includes("write src/foo.ts (2 lines"));
});

test("SKILL.md reads render as compact [skill] rows", () => {
  initTheme("dark");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = workDir;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  try {
    toolDisplayExtension(pi);
    const definition = createReadToolDefinition(workDir);
    const renderRead = (filePath: string, body: string): string => {
      const component = new ToolExecutionComponent(
        "read",
        `read-${filePath}`,
        { path: filePath },
        { showImages: false, imageWidthCells: 20 },
        definition,
        { requestRender: () => undefined } as never,
        workDir,
      );
      component.markExecutionStarted();
      component.setArgsComplete();
      component.updateResult(
        { content: [{ type: "text", text: body }], details: {}, isError: false } as never,
        false,
      );
      return stripAnsi(component.render(100).join("\n"));
    };

    const skillText = renderRead(
      path.join(workDir, "find-skills", "SKILL.md"),
      "---\nname: find-skills\n---\n# Find Skills\n",
    );
    assert.match(skillText, /\[skill\] find-skills/);
    assert.match(skillText, /to expand/);
    assert.doesNotMatch(skillText, /↳ loaded/);
    assert.doesNotMatch(skillText, /Find Skills/);

    const sourceText = renderRead(path.join(workDir, "src", "foo.ts"), "a\nb\nc\n");
    assert.match(sourceText, /read /);
    assert.match(sourceText, /↳ loaded 3 lines/);
    assert.doesNotMatch(sourceText, /\[skill\]/);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      void handler({ reason: "reload" }, {});
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("edit partial result shows the progress line", () => {
  const { edit } = createToolDisplayRenderers();
  const rendered = renderLines(
    edit.renderResult(
      textResult(""),
      { expanded: false, isPartial: true } as never,
      theme,
      renderContext({ args: { path: "src/foo.ts", oldText: "a", newText: "x\ny" } }),
    ),
    200,
  ).join("");
  assert.ok(rendered.includes("editing..."));
  assert.ok(rendered.includes("(2 lines)"));
});

function buildAdditionDiff(lineCount: number): string {
  const added = Array.from({ length: lineCount }, (_, index) => `+added-${index + 1}`);
  return [`@@ -0,0 +1,${lineCount} @@`, ...added].join("\n");
}

test("edit diff caps collapsed output and switches split by width", () => {
  const { edit } = createToolDisplayRenderers();
  const capped = renderLines(
    edit.renderResult(
      textResult("ok", { diff: buildAdditionDiff(40), patch: "" }),
      collapsed,
      theme,
      renderContext({ args: { path: "src/foo.ts" } }),
    ),
    100,
  );
  const cappedText = capped.join("\n");
  assert.ok(capped.length <= 30);
  assert.ok(cappedText.includes("added-1"));
  assert.ok(!cappedText.includes("added-40"));
  assert.match(cappedText, /more/);

  const diff = ["@@ -1,2 +1,2 @@", " shared", "-old_value", "+new_value"].join("\n");
  const details = textResult("ok", { diff, patch: "" });
  const context = renderContext({ args: { path: "src/foo.ts" } });
  const wide = renderLines(edit.renderResult(details, collapsed, theme, context), 200);
  assert.ok(wide.some((line) => line.includes("old_value") && line.includes("new_value")));
  const narrow = renderLines(edit.renderResult(details, collapsed, theme, context), 80);
  assert.equal(
    narrow.some((line) => line.includes("old_value") && line.includes("new_value")),
    false,
  );
});

test("write pre-capture renders overwrite and create diffs without wrapping execute", () => {
  // Drive the real production path: extension registration → tool_call event
  // → pre-execution capture → adapter-selected renderer via the real
  // ToolExecutionComponent.
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let registerToolCalls = 0;
  const pi = {
    registerTool: () => {
      registerToolCalls += 1;
    },
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  toolDisplayExtension(pi);
  assert.equal(registerToolCalls, 0);

  const emit = (event: string, payload: unknown, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      void handler(payload, ctx);
    }
  };

  const renderWriteRow = (toolCallId: string, args: Record<string, unknown>): string => {
    initTheme("dark");
    // Minimal write definition: the adapter selects the package renderer and
    // never calls execute in this test.
    const definition = {
      name: "write",
      label: "write",
      description: "",
      parameters: {},
      execute: async () => ({ content: [] }),
    } as never;
    const component = new ToolExecutionComponent(
      "write",
      toolCallId,
      args,
      { showImages: false, imageWidthCells: 20 },
      definition,
      { requestRender: () => {} } as never,
      workDir,
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    component.updateResult(
      { content: [{ type: "text", text: "ok" }], details: {}, isError: false } as never,
      false,
    );
    return stripAnsi(component.render(100).join("\n"));
  };

  const overwritePath = path.join(workDir, "overwrite.txt");
  fs.writeFileSync(overwritePath, "previous-content-line\n");
  emit(
    "tool_call",
    { toolName: "write", toolCallId: "write-1", input: { path: "overwrite.txt" } },
    { cwd: workDir },
  );
  const overwriteText = renderWriteRow("write-1", {
    path: "overwrite.txt",
    content: "replacement-content-line\n",
  });
  assert.ok(overwriteText.includes("previous-content-line"));
  assert.ok(overwriteText.includes("replacement-content-line"));

  // Non-write tools are not captured: a bash tool_call against the same file
  // must not seed write pre-execution content.
  emit(
    "tool_call",
    { toolName: "bash", toolCallId: "bash-1", input: { path: "overwrite.txt" } },
    { cwd: workDir },
  );
  assert.ok(
    !renderWriteRow("bash-1", { path: "overwrite.txt", content: "x\n" }).includes(
      "previous-content",
    ),
  );

  // New-file write renders as pure additions.
  emit(
    "tool_call",
    { toolName: "write", toolCallId: "write-2", input: { path: "new.txt" } },
    { cwd: workDir },
  );
  const createText = renderWriteRow("write-2", {
    path: "new.txt",
    content: "fresh-1\nfresh-2\n",
  });
  assert.ok(createText.includes("fresh-1"));
  assert.ok(createText.includes("fresh-2"));
  assert.ok(!createText.includes("previous-content"));

  // Teardown: reload shutdown restores the patched prototype.
  emit("session_shutdown", { reason: "reload" }, {});
});

test("config controls every tool category on the next agent turn", async () => {
  initTheme("dark");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-display-all-tools-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let command:
    | {
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    | undefined;
  const pi = {
    registerCommand: (_name: string, definition: typeof command) => {
      command = definition;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;

  const secondHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const secondPi = {
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = secondHandlers.get(event) ?? [];
      current.push(handler);
      secondHandlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  const emit = (event: string, payload: unknown, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) void handler(payload, ctx);
  };
  const emitSecond = (event: string, payload: unknown, ctx: unknown) => {
    for (const handler of secondHandlers.get(event) ?? []) void handler(payload, ctx);
  };
  const definition = (name: string, renderCall?: () => Text) =>
    ({
      name,
      label: name,
      description: "",
      parameters: {},
      execute: async () => ({ content: [] }),
      ...(renderCall ? { renderCall } : {}),
    }) as never;
  const row = (
    name: string,
    args: Record<string, unknown>,
    renderCall?: () => Text,
    registered = true,
  ) => {
    const component = new ToolExecutionComponent(
      name,
      `${name}-call`,
      args,
      { showImages: false, imageWidthCells: 20 },
      registered ? definition(name, renderCall) : undefined,
      { requestRender: () => undefined } as never,
      agentDir,
    );
    component.updateResult(
      { content: [{ type: "text", text: `${name}-result` }], details: {}, isError: false },
      false,
    );
    return component;
  };

  try {
    toolDisplayExtension(pi);
    // A second tab becomes the prototype adapter owner. The first tab's
    // config command must still update and redraw rows through shared state.
    toolDisplayExtension(secondPi);
    const bash = row("bash", { command: "echo debug" });
    const fallback = row("TaskUpdate", { taskId: "5", status: "in_progress" });
    const native = row("native_tool", { payload: "value" }, () => new Text("native call", 0, 0));
    const unknown = row("unknown_tool", { raw: "unknown" }, undefined, false);
    const rendered = (component: ToolExecutionComponent) =>
      stripAnsi(component.render(100).join("\n"));

    assert.doesNotMatch(rendered(bash), /"command"/);
    assert.doesNotMatch(rendered(fallback), /"taskId"/);
    assert.match(rendered(native), /native call/);
    assert.doesNotMatch(rendered(native), /"payload"/);
    assert.match(rendered(unknown), /unknown_tool/);
    assert.doesNotMatch(rendered(unknown), /"raw"/);

    assert.ok(command);
    const notices: string[] = [];
    await command.handler("unknown", {
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message) },
    } as never);
    await command.handler("config", {
      hasUI: false,
      ui: { notify: (message: string) => notices.push(message) },
    } as never);
    assert.deepEqual(notices, [
      "Usage: /mpi-tool-display config",
      "mpi-tool-display config requires interactive UI",
    ]);

    await command.handler("config", {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: () => void,
          ) => { handleInput(data: string): void },
        ) => {
          let done = false;
          const view = factory(
            { requestRender: () => undefined },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            {},
            () => {
              done = true;
            },
          );
          // j selects the second row (Raw tool arguments), Enter toggles it.
          view.handleInput("j");
          view.handleInput("\r");
          view.handleInput("\x1b");
          assert.equal(done, true);
        },
      },
    } as never);

    emitSecond("before_agent_start", {}, { ui: { notify: () => undefined } });
    const enabledBash = row("bash", { command: "echo enabled" });
    const enabledFallback = row("TaskUpdate", { taskId: "6", status: "completed" });
    const enabledNative = row(
      "native_tool",
      { payload: "enabled" },
      () => new Text("native call", 0, 0),
    );
    const enabledUnknown = row("unknown_tool", { raw: "enabled" }, undefined, false);
    assert.match(rendered(enabledBash), /"command": "echo enabled"/);
    assert.match(rendered(enabledFallback), /"taskId": "6"/);
    assert.match(rendered(enabledNative), /native call/);
    assert.match(rendered(enabledNative), /"payload": "enabled"/);
    assert.match(rendered(enabledNative), /native_tool-result/);
    assert.match(rendered(enabledUnknown), /"raw": "enabled"/);
    assert.match(rendered(enabledUnknown), /unknown_tool-result/);
    const persisted = loadToolDisplayRuntimeConfig(agentDir);
    assert.equal(persisted.ok && persisted.config.showRawToolArguments, true);

    const disabled = writeToolDisplayRuntimeConfig(agentDir, {
      showRawToolArguments: false,
      compactBashCallRow: true,
    });
    assert.equal(disabled.ok, true);
    emitSecond("before_agent_start", {}, { ui: { notify: () => undefined } });
    const disabledBash = row("bash", { command: "echo disabled" });
    const disabledFallback = row("TaskUpdate", { taskId: "7", status: "pending" });
    const disabledNative = row(
      "native_tool",
      { payload: "disabled" },
      () => new Text("native call", 0, 0),
    );
    const disabledUnknown = row("unknown_tool", { raw: "disabled" }, undefined, false);
    assert.doesNotMatch(rendered(disabledBash), /"command"/);
    assert.doesNotMatch(rendered(disabledFallback), /"taskId"/);
    assert.match(rendered(disabledNative), /native call/);
    assert.doesNotMatch(rendered(disabledNative), /"payload"/);
    assert.doesNotMatch(rendered(disabledUnknown), /"raw"/);
  } finally {
    emit("session_shutdown", { reason: "reload" }, {});
    emitSecond("session_shutdown", { reason: "reload" }, {});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
