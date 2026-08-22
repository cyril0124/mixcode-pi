import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  installToolExecutionAdapter,
  type CallRenderer,
  type ResultRenderer,
  type ToolRowResolver,
} from "./tool-execution-adapter.js";

const nativeCall = (() => new Text("native call", 0, 0)) as CallRenderer;
const customCall = (() => new Text("custom call", 0, 0)) as CallRenderer;
const nativeResult = (() => new Text("native result", 0, 0)) as ResultRenderer;
const customResult = (() => new Text("custom result", 0, 0)) as ResultRenderer;

interface FakeRow {
  toolName: string;
  args?: unknown;
  invalidated: number;
  invalidate(): void;
  formatToolExecution(): string;
  getCallRenderer(): CallRenderer | undefined;
  getResultRenderer(): ResultRenderer | undefined;
  getRenderShell(): NonNullable<ToolDefinition["renderShell"]>;
}

function createPrototype() {
  return {
    formatToolExecution(this: { toolName?: string; args?: unknown }): string {
      const serialized = JSON.stringify(this.args, null, 2);
      return `${this.toolName}${serialized ? `\n\n${serialized}` : ""}\nNATIVE_RESULT`;
    },
    getCallRenderer(): CallRenderer | undefined {
      return nativeCall;
    },
    getResultRenderer(): ResultRenderer | undefined {
      return nativeResult;
    },
    getRenderShell(this: { toolName?: string }): "default" | "self" {
      return this.toolName === "edit" ? "self" : "default";
    },
  };
}

function createRow(prototype: object, toolName: string, args: unknown = {}): FakeRow {
  const row = Object.create(prototype) as FakeRow;
  row.toolName = toolName;
  row.args = args;
  row.invalidated = 0;
  row.invalidate = () => {
    row.invalidated += 1;
  };
  return row;
}

function nativeResolver(showRawArguments = false): ToolRowResolver {
  return {
    call: (_name, native) => native,
    result: (_name, native) => native,
    shell: (_name, native) => native,
    showRawArguments: () => showRawArguments,
  };
}

test("adapter selects display renderers without mutating tool definitions", () => {
  const prototype = createPrototype();
  const installation = installToolExecutionAdapter(prototype, {
    call: (name, native) => (name === "bash" ? customCall : native),
    result: (name, native) => (name === "bash" ? customResult : native),
    shell: (name, native) => (name === "edit" ? "default" : native),
    showRawArguments: () => false,
  });
  try {
    const bash = createRow(prototype, "bash");
    assert.equal(bash.getCallRenderer(), customCall);
    assert.equal(bash.getResultRenderer(), customResult);
    assert.equal(bash.getRenderShell(), "default");

    const edit = createRow(prototype, "edit");
    assert.equal(edit.getCallRenderer(), nativeCall);
    assert.equal(edit.getRenderShell(), "default");

    const other = createRow(prototype, "custom-tool");
    assert.equal(other.getCallRenderer(), nativeCall);
    assert.equal(other.getResultRenderer(), nativeResult);
    assert.equal(other.getRenderShell(), "default");
  } finally {
    installation.dispose();
  }
});

test("adapter controls generic fallback arguments without changing native results", () => {
  const prototype = createPrototype();
  let showRawArguments = false;
  const installation = installToolExecutionAdapter(prototype, {
    ...nativeResolver(),
    showRawArguments: () => showRawArguments,
  });
  try {
    const row = createRow(prototype, "unknown_tool", { secret: "value" });
    assert.equal(row.formatToolExecution(), "unknown_tool\nNATIVE_RESULT");
    assert.deepEqual(row.args, { secret: "value" });

    showRawArguments = true;
    assert.equal(
      row.formatToolExecution(),
      'unknown_tool\n\n{\n  "secret": "value"\n}\nNATIVE_RESULT',
    );
  } finally {
    installation.dispose();
  }
});

test("adapter dispose restores the exact native selectors", () => {
  const prototype = createPrototype();
  const originalFormat = prototype.formatToolExecution;
  const originalCall = prototype.getCallRenderer;
  const originalResult = prototype.getResultRenderer;
  const originalShell = prototype.getRenderShell;
  const installation = installToolExecutionAdapter(prototype, {
    call: () => customCall,
    result: () => customResult,
    shell: () => "default",
    showRawArguments: () => false,
  });
  assert.notEqual(prototype.formatToolExecution, originalFormat);
  assert.notEqual(prototype.getCallRenderer, originalCall);
  assert.notEqual(prototype.getResultRenderer, originalResult);
  assert.notEqual(prototype.getRenderShell, originalShell);

  installation.dispose();

  assert.equal(prototype.formatToolExecution, originalFormat);
  assert.equal(prototype.getCallRenderer, originalCall);
  assert.equal(prototype.getResultRenderer, originalResult);
  assert.equal(prototype.getRenderShell, originalShell);
});

test("re-install terminates when tracked rows re-enter patched getters from invalidate", () => {
  const prototype = createPrototype();
  const resolver = nativeResolver();
  const first = installToolExecutionAdapter(prototype, resolver);
  const rows: FakeRow[] = [];
  for (let index = 0; index < 3; index += 1) {
    const row = createRow(prototype, "bash");
    row.invalidate = () => {
      row.invalidated += 1;
      row.getCallRenderer();
    };
    row.getCallRenderer();
    rows.push(row);
  }

  const second = installToolExecutionAdapter(prototype, resolver);
  try {
    for (const row of rows) assert.equal(row.invalidated, 1);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("new installation replaces resolver ownership and stale dispose cannot remove it", () => {
  const prototype = createPrototype();
  const first = installToolExecutionAdapter(prototype, {
    ...nativeResolver(),
    call: () => customCall,
  });
  const secondCall = (() => new Text("second", 0, 0)) as CallRenderer;
  const second = installToolExecutionAdapter(prototype, {
    ...nativeResolver(),
    call: () => secondCall,
  });

  first.dispose();
  assert.equal(createRow(prototype, "bash").getCallRenderer(), secondCall);
  second.dispose();
  assert.equal(prototype.getCallRenderer(), nativeCall);
});
