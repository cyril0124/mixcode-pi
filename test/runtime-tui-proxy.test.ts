import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI as PiTui } from "@earendil-works/pi-tui";
import { createTerminalRowsProxy } from "../src/agent/runtime-tui-proxy.js";

test("terminal rows proxy overrides rows while preserving tui and terminal behavior", () => {
  const calls: string[] = [];
  let rows = 12;
  const tui = {
    terminal: {
      get rows() {
        return 40;
      },
      get columns() {
        return 100;
      },
      write: (data: string) => calls.push(`write:${data}`),
    },
    requestRender: () => calls.push("render"),
  } as unknown as PiTui;

  const proxy = createTerminalRowsProxy(tui, () => rows);

  assert.equal(proxy.terminal.rows, 12);
  assert.equal(proxy.terminal.columns, 100);
  proxy.terminal.write("x");
  proxy.requestRender();
  rows = 7;
  assert.equal(proxy.terminal.rows, 7);
  assert.deepEqual(calls, ["write:x", "render"]);
});
